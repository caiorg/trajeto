import { randomUUID } from 'node:crypto';
import { buildSegments, cumulativeDistances, simulateDrive, type Coord, type Maneuver, type PlanResponse, type Route } from '@wayboo/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { CROWD, db } from '../src/db';

/** Rota sintética de ~4,5 km com uma curva, a 12 m/s no roteador. */
function makeRoute(): Route {
  const from: Coord = [-46.65, -23.56];
  const to: Coord = [-46.62, -23.59];
  const n = 80;
  const mid: Coord = [(from[0] + to[0]) / 2 + 0.004, (from[1] + to[1]) / 2];
  const geometry: Coord[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const [a, b, g] = f < 0.5 ? [from, mid, f * 2] : [mid, to, (f - 0.5) * 2];
    geometry.push([a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g]);
  }
  const cum = cumulativeDistances(geometry);
  const m = (type: number, b: number, e: number): Maneuver => ({
    type,
    instruction: 'Siga',
    streetNames: [],
    distanceM: cum[e]! - cum[b]!,
    durationS: (cum[e]! - cum[b]!) / 12,
    beginIdx: b,
    endIdx: e,
    toll: false,
    highway: false,
  });
  const maneuvers = [m(1, 0, n / 2), m(15, n / 2, n), m(4, n, n)];
  return {
    id: randomUUID(),
    geometry,
    distanceM: cum[n]!,
    baseDurationS: cum[n]! / 12,
    maneuvers,
    hasToll: false,
    hasHighway: false,
    hasFerry: false,
    highwayShare: 0,
    segments: buildSegments(geometry, maneuvers),
    provider: 'test',
  };
}

const ROUTE = makeRoute();
const [lon0, lat0] = ROUTE.geometry[0]!;
const [lon1, lat1] = ROUTE.geometry[ROUTE.geometry.length - 1]!;
const TZ = 'America/Sao_Paulo';
const DAY_MS = 86_400_000;

vi.mock('../src/providers/routing', () => ({ valhalla: { name: 'test', route: async () => [structuredClone(ROUTE)] } }));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
}));

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

async function call<T>(userId: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const res = await app.inject({ method, url, headers: { 'x-user-id': userId }, payload });
  return { status: res.statusCode, body: res.json<T>() };
}

/** Planeja, dirige a rota com trânsito 1,8× o previsto pelo roteador e encerra a viagem pela API. */
async function drive(userId: string) {
  const { body: plan } = await call<PlanResponse>(userId, 'POST', '/plan', {
    origin: { lat: lat0, lon: lon0 },
    destination: { lat: lat1, lon: lon1 },
    timeZone: TZ,
  });
  const { body: trip } = await call<{ tripId: string }>(userId, 'POST', '/trips', { planId: plan.planId, routeIndex: 0, timeZone: TZ });
  const route = plan.routes[0]!.route;
  const samples = [...simulateDrive(route, route.segments.map((s) => s.baseDurationS * 1.8), Date.now() + 1000, 2)];
  await call(userId, 'POST', `/trips/${trip.tripId}/samples`, { samples });
  const { body } = await call<{ learnedSegments: number }>(userId, 'POST', `/trips/${trip.tripId}/finish`);
  return body;
}

const rows = (userId: string) =>
  db.prepare('SELECT key, seg, w, mean, m2, t FROM stats WHERE user_id = ? ORDER BY key').all(userId) as {
    key: string;
    t: number;
  }[];

describe('opt-in do aprendizado coletivo', () => {
  it('vem desligado e a viagem sem opt-in não altera nenhuma linha do agregado', async () => {
    const userId = randomUUID();
    expect((await call(userId, 'GET', '/privacy')).body).toEqual({ shareCrowd: false });

    const before = rows(CROWD);
    const res = await drive(userId);

    expect(res.learnedSegments).toBeGreaterThan(0);
    expect(rows(userId).length).toBeGreaterThan(0);
    expect(rows(CROWD)).toEqual(before);
  });

  it('com opt-in soma só chaves de trecho e contexto, com a data sem horário', async () => {
    const userId = randomUUID();
    expect((await call(userId, 'PUT', '/privacy', { shareCrowd: true })).body).toEqual({ shareCrowd: true });

    await drive(userId);

    const crowd = rows(CROWD);
    expect(crowd.length).toBeGreaterThan(0);
    for (const r of crowd) {
      expect(r.key).toMatch(/^(sb|s|c)\|/);
      expect(r.t % DAY_MS).toBe(0);
      expect(JSON.stringify(r)).not.toContain(userId);
    }
  });

  it('revogar o opt-in interrompe novas contribuições', async () => {
    const userId = randomUUID();
    await call(userId, 'PUT', '/privacy', { shareCrowd: true });
    expect((await call(userId, 'PUT', '/privacy', { shareCrowd: false })).body).toEqual({ shareCrowd: false });

    const before = rows(CROWD);
    await drive(userId);
    expect(rows(CROWD)).toEqual(before);
  });

  it('sem opt-in o usuário ainda usa o que os outros compartilharam', async () => {
    const sharer = randomUUID();
    await call(sharer, 'PUT', '/privacy', { shareCrowd: true });
    await drive(sharer);

    const userId = randomUUID();
    const { body: plan } = await call<PlanResponse>(userId, 'POST', '/plan', {
      origin: { lat: lat0, lon: lon0 },
      destination: { lat: lat1, lon: lon1 },
      timeZone: TZ,
    });
    const eta = plan.routes[0]!.eta;
    expect(rows(userId)).toEqual([]);
    expect(eta.durationS).toBeGreaterThan(eta.baseDurationS * 1.1);
  });

  it('valida o corpo e exige o identificador', async () => {
    expect((await call(randomUUID(), 'PUT', '/privacy', { shareCrowd: 'sim' })).status).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/privacy' })).statusCode).toBe(401);
  });
});
