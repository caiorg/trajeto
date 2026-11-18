import { haversine } from '../geo';
import type { DayType } from '../types';
import { BIN_MINUTES, BINS_PER_DAY, DEFAULT_HALF_LIFE_DAYS, type LocalTime } from './stats';

export type PlaceKind = 'home' | 'work' | 'other';

export interface Place {
  id: string;
  lat: number;
  lon: number;
  name: string | null;
  kind: PlaceKind;
  /** Rótulo definido pelo usuário (tem prioridade sobre a inferência). */
  pinned: boolean;
  visits: number;
  homeScore: number;
  workScore: number;
}

export const PLACE_RADIUS_M = 220;

export function matchPlace(places: Place[], lat: number, lon: number, radiusM = PLACE_RADIUS_M): Place | null {
  let best: Place | null = null;
  let bestD = radiusM;
  for (const p of places) {
    const d = haversine([p.lon, p.lat], [lon, lat]);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Registra uma chegada: move o centróide e acumula indícios de casa/trabalho. */
export function recordArrival(place: Place, lat: number, lon: number, at: LocalTime): Place {
  const visits = place.visits + 1;
  const h = at.minuteOfDay / 60;
  const homeHint = h >= 17 || h < 2 ? 1 : at.dayType !== 'weekday' && h >= 12 ? 0.3 : 0;
  const workHint = at.dayType === 'weekday' && h >= 6 && h < 11 ? 1 : 0;
  return {
    ...place,
    lat: place.lat + (lat - place.lat) / visits,
    lon: place.lon + (lon - place.lon) / visits,
    visits,
    homeScore: place.homeScore + homeHint,
    workScore: place.workScore + workHint,
  };
}

/** Saídas de manhã em dia útil indicam casa; saídas no fim da tarde indicam trabalho. */
export function recordDeparture(place: Place, at: LocalTime): Place {
  const h = at.minuteOfDay / 60;
  if (at.dayType !== 'weekday') return place;
  if (h >= 5 && h < 10) return { ...place, homeScore: place.homeScore + 0.7 };
  if (h >= 16 && h < 20) return { ...place, workScore: place.workScore + 0.7 };
  return place;
}

export function inferKinds(places: Place[]): Place[] {
  const free = places.filter((p) => !p.pinned);
  const pinnedHome = places.some((p) => p.pinned && p.kind === 'home');
  const pinnedWork = places.some((p) => p.pinned && p.kind === 'work');
  const home = pinnedHome ? null : [...free].sort((a, b) => b.homeScore - a.homeScore).find((p) => p.homeScore >= 2);
  const work = pinnedWork
    ? null
    : [...free].filter((p) => p !== home).sort((a, b) => b.workScore - a.workScore).find((p) => p.workScore >= 2);
  return places.map((p) => {
    if (p.pinned) return p;
    const kind: PlaceKind = p === home ? 'home' : p === work ? 'work' : 'other';
    return { ...p, kind };
  });
}

export const PLACE_KIND_LABEL: Record<PlaceKind, string> = { home: 'Casa', work: 'Trabalho', other: 'Lugar frequente' };

// ---------- rotinas origem → destino ----------

export interface Routine {
  originId: string;
  destId: string;
  dayType: DayType;
  /** Histograma de horários de saída (48 bins de 30 min) com decaimento. */
  hist: number[];
  t: number;
}

const decayFactor = (from: number, to: number) => 0.5 ** (Math.max(0, to - from) / (DEFAULT_HALF_LIFE_DAYS * 86_400_000));

export function recordRoutine(r: Routine | undefined, key: Omit<Routine, 'hist' | 't'>, at: LocalTime, now: number): Routine {
  const f = r ? decayFactor(r.t, now) : 1;
  const hist = r ? r.hist.map((v) => v * f) : new Array<number>(BINS_PER_DAY).fill(0);
  hist[at.bin] = (hist[at.bin] ?? 0) + 1;
  hist[(at.bin + 1) % BINS_PER_DAY] = (hist[(at.bin + 1) % BINS_PER_DAY] ?? 0) + 0.3;
  hist[(at.bin - 1 + BINS_PER_DAY) % BINS_PER_DAY] = (hist[(at.bin - 1 + BINS_PER_DAY) % BINS_PER_DAY] ?? 0) + 0.3;
  return { ...key, hist, t: now };
}

export interface TripPrediction {
  destId: string;
  probability: number;
  /** Horário típico de saída (minuto do dia) */
  typicalDepartureMin: number;
  /** Força da evidência (peso decaído no horário atual) */
  support: number;
}

/**
 * Prevê para onde o usuário vai agora a partir de `originId`.
 * Considera o histograma de saídas numa janela de ±90 min do horário atual.
 */
export function predictTrips(routines: Routine[], originId: string, at: LocalTime, now: number): TripPrediction[] {
  const window = Math.round(90 / BIN_MINUTES);
  const scored = routines
    .filter((r) => r.originId === originId && r.dayType === at.dayType && r.destId !== originId)
    .map((r) => {
      const f = decayFactor(r.t, now);
      let support = 0;
      for (let k = -window; k <= window; k++) {
        const b = (at.bin + k + BINS_PER_DAY) % BINS_PER_DAY;
        support += (r.hist[b] ?? 0) * f * (1 - Math.abs(k) / (window + 1));
      }
      const peak = r.hist.reduce((best, v, i) => (v > (r.hist[best] ?? 0) ? i : best), 0);
      return { destId: r.destId, support, typicalDepartureMin: peak * BIN_MINUTES + BIN_MINUTES / 2 };
    })
    .filter((s) => s.support > 0.5);
  const total = scored.reduce((a, s) => a + s.support, 0) + 1; // +1: chance de ser uma viagem nova
  return scored
    .map((s) => ({ ...s, probability: s.support / total }))
    .sort((a, b) => b.probability - a.probability);
}
