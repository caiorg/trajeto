import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api';

vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../src/lib/store', () => {
  const state = { apiUrl: 'http://x', userId: 'u1', credentials: { 'http://x': { token: 't', userId: 'u1' } }, set: () => {}, setCredential: () => {} };
  return {
    normalizeApiUrl: (u: string) => u.replace(/\/$/, ''),
    settingsHydration: Promise.resolve(null),
    settingsSaved: async () => {},
    timeZone: () => 'UTC',
    useSettings: { getState: () => state, persist: { hasHydrated: () => true } },
  };
});

/** Resposta 200 cujo corpo vem de `json`. */
const ok = (json: () => Promise<unknown>) => ({ ok: true, status: 200, json }) as unknown as Response;

describe('leitura da resposta', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('devolve o JSON da resposta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(async () => ({ tables: {} }))));
    await expect(api.exportMyData()).resolves.toEqual({ tables: {} });
  });

  it('corpo interrompido ou inválido vira erro, não objeto vazio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(async () => Promise.reject(new TypeError('network error')))));
    const e = await api.exportMyData().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 0, message: 'Resposta incompleta do servidor. Tente de novo.' });
  });

  it('o timeout também vale para a leitura do corpo', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        ok(() => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))),
      ),
    );
    const p = api.exportMyData().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await p).toMatchObject({ status: 0, message: 'Resposta incompleta do servidor. Tente de novo.' });
  });

  it('erro HTTP usa a mensagem do servidor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Erro interno' }) }) as unknown as Response));
    await expect(api.exportMyData()).rejects.toMatchObject({ status: 500, message: 'Erro interno' });
  });
});
