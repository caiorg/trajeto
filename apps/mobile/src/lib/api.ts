import type {
  AssistantResponse,
  Brief,
  FinishTripResponse,
  Insights,
  LatLon,
  PlanRequest,
  PlanResponse,
  Privacy,
  RoadAlert,
  Suggestion,
  TraceSample,
} from '@wayboo/core';
import { timeZone, useSettings } from './store';

export interface GeocodeResult {
  name: string;
  label: string;
  lat: number;
  lon: number;
  category: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

async function send<T>(method: Method, path: string, body: unknown, timeoutMs: number, token: string | null): Promise<T> {
  const { apiUrl } = useSettings.getState();
  // AbortSignal.timeout não existe em todas as versões do Hermes.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-time-zone': timeZone(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, `Sem conexão com o servidor (${apiUrl}). Confira a URL em Ajustes.`);
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Erro ${res.status}`);
  return data as T;
}

/** O AsyncStorage carrega depois do primeiro render; sem esperar, o app registraria um usuário novo. */
function hydrated(): Promise<void> {
  if (useSettings.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useSettings.persist.onFinishHydration(() => {
      off();
      resolve();
    });
  });
}

let registering: Promise<string> | null = null;

/**
 * Token deste aparelho para o servidor atual. Sem token, registra o aparelho e envia o
 * `userId` local para o servidor adotar os dados já gravados nele.
 */
async function deviceToken(): Promise<string> {
  await hydrated();
  const { auth, apiUrl } = useSettings.getState();
  if (auth?.apiUrl === apiUrl) return auth.token;
  registering ??= send<{ userId: string; token: string }>('POST', '/auth/device', { legacyUserId: useSettings.getState().userId }, 15000, null)
    .then((r) => {
      useSettings.getState().setAuth(r.userId, { apiUrl, token: r.token });
      return r.token;
    })
    .finally(() => {
      registering = null;
    });
  return registering;
}

async function request<T>(method: Method, path: string, body?: unknown, timeoutMs = 25000): Promise<T> {
  const token = await deviceToken();
  try {
    return await send<T>(method, path, body, timeoutMs, token);
  } catch (e) {
    // Token recusado (banco do servidor recriado, por exemplo): descarta e registra de novo uma vez.
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const { userId, auth } = useSettings.getState();
    if (auth?.token === token) useSettings.getState().setAuth(userId, null);
    return send<T>(method, path, body, timeoutMs, await deviceToken());
  }
}

export const api = {
  health: () => send<{ ok: boolean; ai: { provider: string; model: string } | null }>('GET', '/health', undefined, 5000, null),
  geocode: (q: string, near?: LatLon) =>
    request<{ results: GeocodeResult[] }>(
      'GET',
      `/geocode?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`,
    ),
  reverse: (p: LatLon) => request<{ result: GeocodeResult | null }>('GET', `/reverse?lat=${p.lat}&lon=${p.lon}`),
  plan: (req: Omit<PlanRequest, 'timeZone'>) => request<PlanResponse>('POST', '/plan', { ...req, timeZone: timeZone() }),
  brief: (planId: string) => request<Brief>('POST', `/plan/${planId}/brief`, {}, 30000),
  assistant: (text: string, origin: LatLon) =>
    request<AssistantResponse>('POST', '/assistant', { text, origin, timeZone: timeZone() }, 45000),
  suggestions: (p: LatLon) => request<{ suggestions: Suggestion[] }>('GET', `/suggestions?lat=${p.lat}&lon=${p.lon}`, undefined, 30000),
  startTrip: (planId: string, routeIndex: number) =>
    request<{ tripId: string }>('POST', '/trips', { planId, routeIndex, timeZone: timeZone() }),
  samples: (tripId: string, samples: TraceSample[]) => request<{ stored: number }>('POST', `/trips/${tripId}/samples`, { samples }),
  reroute: (tripId: string, planId: string, routeIndex: number) =>
    request<{ seq: number }>('POST', `/trips/${tripId}/reroute`, { planId, routeIndex }),
  finishTrip: (tripId: string) => request<FinishTripResponse>('POST', `/trips/${tripId}/finish`, {}),
  alerts: (b: { minLat: number; minLon: number; maxLat: number; maxLon: number }) =>
    request<{ alerts: RoadAlert[] }>('GET', `/alerts?minLat=${b.minLat}&minLon=${b.minLon}&maxLat=${b.maxLat}&maxLon=${b.maxLon}`),
  report: (type: RoadAlert['type'], p: LatLon) => request<RoadAlert>('POST', '/alerts', { type, lat: p.lat, lon: p.lon }),
  vote: (id: string, up: boolean) => request<RoadAlert>('POST', `/alerts/${id}/vote`, { up }),
  insights: () => request<Insights>('GET', '/insights'),
  narrative: () => request<{ text: string | null; provider: string }>('POST', '/insights/narrative', {}, 40000),
  privacy: () => request<Privacy>('GET', '/privacy'),
  setPrivacy: (p: Privacy) => request<Privacy>('PUT', '/privacy', p),
  updatePlace: (id: string, patch: { kind?: 'home' | 'work' | 'other'; name?: string | null }) =>
    request<unknown>('PATCH', `/places/${id}`, patch),
};
