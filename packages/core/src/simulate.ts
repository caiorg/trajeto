import { bearing, cumulativeDistances, pointAlong } from './geo';
import type { NavFix } from './navigation';
import type { Route } from './types';

/**
 * Gera fixes de GPS percorrendo a rota com a duração indicada por trecho.
 * Usado no modo "Simular" do app e na geração de histórico sintético.
 */
export function* simulateDrive(
  route: Route,
  segmentDurationsS: number[],
  startAt: number,
  stepS = 1,
  jitterM = 0,
  random: () => number = Math.random,
): Generator<NavFix> {
  const cum = cumulativeDistances(route.geometry);
  let t = 0;
  for (let i = 0; i < route.segments.length; i++) {
    const s = route.segments[i]!;
    const dur = Math.max(0.5, segmentDurationsS[i] ?? s.baseDurationS);
    const speed = (s.endM - s.startM) / dur;
    for (let local = 0; local < dur; local += stepS) {
      const d = s.startM + speed * local;
      const p = pointAlong(route.geometry, cum, d);
      const ahead = pointAlong(route.geometry, cum, d + 10);
      const j = () => ((random() - 0.5) * 2 * jitterM) / 111_320;
      yield {
        t: startAt + Math.round((t + local) * 1000),
        lat: p[1] + j(),
        lon: p[0] + j(),
        speed,
        heading: bearing(p, ahead),
        accuracy: Math.max(5, jitterM),
      };
    }
    t += dur;
  }
  const end = route.geometry[route.geometry.length - 1]!;
  yield { t: startAt + Math.round(t * 1000), lat: end[1], lon: end[0], speed: 0, heading: null, accuracy: 5 };
}
