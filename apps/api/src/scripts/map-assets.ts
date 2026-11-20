/**
 * Prepara os arquivos do mapa para o servidor próprio (serviço `map-assets` do docker-compose).
 *
 * Na primeira execução baixa do OpenFreeMap os estilos, as fontes e os sprites. Em toda execução
 * regrava `styles/light.json` e `styles/dark.json` com `PUBLIC_URL`, então trocar a URL pública
 * só exige subir a stack de novo. Depois do primeiro download, não acessa a rede.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selfHostStyle, spriteOf, type MapStyle } from '../selfhost/map-style';

const OFM_STYLES = 'https://tiles.openfreemap.org/styles';
const OFM_ASSETS = 'https://assets.openfreemap.com';
/** Tema do app → estilo do OpenFreeMap. */
const STYLES = { light: 'liberty', dark: 'dark' } as const;

const dir = process.env.MAP_DIR ?? '/srv/map';
const publicUrl = process.env.PUBLIC_URL?.trim();
if (!publicUrl || !URL.canParse(publicUrl)) throw new Error('PUBLIC_URL é obrigatória (ex.: http://192.168.0.10:8080).');

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Extrai `url` (tar.gz com uma pasta raiz) em `dest`. Grava numa pasta temporária e troca no fim, para não deixar extração pela metade. */
async function extract(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return;
  const tmp = `${dest}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const archive = `${tmp}.tar.gz`;
  console.log(`Baixando ${url}`);
  await download(url, archive);
  execFileSync('tar', ['-xzf', archive, '-C', tmp, '--strip-components=1']);
  await rm(archive);
  await rename(tmp, dest);
}

async function upstreamStyle(name: string): Promise<MapStyle> {
  const file = join(dir, 'upstream', `${name}.json`);
  if (!existsSync(file)) {
    await mkdir(join(dir, 'upstream'), { recursive: true });
    console.log(`Baixando estilo ${name}`);
    await download(`${OFM_STYLES}/${name}`, `${file}.tmp`);
    await rename(`${file}.tmp`, file);
  }
  return JSON.parse(await readFile(file, 'utf8')) as MapStyle;
}

await mkdir(join(dir, 'styles'), { recursive: true });
await mkdir(join(dir, 'sprites'), { recursive: true });
await extract(`${OFM_ASSETS}/fonts/ofm.tar.gz`, join(dir, 'fonts'));
for (const [theme, name] of Object.entries(STYLES)) {
  const style = await upstreamStyle(name);
  const { id } = spriteOf(style);
  await extract(`${OFM_ASSETS}/sprites/${id}.tar.gz`, join(dir, 'sprites', id));
  await writeFile(join(dir, 'styles', `${theme}.json`), JSON.stringify(selfHostStyle(style, publicUrl)));
}
console.log(`Estilos do mapa prontos para ${publicUrl}`);
