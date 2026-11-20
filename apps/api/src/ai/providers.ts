import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { config } from '../config';

/**
 * Abstração mínima de LLM: só geração de objeto estruturado validado por zod.
 * É tudo que o planejador precisa, e mantém os adaptadores pequenos.
 */
export interface LlmProvider {
  name: string;
  model: string;
  generateObject<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; schemaName: string }): Promise<z.infer<S>>;
}

class AiError extends Error {}

function anthropicProvider(model: string): LlmProvider {
  // Sem argumentos o SDK resolve ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ou o perfil do `ant auth login`.
  const client = new Anthropic({ timeout: config.ai.timeoutMs, maxRetries: 1 });
  return {
    name: 'anthropic',
    model,
    async generateObject({ system, prompt, schema }) {
      const res = await client.beta.messages.parse({
        model,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: prompt }],
        // Esforço baixo: a decisão é curta e a resposta precisa chegar antes do motorista sair.
        output_config: { format: betaZodOutputFormat(schema), effort: 'low' },
        // Se um classificador recusar, o servidor reexecuta no modelo de fallback recomendado.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      if (res.stop_reason === 'refusal') throw new AiError('O modelo recusou a solicitação');
      if (res.parsed_output == null) throw new AiError(`Resposta sem JSON válido (stop_reason=${res.stop_reason})`);
      return res.parsed_output as z.infer<typeof schema>;
    },
  };
}

type Fetch = typeof globalThis.fetch;

interface OpenAiCompatibleOptions {
  name: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  /** Campos do corpo fora do schema da OpenAI (ex.: `provider` do OpenRouter). */
  extraBody?: Record<string, unknown>;
  fetch?: Fetch;
  /** Roda antes de cada chamada; lança para desistir sem gastar a requisição. */
  preflight?: () => Promise<void>;
}

/** OpenAI e qualquer servidor compatível (Ollama, vLLM, LM Studio, OpenRouter) via `baseURL`. */
function openAiCompatibleProvider(o: OpenAiCompatibleOptions): LlmProvider {
  const client = new OpenAI({
    apiKey: o.apiKey,
    baseURL: o.baseURL,
    defaultHeaders: o.defaultHeaders,
    fetch: o.fetch,
    timeout: config.ai.timeoutMs,
    maxRetries: 1,
  });
  return {
    name: o.name,
    model: o.model,
    async generateObject({ system, prompt, schema, schemaName }) {
      await o.preflight?.();
      const res = await client.chat.completions.parse({
        ...o.extraBody,
        model: o.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: zodResponseFormat(schema, schemaName),
      });
      const msg = res.choices[0]?.message;
      if (msg?.refusal) throw new AiError(`O modelo recusou: ${msg.refusal}`);
      if (msg?.parsed == null) throw new AiError('Resposta sem JSON válido');
      return msg.parsed as z.infer<typeof schema>;
    },
  };
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Cabeçalhos opcionais de atribuição do app (https://openrouter.ai/docs/api-reference/overview). */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/caiorg/wayboo', 'X-OpenRouter-Title': 'Wayboo' };

/**
 * Consulta `GET /models/{id}/endpoints`: o suporte a saída estruturada varia por endpoint (provedor) do modelo.
 * Retorna `null` quando o catálogo não responde; aí a chamada segue e `require_parameters` decide.
 */
export async function openRouterStructuredOutputSupport(
  model: string,
  opts: { apiKey?: string; baseURL?: string; fetch?: Fetch } = {},
): Promise<boolean | null> {
  const { apiKey, baseURL = OPENROUTER_BASE_URL, fetch: fetchImpl = globalThis.fetch } = opts;
  try {
    const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/models/${model}/endpoints`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { endpoints?: { supported_parameters?: string[] }[] } };
    const endpoints = body.data?.endpoints;
    if (!Array.isArray(endpoints)) return null;
    return endpoints.some((e) => e.supported_parameters?.includes('structured_outputs'));
  } catch {
    return null;
  }
}

/** OpenRouter via API compatível com a OpenAI. Exportado para reuso com chave do usuário. */
export function openRouterProvider(opts: { model: string; apiKey: string; baseURL?: string; fetch?: Fetch }): LlmProvider {
  const { model, apiKey, baseURL = OPENROUTER_BASE_URL, fetch: fetchImpl = globalThis.fetch } = opts;
  let support: Promise<boolean | null> | undefined;
  return openAiCompatibleProvider({
    name: 'openrouter',
    model,
    apiKey,
    baseURL,
    fetch: fetchImpl,
    defaultHeaders: OPENROUTER_HEADERS,
    // Sem isso o roteador pode mandar para um provedor que ignora `response_format`.
    extraBody: { provider: { require_parameters: true } },
    async preflight() {
      support ??= openRouterStructuredOutputSupport(model, { apiKey, baseURL, fetch: fetchImpl });
      if ((await support) === false) throw new AiError(`${model} não tem saída estruturada em nenhum provedor do OpenRouter`);
    },
  });
}

function create(): LlmProvider | null {
  const { provider, model, baseUrl, apiKey } = config.ai;
  if (provider === 'none' || !model) return null;
  if (provider === 'anthropic') return anthropicProvider(model);
  if (provider === 'openrouter') return openRouterProvider({ model, apiKey: apiKey!, baseURL: baseUrl });
  return openAiCompatibleProvider({ name: provider, model, baseURL: baseUrl, apiKey });
}

export const llm = create();

/** Executa com prazo; em falha retorna null para o chamador usar o caminho determinístico. */
export async function tryLlm<T>(fn: (p: LlmProvider) => Promise<T>, log: (msg: string) => void): Promise<T | null> {
  if (!llm) return null;
  try {
    return await fn(llm);
  } catch (e) {
    log(`IA indisponível (${llm.name}/${llm.model}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
