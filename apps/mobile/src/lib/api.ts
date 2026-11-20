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
import { getRandomBytes } from 'expo-crypto';
import { normalizeApiUrl, settingsHydration, timeZone, useSettings } from './store';

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

/** `baseUrl` vem de quem chama: o token só vai para o servidor em que foi registrado. */
async function send<T>(baseUrl: string, method: Method, path: string, body: unknown, timeoutMs: number, token: string | null): Promise<T> {
  // AbortSignal.timeout não existe em todas as versões do Hermes.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
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
    throw new ApiError(0, `Sem conexão com o servidor (${baseUrl}). Confira a URL em Ajustes.`);
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Erro ${res.status}`);
  return data as T;
}

const currentUrl = () => normalizeApiUrl(useSettings.getState().apiUrl);

/** O AsyncStorage carrega depois do primeiro render; sem esperar, o app registraria um usuário novo. */
async function hydrated(): Promise<void> {
  if (useSettings.persist.hasHydrated()) return;
  // Leitura falhou ou JSON corrompido: erro tratável em vez de travar a chamada ou criar outra identidade.
  if ((await settingsHydration) !== null) throw new ApiError(0, 'Não foi possível ler os ajustes salvos neste aparelho.');
}

/** 32 bytes aleatórios em base64url (43 caracteres), o formato que o servidor aceita. */
function newToken(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = getRandomBytes(32);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (i + 1 < bytes.length ? abc[(n >> 6) & 63]! : '') + (i + 2 < bytes.length ? abc[n & 63]! : '');
  }
  return out;
}

/** Um registro em andamento por servidor; nunca compartilhado entre URLs. */
const registering = new Map<string, Promise<string>>();

/**
 * Token deste aparelho para `baseUrl`. Sem registro confirmado, grava um token novo (ou reusa o
 * gravado) e o registra. O registro é idempotente, então repetir após uma resposta perdida
 * devolve o mesmo usuário. Envia o `userId` local para o servidor adotar os dados já gravados nele.
 */
async function deviceToken(baseUrl: string): Promise<string> {
  await hydrated();
  const saved = useSettings.getState().credentials[baseUrl];
  if (saved?.userId) return saved.token;
  let pending = registering.get(baseUrl);
  if (!pending) {
    const token = saved?.token ?? newToken();
    if (!saved) useSettings.getState().setCredential(baseUrl, { token });
    pending = send<{ userId: string }>(baseUrl, 'POST', '/auth/device', { token, legacyUserId: useSettings.getState().userId }, 15000, null)
      .then(({ userId }) => {
        useSettings.getState().setCredential(baseUrl, { token, userId });
        return token;
      })
      .finally(() => registering.delete(baseUrl));
    registering.set(baseUrl, pending);
  }
  return pending;
}

async function request<T>(method: Method, path: string, body?: unknown, timeoutMs = 25000): Promise<T> {
  const baseUrl = currentUrl();
  const token = await deviceToken(baseUrl);
  try {
    return await send<T>(baseUrl, method, path, body, timeoutMs, token);
  } catch (e) {
    // Token recusado (banco do servidor recriado, por exemplo): registra o mesmo token de novo, uma vez.
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    if (useSettings.getState().credentials[baseUrl]?.token === token) useSettings.getState().setCredential(baseUrl, { token });
    return send<T>(baseUrl, method, path, body, timeoutMs, await deviceToken(baseUrl));
  }
}

export const api = {
  health: () => send<{ ok: boolean; ai: { provider: string; model: string } | null }>(currentUrl(), 'GET', '/health', undefined, 5000, null),
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
