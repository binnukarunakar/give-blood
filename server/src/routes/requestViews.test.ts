import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import type { AuthUser } from '../auth/verifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import { FakePushSender } from '../push/fakePushSender.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
});

// A + C are verified requesters, U is UNVERIFIED (proves verified is not needed
// to VIEW), X's uid has no requester row at all.
const TOK_A = 'tok-a';
const TOK_C = 'tok-c';
const TOK_U = 'tok-u';
const TOK_X = 'tok-x';
const VERIFIER = new FakeTokenVerifier(
  new Map<string, AuthUser>([
    [TOK_A, { uid: 'uid-a', phone: null }],
    [TOK_C, { uid: 'uid-c', phone: null }],
    [TOK_U, { uid: 'uid-u', phone: null }],
    [TOK_X, { uid: 'uid-x', phone: null }],
  ]),
);

interface PledgeCardOut {
  pledgeId: string;
  donorHandle: string;
  donorBloodGroup: string;
  donorPhone: string | null;
  etaBucket: string;
  state: string;
  createdAt: string;
}
// One shape for both routes; hospital/pledges present only on the detail route.
interface RequestOut {
  requestId: string;
  bloodGroup: string;
  unitsNeeded: number;
  unitsConfirmed: number;
  urgency: string;
  state: string;
  radiusTier: number;
  hospitalId: string;
  createdAt: string;
  expiresAt: string;
  donorsAlerted: number;
  activePledges: number;
  hospital?: { name: string; address: string; bloodbankPhone: string };
  pledges?: PledgeCardOut[];
}

let db: PGlite;
let app: FastifyInstance;
let hospitalId: string;
let requesterA: string;
let requesterC: string;
let donorSeq = 0;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

function get(token: string | null, url: string) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return app.inject({ method: 'GET', url, headers });
}

async function seedRequester(uid: string, verified: boolean): Promise<string> {
  const res = await db.query<{ requester_id: string }>(
    `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
     VALUES ($1, $2, $3, 'REQUESTER_PHONE') RETURNING requester_id`,
    [uid, verified, hospitalId],
  );
  return firstRow(res).requester_id;
}

/** A fresh donor per call (unique firebase_uid/handle via a counter). */
async function seedDonor(group = 'O-'): Promise<string> {
  donorSeq += 1;
  const res = await db.query<{ donor_id: string }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, opted_in, available)
     VALUES ($1, $2, $3::blood_group, 'dr5ru', 'America/New_York', 'DONOR_PHONE', true, true)
     RETURNING donor_id`,
    [`donor-uid-${donorSeq}`, `donor-${donorSeq}`, group],
  );
  return firstRow(res).donor_id;
}

interface RequestSeed {
  group?: string;
  unitsNeeded?: number;
  unitsConfirmed?: number;
  urgency?: string;
  state?: string;
  radiusTier?: number;
  createdAt?: string;
}
async function seedRequest(requesterId: string, o: RequestSeed = {}): Promise<string> {
  const res = await db.query<{ request_id: string }>(
    `INSERT INTO request
       (requester_id, hospital_id, blood_group, units_needed, urgency,
        state, radius_tier, units_confirmed, expires_at, created_at)
     VALUES ($1, $2, $3::blood_group, $4, $5::request_urgency,
        $6::request_state, $7, $8, now() + interval '1 day', $9::timestamptz)
     RETURNING request_id`,
    [
      requesterId, hospitalId, o.group ?? 'O-', o.unitsNeeded ?? 2, o.urgency ?? 'standard',
      o.state ?? 'alerting', o.radiusTier ?? 0, o.unitsConfirmed ?? 0,
      o.createdAt ?? new Date().toISOString(),
    ],
  );
  return firstRow(res).request_id;
}

/** One dispatch (donor alerted); response defaults 'none'. Needs a real donor (FK). */
async function seedDispatch(requestId: string, response = 'none'): Promise<string> {
  const donorId = await seedDonor();
  const res = await db.query<{ dispatch_id: string }>(
    `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send, response)
     VALUES ($1, $2, 0, $3::dispatch_response) RETURNING dispatch_id`,
    [requestId, donorId, response],
  );
  return firstRow(res).dispatch_id;
}

interface PledgeSeed {
  handle?: string;
  group?: string;
  phone?: string | null;
  eta?: string;
  state?: string;
  createdAt?: string;
}
/** A pledge with explicit snapshot columns; returns { pledgeId, donorId }. */
async function seedPledge(requestId: string, o: PledgeSeed = {}): Promise<{ pledgeId: string; donorId: string }> {
  const donorId = await seedDonor(o.group ?? 'O-');
  const res = await db.query<{ pledge_id: string }>(
    `INSERT INTO pledge
       (request_id, donor_id, donor_handle, donor_blood_group, donor_phone,
        eta_bucket, state, created_at)
     VALUES ($1, $2, $3, $4::blood_group, $5, $6::eta_bucket, $7::pledge_state, $8::timestamptz)
     RETURNING pledge_id`,
    [
      requestId, donorId, o.handle ?? 'Snapshot Handle', o.group ?? 'O-', o.phone ?? null,
      o.eta ?? 'le_1h', o.state ?? 'active', o.createdAt ?? new Date().toISOString(),
    ],
  );
  return { pledgeId: firstRow(res).pledge_id, donorId };
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);
  hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown Hospital', '1 Times Square, NY', 40.758000, -73.985500, 'HOSPITAL_BLOODBANK_PHONE')
       RETURNING hospital_id`,
    ),
  ).hospital_id;
  requesterA = await seedRequester('uid-a', true);
  requesterC = await seedRequester('uid-c', true);
  await seedRequester('uid-u', false); // unverified — may still view
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
  // Requests cascade to their dispatch + pledge rows; hospital, requesters, and
  // the donor pool survive (donor is not FK-dependent on request).
  await db.exec('TRUNCATE request CASCADE');
});

// ── Auth ────────────────────────────────────────────────────────────────────

test('401 when no bearer token is presented', async () => {
  expect((await get(null, '/requests/mine')).statusCode).toBe(401);
});

test('403 not_a_requester when the uid has no requester row', async () => {
  const res = await get(TOK_X, '/requests/mine');
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'not_a_requester' });
});

test('unverified requester may still view own requests (verified not required)', async () => {
  const res = await get(TOK_U, '/requests/mine');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual([]);
});

// ── GET /requests/mine ────────────────────────────────────────────────────────

test('mine: empty list for a requester with no requests', async () => {
  const res = await get(TOK_A, '/requests/mine');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual([]);
});

test('mine: newest-first, only own requests, with correct aggregates', async () => {
  await seedRequest(requesterC, { group: 'A+' }); // C's request must never appear in A's list

  const older = await seedRequest(requesterA, {
    group: 'B+', unitsNeeded: 3, unitsConfirmed: 1, urgency: 'critical',
    state: 'partially_pledged', radiusTier: 2, createdAt: '2026-07-01T10:00:00.000Z',
  });
  const newer = await seedRequest(requesterA, { group: 'O-', createdAt: '2026-07-10T10:00:00.000Z' });

  // older: 3 dispatches, mixed responses (count is over ALL rows, not just
  // 'none'); 2 active pledges + 1 withdrawn (active count ignores withdrawn).
  await seedDispatch(older, 'none');
  await seedDispatch(older, 'accepted');
  await seedDispatch(older, 'declined');
  await seedPledge(older, { state: 'active' });
  await seedPledge(older, { state: 'active' });
  await seedPledge(older, { state: 'withdrawn' });

  const list = (await get(TOK_A, '/requests/mine')).json<RequestOut[]>();
  expect(list.map((r) => r.requestId)).toEqual([newer, older]); // newest first
  expect(list[1]!).toMatchObject({
    requestId: older, bloodGroup: 'B+', unitsNeeded: 3, unitsConfirmed: 1, urgency: 'critical',
    state: 'partially_pledged', radiusTier: 2, hospitalId,
    donorsAlerted: 3, // over all dispatch rows regardless of response
    activePledges: 2, // withdrawn excluded
  });
  expect(list[0]!).toMatchObject({ donorsAlerted: 0, activePledges: 0 });
});

test('mine: caps the list at 50 newest requests', async () => {
  const total = 55;
  for (let i = 0; i < total; i += 1) {
    await seedRequest(requesterA, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
  }
  const list = (await get(TOK_A, '/requests/mine')).json<RequestOut[]>();
  expect(list.length).toBe(50);
  const times = list.map((r) => new Date(r.createdAt).getTime());
  for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeLessThan(times[i - 1]!);
  expect(new Date(list[0]!.createdAt).getTime()).toBe(Date.UTC(2026, 0, 1, 0, total - 1)); // oldest 5 dropped
});

// ── GET /requests/:requestId — detail ─────────────────────────────────────────

test('detail: full shape incl. hospital + ordered cards, donorPhone null/present', async () => {
  const requestId = await seedRequest(requesterA, {
    group: 'A+', unitsNeeded: 4, unitsConfirmed: 2, urgency: 'standard',
    state: 'partially_pledged', radiusTier: 1,
  });
  await seedDispatch(requestId, 'none');
  await seedDispatch(requestId, 'accepted');
  // Two cards ordered by created_at ASC; first has no snapshot phone, second does.
  const first = await seedPledge(requestId, {
    handle: 'First Donor', group: 'A+', phone: null, eta: 'le_30m', state: 'active',
    createdAt: '2026-07-02T09:00:00.000Z',
  });
  const second = await seedPledge(requestId, {
    handle: 'Second Donor', group: 'O-', phone: 'DONOR_PHONE', eta: 'le_2h', state: 'donated',
    createdAt: '2026-07-02T11:00:00.000Z',
  });

  const res = await get(TOK_A, `/requests/${requestId}`);
  expect(res.statusCode).toBe(200);
  const body = res.json<RequestOut>();
  expect(body).toMatchObject({
    requestId, bloodGroup: 'A+', unitsNeeded: 4, unitsConfirmed: 2, urgency: 'standard',
    state: 'partially_pledged', radiusTier: 1, hospitalId,
    donorsAlerted: 2, activePledges: 1, // 'donated' is not active
  });
  expect(body.hospital).toEqual({
    name: 'Midtown Hospital', address: '1 Times Square, NY', bloodbankPhone: 'HOSPITAL_BLOODBANK_PHONE',
  });
  expect(body.pledges!.map((p) => p.pledgeId)).toEqual([first.pledgeId, second.pledgeId]); // ordered
  expect(body.pledges![0]).toEqual({
    pledgeId: first.pledgeId, donorHandle: 'First Donor', donorBloodGroup: 'A+',
    donorPhone: null, etaBucket: 'le_30m', state: 'active', createdAt: '2026-07-02T09:00:00.000Z',
  });
  expect(body.pledges![1]).toEqual({
    pledgeId: second.pledgeId, donorHandle: 'Second Donor', donorBloodGroup: 'O-',
    donorPhone: 'DONOR_PHONE', etaBucket: 'le_2h', state: 'donated', createdAt: '2026-07-02T11:00:00.000Z',
  });
});

test('detail: pledge cards are snapshots, never a live window into Donor', async () => {
  const requestId = await seedRequest(requesterA);
  const { donorId } = await seedPledge(requestId, { handle: 'Original Handle', state: 'active' });
  // Mutate the LIVE donor row AFTER the snapshot was written.
  await db.query(`UPDATE donor SET handle = 'Renamed Live' WHERE donor_id = $1::uuid`, [donorId]);
  const body = (await get(TOK_A, `/requests/${requestId}`)).json<RequestOut>();
  expect(body.pledges![0]!.donorHandle).toBe('Original Handle'); // old snapshot, not the live value
});

test('detail: withdrawn + released excluded; active + donated + no_show included', async () => {
  const requestId = await seedRequest(requesterA);
  await seedPledge(requestId, { handle: 'Active', state: 'active', createdAt: '2026-07-02T01:00:00.000Z' });
  await seedPledge(requestId, { handle: 'Donated', state: 'donated', createdAt: '2026-07-02T02:00:00.000Z' });
  await seedPledge(requestId, { handle: 'NoShow', state: 'no_show', createdAt: '2026-07-02T03:00:00.000Z' });
  await seedPledge(requestId, { handle: 'Withdrawn', state: 'withdrawn', createdAt: '2026-07-02T04:00:00.000Z' });
  await seedPledge(requestId, { handle: 'Released', state: 'released', createdAt: '2026-07-02T05:00:00.000Z' });
  const body = (await get(TOK_A, `/requests/${requestId}`)).json<RequestOut>();
  expect(body.pledges!.map((p) => p.state)).toEqual(['active', 'donated', 'no_show']);
  const handles = body.pledges!.map((p) => p.donorHandle);
  expect(handles).not.toContain('Withdrawn');
  expect(handles).not.toContain('Released');
});

test('detail: a declined dispatch changes nothing in the view', async () => {
  const requestId = await seedRequest(requesterA);
  const dispatchId = await seedDispatch(requestId, 'none');
  await seedDispatch(requestId, 'none');
  await seedPledge(requestId, { state: 'active' });
  const before = (await get(TOK_A, `/requests/${requestId}`)).json<RequestOut>();
  // A donor declines: flip an existing dispatch none→declined. donorsAlerted counts
  // the dispatch either way; there is no per-response itemization anywhere.
  await db.query(
    `UPDATE dispatch SET response = 'declined', responded_at = now() WHERE dispatch_id = $1::uuid`,
    [dispatchId],
  );
  const after = (await get(TOK_A, `/requests/${requestId}`)).json<RequestOut>();
  expect(after).toEqual(before);
  expect(after.donorsAlerted).toBe(2);
});

test('privacy: no Donor-table field ever appears on a pledge card', async () => {
  const requestId = await seedRequest(requesterA);
  await seedPledge(requestId, { state: 'active' });
  await seedPledge(requestId, { state: 'donated', createdAt: '2026-07-03T00:00:00.000Z' });
  const body = (await get(TOK_A, `/requests/${requestId}`)).json<RequestOut>();
  const allowed = new Set(['pledgeId', 'donorHandle', 'donorBloodGroup', 'donorPhone', 'etaBucket', 'state', 'createdAt']);
  const forbidden = ['donorId', 'donor_id', 'geohash5', 'tz', 'pushToken', 'push_token', 'lastAlertedAt'];
  expect(body.pledges!.length).toBe(2);
  for (const card of body.pledges!) {
    expect(new Set(Object.keys(card))).toEqual(allowed);
    for (const key of forbidden) expect(card).not.toHaveProperty(key);
  }
  // Whole-response guard: the serialized detail carries no donor-id / geo / tz token.
  const raw = JSON.stringify(body);
  for (const token of ['donor_id', 'donorId', 'geohash5', '"tz"', 'push_token']) {
    expect(raw).not.toContain(token);
  }
});

// ── Uniform 404 (malformed / nonexistent / foreign are indistinguishable) ─────

test('detail: malformed, nonexistent, and foreign ids all return an identical 404', async () => {
  const foreign = await seedRequest(requesterC); // owned by C, requested by A
  for (const id of ['not-a-uuid', '123e4567-e89b-12d3-a456-426614174000', foreign]) {
    const res = await get(TOK_A, `/requests/${id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  }
});

test('detail: 403 not_a_requester is resolved before any 404', async () => {
  expect((await get(TOK_X, '/requests/123e4567-e89b-12d3-a456-426614174000')).statusCode).toBe(403);
});
