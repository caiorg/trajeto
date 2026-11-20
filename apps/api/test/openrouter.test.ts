import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openRouterProvider } from '../src/ai/providers';

const MODEL = 'openai/gpt-4o-mini';
const KEY = 'sk-or-test';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const catalog = (params: string[][]) =>
  json({ data: { id: MODEL, endpoints: params.map((supported_parameters, i) => ({ provider_name: `p${i}`, supported_parameters })) } });

const completion = (content: string) =>
  json({
    id: 'gen-1',
    object: 'chat.completion',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
  });

type Call = { url: string; headers: Headers; body: any };

/** Simula o OpenRouter: catálogo de endpoints e chat completions. Nenhuma chamada sai da máquina. */
function fakeOpenRouter(opts: { catalog: () => Response; content: string }) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/endpoints')) return opts.catalog();
    if (url.endsWith('/chat/completions')) return completion(opts.content);
    return json({ error: { code: 404, message: 'Not Found' } }, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const Schema = z.object({ headline: z.string(), warnings: z.array(z.string()) });
const args = { system: 'sys', prompt: 'oi', schema: Schema, schemaName: 'route_brief' };

describe('openRouterProvider', () => {
  it('envia saída estruturada, cabeçalhos e exige provedor compatível', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['response_format', 'structured_outputs']]), content: '{"headline":"ok","warnings":[]}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: [] });
    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: [] });

    const [check, chat] = or.calls;
    expect(check!.url).toBe(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`);
    expect(chat!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(chat!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(chat!.headers.get('http-referer')).toBe('https://github.com/caiorg/wayboo');
    expect(chat!.headers.get('x-openrouter-title')).toBe('Wayboo');
    expect(chat!.body).toMatchObject({
      model: MODEL,
      provider: { require_parameters: true },
      response_format: { type: 'json_schema', json_schema: { name: 'route_brief', strict: true } },
    });
    // O catálogo é consultado uma vez só.
    expect(or.calls.filter((c) => c.url.endsWith('/endpoints'))).toHaveLength(1);
    expect(or.calls.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(2);
  });

  it('desiste sem chamar o modelo quando nenhum endpoint tem saída estruturada', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['temperature', 'response_format'], ['tools']]), content: '{}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    await expect(p.generateObject(args)).rejects.toThrow(/saída estruturada/);
    expect(or.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('segue para o modelo quando o catálogo não responde', async () => {
    const or = fakeOpenRouter({ catalog: () => json({ error: { code: 502, message: 'down' } }, 502), content: '{"headline":"ok","warnings":["a"]}' });
    const p = openRouterProvider({ model: MODEL, apiKey: KEY, fetch: or.fetch });

    expect(await p.generateObject(args)).toEqual({ headline: 'ok', warnings: ['a'] });
  });
});

describe('AI_PROVIDER=openrouter no planejador', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function plannerWith(or: ReturnType<typeof fakeOpenRouter>) {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('AI_MODEL', MODEL);
    vi.stubEnv('OPENROUTER_API_KEY', KEY);
    vi.stubGlobal('fetch', or.fetch);
    vi.resetModules();
    return import('../src/ai/planner');
  }

  const intent = {
    destinationQuery: 'Parque Ibirapuera',
    destinationPlace: null,
    avoidTolls: true,
    avoidHighways: false,
    avoidFerries: false,
    stops: [],
    arriveBy: null,
    departAt: null,
    priority: null,
  };

  it('interpreta o pedido com o modelo', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['structured_outputs']]), content: JSON.stringify(intent) });
    const { parseIntent } = await plannerWith(or);

    const res = await parseIntent('ir pro Ibirapuera sem pedágio', () => {});
    expect(res.provider).toBe('ia');
    expect(res.intent).toMatchObject({ destinationQuery: 'Parque Ibirapuera', avoidTolls: true });
  });

  it('cai no modo regras quando o modelo não tem saída estruturada', async () => {
    const or = fakeOpenRouter({ catalog: () => catalog([['tools']]), content: JSON.stringify(intent) });
    const { parseIntent } = await plannerWith(or);
    const log = vi.fn();

    const res = await parseIntent('ir pro Ibirapuera sem pedágio', log);
    expect(res.provider).toBe('regras');
    expect(res.intent.avoidTolls).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('openrouter'));
    expect(or.calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });
});
