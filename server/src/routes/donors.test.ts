import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import type { AuthUser } from '../auth/verifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import { eligibleDonors } from '../matching/eligibility.js';
import { FakePushSender } from '../push/fakePushSender.js';
import type { PushResult } from '../push/pushSender.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
});

// Geohash-5 cells resolving (via ngeohash + tz-lookup) to known IANA zones:
// Manhattan → America/New_York, LA → America/Los_Angeles.
const MANHATTAN = 'dr5ru';
const LA = '9q5ct';
const HOSP_LAT = 40.758;
const HOSP_LNG = -73.9855;
// 17:00Z = 13:00 EDT — afternoon in NY, so quiet hours never suppress the match.
const DAYTIME = new Date('2026-07-20T17:00:00Z');

const TOK_1 = 'tok-1';
const UID_1 = 'uid-1';
const PHONE_1 = '+15550000001';
const TOK_NOPHONE = 'tok-nophone';
const UID_NOPHONE = 'uid-nophone';
const DEAD_TOKEN = 'dead-token-xyz';

const VERIFIER = new FakeTokenVerifier(
  new Map<string, AuthUser>([
    [TOK_1, { uid: UID_1, phone: PHONE_1 }],
    [TOK_NOPHONE, { uid: UID_NOPHONE, phone: null }],
  ]),
);

interface DonorRow {
  firebase_uid: string;
  handle: string;
  blood_group: string;
  geohash5: string;
  tz: string;
  phone: string;
  push_token: string | null;
  push_verified_at: Date | null;
  share_phone_on_accept: boolean;
  opted_in: boolean;
  available: boolean;
  last_donation_at: Date | null;
}
const DONOR_SQL = `
  SELECT firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
         push_verified_at, share_phone_on_accept, opted_in, available, last_donation_at
  FROM donor WHERE firebase_uid = $1`;

let db: PGlite;
let app: FastifyInstance;
let push: FakePushSender;
let requestId: string;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  firstRow(await db.query<T>(sql, params));
const donorRow = (uid: string) => db.query<DonorRow>(DONOR_SQL, [uid]);
const headers = (t: string | null): Record<string, string> =>
  t === null ? {} : { authorization: `Bearer ${t}` };
const body = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  handle: 'nightbird', bloodGroup: 'O-', geohash5: MANHATTAN, consent: true, ...o,
});
const post = (t: string | null, url: string, b?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: headers(t), payload: b ?? {} });
const register = (t: string | null, o: Record<string, unknown> = {}) => post(t, '/donors', body(o));
const getMe = (t: string) => app.inject({ method: 'GET', url: '/donors/me', headers: headers(t) });
const patchMe = (t: string, b: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/donors/me', headers: headers(t), payload: b });
const putToken = (t: string, b: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/donors/me/push-token', headers: headers(t), payload: b });
const donorId = async (uid: string): Promise<string> =>
  firstRow(await db.query<{ donor_id: string }>('SELECT donor_id FROM donor WHERE firebase_uid = $1', [uid]))
    .donor_id;

async function seedActivePledge(id: string): Promise<void> {
  await db.query(
    `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
     VALUES ($1::uuid, $2::uuid, 'x', 'O-'::blood_group, 'le_1h'::eta_bucket, 'active'::pledge_state)`,
    [requestId, id],
  );
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`); // pin session tz for make_interval day math
  const hospitalId = (
    await one<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown', 'Times Square', $1, $2, 'HOSPITAL_BLOODBANK_PHONE') RETURNING hospital_id`,
      [HOSP_LAT, HOSP_LNG],
    )
  ).hospital_id;
  const requesterId = (
    await one<{ requester_id: string }>(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ('uid-req', true, $1, 'REQ_PHONE') RETURNING requester_id`,
      [hospitalId],
    )
  ).requester_id;
  requestId = (
    await one<{ request_id: string }>(
      `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, expires_at)
       VALUES ($1, $2, 'O-'::blood_group, 1, 'standard', now() + interval '1 day') RETURNING request_id`,
      [requesterId, hospitalId],
    )
  ).request_id;
  push = new FakePushSender(new Map<string, PushResult>([[DEAD_TOKEN, 'dead_token']]));
  app = buildApp({ config: CONFIG, verifier: VERIFIER, db, push, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE donor CASCADE'); // cascades to dispatch + pledge
  push.sent.length = 0;
});
test('POST /donors 201: row persisted field-by-field, gates set, tz derived, token NULL', async () => {
  const res = await register(TOK_1);
  expect(res.statusCode).toBe(201);
  expect(res.json()).toEqual({ donorId: expect.any(String), handle: 'nightbird', bloodGroup: 'O-', geohash5: MANHATTAN, tz: 'America/New_York' });
  const row = firstRow(await donorRow(UID_1));
  expect(row.firebase_uid).toBe(UID_1);
  expect(row.handle).toBe('nightbird');
  expect(row.blood_group).toBe('O-');
  expect(row.geohash5).toBe(MANHATTAN);
  expect(row.tz).toBe('America/New_York');
  expect(row.phone).toBe(PHONE_1); // phone comes from the OTP claim, not the body
  expect(row.opted_in).toBe(true); // consent gate
  expect(row.available).toBe(true); // intent gate
  expect(row.share_phone_on_accept).toBe(false);
  expect(row.push_token).toBeNull();
  expect(row.push_verified_at).toBeNull(); // not yet in the matching pool
});
test('401 when no bearer token is presented', async () => {
  expect((await register(null)).statusCode).toBe(401);
});
test('403 phone_auth_required when the token carries no phone claim', async () => {
  const res = await register(TOK_NOPHONE);
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'phone_auth_required' });
  expect((await donorRow(UID_NOPHONE)).rows).toHaveLength(0); // nothing inserted
});
test('400 on bad geohash, missing consent, and consent:false', async () => {
  for (const b of [body({ geohash5: 'abcde' }), body({ consent: undefined }), body({ consent: false })]) {
    expect((await post(TOK_1, '/donors', b)).statusCode).toBe(400);
  }
});
test('409 already_registered when the same uid registers twice', async () => {
  expect((await register(TOK_1)).statusCode).toBe(201);
  const dup = await register(TOK_1, { handle: 'other' });
  expect(dup.statusCode).toBe(409);
  expect(dup.json()).toEqual({ error: 'already_registered' });
});
test('GET /donors/me returns the view; never exposes pushToken or firebaseUid', async () => {
  await register(TOK_1);
  const res = await getMe(TOK_1);
  expect(res.statusCode).toBe(200);
  const b = res.json<Record<string, unknown>>();
  expect(Object.keys(b).sort()).toEqual(['activePledge', 'available', 'bloodGroup', 'donorId', 'geohash5', 'handle',
    'lastDonationAt', 'optedIn', 'pushVerified', 'sharePhoneOnAccept', 'snoozeUntil', 'travelRadiusKm', 'tz']);
  expect(b).not.toHaveProperty('pushToken');
  expect(b).not.toHaveProperty('push_token');
  expect(b).not.toHaveProperty('firebaseUid');
  expect(b).not.toHaveProperty('phone');
  expect(b.pushVerified).toBe(false);
  expect(b.snoozeUntil).toBeNull();
  expect(b.lastDonationAt).toBeNull();
  expect(b.activePledge).toBeNull(); // no pledge → the null shape
});
// GB-32 (b): a reload has to find the donor's live pledge somewhere, and the
// donor's own row is the one thing the client always fetches on boot.
test('GET /donors/me activePledge: the live pledge + its alert id, null once released', async () => {
  await register(TOK_1);
  const id = await donorId(UID_1);
  const dispatchId = firstRow(
    await db.query<{ dispatch_id: string }>(
      `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1::uuid, $2::uuid, 0)
       RETURNING dispatch_id`,
      [requestId, id],
    ),
  ).dispatch_id;
  await seedActivePledge(id);
  const pledgeId = firstRow(
    await db.query<{ pledge_id: string }>(`SELECT pledge_id FROM pledge WHERE donor_id = $1::uuid`, [id]),
  ).pledge_id;

  const res = await getMe(TOK_1);
  expect(res.statusCode).toBe(200);
  // alertId is the donor's OWN dispatch id — what GET /alerts/:alertId takes.
  expect(res.json<Record<string, unknown>>().activePledge).toEqual({
    pledgeId,
    alertId: dispatchId,
    requestState: 'open',
  });

  // Only 'active' counts: a released pledge is history, not a resume pointer.
  await db.query(`UPDATE pledge SET state = 'released' WHERE pledge_id = $1::uuid`, [pledgeId]);
  expect((await getMe(TOK_1)).json<Record<string, unknown>>().activePledge).toBeNull();
});
test('GET /donors/me 404 when the uid has no donor row', async () => {
  expect((await getMe(TOK_1)).statusCode).toBe(404);
});
test('PATCH toggles persist across a follow-up GET', async () => {
  await register(TOK_1);
  const snooze = '2026-08-01T12:00:00.000Z';
  const res = await patchMe(TOK_1, {
    handle: 'dayhawk', available: false, optedIn: false, snoozeUntil: snooze, sharePhoneOnAccept: true,
  });
  expect(res.statusCode).toBe(200);
  const after = (await getMe(TOK_1)).json<Record<string, unknown>>();
  expect(after.handle).toBe('dayhawk');
  expect(after.available).toBe(false);
  expect(after.optedIn).toBe(false);
  expect(after.snoozeUntil).toBe(snooze);
  expect(after.sharePhoneOnAccept).toBe(true);
});
test('PATCH empty body → 400', async () => {
  await register(TOK_1);
  expect((await patchMe(TOK_1, {})).statusCode).toBe(400);
});
test('PATCH geohash5 re-derives tz atomically (NY → LA flips the zone)', async () => {
  await register(TOK_1); // Manhattan → America/New_York
  const res = await patchMe(TOK_1, { geohash5: LA });
  expect(res.statusCode).toBe(200);
  expect(res.json<{ geohash5: string; tz: string }>()).toMatchObject({ geohash5: LA, tz: 'America/Los_Angeles' });
  const row = firstRow(await donorRow(UID_1));
  expect(row.geohash5).toBe(LA);
  expect(row.tz).toBe('America/Los_Angeles');
});
test('PATCH bloodGroup: 200 with no active pledge, 409 blood_group_locked with one', async () => {
  await register(TOK_1);
  const ok = await patchMe(TOK_1, { bloodGroup: 'A+' });
  expect(ok.statusCode).toBe(200);
  expect(ok.json<{ bloodGroup: string }>().bloodGroup).toBe('A+');
  await seedActivePledge(await donorId(UID_1));
  const locked = await patchMe(TOK_1, { bloodGroup: 'B+' });
  expect(locked.statusCode).toBe(409);
  expect(locked.json()).toEqual({ error: 'blood_group_locked' });
  expect(firstRow(await donorRow(UID_1)).blood_group).toBe('A+'); // blocked change did not persist
});
test('PUT push-token stores token, clears prior verification, sends exact VERIFY_PUSH', async () => {
  await register(TOK_1);
  expect((await putToken(TOK_1, { token: 't-first' })).statusCode).toBe(202);
  expect((await post(TOK_1, '/donors/me/push-verified')).statusCode).toBe(200);
  expect((await getMe(TOK_1)).json<{ pushVerified: boolean }>().pushVerified).toBe(true);
  push.sent.length = 0;
  const res = await putToken(TOK_1, { token: 't-second' });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toEqual({ verificationSent: true });
  const row = firstRow(await donorRow(UID_1));
  expect(row.push_token).toBe('t-second'); // new address stored
  expect(row.push_verified_at).toBeNull(); // verification cleared by rotation
  expect(push.sent).toHaveLength(1);
  expect(push.sent[0]?.token).toBe('t-second');
  expect(push.sent[0]?.payload).toEqual({ type: 'VERIFY_PUSH' }); // exact payload, no id
});
test('PUT push-token dead_token → 502 and the token is NULLed again', async () => {
  await register(TOK_1);
  const res = await putToken(TOK_1, { token: DEAD_TOKEN });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: 'push_delivery_failed' });
  const row = firstRow(await donorRow(UID_1));
  expect(row.push_token).toBeNull(); // stored then re-NULLed on dead token
  expect(row.push_verified_at).toBeNull();
  expect(push.sent[0]?.payload).toEqual({ type: 'VERIFY_PUSH' });
});
test('POST push-verified 409 without a token, 200 with one, then pushVerified true', async () => {
  await register(TOK_1);
  const noToken = await post(TOK_1, '/donors/me/push-verified');
  expect(noToken.statusCode).toBe(409);
  expect(noToken.json()).toEqual({ error: 'no_push_token' });
  await putToken(TOK_1, { token: 't-live' });
  const ok = await post(TOK_1, '/donors/me/push-verified');
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ pushVerified: true });
  expect(firstRow(await donorRow(UID_1)).push_verified_at).not.toBeNull();
  expect((await getMe(TOK_1)).json<{ pushVerified: boolean }>().pushVerified).toBe(true);
});
test('donations: default now; past accepted but never moves stamp backward (max); future 400', async () => {
  await register(TOK_1);
  const before = Date.now();
  const now = await post(TOK_1, '/donors/me/donations'); // default = now
  expect(now.statusCode).toBe(200);
  const nowStamp = now.json<{ lastDonationAt: string }>().lastDonationAt;
  const ts = new Date(nowStamp).getTime();
  expect(ts).toBeGreaterThanOrEqual(before - 2000);
  expect(ts).toBeLessThanOrEqual(Date.now() + 2000);
  // Explicit past self-report: accepted (200) but max() keeps the later "now" — no backward move.
  const past = await post(TOK_1, '/donors/me/donations', { donatedAt: '2026-01-01T00:00:00.000Z' });
  expect(past.statusCode).toBe(200);
  expect(past.json<{ lastDonationAt: string }>().lastDonationAt).toBe(nowStamp);
  // Future timestamps are rejected.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const futureRes = await post(TOK_1, '/donors/me/donations', { donatedAt: future });
  expect(futureRes.statusCode).toBe(400);
  expect(futureRes.json()).toEqual({ error: 'future_donation' });
});
test('pool entry: register → token → verified makes the donor match eligibleDonors', async () => {
  const args = { bloodGroup: 'O-' as const, hospitalLat: HOSP_LAT, hospitalLng: HOSP_LNG, tierIdx: 0 as const, urgency: 'standard' as const, requestId: null, now: DAYTIME };
  const matches = () => eligibleDonors(db, args).then((ds) => ds.map((d) => d.donorId));
  const id = (await register(TOK_1)).json<{ donorId: string }>().donorId;
  expect(await matches()).not.toContain(id); // no token, unverified
  await putToken(TOK_1, { token: 't-pool' });
  expect(await matches()).not.toContain(id); // token set but push_verified_at still NULL
  await post(TOK_1, '/donors/me/push-verified');
  expect(await matches()).toContain(id); // verified → in the pool
});