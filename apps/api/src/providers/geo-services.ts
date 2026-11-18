import { geohash, type StopCategory, type WeatherNow } from '@trajeto/core';
import { config } from '../config';
import { fetchJson, ttlCache } from './http';

// ---------- busca de endereços e POIs (Photon / OSM) ----------

export interface GeocodeResult {
  name: string;
  label: string;
  lat: number;
  lon: number;
  category: string | null;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    city?: string;
    state?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

const geocodeCache = ttlCache<GeocodeResult[]>(10 * 60_000);

function toResult(f: PhotonFeature): GeocodeResult {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(', ');
  const name = p.name || street || p.city || 'Local';
  const label = [p.name && street ? street : null, p.district, p.city, p.state].filter(Boolean).join(' · ');
  return {
    name,
    label,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    category: p.osm_key && p.osm_value ? `${p.osm_key}:${p.osm_value}` : null,
  };
}

export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export async function geocode(
  q: string,
  near?: { lat: number; lon: number },
  osmTag?: string,
  limit = 8,
  bbox?: BBox,
): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit), lang: 'default' });
  if (bbox) params.set('bbox', bbox.map((v) => v.toFixed(4)).join(','));
  if (near) {
    params.set('lat', near.lat.toFixed(5));
    params.set('lon', near.lon.toFixed(5));
  }
  if (osmTag) params.set('osm_tag', osmTag);
  const key = params.toString();
  const hit = geocodeCache.get(key);
  if (hit) return hit;
  const res = await fetchJson<{ features: PhotonFeature[] }>(`${config.photonUrl}/api/?${key}`);
  const out = res.features.map(toResult);
  geocodeCache.set(key, out);
  return out;
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult | null> {
  const res = await fetchJson<{ features: PhotonFeature[] }>(
    `${config.photonUrl}/reverse?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&limit=1&lang=default`,
  );
  return res.features[0] ? toResult(res.features[0]) : null;
}

/** O Photon ranqueia por texto; por isso cada categoria tem vários termos (marcas comuns no Brasil). */
export const STOP_QUERY: Record<StopCategory, { qs: string[]; tag: string; label: string }> = {
  fuel: { qs: ['posto', 'auto posto', 'shell', 'ipiranga', 'petrobras'], tag: 'amenity:fuel', label: 'Posto de combustível' },
  food: { qs: ['restaurante', 'lanchonete'], tag: 'amenity:restaurant', label: 'Restaurante' },
  coffee: { qs: ['café', 'padaria', 'starbucks'], tag: 'amenity:cafe', label: 'Café' },
  pharmacy: { qs: ['farmácia', 'drogaria', 'droga raia', 'drogasil'], tag: 'amenity:pharmacy', label: 'Farmácia' },
  parking: { qs: ['estacionamento', 'estapar'], tag: 'amenity:parking', label: 'Estacionamento' },
  ev_charging: { qs: ['eletroposto', 'carregador', 'charging'], tag: 'amenity:charging_station', label: 'Eletroposto' },
  atm: { qs: ['banco 24 horas', 'caixa eletrônico', 'atm'], tag: 'amenity:atm', label: 'Caixa eletrônico' },
  supermarket: { qs: ['supermercado', 'mercado', 'carrefour', 'pão de açúcar'], tag: 'shop:supermarket', label: 'Supermercado' },
};

// ---------- clima atual (Open-Meteo) ----------

const weatherCache = ttlCache<WeatherNow | null>(10 * 60_000);

const WMO: Record<number, string> = {
  0: 'Céu limpo',
  1: 'Poucas nuvens',
  2: 'Parcialmente nublado',
  3: 'Nublado',
  45: 'Neblina',
  48: 'Neblina com geada',
  51: 'Garoa fraca',
  53: 'Garoa',
  55: 'Garoa forte',
  61: 'Chuva fraca',
  63: 'Chuva',
  65: 'Chuva forte',
  80: 'Pancadas de chuva',
  81: 'Pancadas fortes',
  82: 'Temporal',
  95: 'Tempestade',
  96: 'Tempestade com granizo',
  99: 'Tempestade com granizo',
};

export async function currentWeather(lat: number, lon: number): Promise<WeatherNow | null> {
  const key = geohash(lat, lon, 5);
  const cached = weatherCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const res = await fetchJson<{ current: { precipitation: number; weather_code: number; visibility?: number } }>(
      `${config.openMeteoUrl}/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=precipitation,weather_code,visibility`,
      { timeoutMs: 4000 },
    );
    const w: WeatherNow = {
      precipitationMm: res.current.precipitation,
      weatherCode: res.current.weather_code,
      visibilityM: res.current.visibility ?? null,
      description: WMO[res.current.weather_code] ?? 'Tempo instável',
    };
    weatherCache.set(key, w);
    return w;
  } catch {
    // Clima é contexto opcional: sem ele o ETA segue sem o fator.
    weatherCache.set(key, null);
    return null;
  }
}

export function weatherFlags(w: WeatherNow | null) {
  if (!w) return { rain: false, heavyRain: false, lowVisibility: false };
  const heavyCodes = [65, 82, 95, 96, 99];
  const rainCodes = [53, 55, 61, 63, 80, 81, ...heavyCodes];
  return {
    rain: w.precipitationMm >= 0.2 || rainCodes.includes(w.weatherCode),
    heavyRain: w.precipitationMm >= 4 || heavyCodes.includes(w.weatherCode),
    lowVisibility: (w.visibilityM !== null && w.visibilityM < 800) || w.weatherCode === 45 || w.weatherCode === 48,
  };
}
