const env = process.env;

export type AiProviderName = 'anthropic' | 'openai' | 'ollama' | 'none';

function detectProvider(): AiProviderName {
  const explicit = env.AI_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'ollama' || explicit === 'none') return explicit;
  if (explicit) throw new Error(`AI_PROVIDER inválido: ${explicit} (use anthropic | openai | ollama | none)`);
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

const provider = detectProvider();

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
    baseUrl: env.AI_BASE_URL ?? (provider === 'ollama' ? 'http://localhost:11434/v1' : undefined),
    apiKey: provider === 'openai' ? env.OPENAI_API_KEY : provider === 'ollama' ? (env.OLLAMA_API_KEY ?? 'ollama') : undefined,
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 15000),
  },
};

if ((provider === 'openai' || provider === 'ollama') && !config.ai.model) {
  throw new Error(`AI_MODEL é obrigatório para AI_PROVIDER=${provider} (ex.: o nome do modelo instalado no Ollama).`);
}
