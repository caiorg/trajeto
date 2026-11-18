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

/** OpenAI e qualquer servidor compatível (Ollama, vLLM, LM Studio) via `baseURL`. */
function openAiCompatibleProvider(name: string, model: string, baseURL: string | undefined, apiKey: string | undefined): LlmProvider {
  const client = new OpenAI({ apiKey, baseURL, timeout: config.ai.timeoutMs, maxRetries: 1 });
  return {
    name,
    model,
    async generateObject({ system, prompt, schema, schemaName }) {
      const res = await client.chat.completions.parse({
        model,
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

function create(): LlmProvider | null {
  const { provider, model, baseUrl, apiKey } = config.ai;
  if (provider === 'none' || !model) return null;
  if (provider === 'anthropic') return anthropicProvider(model);
  return openAiCompatibleProvider(provider, model, baseUrl, apiKey);
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
