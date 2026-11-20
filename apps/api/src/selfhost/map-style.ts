/**
 * Converte um estilo do OpenFreeMap para o servidor próprio: tiles do PMTiles local, fontes e
 * sprites servidos pelo gateway. Depois da conversão, o estilo não aponta para nenhum host externo.
 */
import { z } from 'zod';

/** Nome do arquivo PMTiles servido pelo `go-pmtiles` (`/tiles/<nome>/{z}/{x}/{y}.mvt`). */
export const TILESET = 'region';

const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/** O que a conversão usa de um estilo MapLibre; o resto passa intacto. */
export const MapStyleSchema = z.looseObject({
  version: z.literal(8),
  sources: z.record(z.string(), z.looseObject({ type: z.string() })),
  layers: z.array(z.looseObject({ id: z.string(), source: z.string().optional() })),
  glyphs: z.string().optional(),
  sprite: z.string().optional(),
});

export type MapStyle = z.infer<typeof MapStyleSchema>;

/** `.../sprites/ofm_f384/ofm` vira `{ id: 'ofm_f384', name: 'ofm' }`. O pacote do OpenFreeMap se chama `<id>.tar.gz`. */
export function spriteOf(style: MapStyle): { id: string; name: string } {
  const m = /\/sprites\/([^/]+)\/([^/]+)$/.exec(style.sprite ?? '');
  if (!m) throw new Error(`Sprite inesperado no estilo: ${style.sprite}`);
  return { id: m[1]!, name: m[2]! };
}

export function selfHostStyle(style: MapStyle, publicUrl: string): MapStyle {
  const base = publicUrl.replace(/\/+$/, '');
  const vector = Object.entries(style.sources).filter(([, s]) => s.type === 'vector');
  if (vector.length !== 1) throw new Error(`O estilo deve ter uma fonte vetorial; tem ${vector.length}.`);
  const [vectorId] = vector[0]!;
  const sprite = spriteOf(style);
  // O relevo raster (`ne2_shaded`) vem do OpenFreeMap e não tem equivalente local: sai com as camadas que o usam.
  const sources: MapStyle['sources'] = {
    [vectorId]: {
      type: 'vector',
      tiles: [`${base}/tiles/${TILESET}/{z}/{x}/{y}.mvt`],
      minzoom: 0,
      maxzoom: 14,
      attribution: ATTRIBUTION,
    },
  };
  return {
    ...style,
    sources,
    layers: style.layers.filter((l) => l.source === undefined || l.source in sources),
    glyphs: `${base}/map/fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}/map/sprites/${sprite.id}/${sprite.name}`,
  };
}
