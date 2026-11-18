import type { Coord, LatLon, RoadAlert, SlowSpot } from '@wayboo/core';
import type { FeatureCollection } from 'geojson';
import { ALERT_COLORS, type Theme } from '@/lib/theme';

export interface MapRoute {
  id: string;
  coords: Coord[];
  selected: boolean;
}

export interface MapData {
  routes: MapRoute[];
  alerts: RoadAlert[];
  slowSpots: SlowSpot[];
  destination: LatLon | null;
  stops: LatLon[];
  puck: { lat: number; lon: number; heading: number | null } | null;
}

export type CameraCommand =
  | { type: 'fit'; bounds: [number, number, number, number]; padding: { top: number; bottom: number; left: number; right: number } }
  | { type: 'follow'; center: Coord; bearing: number; zoom: number; pitch: number }
  | { type: 'center'; center: Coord; zoom: number };

export interface MapViewProps {
  theme: Theme;
  data: MapData;
  /** `nonce` muda a cada comando, para repetir o mesmo enquadramento quando preciso. */
  camera: (CameraCommand & { nonce: number }) | null;
  initialCenter: Coord;
  onLongPress?: (p: LatLon) => void;
  onUserPan?: () => void;
}

export const SOURCE = { routes: 'routes', alerts: 'alerts', spots: 'spots', points: 'points' } as const;

export function buildSources(data: MapData): Record<keyof typeof SOURCE, FeatureCollection> {
  // Alternativas primeiro: a selecionada é desenhada por cima.
  const routes = [...data.routes].sort((a, b) => Number(a.selected) - Number(b.selected));
  return {
    routes: {
      type: 'FeatureCollection',
      features: routes.map((r) => ({
        type: 'Feature',
        properties: { id: r.id, selected: r.selected ? 1 : 0 },
        geometry: { type: 'LineString', coordinates: r.coords },
      })),
    },
    alerts: {
      type: 'FeatureCollection',
      features: data.alerts.map((a) => ({
        type: 'Feature',
        properties: { id: a.id, color: ALERT_COLORS[a.type] ?? '#DC2626' },
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      })),
    },
    spots: {
      type: 'FeatureCollection',
      features: data.slowSpots.map((s) => ({
        type: 'Feature',
        properties: { factor: s.factor },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    },
    points: {
      type: 'FeatureCollection',
      features: [
        ...(data.destination
          ? [{ type: 'Feature' as const, properties: { kind: 'dest' }, geometry: { type: 'Point' as const, coordinates: [data.destination.lon, data.destination.lat] } }]
          : []),
        ...data.stops.map((s) => ({
          type: 'Feature' as const,
          properties: { kind: 'stop' },
          geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        })),
        ...(data.puck
          ? [{ type: 'Feature' as const, properties: { kind: 'puck' }, geometry: { type: 'Point' as const, coordinates: [data.puck.lon, data.puck.lat] } }]
          : []),
      ],
    },
  };
}

/** Camadas no formato da especificação de estilo do MapLibre (mesmo formato no web e no nativo). */
export function layerSpecs(theme: Theme) {
  const sel = ['==', ['get', 'selected'], 1] as const;
  return [
    {
      id: 'spots-heat',
      source: SOURCE.spots,
      type: 'circle' as const,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 34],
        'circle-color': '#F97316',
        'circle-opacity': 0.22,
        'circle-blur': 0.6,
      },
    },
    {
      id: 'routes-casing',
      source: SOURCE.routes,
      type: 'line' as const,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', sel, theme.dark ? '#0B2A73' : '#0B3BB8', theme.dark ? '#1E293B' : '#64748B'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', sel, 7, 5], 16, ['case', sel, 15, 10]],
      },
    },
    {
      id: 'routes-line',
      source: SOURCE.routes,
      type: 'line' as const,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', sel, theme.primary, theme.routeAlt],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', sel, 4.5, 3], 16, ['case', sel, 10, 6.5]],
      },
    },
    {
      id: 'alerts-dot',
      source: SOURCE.alerts,
      type: 'circle' as const,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 10],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 2.5,
      },
    },
    {
      id: 'points-halo',
      source: SOURCE.points,
      type: 'circle' as const,
      filter: ['==', ['get', 'kind'], 'puck'],
      paint: { 'circle-radius': 22, 'circle-color': theme.primary, 'circle-opacity': 0.18 },
    },
    {
      id: 'points-dot',
      source: SOURCE.points,
      type: 'circle' as const,
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'puck', 9, 'dest', 9, 7],
        'circle-color': ['match', ['get', 'kind'], 'puck', theme.primary, 'dest', '#E11D48', theme.learn],
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 3,
      },
    },
  ];
}
