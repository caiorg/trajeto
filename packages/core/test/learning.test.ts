import { describe, expect, it } from 'vitest';
import {
  analyzeTrace,
  buildSegments,
  createNavigator,
  cumulativeDistances,
  decodePolyline,
  geohash,
  geohashCenter,
  haversine,
  inferKinds,
  learnFromTrip,
  localTime,
  matchPlace,
  predictEta,
  predictTrips,
  PRIOR_WEIGHTS,
  recordArrival,
  recordRoutine,
  routeFeatures,
  simulateDrive,
  tradeoffs,
  updatePreferences,
  type Coord,
  type Maneuver,
  type Place,
  type Route,
  type StatsMap,
  type TripContext,
} from '../src';

const TZ = 'America/Sao_Paulo';
const NO_CTX: TripContext = { rain: false, heavyRain: false, lowVisibility: false, alertsOnRoute: 0 };

/** Rota sintética em linha (com uma curva) a ~12 m/s. */
function makeRoute(id: string, from: Coord, to: Coord, opts: Partial<Route> = {}): Route {
  const n = 80;
  const mid: Coord = [(from[0] + to[0]) / 2 + 0.004, (from[1] + to[1]) / 2];
  const geometry: Coord[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const [a, b, g] = f < 0.5 ? [from, mid, f * 2] : [mid, to, (f - 0.5) * 2];
    geometry.push([a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g]);
  }
  const cum = cumulativeDistances(geometry);
  const half = n / 2;
  const m = (type: number, b: number, e: number, street: string): Maneuver => ({
    type,
    instruction: `${type === 15 ? 'Vire à esquerda' : 'Siga'} na ${street}`,
    streetNames: [street],
    distanceM: cum[e]! - cum[b]!,
    durationS: (cum[e]! - cum[b]!) / 12,
    beginIdx: b,
    endIdx: e,
    toll: false,
    highway: false,
  });
  const maneuvers = [m(1, 0, half, 'Rua A'), m(15, half, n, 'Rua B'), { ...m(4, n, n, ''), instruction: 'Você chegou' }];
  const distanceM = cum[n]!;
  return {
    id,
    geometry,
    distanceM,
    baseDurationS: distanceM / 12,
    maneuvers,
    hasToll: false,
    hasHighway: false,
    hasFerry: false,
    highwayShare: 0,
    segments: buildSegments(geometry, maneuvers),
    provider: 'test',
    ...opts,
  };
}

const HOME: Coord = [-46.65, -23.56];
const WORK: Coord = [-46.62, -23.6];

function at(dayOffset: number, hh: number, mm: number): number {
  // 2026-11-02 é segunda-feira; horário de Brasília = UTC-3.
  return Date.UTC(2026, 10, 2 + dayOffset, hh + 3, mm);
}

describe('geo', () => {
  it('decodifica polyline6 e geohash ida e volta', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)[0]).toEqual([-120.2, 38.5]);
    const h = geohash(-23.5614, -46.6559, 7);
    const c = geohashCenter(h);
    expect(haversine(c, [-46.6559, -23.5614])).toBeLessThan(120);
  });

  it('localTime respeita fuso e tipo de dia', () => {
    const lt = localTime(at(0, 8, 15), TZ);
    expect(lt).toMatchObject({ dayType: 'weekday', bin: 16, minuteOfDay: 495 });
    expect(localTime(at(5, 10, 0), TZ).dayType).toBe('saturday');
  });
});

describe('segmentos', () => {
  it('cobrem a rota inteira e somam o tempo base', () => {
    const r = makeRoute('r', HOME, WORK);
    const last = r.segments[r.segments.length - 1]!;
    expect(r.segments[0]!.startM).toBe(0);
    expect(last.endM).toBeCloseTo(r.distanceM, 3);
    const sum = r.segments.reduce((a, s) => a + s.baseDurationS, 0);
    expect(sum).toBeCloseTo(r.baseDurationS, 0);
    expect(r.segments.length).toBeGreaterThan(20);
  });

  it('gera chaves iguais para rotas que compartilham a mesma via', () => {
    const a = makeRoute('a', HOME, WORK);
    const b = makeRoute('b', HOME, WORK);
    expect(a.segments.map((s) => s.key)).toEqual(b.segments.map((s) => s.key));
  });
});

describe('rastro → observações', () => {
  it('recupera a duração real de cada trecho a partir do GPS', () => {
    const r = makeRoute('r', HOME, WORK);
    const truth = r.segments.map((s, i) => s.baseDurationS * (i % 3 === 0 ? 2 : 1));
    const samples = [...simulateDrive(r, truth, at(0, 8, 0), 1, 4, mulberry(1))];
    const a = analyzeTrace(r, samples);
    expect(a.reachedEnd).toBe(true);
    expect(a.coverage).toBeGreaterThan(0.95);
    const long = a.observations.filter((o) => r.segments[o.index]!.baseDurationS > 8);
    expect(long.length).toBeGreaterThan(10);
    for (const o of long) expect(Math.abs(o.durationS - truth[o.index]!)).toBeLessThan(3);
  });
});

describe('ETA aprendido', () => {
  it('converge para o trânsito real do horário de pico ao longo das semanas', () => {
    const r = makeRoute('r', HOME, WORK);
    const rnd = mulberry(7);
    const user: StatsMap = new Map();
    const crowd: StatsMap = new Map();
    // Trânsito real: trechos do meio 2,2x mais lentos às 8h; resto 1,3x.
    const truthAt = (i: number) => (i > r.segments.length * 0.4 && i < r.segments.length * 0.7 ? 2.2 : 1.3);
    const errors: number[] = [];
    const baseErrors: number[] = [];
    let day = 0;
    for (let trip = 0; trip < 20; trip++) {
      while (localTime(at(day, 8, 0), TZ).dayType !== 'weekday') day++;
      const depart = at(day, 7 + Math.floor(rnd() * 2), Math.floor(rnd() * 60) % 30 + 30 * Math.floor(rnd() * 2));
      const truth = r.segments.map((s, i) => s.baseDurationS * truthAt(i) * (0.9 + rnd() * 0.2));
      const actual = truth.reduce((a, b) => a + b, 0);
      const pred = predictEta({ route: r, departAt: depart, timeZone: TZ, user, crowd, ctx: NO_CTX });
      errors.push(Math.abs(pred.durationS - actual) / actual);
      baseErrors.push(Math.abs(r.baseDurationS - actual) / actual);
      const trace = analyzeTrace(r, [...simulateDrive(r, truth, depart, 1, 3, rnd)]);
      const learned = learnFromTrip({
        route: r,
        observations: trace.observations,
        departAt: depart,
        timeZone: TZ,
        user,
        crowd,
        ctx: NO_CTX,
        odKey: 'od|home|work',
        actualTotalS: actual,
      });
      for (const [k, v] of learned.user) user.set(k, v);
      for (const [k, v] of learned.crowd) crowd.set(k, v);
      day++;
    }
    const first = errors[0]!;
    const lastFive = errors.slice(-5).reduce((a, b) => a + b, 0) / 5;
    expect(first).toBeCloseTo(baseErrors[0]!, 5);
    expect(first).toBeGreaterThan(0.3);
    expect(lastFive).toBeLessThan(0.06);

    // Confiança sobe; fora do horário aprendido (madrugada de domingo) o modelo não inventa trânsito local.
    const peak = predictEta({ route: r, departAt: at(day, 8, 0), timeZone: TZ, user, crowd, ctx: NO_CTX });
    expect(peak.confidence).toBeGreaterThan(0.6);
    expect(peak.p10S).toBeLessThan(peak.durationS);
    expect(peak.p90S).toBeGreaterThan(peak.durationS);
  });

  it('aprende o efeito da chuva a partir do resíduo das viagens', () => {
    const r = makeRoute('r', HOME, WORK);
    const user: StatsMap = new Map();
    const crowd: StatsMap = new Map();
    const rainy: TripContext = { ...NO_CTX, rain: true };
    for (let d = 0; d < 8; d++) {
      const depart = at(d, 14, 0);
      const actual = r.baseDurationS * 1.35;
      const learned = learnFromTrip({
        route: r,
        observations: [],
        departAt: depart,
        timeZone: TZ,
        user,
        crowd,
        ctx: rainy,
        actualTotalS: actual,
      });
      for (const [k, v] of learned.user) user.set(k, v);
    }
    const dry = predictEta({ route: r, departAt: at(9, 14, 0), timeZone: TZ, user, crowd, ctx: NO_CTX });
    const wet = predictEta({ route: r, departAt: at(9, 14, 0), timeZone: TZ, user, crowd, ctx: rainy });
    expect(wet.durationS / dry.durationS).toBeGreaterThan(1.25);
    expect(wet.factors.some((f) => f.label === 'Chuva')).toBe(true);
  });
});

describe('preferências', () => {
  it('aprende que o usuário evita pedágio mesmo perdendo alguns minutos', () => {
    const toll = makeRoute('t', HOME, WORK, { hasToll: true });
    const free = makeRoute('f', HOME, WORK);
    const etaOf = (route: Route, s: number) => ({
      route,
      eta: { durationS: s, p10S: s * 0.9, p90S: s * 1.1, baseDurationS: s, confidence: 0, factors: [], segmentDurationsS: [] },
      familiarity: 0,
      alerts: 0,
    });
    let w = { ...PRIOR_WEIGHTS };
    for (let i = 0; i < 30; i++) {
      const f = routeFeatures([etaOf(toll, 1500), etaOf(free, 1500 + 60 * (3 + (i % 5)))]);
      w = updatePreferences(w, f, 1);
    }
    const tollTradeoff = tradeoffs(w).find((t) => t.feature === 'toll')!;
    expect(tollTradeoff.minutesPerUnit).toBeGreaterThan(5);
  });
});

describe('rotinas', () => {
  it('identifica casa e trabalho e prevê a ida ao trabalho de manhã', () => {
    let places: Place[] = [
      { id: 'h', lat: HOME[1], lon: HOME[0], name: null, kind: 'other', pinned: false, visits: 0, homeScore: 0, workScore: 0 },
      { id: 'w', lat: WORK[1], lon: WORK[0], name: null, kind: 'other', pinned: false, visits: 0, homeScore: 0, workScore: 0 },
    ];
    let routine;
    for (let d = 0; d < 10; d++) {
      places = places.map((p) =>
        p.id === 'w' ? recordArrival(p, WORK[1], WORK[0], localTime(at(d, 8, 40), TZ)) : recordArrival(p, HOME[1], HOME[0], localTime(at(d, 18, 50), TZ)),
      );
      routine = recordRoutine(routine, { originId: 'h', destId: 'w', dayType: 'weekday' }, localTime(at(d, 8, 0), TZ), at(d, 8, 0));
    }
    places = inferKinds(places);
    expect(places.find((p) => p.id === 'h')!.kind).toBe('home');
    expect(places.find((p) => p.id === 'w')!.kind).toBe('work');
    expect(matchPlace(places, HOME[1] + 0.001, HOME[0])?.id).toBe('h');
    const pred = predictTrips([routine!], 'h', localTime(at(14, 7, 45), TZ), at(14, 7, 45));
    expect(pred[0]?.destId).toBe('w');
    expect(pred[0]!.probability).toBeGreaterThan(0.7);
    expect(predictTrips([routine!], 'h', localTime(at(14, 15, 0), TZ), at(14, 15, 0))).toHaveLength(0);
  });
});

describe('navegação', () => {
  it('anuncia manobras, detecta chegada e desvio', () => {
    const r = makeRoute('r', HOME, WORK);
    const nav = createNavigator(r);
    const said: string[] = [];
    let last;
    for (const fix of simulateDrive(r, r.segments.map((s) => s.baseDurationS), at(0, 9, 0), 1)) {
      last = nav.update(fix);
      if (last.announcement) said.push(last.announcement);
    }
    expect(said[0]).toContain('Siga');
    expect(said.some((s) => s.startsWith('Em ') && s.includes('vire à esquerda'))).toBe(true);
    expect(said.some((s) => s.startsWith('Vire à esquerda'))).toBe(true);
    expect(said[said.length - 1]).toBe('Você chegou ao destino');
    expect(last!.arrived).toBe(true);

    const nav2 = createNavigator(r);
    nav2.update({ t: 1, lat: HOME[1], lon: HOME[0], accuracy: 5 });
    let s;
    for (let i = 0; i < 3; i++) s = nav2.update({ t: 2 + i, lat: HOME[1] + 0.003, lon: HOME[0] - 0.003, accuracy: 5 });
    expect(s!.offRoute).toBe(true);
  });
});

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
