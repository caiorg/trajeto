import { Camera, GeoJSONSource, Layer, Map, type CameraRef, type LayerProps } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { buildSources, layerSpecs, SOURCE, type MapViewProps } from './mapData';

/** Implementação nativa (iOS/Android). A versão web fica em MapView.web.tsx. */
export function MapView({ theme, data, camera, initialCenter, onLongPress, onUserPan }: MapViewProps) {
  const cameraRef = useRef<CameraRef>(null);
  const sources = useMemo(() => buildSources(data), [data]);
  const layers = useMemo(() => layerSpecs(theme), [theme]);

  useEffect(() => {
    const c = cameraRef.current;
    if (!c || !camera) return;
    if (camera.type === 'fit') {
      c.fitBounds(camera.bounds, { padding: camera.padding, duration: 700 });
    } else if (camera.type === 'follow') {
      c.easeTo({ center: camera.center, bearing: camera.bearing, zoom: camera.zoom, pitch: camera.pitch, duration: 900, easing: 'linear' });
    } else {
      c.flyTo({ center: camera.center, zoom: camera.zoom, duration: 800 });
    }
  }, [camera]);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={theme.mapStyle}
      logo={false}
      attribution
      attributionPosition={{ bottom: 8, left: 8 }}
      compass={false}
      onLongPress={(e) => onLongPress?.({ lon: e.nativeEvent.lngLat[0], lat: e.nativeEvent.lngLat[1] })}
      onRegionWillChange={(e) => {
        if (e.nativeEvent.userInteraction) onUserPan?.();
      }}
    >
      <Camera ref={cameraRef} initialViewState={{ center: initialCenter, zoom: 13 }} />
      {(Object.keys(SOURCE) as (keyof typeof SOURCE)[]).map((key) => (
        <GeoJSONSource key={key} id={SOURCE[key]} data={sources[key]}>
          {layers
            .filter((l) => l.source === SOURCE[key])
            .map(({ source: _source, ...l }) => (
              <Layer key={l.id} {...(l as unknown as LayerProps)} />
            ))}
        </GeoJSONSource>
      ))}
    </Map>
  );
}
