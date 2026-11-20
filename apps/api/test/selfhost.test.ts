import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { selfHostStyle, type MapStyle } from '../src/selfhost/map-style';

// `config.ts` lê o ambiente ao ser importado; o hoisted roda antes dos imports.
vi.hoisted(() => {
  process.env.MAP_STYLE_URL = 'http://wayboo.lan:8080/map/styles/light.json';
});

const { buildApp } = await import('../src/app');

const upstream: MapStyle = {
  version: 8,
  sources: {
    ne2_shaded: { type: 'raster', tiles: ['https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png'] },
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  },
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
  layers: [
    { id: 'background', type: 'background' },
    { id: 'natural_earth', type: 'raster', source: 'ne2_shaded' },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
  ],
};

describe('estilo do mapa no servidor próprio', () => {
  const style = selfHostStyle(upstream, 'http://wayboo.lan:8080/');

  it('não aponta para nenhum host externo', () => {
    // A atribuição tem links que o mapa só mostra; o resto são URLs que o mapa baixa.
    const { attribution: _, ...vector } = style.sources.openmaptiles!;
    const hosts = JSON.stringify({ ...style, sources: { openmaptiles: vector } }).match(/https?:\/\/[^/"]+/g);
    expect(new Set(hosts)).toEqual(new Set(['http://wayboo.lan:8080']));
  });

  it('troca a fonte vetorial pelo PMTiles local e tira o relevo raster', () => {
    expect(Object.keys(style.sources)).toEqual(['openmaptiles']);
    expect(style.sources.openmaptiles).toMatchObject({ type: 'vector', tiles: ['http://wayboo.lan:8080/tiles/region/{z}/{x}/{y}.mvt'], maxzoom: 14 });
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'water']);
    expect(style.glyphs).toBe('http://wayboo.lan:8080/map/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toBe('http://wayboo.lan:8080/map/sprites/ofm_f384/ofm');
  });
});

describe('/health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(() => app.close());

  it('anuncia os estilos do mapa; sem MAP_STYLE_DARK_URL, o escuro usa o mesmo', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const url = 'http://wayboo.lan:8080/map/styles/light.json';
    expect(res.json()).toMatchObject({ ok: true, map: { light: url, dark: url } });
  });
});
