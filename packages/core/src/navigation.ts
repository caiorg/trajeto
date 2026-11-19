import type { PlanRequest, PlanResponse } from './api';
import { cumulativeDistances, haversine, projectOnPolyline, type Coord } from './geo';
import { spokenInstruction } from './instructions';
import type { LatLon, Maneuver, Route, RouteOptions } from './types';

export interface NavFix {
  t: number;
  lat: number;
  lon: number;
  /** m/s */
  speed?: number | null;
  heading?: number | null;
  accuracy?: number | null;
}

export interface NavState {
  alongM: number;
  remainingM: number;
  remainingS: number;
  arrivalAt: number;
  snapped: Coord;
  offsetM: number;
  nextManeuver: Maneuver | null;
  nextManeuverIndex: number;
  distanceToManeuverM: number;
  /** Manobra seguinte à próxima (para "depois, ..."). */
  thenManeuver: Maneuver | null;
  offRoute: boolean;
  arrived: boolean;
  currentStreet: string | null;
  /** Texto a falar agora, se houver */
  announcement: string | null;
  progress: number;
  /** Razão entre ritmo real e previsto até aqui (1 = no previsto). */
  paceRatio: number;
}

export interface NavigatorOptions {
  /** Duração prevista por trecho (ETA aprendido). Sem isso usa o tempo base. */
  segmentDurationsS?: number[];
  startedAt?: number;
}

export function createNavigator(route: Route, opts: NavigatorOptions = {}) {
  const coords = route.geometry;
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1] ?? 0;
  const segDur = opts.segmentDurationsS ?? route.segments.map((s) => s.baseDurationS);
  // Tempo previsto restante a partir do início de cada trecho (sufixo acumulado).
  const suffix = new Array<number>(segDur.length + 1).fill(0);
  for (let i = segDur.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + segDur[i]!;
  const maneuverStartM = route.maneuvers.map((m) => cum[m.beginIdx] ?? 0);

  let lastIdx = 0;
  let lastAlong = 0;
  let badFixes = 0;
  let startedAt = opts.startedAt ?? null;
  const spoken = new Set<string>();

  const predictedRemaining = (along: number): number => {
    const i = route.segments.findIndex((s) => along < s.endM);
    if (i < 0) return 0;
    const s = route.segments[i]!;
    const len = s.endM - s.startM;
    const frac = len > 0 ? (s.endM - along) / len : 0;
    return suffix[i + 1]! + segDur[i]! * Math.max(0, Math.min(1, frac));
  };

  function update(fix: NavFix): NavState {
    startedAt ??= fix.t;
    const p: Coord = [fix.lon, fix.lat];
    let proj = projectOnPolyline(coords, cum, p, lastIdx - 3, lastIdx + 80);
    if (proj.offsetM > 60) proj = projectOnPolyline(coords, cum, p);

    const tolerance = Math.max(35, (fix.accuracy ?? 10) * 1.5);
    badFixes = proj.offsetM > tolerance ? badFixes + 1 : 0;
    const offRoute = badFixes >= 3 || (proj.offsetM > 150 && (fix.accuracy ?? 10) < 30);

    // Evita que ruído de GPS faça o progresso voltar.
    const along = proj.offsetM <= tolerance ? Math.max(lastAlong - 15, proj.alongM) : lastAlong;
    if (proj.offsetM <= tolerance) {
      lastIdx = proj.index;
      lastAlong = along;
    }

    const remainingM = Math.max(0, total - along);
    const arrived = remainingM < 30 || (remainingM < 60 && (fix.speed ?? 5) < 2);

    // Ritmo real vs previsto: ajusta o restante de forma amortecida.
    const elapsedS = (fix.t - startedAt) / 1000;
    const predictedElapsed = suffix[0]! - predictedRemaining(along);
    const paceRatio =
      along > 800 && predictedElapsed > 60 ? Math.max(0.7, Math.min(1.8, elapsedS / predictedElapsed)) : 1;
    const remainingS = predictedRemaining(along) * (1 + (paceRatio - 1) * 0.5);

    const nextIdx = maneuverStartM.findIndex((m, i) => i > 0 && m > along + 3);
    const next = nextIdx >= 0 ? route.maneuvers[nextIdx]! : null;
    const distToManeuver = nextIdx >= 0 ? maneuverStartM[nextIdx]! - along : remainingM;
    const then = nextIdx >= 0 ? (route.maneuvers[nextIdx + 1] ?? null) : null;
    const current = route.maneuvers[nextIdx > 0 ? nextIdx - 1 : route.maneuvers.length - 1];

    let announcement: string | null = null;
    if (arrived) {
      if (!spoken.has('arrive')) {
        spoken.add('arrive');
        announcement = 'Você chegou ao destino';
      }
    } else if (!spoken.has('start')) {
      spoken.add('start');
      announcement = route.maneuvers[0] ? spokenInstruction(route.maneuvers[0], null) : null;
    } else if (next && !offRoute) {
      const v = Math.max(5, fix.speed ?? 10);
      const far = Math.max(300, v * 28);
      const near = Math.max(50, v * 6);
      if (distToManeuver <= near && !spoken.has(`${nextIdx}:near`)) {
        spoken.add(`${nextIdx}:near`).add(`${nextIdx}:far`);
        const thenText =
          then && maneuverStartM[nextIdx + 1]! - maneuverStartM[nextIdx]! < 120
            ? `, depois ${then.instruction.charAt(0).toLowerCase()}${then.instruction.slice(1)}`
            : '';
        announcement = `${next.instruction}${thenText}`;
      } else if (distToManeuver <= far && distToManeuver > near * 1.5 && !spoken.has(`${nextIdx}:far`)) {
        spoken.add(`${nextIdx}:far`);
        announcement = spokenInstruction(next, distToManeuver);
      }
    }

    return {
      alongM: along,
      remainingM,
      remainingS,
      arrivalAt: fix.t + remainingS * 1000,
      snapped: proj.point,
      offsetM: proj.offsetM,
      nextManeuver: next,
      nextManeuverIndex: nextIdx,
      distanceToManeuverM: Math.max(0, distToManeuver),
      thenManeuver: then,
      offRoute,
      arrived,
      currentStreet: current?.streetNames[0] ?? null,
      announcement,
      progress: total > 0 ? along / total : 1,
      paceRatio,
    };
  }

  return { update, totalM: total };
}

export type Navigator = ReturnType<typeof createNavigator>;

/** Parada intermediária da viagem (ex.: posto pedido ao copiloto). */
export interface TripStop extends LatLon {
  visited: boolean;
}

/** Pedido de replanejamento a partir da posição atual, mantendo destino e paradas pendentes. */
export function rerouteRequest(
  plan: Pick<PlanResponse, 'destination' | 'destinationName'>,
  fix: Pick<NavFix, 'lat' | 'lon'>,
  stops: TripStop[],
  options: RouteOptions,
): Omit<PlanRequest, 'timeZone'> {
  return {
    origin: { lat: fix.lat, lon: fix.lon },
    destination: plan.destination,
    destinationName: plan.destinationName ?? undefined,
    waypoints: stops.filter((s) => !s.visited).map(({ lat, lon }) => ({ lat, lon })),
    options,
    reroute: true,
  };
}

export const STOP_VISITED_RADIUS_M = 50;

/** Marca como visitadas as paradas a menos de `radiusM` da posição. Devolve o mesmo array se nada mudou. */
export function markVisitedStops(
  stops: TripStop[],
  fix: Pick<NavFix, 'lat' | 'lon'>,
  radiusM = STOP_VISITED_RADIUS_M,
): TripStop[] {
  let changed = false;
  const next = stops.map((s) => {
    if (s.visited || haversine([s.lon, s.lat], [fix.lon, fix.lat]) > radiusM) return s;
    changed = true;
    return { ...s, visited: true };
  });
  return changed ? next : stops;
}
