/**
 * Gera histórico sintético de trajetos casa↔trabalho para demonstrar e validar o aprendizado.
 * Usa os mesmos serviços da API (plano → viagem → amostras GPS → fim), com o relógio no passado.
 *
 *   bun run seed --user <uuid> [--days 20] [--home lat,lon] [--work lat,lon]
 */
import { parseArgs } from 'node:util';
import { localTime, simulateDrive, type PlanResponse } from '@wayboo/core';
import { db, insertSamples } from '../db';
import { evaluatePlan, plan } from '../services/planning';
import { finishTrip, startTrip } from '../services/trips';

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    days: { type: 'string', default: '20' },
    home: { type: 'string', default: '-23.5665,-46.6930' }, // Pinheiros
    work: { type: 'string', default: '-23.5614,-46.6559' }, // Av. Paulista
    tz: { type: 'string', default: 'America/Sao_Paulo' },
  },
});
if (!values.user) throw new Error('Informe --user <uuid> (o mesmo id que o app mostra em Ajustes).');
const userId = values.user;
const tz = values.tz!;
const parse = (s: string) => {
  const [lat, lon] = s.split(',').map(Number);
  return { lat: lat!, lon: lon! };
};
const home = parse(values.home!);
const work = parse(values.work!);

let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/** "Verdade" sintética: pico às 8h e 18h, trechos centrais da rota mais congestionados. */
function trafficAt(minuteOfDay: number, frac: number): number {
  const peak = (center: number) => Math.exp(-(((minuteOfDay - center) / 50) ** 2));
  const rush = Math.max(peak(8 * 60 + 10), peak(18 * 60 + 20));
  const hotspot = frac > 0.3 && frac < 0.65 ? 1.6 : 0.6;
  return 1.15 + rush * hotspot * 1.4;
}

const NO_AVOID = { avoidTolls: false, avoidHighways: false, avoidFerries: false };

async function main() {
  const days = Number(values.days);
  const plans: Record<'go' | 'back', PlanResponse> = {
    go: await plan(userId, { origin: home, destination: work, timeZone: tz, waypoints: [], options: NO_AVOID, reroute: false }),
    back: await plan(userId, { origin: work, destination: home, timeZone: tz, waypoints: [], options: NO_AVOID, reroute: false }),
  };
  const now = Date.now();
  let made = 0;
  for (let d = days; d >= 1; d--) {
    const dayStart = now - d * 86_400_000;
    const lt = localTime(dayStart, tz);
    if (lt.dayType !== 'weekday') continue;
    const midnight = dayStart - lt.minuteOfDay * 60_000;
    for (const [dir, hour] of [
      ['go', 7.6],
      ['back', 17.9],
    ] as const) {
      const p = plans[dir];
      const depart = midnight + Math.round((hour + rnd() * 0.9) * 3_600_000);
      // Reavalia a mesma rota com o que já foi aprendido, como o app faria naquele dia (sem nova chamada ao roteador).
      const fresh = evaluatePlan(
        userId,
        { origin: p.origin, destination: p.destination, timeZone: tz, departAt: depart, waypoints: [], options: NO_AVOID, reroute: true },
        [p.routes[0]!.route],
        null,
      );
      const route = fresh.routes[0]!.route;
      const minute = localTime(depart, tz).minuteOfDay;
      let elapsed = 0;
      const truth = route.segments.map((s) => {
        const dur = s.baseDurationS * trafficAt(minute + elapsed / 60, s.startM / route.distanceM) * (0.9 + rnd() * 0.2);
        elapsed += dur;
        return dur;
      });
      const { tripId } = startTrip(userId, fresh.planId, 0, tz);
      db.prepare('UPDATE trips SET started_at = ? WHERE id = ?').run(depart, tripId);
      db.prepare('UPDATE trip_legs SET started_at = ? WHERE trip_id = ?').run(depart, tripId);
      const samples = [...simulateDrive(route, truth, depart, 2, 5, rnd)];
      insertSamples(tripId, samples);
      const r = finishTrip(userId, tripId);
      made++;
      console.log(
        `${new Date(depart).toISOString().slice(0, 16)} ${dir === 'go' ? 'ida  ' : 'volta'} real ${(r.actualS / 60).toFixed(1)} min | ` +
          `roteador erra ${r.errorBasePct.toFixed(0).padStart(3)}% | aprendido erra ${r.errorLearnedPct.toFixed(0).padStart(3)}%`,
      );
    }
  }
  console.log(`\n${made} viagens simuladas para ${userId}.`);
}

await main();
