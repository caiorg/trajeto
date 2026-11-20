const env = process.env;

export type AiProviderName = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'none';

const PROVIDERS: readonly AiProviderName[] = ['anthropic', 'openai', 'ollama', 'openrouter', 'none'];

function detectProvider(): AiProviderName {
  const explicit = env.AI_PROVIDER?.toLowerCase();
  if (explicit && (PROVIDERS as readonly string[]).includes(explicit)) return explicit as AiProviderName;
  if (explicit) throw new Error(`AI_PROVIDER inválido: ${explicit} (use ${PROVIDERS.join(' | ')})`);
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  return 'none';
}

const provider = detectProvider();

const DEFAULT_BASE_URL: Partial<Record<AiProviderName, string>> = {
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const API_KEY: Partial<Record<AiProviderName, string | undefined>> = {
  openai: env.OPENAI_API_KEY,
  ollama: env.OLLAMA_API_KEY ?? 'ollama',
  openrouter: env.OPENROUTER_API_KEY,
};

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  dbPath: env.DB_PATH ?? 'wayboo.db',
  userAgent: env.USER_AGENT ?? 'Wayboo/0.1 (+https://github.com/caiorg/wayboo)',
  valhallaUrl: (env.VALHALLA_URL ?? 'https://valhalla1.openstreetmap.de').replace(/\/$/, ''),
  photonUrl: (env.PHOTON_URL ?? 'https://photon.komoot.io').replace(/\/$/, ''),
  openMeteoUrl: (env.OPEN_METEO_URL ?? 'https://api.open-meteo.com').replace(/\/$/, ''),
  corsOrigin: env.CORS_ORIGIN ?? true,
  ai: {
    provider,
    model: env.AI_MODEL ?? (provider === 'anthropic' ? 'claude-opus-5-5' : null),
    baseUrl: env.AI_BASE_URL ?? DEFAULT_BASE_URL[provider],
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
