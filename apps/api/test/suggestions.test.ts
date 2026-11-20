import { randomBytes } from 'node:crypto';
import { BINS_PER_DAY, localTime, type Coord, type Suggestion } from '@wayboo/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { newPlace, saveRoutine, upsertPlace } from '../src/db';

const TZ = 'America/Sao_Paulo';
const HOME: Coord = [-46.65, -23.56];
const WORK: Coord = [-46.62, -23.59];

/** Polyline com precisão 6, o formato que o Valhalla devolve em `shape`. */
function encodePolyline(coords: Coord[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e6);
    const lo = Math.round(lon * 1e6);
    enc(la - prevLat);
    enc(lo - prevLon);
    prevLat = la;
    prevLon = lo;
  }
  return out;
}

const n = 40;
const shape = Array.from({ length: n + 1 }, (_, i): Coord => [HOME[0] + ((WORK[0] - HOME[0]) * i) / n, HOME[1] + ((WORK[1] - HOME[1]) * i) / n]);
const VALHALLA = {
  trip: {
    legs: [
      {
        shape: encodePolyline(shape),
        maneuvers: [
          { type: 1, street_names: ['Rua A'], length: 4.5, time: 400, begin_shape_index: 0, end_shape_index: n },
          { type: 4, length: 0, time: 0, begin_shape_index: n, end_shape_index: n },
        ],
      },
    ],
    summary: { length: 4.5, time: 400 },
  },
};

const routerCalls = vi.fn();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const defaults = { ...config.suggestions };
beforeEach(() => {
  routerCalls.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${config.valhallaUrl}/route`)) {
        routerCalls(url);
        return json(VALHALLA);
      }
      if (url.startsWith(config.openMeteoUrl)) return json({ current: { precipitation: 0, weather_code: 0, visibility: 10000 } });
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.assign(config.suggestions, defaults);
});

/** Usuário com casa, trabalho e o hábito de ir de casa ao trabalho em qualquer horário. */
async function commuter() {
  const token = randomBytes(32).toString('base64url');
  const { userId } = (await app.inject({ method: 'POST', url: '/auth/device', payload: { token } })).json<{ userId: string }>();
  const home = { ...newPlace(HOME[1], HOME[0]), kind: 'home' as const, visits: 10 };
  const work = { ...newPlace(WORK[1], WORK[0]), kind: 'work' as const, visits: 10 };
  upsertPlace(userId, home);
  upsertPlace(userId, work);
  const now = Date.now();
  saveRoutine(userId, { originId: home.id, destId: work.id, dayType: localTime(now, TZ).dayType, hist: Array(BINS_PER_DAY).fill(1), t: now });
  return async (here: Coord = HOME) => {
    const res = await app.inject({
      method: 'GET',
      url: `/suggestions?lat=${here[1]}&lon=${here[0]}`,
      headers: { authorization: `Bearer ${token}`, 'x-time-zone': TZ },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ suggestions: Suggestion[] }>().suggestions;
  };
}

describe('cache das sugestões de rotina', () => {
  it('duas aberturas seguidas no mesmo lugar chamam o roteador uma vez só', async () => {
    const open = await commuter();
    const first = await open();
    const second = await open();

    expect(routerCalls).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.plan.planId).not.toBe(first[0]!.plan.planId);
    expect(second[0]!.plan.routes[0]!.route.geometry).toEqual(first[0]!.plan.routes[0]!.route.geometry);
    expect(second[0]!.plan.routes[0]!.route.id).not.toBe(first[0]!.plan.routes[0]!.route.id);
  });

  it('cada usuário tem a própria rota guardada', async () => {
    await (await commuter())();
    await (await commuter())();
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });

  it('chama o roteador de novo quando a rota guardada passa da idade máxima', async () => {
    config.suggestions.routeMaxAgeMs = 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    const open = await commuter();
    await open();
    vi.advanceTimersByTime(30_000);
    await open();
    expect(routerCalls).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    await open();
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });

  it('chama o roteador de novo quando o usuário está longe da origem da rota guardada', async () => {
    config.suggestions.routeRadiusM = 50;
    const open = await commuter();
    await open();
    // ~110 m ao norte: ainda é "casa" (raio de 300 m), mas fora do raio da rota guardada.
    const nearby: Coord = [HOME[0], HOME[1] + 0.001];
    await open(nearby);
    expect(routerCalls).toHaveBeenCalledTimes(2);
    await open(nearby);
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });
});
