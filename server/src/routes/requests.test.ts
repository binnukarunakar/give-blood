import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import type { AuthUser } from '../auth/verifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import {
  MAX_OPEN_REQUESTS_PER_REQUESTER,
  MAX_UNITS_PER_REQUEST,
  REQUEST_TTL_HOURS,
} from '../domain/protocol.js';
import { FakePushSender } from '../push/fakePushSender.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
});

const MS_PER_HOUR = 3_600_000;

// Tokens → principals. A + C are verified requesters, B is unverified, X's uid
// has no requester row at all.
const TOK_A = 'tok-a';
const TOK_B = 'tok-b';
const TOK_C = 'tok-c';
const TOK_X = 'tok-x';
const UID_A = 'uid-a';
const UID_B = 'uid-b';
const UID_C = 'uid-c';
const UID_X = 'uid-x';

const VERIFIER = new FakeTokenVerifier(
  new Map<string, AuthUser>([
    [TOK_A, { uid: UID_A, phone: null }],
    [TOK_B, { uid: UID_B, phone: null }],
    [TOK_C, { uid: UID_C, phone: null }],
    [TOK_X, { uid: UID_X, phone: null }],
  ]),
);

const SELECT_REQUEST_SQL = `
  SELECT requester_id, hospital_id, blood_group, units_needed, urgency,
         state, radius_tier, units_confirmed, expires_at
  FROM request WHERE request_id = $1::uuid
`;

interface RequestRow {
  requester_id: string;
  hospital_id: string;
  blood_group: string;
  units_needed: number;
  urgency: string;
  state: string;
  radius_tier: number;
  units_confirmed: number;
  expires_at: Date;
}

let db: PGlite;
let app: FastifyInstance;
let hospitalId: string;
let requesterA: string;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

async function seedRequester(uid: string, verified: boolean): Promise<string> {
  const res = await db.query<{ requester_id: string }>(
    `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
     VALUES ($1, $2, $3, 'REQUESTER_PHONE') RETURNING requester_id`,
    [uid, verified, hospitalId],
  );
  return firstRow(res).requester_id;
}

/** Insert a request row directly (bypasses the route) for cap/dedupe/terminal seeding. */
async function seedRequest(requesterId: string, bloodGroup: string, state: string): Promise<string> {
  const res = await db.query<{ request_id: string }>(
    `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, state, expires_at)
     VALUES ($1, $2, $3::blood_group, 1, 'standard', $4::request_state, now() + interval '1 day')
     RETURNING request_id`,
    [requesterId, hospitalId, bloodGroup, state],
  );
  return firstRow(res).request_id;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { bloodGroup: 'O-', unitsNeeded: 2, urgency: 'standard', hospitalId, ...overrides };
}

function post(token: string | null, body: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.inject({ method: 'POST', url: '/requests', headers, payload: body });
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  // make_interval / day math run in the session tz; pin UTC for determinism.
  await db.exec(`SET TIME ZONE 'UTC'`);

  hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown Hospital', 'Times Square', 40.758000, -73.985500, 'HOSPITAL_BLOODBANK_PHONE')
       RETURNING hospital_id`,
    ),
  ).hospital_id;
  requesterA = await seedRequester(UID_A, true);
  await seedRequester(UID_B, false); // unverified
  await seedRequester(UID_C, true); // second verified requester (used via TOK_C)

  app = buildApp({
    config: CONFIG,
    verifier: VERIFIER,
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
  // Clear requests between tests (cascades to dispatch/pledge); hospital +
  // requesters survive so the seeded principals stay valid.
  await db.exec('TRUNCATE request CASCADE');
});

test('401 when no bearer token is presented', async () => {
  const res = await post(null, validBody());
  expect(res.statusCode).toBe(401);
});

test('403 not_a_requester when the uid has no requester row', async () => {
  const res = await post(TOK_X, validBody());
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'not_a_requester' });
});

test('403 not_verified when the requester account is unverified', async () => {
  const res = await post(TOK_B, validBody());
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'not_verified' });
});

test('400 on invalid body: units 0, units over max, bad group, bad uuid', async () => {
  const badBodies = [
    validBody({ unitsNeeded: 0 }),
    validBody({ unitsNeeded: MAX_UNITS_PER_REQUEST + 1 }),
    validBody({ bloodGroup: 'Z+' }),
    validBody({ hospitalId: 'not-a-uuid' }),
  ];
  for (const body of badBodies) {
    const res = await post(TOK_A, body);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  }
});

test('404 unknown_hospital for a well-formed but unregistered hospital id', async () => {
  const res = await post(TOK_A, validBody({ hospitalId: '123e4567-e89b-12d3-a456-426614174000' }));
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'unknown_hospital' });
});

test('201 happy path: row persisted field-by-field, TTL 12h critical and 24h standard', async () => {
  const cases = [
    { urgency: 'critical', group: 'O-' },
    { urgency: 'standard', group: 'A-' },
  ] as const;

  for (const { urgency, group } of cases) {
    const before = Date.now();
    const res = await post(TOK_A, validBody({ urgency, bloodGroup: group, unitsNeeded: 3 }));
    const after = Date.now();
    expect(res.statusCode).toBe(201);

    const payload = res.json<{ requestId: string; state: string; expiresAt: string; warning?: string }>();
    expect(payload.state).toBe('open');
    expect(payload.warning).toBeUndefined();

    const row = firstRow(await db.query<RequestRow>(SELECT_REQUEST_SQL, [payload.requestId]));
    expect(row.requester_id).toBe(requesterA);
    expect(row.hospital_id).toBe(hospitalId);
    expect(row.blood_group).toBe(group);
    expect(row.units_needed).toBe(3);
    expect(row.urgency).toBe(urgency);
    expect(row.state).toBe('open');
    expect(row.radius_tier).toBe(0);
    expect(row.units_confirmed).toBe(0);

    const ttlMs = REQUEST_TTL_HOURS[urgency] * MS_PER_HOUR;
    const expiresMs = row.expires_at.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + ttlMs - 2000);
    expect(expiresMs).toBeLessThanOrEqual(after + ttlMs + 2000);
    // Response echo matches the persisted timestamp exactly.
    expect(new Date(payload.expiresAt).getTime()).toBe(expiresMs);
  }
});

test('409 duplicate_request: same requester repeats hospital+group within the window', async () => {
  const first = await post(TOK_A, validBody({ bloodGroup: 'B+' }));
  expect(first.statusCode).toBe(201);
  const firstId = first.json<{ requestId: string }>().requestId;

  const dup = await post(TOK_A, validBody({ bloodGroup: 'B+' }));
  expect(dup.statusCode).toBe(409);
  expect(dup.json()).toEqual({ error: 'duplicate_request', existingRequestId: firstId });
});

test('201 when differentPatient:true overrides the same-requester dedupe', async () => {
  const first = await post(TOK_A, validBody({ bloodGroup: 'B+' }));
  expect(first.statusCode).toBe(201);

  const second = await post(TOK_A, validBody({ bloodGroup: 'B+', differentPatient: true }));
  expect(second.statusCode).toBe(201);
});

test('dedupe ignores terminal-state requests: a cancelled twin does not block', async () => {
  await seedRequest(requesterA, 'B+', 'cancelled');
  const res = await post(TOK_A, validBody({ bloodGroup: 'B+' }));
  expect(res.statusCode).toBe(201);
});

test('429 too_many_open_requests at the open-request cap', async () => {
  // Distinct groups + varied NON-terminal states: proves the cap counts the
  // full OPEN_REQUEST_STATES set, and avoids tripping same-requester dedupe.
  const seeds = [
    { group: 'O-', state: 'open' },
    { group: 'O+', state: 'alerting' },
    { group: 'A-', state: 'partially_pledged' },
  ] as const;
  expect(seeds.length).toBe(MAX_OPEN_REQUESTS_PER_REQUESTER);
  for (const s of seeds) {
    await seedRequest(requesterA, s.group, s.state);
  }

  const res = await post(TOK_A, validBody({ bloodGroup: 'A+' })); // 4th distinct group
  expect(res.statusCode).toBe(429);
  expect(res.json()).toEqual({ error: 'too_many_open_requests' });
});

test('cross-requester: different requester, same hospital+group → 201 with warning', async () => {
  await seedRequest(requesterA, 'B+', 'open');
  const res = await post(TOK_C, validBody({ bloodGroup: 'B+' }));
  expect(res.statusCode).toBe(201);
  expect(res.json<{ warning?: string }>().warning).toBe('similar_open_request_exists');
});

test('warning absent when no similar open request exists', async () => {
  const res = await post(TOK_A, validBody({ bloodGroup: 'AB+' }));
  expect(res.statusCode).toBe(201);
  expect(res.json<{ warning?: string }>().warning).toBeUndefined();
});
