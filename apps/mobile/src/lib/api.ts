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

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, timeoutMs = 25000): Promise<T> {
  const { apiUrl, userId } = useSettings.getState();
  // AbortSignal.timeout não existe em todas as versões do Hermes.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'x-user-id': userId,
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

export const api = {
  health: () => request<{ ok: boolean; ai: { provider: string; model: string } | null }>('GET', '/health', undefined, 5000),
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
