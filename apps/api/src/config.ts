import { z } from 'zod';

const env = process.env;

/** Vazio ou só espaços conta como ausente; assim as checagens de obrigatório abaixo pegam `"   "`. */
const optionalText = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

const AiEnv = z.object({
  AI_MODEL: optionalText,
  AI_BASE_URL: optionalText.pipe(z.url().optional()),
  OPENAI_API_KEY: optionalText,
  OLLAMA_API_KEY: optionalText,
  OPENROUTER_API_KEY: optionalText,
});

function parseAiEnv() {
  const r = AiEnv.safeParse(env);
  if (r.success) return r.data;
  // Só o nome da variável: a mensagem não pode vazar a chave.
  const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
  throw new Error(`Variável de ambiente inválida: ${names.join(', ')}`);
}

const aiEnv = parseAiEnv();

export type AiProviderName = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'none';

const PROVIDERS: readonly AiProviderName[] = ['anthropic', 'openai', 'ollama', 'openrouter', 'none'];

function detectProvider(): AiProviderName {
  const explicit = env.AI_PROVIDER?.toLowerCase();
  if (explicit && (PROVIDERS as readonly string[]).includes(explicit)) return explicit as AiProviderName;
  if (explicit) throw new Error(`AI_PROVIDER inválido: ${explicit} (use ${PROVIDERS.join(' | ')})`);
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (aiEnv.OPENAI_API_KEY) return 'openai';
  if (aiEnv.OPENROUTER_API_KEY) return 'openrouter';
  return 'none';
}

const provider = detectProvider();

const DEFAULT_BASE_URL: Partial<Record<AiProviderName, string>> = {
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const API_KEY: Partial<Record<AiProviderName, string | undefined>> = {
  openai: aiEnv.OPENAI_API_KEY,
  ollama: aiEnv.OLLAMA_API_KEY ?? 'ollama',
  openrouter: aiEnv.OPENROUTER_API_KEY,
};

/** Estilos do mapa no servidor próprio, anunciados em `/health`. Sem `MAP_STYLE_URL`, o app usa os do OpenFreeMap. */
const MapEnv = z.object({
  MAP_STYLE_URL: optionalText.pipe(z.url().optional()),
  MAP_STYLE_DARK_URL: optionalText.pipe(z.url().optional()),
});
const mapEnv = MapEnv.parse(env);

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  dbPath: env.DB_PATH ?? 'wayboo.db',
  userAgent: env.USER_AGENT ?? 'Wayboo/0.1 (+https://github.com/caiorg/wayboo)',
  valhallaUrl: (env.VALHALLA_URL ?? 'https://valhalla1.openstreetmap.de').replace(/\/$/, ''),
  photonUrl: (env.PHOTON_URL ?? 'https://photon.komoot.io').replace(/\/$/, ''),
  openMeteoUrl: (env.OPEN_METEO_URL ?? 'https://api.open-meteo.com').replace(/\/$/, ''),
  mapStyles: mapEnv.MAP_STYLE_URL ? { light: mapEnv.MAP_STYLE_URL, dark: mapEnv.MAP_STYLE_DARK_URL ?? mapEnv.MAP_STYLE_URL } : null,
  corsOrigin: env.CORS_ORIGIN ?? true,
  ai: {
    provider,
    model: aiEnv.AI_MODEL ?? (provider === 'anthropic' ? 'claude-opus-5-5' : null),
    baseUrl: aiEnv.AI_BASE_URL ?? DEFAULT_BASE_URL[provider],
    apiKey: API_KEY[provider],
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 15000),
  },
};

if ((provider === 'openai' || provider === 'ollama' || provider === 'openrouter') && !config.ai.model) {
  throw new Error(
    `AI_MODEL é obrigatório para AI_PROVIDER=${provider} (ex.: o nome do modelo instalado no Ollama ou "openai/gpt-4o-mini" no OpenRouter).`,
  );
}
if (provider === 'openrouter' && !config.ai.apiKey) throw new Error('OPENROUTER_API_KEY é obrigatório para AI_PROVIDER=openrouter.');
