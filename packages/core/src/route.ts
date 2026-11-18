import { cumulativeDistances, geohash, pointAlong, type Coord } from './geo';
import type { Maneuver, RouteSegment } from './types';

const CELL_PRECISION = 7;
const PROBE_STEP_M = 15;

/** Tempo acumulado (s) em cada vértice, distribuindo o tempo de cada manobra pelo seu comprimento. */
export function vertexTimes(geometry: Coord[], cum: number[], maneuvers: Maneuver[]): number[] {
  const times = new Array<number>(geometry.length).fill(0);
  let t = 0;
  for (const m of maneuvers) {
    const len = cum[m.endIdx]! - cum[m.beginIdx]!;
    for (let i = m.beginIdx + 1; i <= m.endIdx; i++) {
      const edge = cum[i]! - cum[i - 1]!;
      t += len > 0 ? (m.durationS * edge) / len : 0;
      times[i] = t;
    }
  }
  return times;
}

export function timeAtDistance(cum: number[], times: number[], alongM: number): number {
  if (alongM <= 0) return 0;
  const last = cum.length - 1;
  if (alongM >= cum[last]!) return times[last]!;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= alongM) lo = mid;
    else hi = mid;
  }
  const span = cum[hi]! - cum[lo]!;
  const f = span === 0 ? 0 : (alongM - cum[lo]!) / span;
  return times[lo]! + f * (times[hi]! - times[lo]!);
}

const cellAt = (geometry: Coord[], cum: number[], d: number) => {
  const p = pointAlong(geometry, cum, d);
  return geohash(p[1], p[0], CELL_PRECISION);
};

/**
 * Divide a rota nos pontos em que ela cruza bordas de células geohash-7.
 * Bordas de célula são geográficas, então duas rotas que passam pela mesma rua,
 * no mesmo sentido, geram as mesmas chaves e compartilham o que foi aprendido.
 */
export function buildSegments(geometry: Coord[], maneuvers: Maneuver[]): RouteSegment[] {
  if (geometry.length < 2) return [];
  const cum = cumulativeDistances(geometry);
  const total = cum[cum.length - 1]!;
  const times = vertexTimes(geometry, cum, maneuvers);

  const runs: { cell: string; startM: number; endM: number }[] = [];
  let current = cellAt(geometry, cum, 0);
  let runStart = 0;
  let prevD = 0;
  for (let d = PROBE_STEP_M; ; d += PROBE_STEP_M) {
    const probe = Math.min(d, total);
    const cell = cellAt(geometry, cum, probe);
    if (cell !== current) {
      // Busca binária do ponto exato de troca de célula.
      let lo = prevD;
      let hi = probe;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (cellAt(geometry, cum, mid) === current) lo = mid;
        else hi = mid;
      }
      runs.push({ cell: current, startM: runStart, endM: hi });
      current = cell;
      runStart = hi;
    }
    prevD = probe;
    if (probe >= total) break;
  }
  runs.push({ cell: current, startM: runStart, endM: total });

  return runs.map((r, i) => ({
    key: `${runs[i - 1]?.cell ?? '^'}>${r.cell}>${runs[i + 1]?.cell ?? '$'}`,
    startM: r.startM,
    endM: r.endM,
    baseDurationS: timeAtDistance(cum, times, r.endM) - timeAtDistance(cum, times, r.startM),
  }));
}
