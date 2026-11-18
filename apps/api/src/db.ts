import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  PRIOR_WEIGHTS,
  segmentOfKey,
  type DecayedStat,
  type Place,
  type PlanResponse,
  type PreferenceWeights,
  type RoadAlert,
  type Routine,
  type StatsMap,
  type TraceSample,
} from '@trajeto/core';
import { config } from './config';

/** Usuário agregado (crowd): estatísticas de todos, sem identificar ninguém. */
export const CROWD = '*';

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS stats (
  user_id TEXT NOT NULL, key TEXT NOT NULL, seg TEXT,
  w REAL NOT NULL, mean REAL NOT NULL, m2 REAL NOT NULL, t INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS stats_seg ON stats(user_id, seg);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  name TEXT, kind TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0, home_score REAL NOT NULL DEFAULT 0, work_score REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS places_user ON places(user_id);
CREATE TABLE IF NOT EXISTS routines (
  user_id TEXT NOT NULL, origin_id TEXT NOT NULL, dest_id TEXT NOT NULL, day_type TEXT NOT NULL,
  hist TEXT NOT NULL, t INTEGER NOT NULL, trips INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, origin_id, dest_id, day_type)
);
CREATE TABLE IF NOT EXISTS prefs (user_id TEXT PRIMARY KEY, weights TEXT NOT NULL, updates INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, route_index INTEGER NOT NULL,
  time_zone TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  predicted_s REAL NOT NULL, base_s REAL NOT NULL, actual_s REAL, distance_m REAL NOT NULL,
  origin_place TEXT, dest_place TEXT, ctx TEXT NOT NULL, status TEXT NOT NULL,
  error_base REAL, error_learned REAL
);
CREATE INDEX IF NOT EXISTS trips_user ON trips(user_id, started_at);
CREATE TABLE IF NOT EXISTS trip_legs (
  trip_id TEXT NOT NULL, seq INTEGER NOT NULL, started_at INTEGER NOT NULL, plan_id TEXT NOT NULL, route_index INTEGER NOT NULL,
  PRIMARY KEY (trip_id, seq)
);
CREATE TABLE IF NOT EXISTS samples (
  trip_id TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  speed REAL, heading REAL, accuracy REAL
);
CREATE INDEX IF NOT EXISTS samples_trip ON samples(trip_id, t);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, note TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0,
  reporter TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_geo ON alerts(lat, lon);
CREATE TABLE IF NOT EXISTS alert_votes (alert_id TEXT NOT NULL, user_id TEXT NOT NULL, up INTEGER NOT NULL, PRIMARY KEY (alert_id, user_id));
CREATE TABLE IF NOT EXISTS anomalies (
  user_id TEXT NOT NULL, seg TEXT NOT NULL, at INTEGER NOT NULL, expected_s REAL NOT NULL, observed_s REAL NOT NULL
);
`);

type Row = Record<string, string | number | null>;

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- estatísticas ----------

const toStat = (r: Row): DecayedStat => ({ w: Number(r.w), mean: Number(r.mean), m2: Number(r.m2), t: Number(r.t) });

/** Carrega estatísticas dos trechos informados + todas as chaves globais (sem trecho) do usuário. */
export function loadStats(userId: string, segs: string[]): StatsMap {
  const map: StatsMap = new Map();
  const unique = [...new Set(segs)];
  const chunk = 400;
  for (let i = 0; i < unique.length; i += chunk) {
    const part = unique.slice(i, i + chunk);
    const rows = db
      .prepare(`SELECT key, w, mean, m2, t FROM stats WHERE user_id = ? AND seg IN (${part.map(() => '?').join(',')})`)
      .all(userId, ...part) as Row[];
    for (const r of rows) map.set(String(r.key), toStat(r));
  }
  for (const r of db.prepare('SELECT key, w, mean, m2, t FROM stats WHERE user_id = ? AND seg IS NULL').all(userId) as Row[]) {
    map.set(String(r.key), toStat(r));
  }
  return map;
}

export function saveStats(userId: string, stats: StatsMap): void {
  const stmt = db.prepare(
    `INSERT INTO stats (user_id, key, seg, w, mean, m2, t) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET w = excluded.w, mean = excluded.mean, m2 = excluded.m2, t = excluded.t`,
  );
  for (const [key, s] of stats) stmt.run(userId, key, segmentOfKey(key), s.w, s.mean, s.m2, s.t);
}

export function statsByPrefix(userId: string, prefix: string, minW: number): { key: string; stat: DecayedStat }[] {
  return (db.prepare('SELECT key, w, mean, m2, t FROM stats WHERE user_id = ? AND key LIKE ? AND w >= ?').all(userId, `${prefix}%`, minW) as Row[]).map(
    (r) => ({ key: String(r.key), stat: toStat(r) }),
  );
}

// ---------- lugares e rotinas ----------

const toPlace = (r: Row): Place => ({
  id: String(r.id),
  lat: Number(r.lat),
  lon: Number(r.lon),
  name: r.name === null ? null : String(r.name),
  kind: String(r.kind) as Place['kind'],
  pinned: Number(r.pinned) === 1,
  visits: Number(r.visits),
  homeScore: Number(r.home_score),
  workScore: Number(r.work_score),
});

export function getPlaces(userId: string): Place[] {
  return (db.prepare('SELECT * FROM places WHERE user_id = ?').all(userId) as Row[]).map(toPlace);
}

export function upsertPlace(userId: string, p: Place): void {
  db.prepare(
    `INSERT INTO places (id, user_id, lat, lon, name, kind, pinned, visits, home_score, work_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, name = excluded.name, kind = excluded.kind,
       pinned = excluded.pinned, visits = excluded.visits, home_score = excluded.home_score, work_score = excluded.work_score`,
  ).run(p.id, userId, p.lat, p.lon, p.name, p.kind, p.pinned ? 1 : 0, p.visits, p.homeScore, p.workScore);
}

export function newPlace(lat: number, lon: number): Place {
  return { id: randomUUID(), lat, lon, name: null, kind: 'other', pinned: false, visits: 0, homeScore: 0, workScore: 0 };
}

export function getRoutines(userId: string): (Routine & { trips: number })[] {
  return (db.prepare('SELECT * FROM routines WHERE user_id = ?').all(userId) as Row[]).map((r) => ({
    originId: String(r.origin_id),
    destId: String(r.dest_id),
    dayType: String(r.day_type) as Routine['dayType'],
    hist: JSON.parse(String(r.hist)) as number[],
    t: Number(r.t),
    trips: Number(r.trips),
  }));
}

export function saveRoutine(userId: string, r: Routine): void {
  db.prepare(
    `INSERT INTO routines (user_id, origin_id, dest_id, day_type, hist, t, trips) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, origin_id, dest_id, day_type) DO UPDATE SET hist = excluded.hist, t = excluded.t, trips = trips + 1`,
  ).run(userId, r.originId, r.destId, r.dayType, JSON.stringify(r.hist.map((v) => Math.round(v * 1000) / 1000)), r.t);
}

// ---------- preferências ----------

export function getPrefs(userId: string): { weights: PreferenceWeights; updates: number } {
  const r = db.prepare('SELECT weights, updates FROM prefs WHERE user_id = ?').get(userId) as Row | undefined;
  if (!r) return { weights: { ...PRIOR_WEIGHTS }, updates: 0 };
  return { weights: { ...PRIOR_WEIGHTS, ...(JSON.parse(String(r.weights)) as PreferenceWeights) }, updates: Number(r.updates) };
}

export function savePrefs(userId: string, weights: PreferenceWeights, updates: number): void {
  db.prepare(
    `INSERT INTO prefs (user_id, weights, updates) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET weights = excluded.weights, updates = excluded.updates`,
  ).run(userId, JSON.stringify(weights), updates);
}

// ---------- planos ----------

export function savePlan(userId: string, plan: PlanResponse): void {
  db.prepare('INSERT INTO plans (id, user_id, created_at, body) VALUES (?, ?, ?, ?)').run(plan.planId, userId, plan.createdAt, JSON.stringify(plan));
  // Planos só servem para iniciar viagens; os de mais de 2 dias sem viagem podem sair.
  db.prepare(
    'DELETE FROM plans WHERE created_at < ? AND id NOT IN (SELECT plan_id FROM trip_legs)',
  ).run(Date.now() - 2 * 86_400_000);
}

export function getPlan(userId: string, planId: string): PlanResponse | null {
  const r = db.prepare('SELECT body FROM plans WHERE id = ? AND user_id = ?').get(planId, userId) as Row | undefined;
  return r ? (JSON.parse(String(r.body)) as PlanResponse) : null;
}

// ---------- amostras ----------

export function insertSamples(tripId: string, samples: TraceSample[]): void {
  const stmt = db.prepare('INSERT INTO samples (trip_id, t, lat, lon, speed, heading, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const s of samples) stmt.run(tripId, s.t, s.lat, s.lon, s.speed ?? null, s.heading ?? null, s.accuracy ?? null);
}

export function getSamples(tripId: string): TraceSample[] {
  return (db.prepare('SELECT t, lat, lon, speed, heading, accuracy FROM samples WHERE trip_id = ? ORDER BY t').all(tripId) as Row[]).map((r) => ({
    t: Number(r.t),
    lat: Number(r.lat),
    lon: Number(r.lon),
    speed: r.speed === null ? null : Number(r.speed),
    heading: r.heading === null ? null : Number(r.heading),
    accuracy: r.accuracy === null ? null : Number(r.accuracy),
  }));
}

// ---------- alertas ----------

export const toAlert = (r: Row): RoadAlert => ({
  id: String(r.id),
  type: String(r.type) as RoadAlert['type'],
  lat: Number(r.lat),
  lon: Number(r.lon),
  note: r.note === null ? null : String(r.note),
  createdAt: new Date(Number(r.created_at)).toISOString(),
  expiresAt: new Date(Number(r.expires_at)).toISOString(),
  upvotes: Number(r.up),
  downvotes: Number(r.down),
});

export function alertsInBox(minLat: number, minLon: number, maxLat: number, maxLon: number, now = Date.now()): RoadAlert[] {
  return (
    db
      .prepare('SELECT * FROM alerts WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND expires_at > ? LIMIT 500')
      .all(minLat, maxLat, minLon, maxLon, now) as Row[]
  ).map(toAlert);
}
