import { cumulativeDistances, projectOnPolyline, type Coord } from '../geo';
import type { Route, TraceSample } from '../types';
import type { SegmentObservation } from './eta';

const MAX_OFFSET_M = 45;
const MAX_BACKTRACK_M = 25;
const MAX_GAP_S = 90;

export interface TraceAnalysis {
  observations: SegmentObservation[];
  /** Fração da rota coberta pelo rastro (0..1) */
  coverage: number;
  /** true se o rastro chegou a menos de 80 m do fim da rota */
  reachedEnd: boolean;
  firstT: number | null;
  lastT: number | null;
}

/**
 * Converte um rastro GPS em tempos observados por trecho.
 * Pontos fora da rota (desvio) ou recuos de GPS são descartados; o tempo de entrada
 * em cada borda de trecho é interpolado entre as amostras vizinhas.
 */
export function analyzeTrace(route: Route, samples: TraceSample[]): TraceAnalysis {
  const coords = route.geometry;
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1] ?? 0;
  const series: { t: number; d: number }[] = [];
  let idx = 0;

  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const p: Coord = [s.lon, s.lat];
    // Janela local primeiro (rápido); se falhar, busca global (ex.: GPS voltou após túnel).
    let proj = projectOnPolyline(coords, cum, p, idx - 5, idx + 60);
    if (proj.offsetM > MAX_OFFSET_M) proj = projectOnPolyline(coords, cum, p);
    const tolerance = MAX_OFFSET_M + Math.min(30, s.accuracy ?? 0);
    if (proj.offsetM > tolerance) continue;
    const last = series[series.length - 1];
    if (last && proj.alongM < last.d - MAX_BACKTRACK_M) continue;
    idx = proj.index;
    series.push({ t: s.t, d: last ? Math.max(last.d, proj.alongM) : proj.alongM });
  }

  const empty: TraceAnalysis = { observations: [], coverage: 0, reachedEnd: false, firstT: null, lastT: null };
  if (series.length < 2 || total === 0) return empty;

  const timeAt = (d: number): number | null => {
    if (d < series[0]!.d || d > series[series.length - 1]!.d) return null;
    let lo = 0;
    let hi = series.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (series[mid]!.d <= d) lo = mid;
      else hi = mid;
    }
    const a = series[lo]!;
    const b = series[hi]!;
    if ((b.t - a.t) / 1000 > MAX_GAP_S && b.d - a.d > 0) return null;
    // Parado no mesmo ponto: o instante de cruzamento é a última amostra parada.
    if (b.d === a.d) return b.t;
    return a.t + ((d - a.d) / (b.d - a.d)) * (b.t - a.t);
  };

  const observations: SegmentObservation[] = [];
  route.segments.forEach((seg, index) => {
    const t0 = timeAt(seg.startM);
    const t1 = timeAt(seg.endM);
    if (t0 === null || t1 === null || t1 <= t0) return;
    observations.push({ index, enteredAt: Math.round(t0), durationS: (t1 - t0) / 1000 });
  });

  const first = series[0]!;
  const last = series[series.length - 1]!;
  return {
    observations,
    coverage: (last.d - first.d) / total,
    reachedEnd: total - last.d < 80,
    firstT: first.t,
    lastT: last.t,
  };
}
