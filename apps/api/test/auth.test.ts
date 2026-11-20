import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { db, setShareCrowd } from '../src/db';

type Device = { userId: string; token: string };

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

async function register(legacyUserId?: string): Promise<Device> {
  const res = await app.inject({ method: 'POST', url: '/auth/device', payload: legacyUserId ? { legacyUserId } : {} });
  expect(res.statusCode).toBe(200);
  return res.json<Device>();
}

const privacy = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/privacy', headers });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('autenticação por aparelho', () => {
  it('recusa requisição sem token, com token inventado ou só com x-user-id', async () => {
    const { userId } = await register();
    expect((await privacy({})).statusCode).toBe(401);
    expect((await privacy(bearer('A'.repeat(43)))).statusCode).toBe(401);
    expect((await privacy(bearer('curto'))).statusCode).toBe(401);
    expect((await privacy({ 'x-user-id': userId })).statusCode).toBe(401);
  });

  it('emite token que dá acesso só aos dados do próprio usuário', async () => {
    const a = await register();
    const b = await register();
    expect(a.userId).not.toBe(b.userId);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const put = await app.inject({ method: 'PUT', url: '/privacy', headers: bearer(a.token), payload: { shareCrowd: true } });
    expect(put.json()).toEqual({ shareCrowd: true });
    expect((await privacy(bearer(b.token))).json()).toEqual({ shareCrowd: false });
  });

  it('guarda só o hash do token', async () => {
    const { token } = await register();
    const all = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(all).not.toContain(token);
  });

  it('adota o UUID anônimo antigo uma única vez', async () => {
    const legacy = randomUUID();
    setShareCrowd(legacy, true);

    const first = await register(legacy);
    expect(first.userId).toBe(legacy);
    expect((await privacy(bearer(first.token))).json()).toEqual({ shareCrowd: true });

    const second = await register(legacy);
    expect(second.userId).not.toBe(legacy);
    expect((await privacy(bearer(second.token))).json()).toEqual({ shareCrowd: false });
  });

  it('valida o UUID antigo', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/device', payload: { legacyUserId: 'nao-uuid' } });
    expect(res.statusCode).toBe(400);
  });
});
