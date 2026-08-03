import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import { FakePushSender } from '../push/fakePushSender.js';

const SWEEP_SECRET = 'a-sufficiently-long-secret';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: SWEEP_SECRET,
  APP_BASE_URL: 'https://gb.example.com',
});

const ZERO_REPORT = {
  opened: 0,
  tiersAdvanced: 0,
  dispatched: 0,
  expired: 0,
  pledgesReleased: 0,
  closureNotices: 0,
};

let db: PGlite;
let app: FastifyInstance;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

/** Seed one fresh 'open' standard request so the sweep has real work to report. */
async function seedOpenRequest(): Promise<void> {
  const hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown Hospital', 'Times Square', 40.758000, -73.985500, 'HOSPITAL_BLOODBANK_PHONE')
       RETURNING hospital_id`,
    ),
  ).hospital_id;
  const requesterId = firstRow(
    await db.query<{ requester_id: string }>(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ('uid_requester_internal', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
      [hospitalId],
    ),
  ).requester_id;
  await db.query(
    `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, expires_at)
     VALUES ($1, $2, 'B+', 2, 'standard', now() + interval '1 day')`,
    [requesterId, hospitalId],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);

  // buildApp takes the sweep secret from config.SWEEP_SHARED_SECRET, which is
  // SWEEP_SECRET here — the same value this suite's headers use.
  app = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(new Map()),
    db,
    push: new FakePushSender(),
    logger: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE hospital, requester, request, donor CASCADE');
});

function sweep(headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/internal/sweep', headers });
}

test('401 when the x-sweep-secret header is absent', async () => {
  const res = await sweep();
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'unauthorized' });
});

test('401 on a wrong secret of the same length', async () => {
  const res = await sweep({ 'x-sweep-secret': 'x'.repeat(SWEEP_SECRET.length) });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'unauthorized' });
});

test('401 — not a crash — on wrong-LENGTH secrets (hashed constant-time compare)', async () => {
  // A raw timingSafeEqual over unequal-length buffers throws (→ 500). The route
  // hashes both sides to equal-length digests first, so any length just misses.
  for (const bad of ['x', 'x'.repeat(200)]) {
    const res = await sweep({ 'x-sweep-secret': bad });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  }
});

test('200 + full report shape on the correct secret (empty DB → all zeros)', async () => {
  const res = await sweep({ 'x-sweep-secret': SWEEP_SECRET });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(ZERO_REPORT);
});

test('the report reflects real sweep work: seeded open request → opened: 1', async () => {
  await seedOpenRequest();
  const res = await sweep({ 'x-sweep-secret': SWEEP_SECRET });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...ZERO_REPORT, opened: 1 });
});

test('Authorization bearer is ignored entirely', async () => {
  // A bearer token — even a syntactically valid one — never authenticates this route...
  const denied = await sweep({ authorization: 'Bearer some-token' });
  expect(denied.statusCode).toBe(401);

  // ...and a garbage bearer never interferes when the sweep secret is right.
  const allowed = await sweep({
    authorization: 'Bearer garbage',
    'x-sweep-secret': SWEEP_SECRET,
  });
  expect(allowed.statusCode).toBe(200);
});
