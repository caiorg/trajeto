import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { db, exportUserData, purgeExpiredTraces, type UserDataExport } from '../src/db';
import { client, makeRoute } from './helpers';

const ROUTE = makeRoute();
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

vi.mock('../src/providers/routing', () => ({ valhalla: { name: 'test', route: async () => [structuredClone(ROUTE)] } }));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
}));

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const api = client(() => app, ROUTE);
const { register, call } = api;

const count = (sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
const samplesOf = (tripId: string) => count('SELECT COUNT(*) AS n FROM samples WHERE trip_id = ?', tripId);
const planExists = (planId: string) => count('SELECT COUNT(*) AS n FROM plans WHERE id = ?', planId) === 1;

describe('retenção dos rastros GPS', () => {
  it('apaga o rastro e o plano da viagem encerrada depois do prazo e mantém o aprendizado', async () => {
    const user = await register();
    const { tripId, planId } = await api.drive(user);
    const stats = count('SELECT COUNT(*) AS n FROM stats WHERE user_id = ?', user.userId);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(stats).toBeGreaterThan(0);

    purgeExpiredTraces(DAY_MS, Date.now() + DAY_MS - HOUR_MS);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(planExists(planId)).toBe(true);

    const purged = purgeExpiredTraces(DAY_MS, Date.now() + DAY_MS + HOUR_MS);
    expect(purged.samples).toBeGreaterThan(0);
    expect(samplesOf(tripId)).toBe(0);
    expect(planExists(planId)).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM trips WHERE id = ?', tripId)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM stats WHERE user_id = ?', user.userId)).toBe(stats);
  });

  it('viagem em andamento só perde o rastro quando é abandonada', async () => {
    const { tripId, planId } = await api.drive(await register(), false);

    purgeExpiredTraces(0, Date.now() + HOUR_MS);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(planExists(planId)).toBe(true);

    purgeExpiredTraces(0, Date.now() + DAY_MS + HOUR_MS);
    expect(samplesOf(tripId)).toBe(0);
  });

  it('apaga alertas e votos expirados há mais que o prazo', async () => {
    const reporter = await register();
    const voter = await register();
    // Buraco dura 14 dias; acidente, 45 minutos.
    const { body: kept } = await call<{ id: string }>(reporter, 'POST', '/alerts', { type: 'pothole', lat: -22.9, lon: -43.2 });
    const { body: gone } = await call<{ id: string }>(reporter, 'POST', '/alerts', { type: 'accident', lat: -22.8, lon: -43.1 });
    await call(voter, 'POST', `/alerts/${gone.id}/vote`, { up: false });
    const alertExists = (id: string) => count('SELECT COUNT(*) AS n FROM alerts WHERE id = ?', id) === 1;

    purgeExpiredTraces(DAY_MS, Date.now() + 2 * HOUR_MS);
    expect(alertExists(gone.id)).toBe(true);

    const purged = purgeExpiredTraces(DAY_MS, Date.now() + DAY_MS + 2 * HOUR_MS);
    expect(purged.alerts).toBeGreaterThan(0);
    expect(alertExists(gone.id)).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM alert_votes WHERE alert_id = ?', gone.id)).toBe(0);
    expect(alertExists(kept.id)).toBe(true);
  });
});

describe('dados do usuário', () => {
  it('exige autenticação', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/export' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/me' })).statusCode).toBe(401);
  });

  it('exporta os dados do próprio usuário e nada de outro', async () => {
    const user = await register();
    const other = await register();
    await call(user, 'PUT', '/privacy', { shareCrowd: true });
    const { tripId, planId } = await api.drive(user);
    await api.drive(other);

    const res = await call<UserDataExport>(user, 'GET', '/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const { tables } = res.body;
    expect(res.body.userId).toBe(user.userId);
    expect(tables.trips!.map((t) => t.id)).toEqual([tripId]);
    expect(tables.samples!.length).toBe(samplesOf(tripId));
    expect(tables.plans!.map((p) => p.id)).toEqual([planId]);
    expect(tables.stats!.length).toBeGreaterThan(0);
    expect(tables.places!.length).toBeGreaterThan(0);
    expect(tables.privacy).toEqual([expect.objectContaining({ share_crowd: 1 })]);
    expect(tables.devices).toEqual([{ created_at: expect.any(Number) }]);
    expect(JSON.stringify(res.body)).not.toContain(other.userId);
  });

  it('apagar remove tudo do usuário, invalida o token e não mexe nos dados de outro', async () => {
    const user = await register();
    const other = await register();
    await api.drive(user);
    await api.drive(other);
    const { body: mine } = await call<{ id: string }>(user, 'POST', '/alerts', { type: 'hazard', lat: -23.5, lon: -46.6 });
    const { body: theirs } = await call<{ id: string }>(other, 'POST', '/alerts', { type: 'pothole', lat: -23.4, lon: -46.5 });
    await call(user, 'POST', `/alerts/${theirs.id}/vote`, { up: true });
    const before = (await call<UserDataExport>(other, 'GET', '/me/export')).body.tables;

    const res = await call<{ deleted: Record<string, number> }>(user, 'DELETE', '/me');
    expect(res.status).toBe(200);
    expect(res.body.deleted.samples).toBeGreaterThan(0);

    const left = exportUserData(user.userId).tables;
    for (const [table, rows] of Object.entries(left)) expect(rows, table).toEqual([]);
    expect((await call(user, 'GET', '/privacy')).status).toBe(401);
    expect((await call<UserDataExport>(other, 'GET', '/me/export')).body.tables).toEqual(before);
    // O alerta continua útil para a comunidade, sem apontar para quem o criou.
    expect(db.prepare('SELECT reporter FROM alerts WHERE id = ?').get(mine.id)).toEqual({ reporter: '*' });
  });
});
