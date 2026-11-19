import { Map as MlMap, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { buildSources, layerSpecs, SOURCE, type MapViewProps } from './mapData';

// O Metro não resolve o worker que o maplibre-gl 6 carrega via import.meta.url.
// O postinstall copia o arquivo para public/, que o Expo serve na raiz.
setWorkerUrl('/maplibre-gl-worker.mjs');

/** Implementação web com maplibre-gl. Mesmas camadas e fontes da versão nativa. */
export function MapView({ theme, data, camera, initialCenter, onLongPress, onUserPan }: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const latest = useRef({ data, theme, onLongPress, onUserPan });
  latest.current = { data, theme, onLongPress, onUserPan };

  const install = (m: MlMap) => {
    const sources = buildSources(latest.current.data);
    for (const key of Object.keys(SOURCE) as (keyof typeof SOURCE)[]) {
      if (!m.getSource(SOURCE[key])) m.addSource(SOURCE[key], { type: 'geojson', data: sources[key] });
    }
    for (const l of layerSpecs(latest.current.theme)) {
      if (!m.getLayer(l.id)) m.addLayer(l as unknown as LayerSpecification);
    }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new MlMap({
      container: el.current,
      style: theme.mapStyle,
      center: initialCenter,
      zoom: 13,
      attributionControl: { compact: true },
    });
    map.current = m;
    m.on('style.load', () => install(m));
    m.on('contextmenu', (e: MapMouseEvent) => latest.current.onLongPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    m.on('dragstart', () => latest.current.onUserPan?.());
    return () => {
      m.remove();
      map.current = null;
    };
    // O mapa é criado uma vez; tema e dados são aplicados pelos efeitos abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Trocar o estilo apaga fontes/camadas; o handler de style.load as recria.
    map.current?.setStyle(theme.mapStyle);
  }, [theme.mapStyle]);

  useEffect(() => {
    const m = map.current;
    // Não usar isStyleLoaded(): ele fica false enquanto tiles carregam. Se a fonte ainda
    // não existe, o handler de style.load instala os dados mais recentes.
    if (!m) return;
    const sources = buildSources(data);
    for (const key of Object.keys(SOURCE) as (keyof typeof SOURCE)[]) {
      (m.getSource(SOURCE[key]) as GeoJSONSource | undefined)?.setData(sources[key]);
    }
  }, [data]);

  useEffect(() => {
    const m = map.current;
    if (!m || !camera) return;
    if (camera.type === 'fit') {
      m.fitBounds(
        [
          [camera.bounds[0], camera.bounds[1]],
          [camera.bounds[2], camera.bounds[3]],
        ],
        { padding: camera.padding, duration: 700, bearing: 0, pitch: 0 },
      );
    } else if (camera.type === 'follow') {
      m.easeTo({ center: camera.center, bearing: camera.bearing, zoom: camera.zoom, pitch: camera.pitch, duration: 900, easing: (t) => t });
    } else {
      m.flyTo({ center: camera.center, zoom: camera.zoom, duration: 800 });
    }
  }, [camera]);

  return <div ref={el} style={{ position: 'absolute', inset: 0 }} />;
}
