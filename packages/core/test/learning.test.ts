import { describe, expect, it } from 'vitest';
import {
  analyzeTrace,
  buildSegments,
  createNavigator,
  cumulativeDistances,
  brazilNationalHolidays,
  decodePolyline,
  easterSunday,
  geohash,
  geohashCenter,
  haversine,
  inferKinds,
  learnFromTrip,
  localTime,
  markVisitedStops,
  matchPlace,
  predictEta,
  predictTrips,
  PRIOR_WEIGHTS,
  recordArrival,
  recordRoutine,
  rerouteRequest,
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
  type TripStop,
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
    const lt = localTime(at(1, 8, 15), TZ);
    expect(lt).toMatchObject({ dayType: 'weekday', bin: 16, minuteOfDay: 495, holiday: null });
    expect(lt).toMatchObject({ year: 2026, month: 11, day: 3 });
    expect(localTime(at(5, 10, 0), TZ).dayType).toBe('saturday');
  });
});

describe('feriados', () => {
  const ymd = (d: { year: number; month: number; day: number }) =>
    `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

  it('calcula a Páscoa', () => {
    const cases: [number, string][] = [
      [2024, '2024-03-31'],
      [2025, '2025-04-20'],
      [2026, '2026-04-05'],
      [2027, '2027-03-28'],
      [2038, '2038-04-25'],
      [2285, '2285-03-22'],
    ];
    for (const [year, expected] of cases) expect(ymd(easterSunday(year))).toBe(expected);
  });

  it('lista os feriados nacionais, fixos e móveis', () => {
    const list = brazilNationalHolidays(2026).map((h) => `${ymd(h.date)} ${h.name}`);
    expect(list).toEqual([
      '2026-01-01 Confraternização Universal',
      '2026-02-16 Carnaval',
      '2026-02-17 Carnaval',
      '2026-04-03 Sexta-feira Santa',
      '2026-04-21 Tiradentes',
      '2026-05-01 Dia do Trabalho',
      '2026-06-04 Corpus Christi',
      '2026-09-07 Independência do Brasil',
      '2026-10-12 Nossa Senhora Aparecida',
      '2026-11-02 Finados',
      '2026-11-15 Proclamação da República',
      '2026-11-20 Dia Nacional de Zumbi e da Consciência Negra',
      '2026-12-25 Natal',
    ]);
    // Consciência Negra virou feriado nacional em 2024 (Lei 14.759/2023).
    expect(brazilNationalHolidays(2023).some((h) => h.date.month === 11 && h.date.day === 20)).toBe(false);
  });

  it('localTime trata feriado como domingo, no dia local do fuso', () => {
    // 2026-11-02 (Finados) é segunda.
    const finados = localTime(at(0, 8, 0), TZ);
    expect(finados).toMatchObject({ dow: 1, dayType: 'sunday', holiday: 'Finados' });
    // 23h30 de 01/11 em Brasília já é 02/11 em UTC; ainda não é feriado no fuso local.
    expect(localTime(at(-1, 23, 30), TZ)).toMatchObject({ dayType: 'sunday', holiday: null });
    expect(localTime(at(1, 0, 30), TZ)).toMatchObject({ dayType: 'weekday', holiday: null });
  });

  it('só aplica o calendário brasileiro em fusos do Brasil e aceita calendário próprio', () => {
    expect(localTime(at(0, 8, 0), 'America/New_York').holiday).toBeNull();
    expect(localTime(at(0, 8, 0), 'America/Manaus').holiday).toBe('Finados');
    // Intl aceita o fuso sem diferenciar maiúsculas; o calendário também precisa aceitar.
    expect(localTime(at(0, 8, 0), 'america/sao_paulo')).toMatchObject({ dayType: 'sunday', holiday: 'Finados' });
    expect(localTime(at(0, 8, 0), 'america/new_york').holiday).toBeNull();
    // Ponto de extensão para feriados estaduais e municipais.
    const sp = (d: { month: number; day: number }) => (d.month === 1 && d.day === 25 ? 'Aniversário de São Paulo' : null);
    const lt = localTime(Date.UTC(2027, 0, 25, 11, 0), TZ, sp);
    expect(lt).toMatchObject({ dow: 1, dayType: 'sunday', holiday: 'Aniversário de São Paulo' });
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

  it('num feriado de segunda, o ETA de pico segue o padrão de domingo, não o de dia útil', () => {
    const r = makeRoute('r', HOME, WORK);
    const rnd = mulberry(11);
    const user: StatsMap = new Map();
    const crowd: StatsMap = new Map();
    const drive = (depart: number, factor: number) => {
      const truth = r.segments.map((s) => s.baseDurationS * factor * (0.95 + rnd() * 0.1));
      const trace = analyzeTrace(r, [...simulateDrive(r, truth, depart, 1, 3, rnd)]);
      const learned = learnFromTrip({ route: r, observations: trace.observations, departAt: depart, timeZone: TZ, user, crowd, ctx: NO_CTX });
      for (const [k, v] of learned.user) user.set(k, v);
      for (const [k, v] of learned.crowd) crowd.set(k, v);
    };
    // Quatro semanas de janeiro/2027: pico 2x nos dias úteis, trânsito livre aos domingos.
    const jan = (day: number, hh: number) => Date.UTC(2027, 0, day, hh + 3, 0);
    for (let day = 4; day <= 31; day++) {
      const lt = localTime(jan(day, 8), TZ);
      if (lt.dayType === 'weekday') drive(jan(day, 8), 2);
      else if (lt.dayType === 'sunday') drive(jan(day, 8), 1);
    }
    const peak = (epoch: number) => predictEta({ route: r, departAt: epoch, timeZone: TZ, user, crowd, ctx: NO_CTX });
    const carnavalAt = Date.UTC(2027, 1, 8, 11, 0);
    expect(localTime(carnavalAt, TZ)).toMatchObject({ dow: 1, dayType: 'sunday', holiday: 'Carnaval' });
    const monday = peak(Date.UTC(2027, 1, 1, 11, 0));
    const sunday = peak(Date.UTC(2027, 1, 7, 11, 0));
    const carnaval = peak(carnavalAt);
    expect(monday.durationS / r.baseDurationS).toBeGreaterThan(1.8);
    expect(carnaval.durationS).toBeLessThan(monday.durationS * 0.7);
    expect(carnaval.durationS / sunday.durationS).toBeCloseTo(1, 1);
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

  it('recálculo mantém paradas pendentes e descarta as visitadas', () => {
    const plan = { destination: { lat: WORK[1], lon: WORK[0] }, destinationName: 'Trabalho' };
    const opts = { avoidTolls: false, avoidHighways: false, avoidFerries: false };
    const posto = { lat: -23.58, lon: -46.64 };
    const farmacia = { lat: -23.59, lon: -46.63 };
    let stops: TripStop[] = [posto, farmacia].map((p) => ({ ...p, visited: false }));

    // Longe das paradas: nada muda e o recálculo ainda passa pelas duas.
    const far = { lat: HOME[1], lon: HOME[0] };
    expect(markVisitedStops(stops, far)).toBe(stops);
    const before = rerouteRequest(plan, far, stops, opts);
    expect(before.origin).toEqual(far);
    expect(before.destination).toEqual(plan.destination);
    expect(before.reroute).toBe(true);
    expect(before.waypoints).toEqual([posto, farmacia]);

    // ~30 m do posto marca como visitado; ~80 m da farmácia ainda não.
    stops = markVisitedStops(stops, { lat: posto.lat + 0.00027, lon: posto.lon });
    stops = markVisitedStops(stops, { lat: farmacia.lat + 0.00072, lon: farmacia.lon });
    expect(stops.map((x) => x.visited)).toEqual([true, false]);
    expect(rerouteRequest(plan, far, stops, opts).waypoints).toEqual([farmacia]);

    // Parada visitada não volta, mesmo longe dela.
    stops = markVisitedStops(stops, far);
    expect(rerouteRequest(plan, far, stops, opts).waypoints).toEqual([farmacia]);
  });

  it('recálculo não volta para parada pulada', () => {
    const plan = { destination: { lat: WORK[1], lon: WORK[0] }, destinationName: 'Trabalho' };
    const opts = { avoidTolls: false, avoidHighways: false, avoidFerries: false };
    const a = { lat: -23.58, lon: -46.64 };
    const b = { lat: -23.59, lon: -46.63 };
    let stops: TripStop[] = [a, b].map((p) => ({ ...p, visited: false }));

    // Passa por B sem passar por A e depois sai da rota.
    stops = markVisitedStops(stops, { lat: b.lat + 0.00027, lon: b.lon });
    const offRoute = { lat: HOME[1], lon: HOME[0] };
    stops = markVisitedStops(stops, offRoute);
    expect(rerouteRequest(plan, offRoute, stops, opts).waypoints).toEqual([]);
  });

  it('recálculo não volta para a última parada pulada', () => {
    const r = makeRoute('r', HOME, WORK);
    const plan = { destination: { lat: WORK[1], lon: WORK[0] }, destinationName: 'Trabalho' };
    const opts = { avoidTolls: false, avoidHighways: false, avoidFerries: false };
    const ll = ([lon, lat]: Coord) => ({ lat, lon });
    const a = ll(r.geometry[20]!);
    const b = ll(r.geometry[60]!);
    let stops: TripStop[] = [a, b].map((p) => ({ ...p, visited: false }));
    const nav = createNavigator(r);

    // Segue a rota, passa por A e nunca chega a menos de 100 m de B.
    let t = 0;
    for (const p of r.geometry.slice(0, 77)) {
      if (haversine(p, [b.lon, b.lat]) < 100) continue;
      const fix = { t: (t += 5000), lat: p[1], lon: p[0], accuracy: 5 };
      stops = markVisitedStops(stops, fix, { alongM: nav.update(fix).alongM, project: nav.project, lastWithin: nav.lastWithin });
      if (t === 5000 * 30) expect(stops.map((s) => s.visited)).toEqual([true, false]);
    }

    // Sai da rota perto do destino: o recálculo vai direto para ele.
    const offRoute = { t: (t += 5000), lat: WORK[1] + 0.002, lon: WORK[0] + 0.002, accuracy: 5 };
    stops = markVisitedStops(stops, offRoute, { alongM: nav.update(offRoute).alongM, project: nav.project, lastWithin: nav.lastWithin });
    expect(rerouteRequest(plan, offRoute, stops, opts).waypoints).toEqual([]);
  });

  it('avanço não marca parada cuja posição a rota cruza antes da passagem dela', () => {
    // Vai 2 km para leste até A, volta 1 km até B (cruzada na ida) e segue 1 km para o norte.
    const [x0, y0] = HOME;
    const east = 0.009813;
    const north = 0.008993;
    const geometry: Coord[] = [];
    for (let i = 0; i <= 40; i++) geometry.push([x0 + (east * 2 * i) / 40, y0]);
    for (let i = 1; i <= 20; i++) geometry.push([x0 + east * (2 - i / 20), y0]);
    for (let i = 1; i <= 20; i++) geometry.push([x0 + east, y0 + (north * i) / 20]);
    const nav = createNavigator({ ...makeRoute('r', HOME, WORK), geometry });
    const a = { lat: y0, lon: x0 + 2 * east };
    const b = { lat: y0, lon: x0 + east };
    let stops: TripStop[] = [a, b].map((p) => ({ ...p, visited: false }));

    // Na ida, uma falha de GPS pula de 200 m antes de B para 150 m depois dele.
    for (const [i, km] of [0, 0.2, 0.4, 0.6, 0.8, 1.15].entries()) {
      const fix = { t: i * 5000, lat: y0, lon: x0 + east * km, accuracy: 5 };
      stops = markVisitedStops(stops, fix, { alongM: nav.update(fix).alongM, project: nav.project, lastWithin: nav.lastWithin });
    }
    expect(stops.map((s) => s.visited)).toEqual([false, false]);
  });

  it('avanço marca duas paradas puladas no mesmo trecho longo', () => {
    // Um único trecho de 2 km para leste, com A a 0,5 km e B a 1,5 km.
    const [x0, y0] = HOME;
    const east = 0.009813;
    const geometry: Coord[] = [HOME, [x0 + 2 * east, y0]];
    const nav = createNavigator({ ...makeRoute('r', HOME, WORK), geometry });
    let stops: TripStop[] = [0.5, 1.5].map((km) => ({ lat: y0, lon: x0 + east * km, visited: false }));

    const fix = { t: 0, lat: y0, lon: x0 + east * 1.8, accuracy: 5 };
    stops = markVisitedStops(stops, fix, { alongM: nav.update(fix).alongM, project: nav.project, lastWithin: nav.lastWithin });
    expect(stops.map((s) => s.visited)).toEqual([true, true]);
  });

  it('avanço não marca parada antes de um retorno curto que volta a ela', () => {
    // Passa pela parada (200 m), faz retorno em U a 340 m, volta a ela (480 m) e termina a 490 m.
    const [x0, y0] = HOME;
    const m = 0.009813 / 1000;
    const geometry: Coord[] = [HOME, [x0 + 340 * m, y0], [x0 + 190 * m, y0]];
    const nav = createNavigator({ ...makeRoute('r', HOME, WORK), geometry });
    let stops: TripStop[] = [{ lat: y0, lon: x0 + 200 * m, visited: false }];

    // Falha de GPS: o fix seguinte já está 120 m depois da parada, antes do retorno.
    const fix = { t: 0, lat: y0, lon: x0 + 320 * m, accuracy: 5 };
    stops = markVisitedStops(stops, fix, { alongM: nav.update(fix).alongM, project: nav.project, lastWithin: nav.lastWithin });
    expect(stops[0]!.visited).toBe(false);
  });
  it('avanço marca parada logo antes de um vértice da rota', () => {
    // No equador, a parada fica a 111 m e o vértice seguinte 40 m depois dela.
    const geometry: Coord[] = [[-0.001, 0], [0.00036, 0], [0.001, 0]];
    const nav = createNavigator({ ...makeRoute('r', HOME, WORK), geometry });
    let stops: TripStop[] = [{ lat: 0, lon: 0, visited: false }];

    // ~60 m depois da parada: já passou do raio de 50 m.
    const fix = { t: 0, lat: 0, lon: 0.00054, accuracy: 5 };
    stops = markVisitedStops(stops, fix, { alongM: nav.update(fix).alongM, project: nav.project, lastWithin: nav.lastWithin });
    expect(stops[0]!.visited).toBe(true);
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
