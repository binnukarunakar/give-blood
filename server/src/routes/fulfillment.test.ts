// Fulfillment route tests (GB-14) — PGlite + migrations + buildApp +
// FakeTokenVerifier + inject. One hospital, two requesters (owner + foreign) and
// a donor pool are seeded once; each test seeds its own request/pledge rows and
// truncates them between runs. Donors survive the truncate; last_donation_at is
// reset each test so cooldown assertions start clean.
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

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
/** Per-donor push token, so a recorded send identifies exactly who was notified. */
const dpush = (n: number): string => `push-d${n}`;
const HANDLES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'] as const;
const TOK_A = 'tok-req-a'; // owning requester
const TOK_B = 'tok-req-b'; // foreign requester
/** Tolerance between the test clock and the DB's now() for "stamped ≈ now". */
const CLOCK_SKEW_MS = 60_000;

let db: PGlite;
let app: FastifyInstance;
let push: FakePushSender;
let donorIds: string[] = [];
let hospitalId: string;
let requesterAId: string;
let requesterBId: string;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}
function did(n: number): string {
  const id = donorIds[n - 1];
  if (id === undefined) throw new Error(`no seeded donor d${n}`);
  return id;
}
function dtok(n: number): string {
  return `tok-d${n}`;
}

async function seedDonor(uid: string, handle: string, phone: string, token: string): Promise<string> {
  return firstRow(
    await db.query<{ donor_id: string }>(
      `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                          push_verified_at, opted_in, available)
       VALUES ($1, $2, 'B+', 'dr5ru', 'America/New_York', $3, $4, now(), true, true) RETURNING donor_id`,
      [uid, handle, phone, token],
    ),
  ).donor_id;
}
/** A closure notice needs the donor's own dispatch on that request to point at. */
async function seedDispatch(reqId: string, donorId: string): Promise<string> {
  return firstRow(
    await db.query<{ dispatch_id: string }>(
      `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1::uuid, $2::uuid, 0)
       RETURNING dispatch_id`,
      [reqId, donorId],
    ),
  ).dispatch_id;
}
async function seedRequester(uid: string): Promise<string> {
  return firstRow(
    await db.query<{ requester_id: string }>(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ($1, true, $2, 'REQUESTER_PHONE') RETURNING requester_id`,
      [uid, hospitalId],
    ),
  ).requester_id;
}
async function seedRequest(ownerId: string, state: string, unitsNeeded = 2): Promise<string> {
  return firstRow(
    await db.query<{ request_id: string }>(
      `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, state, expires_at)
       VALUES ($1, $2, 'B+', $3::int, 'standard', $4::request_state, now() + interval '1 day') RETURNING request_id`,
      [ownerId, hospitalId, unitsNeeded, state],
    ),
  ).request_id;
}
async function seedPledge(reqId: string, donorId: string, state = 'active'): Promise<string> {
  return firstRow(
    await db.query<{ pledge_id: string }>(
      `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
       VALUES ($1, $2, 'seed', 'B+', 'le_1h', $3::pledge_state) RETURNING pledge_id`,
      [reqId, donorId, state],
    ),
  ).pledge_id;
}

// Read accessors used across assertions.
async function reqState(id: string): Promise<string> {
  return firstRow(await db.query<{ state: string }>(`SELECT state FROM request WHERE request_id = $1::uuid`, [id])).state;
}
async function pledgeStateOf(id: string): Promise<string> {
  return firstRow(await db.query<{ state: string }>(`SELECT state FROM pledge WHERE pledge_id = $1::uuid`, [id])).state;
}
async function unitsConfirmedOf(id: string): Promise<number> {
  return firstRow(
    await db.query<{ units_confirmed: number }>(`SELECT units_confirmed FROM request WHERE request_id = $1::uuid`, [id]),
  ).units_confirmed;
}
async function activeCount(id: string): Promise<number> {
  return firstRow(
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pledge WHERE request_id = $1::uuid AND state = 'active'`, [id]),
  ).n;
}
async function lastDonationAt(donorId: string): Promise<Date | null> {
  return firstRow(
    await db.query<{ last_donation_at: Date | null }>(`SELECT last_donation_at FROM donor WHERE donor_id = $1::uuid`, [donorId]),
  ).last_donation_at;
}

function post(url: string, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}
const donated = (pledgeId: string, token?: string) => post(`/pledges/${pledgeId}/donated`, token);
const noShow = (pledgeId: string, token?: string) => post(`/pledges/${pledgeId}/no-show`, token);
const withdraw = (pledgeId: string, token?: string) => post(`/pledges/${pledgeId}/withdraw`, token);
const cancel = (requestId: string, token?: string) => post(`/requests/${requestId}/cancel`, token);

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);

  hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown Hospital', '1 Times Sq, New York', 40.758000, -73.985500, 'HOSPITAL_BLOODBANK_PHONE')
       RETURNING hospital_id`,
    ),
  ).hospital_id;
  requesterAId = await seedRequester('uid-req-a');
  requesterBId = await seedRequester('uid-req-b');

  const verifierEntries: [string, AuthUser][] = [
    [TOK_A, { uid: 'uid-req-a', phone: null }],
    [TOK_B, { uid: 'uid-req-b', phone: null }],
  ];
  donorIds = [];
  for (let n = 1; n <= HANDLES.length; n += 1) {
    donorIds.push(await seedDonor(`uid-d${n}`, HANDLES[n - 1] ?? `donor${n}`, `DONOR_PHONE_${n}`, dpush(n)));
    verifierEntries.push([dtok(n), { uid: `uid-d${n}`, phone: null }]);
  }

  push = new FakePushSender();
  app = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(new Map(verifierEntries)),
    db,
    push,
    logger: false,
  });
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE request CASCADE'); // cascades to dispatch + pledge; donors survive
  await db.query(`UPDATE donor SET last_donation_at = NULL`); // clean cooldown baseline
  push.sent.length = 0;
});

test('401 when no token is presented on every route', async () => {
  expect((await donated(ABSENT_UUID)).statusCode).toBe(401);
  expect((await noShow(ABSENT_UUID)).statusCode).toBe(401);
  expect((await withdraw(ABSENT_UUID)).statusCode).toBe(401);
  expect((await cancel(ABSENT_UUID)).statusCode).toBe(401);
});

test('donated happy: 200 shape, units_confirmed 0→1, cooldown stamped ≈ now, state unchanged', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(1));

  const res = await donated(pid, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ pledgeState: 'donated', requestState: 'partially_pledged', unitsConfirmed: 1 });
  expect(await pledgeStateOf(pid)).toBe('donated');
  expect(await unitsConfirmedOf(reqId)).toBe(1);

  const stamped = await lastDonationAt(did(1));
  expect(stamped).not.toBeNull();
  expect(Math.abs(Date.now() - (stamped as Date).getTime())).toBeLessThan(CLOCK_SKEW_MS);
});

test('dual-path GREATEST: donor self-reported yesterday, requester confirms today → today wins', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(2));
  await db.query(`UPDATE donor SET last_donation_at = now() - interval '1 day' WHERE donor_id = $1::uuid`, [did(2)]);
  const before = (await lastDonationAt(did(2))) as Date;

  expect((await donated(pid, TOK_A)).statusCode).toBe(200);
  const after = (await lastDonationAt(did(2))) as Date;
  expect(after.getTime()).toBeGreaterThan(before.getTime()); // moved forward to ~now
  expect(Math.abs(Date.now() - after.getTime())).toBeLessThan(CLOCK_SKEW_MS);
});

test('dual-path never-backward: donor stamp later than confirm-time now → unchanged', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(3));
  // Seed a self-report AHEAD of the route's now() via direct SQL; GREATEST must keep it.
  await db.query(`UPDATE donor SET last_donation_at = now() + interval '1 day' WHERE donor_id = $1::uuid`, [did(3)]);
  const before = (await lastDonationAt(did(3))) as Date;

  expect((await donated(pid, TOK_A)).statusCode).toBe(200);
  const after = (await lastDonationAt(did(3))) as Date;
  expect(after.getTime()).toBe(before.getTime()); // never moved backward
});

test('fulfillment: units=1, one donated → request fulfilled, sibling active pledge released', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 1); // threshold ceil(1×1.5)=2
  const pid1 = await seedPledge(reqId, did(1));
  const pid2 = await seedPledge(reqId, did(2));

  const res = await donated(pid1, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ pledgeState: 'donated', requestState: 'fulfilled', unitsConfirmed: 1 });
  expect(await pledgeStateOf(pid1)).toBe('donated');
  expect(await pledgeStateOf(pid2)).toBe('released');
  expect(await reqState(reqId)).toBe('fulfilled');
  expect(await activeCount(reqId)).toBe(0);
});

test('donated on a non-active pledge → 409 not_active', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(4), 'released');
  const res = await donated(pid, TOK_A);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'not_active', state: 'released' });
  expect(await unitsConfirmedOf(reqId)).toBe(0); // nothing counted
  expect(await lastDonationAt(did(4))).toBeNull(); // no cooldown stamped
});

test('no-show: covered (3 active, units 2) → covered→partially_pledged regression', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 2); // threshold 3
  const pid = await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));
  await seedPledge(reqId, did(3));

  const res = await noShow(pid, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ pledgeState: 'no_show', requestState: 'partially_pledged' });
  expect(await reqState(reqId)).toBe('partially_pledged');
  expect(await activeCount(reqId)).toBe(2);
  expect(await lastDonationAt(did(1))).toBeNull(); // no penalty, no cooldown
});

test('no-show: partially_pledged with 2 active → stays partially_pledged', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));

  const res = await noShow(pid, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json<{ requestState: string }>().requestState).toBe('partially_pledged');
  expect(await activeCount(reqId)).toBe(1);
});

test('no-show: last active pledge no-shows → alerting', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(1));

  const res = await noShow(pid, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json<{ requestState: string }>().requestState).toBe('alerting');
  expect(await reqState(reqId)).toBe('alerting');
  expect(await activeCount(reqId)).toBe(0);
});

test('withdraw (donor auth): same covered→partially_pledged regression, penalty-free', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 2); // threshold 3
  const pid = await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));
  await seedPledge(reqId, did(3));

  const res = await withdraw(pid, dtok(1));
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ pledgeState: 'withdrawn', requestState: 'partially_pledged' });
  expect(await reqState(reqId)).toBe('partially_pledged');
  expect(await activeCount(reqId)).toBe(2);
  expect(await lastDonationAt(did(1))).toBeNull(); // no penalty, no cooldown
});

test('ownership: requester CANNOT withdraw (404), donor CANNOT mark donated (404)', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pid = await seedPledge(reqId, did(1));

  expect((await withdraw(pid, TOK_A)).statusCode).toBe(404); // requester on the donor-only route
  expect((await donated(pid, dtok(1))).statusCode).toBe(404); // donor on a requester-only route
  expect(await pledgeStateOf(pid)).toBe('active'); // neither miss mutated the pledge
});

test('cancel: request cancelled, all active pledges released, count returned', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 2);
  await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));
  await seedPledge(reqId, did(3));

  const res = await cancel(reqId, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ requestState: 'cancelled', pledgesReleased: 3 });
  expect(await reqState(reqId)).toBe('cancelled');
  expect(await activeCount(reqId)).toBe(0);
});

// GB-32 (3): PROTOCOL promises closure notices; only the sweep's expiry pass
// sent them, so a cancel or a fulfilment left pledged donors waiting silently.
test('cancel: one REQUEST_CLOSED per released donor, addressed to their own dispatch', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 2);
  const d1 = await seedDispatch(reqId, did(1));
  const d2 = await seedDispatch(reqId, did(2));
  await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));

  const res = await cancel(reqId, TOK_A);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ requestState: 'cancelled', pledgesReleased: 2 });
  // Post-commit and best-effort, but sent before the response returns.
  expect(push.sent).toHaveLength(2);
  expect(
    [...push.sent].sort((a, b) => a.token.localeCompare(b.token)),
  ).toEqual([
    { token: dpush(1), payload: { type: 'REQUEST_CLOSED', alertId: d1 } },
    { token: dpush(2), payload: { type: 'REQUEST_CLOSED', alertId: d2 } },
  ]);
});

test('fulfil: the released sibling is notified, the donor who donated is NOT', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 1); // one donation fulfils it
  await seedDispatch(reqId, did(1)); // the donor who donates
  const d2 = await seedDispatch(reqId, did(2)); // the released sibling
  const pid1 = await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));

  expect((await donated(pid1, TOK_A)).statusCode).toBe(200);
  expect(await reqState(reqId)).toBe('fulfilled');
  // Exactly one notice: a 'donated' pledge is not a released one.
  expect(push.sent).toEqual([{ token: dpush(2), payload: { type: 'REQUEST_CLOSED', alertId: d2 } }]);
});

test('no closure notice for a donation that does NOT close the request', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2); // needs 2 units
  await seedDispatch(reqId, did(1));
  await seedDispatch(reqId, did(2));
  const pid1 = await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));

  expect((await donated(pid1, TOK_A)).statusCode).toBe(200);
  expect(await pledgeStateOf(pid1)).toBe('donated');
  expect(await activeCount(reqId)).toBe(1); // sibling still pledged — nothing closed
  expect(push.sent).toEqual([]);
});

test('a donor with no push token is silently skipped; the release still happened', async () => {
  const reqId = await seedRequest(requesterAId, 'covered', 2);
  await seedDispatch(reqId, did(1));
  const d2 = await seedDispatch(reqId, did(2));
  const pid1 = await seedPledge(reqId, did(1));
  await seedPledge(reqId, did(2));
  await db.query(`UPDATE donor SET push_token = NULL WHERE donor_id = $1::uuid`, [did(1)]);

  const res = await cancel(reqId, TOK_A);
  expect(res.json()).toEqual({ requestState: 'cancelled', pledgesReleased: 2 }); // count unaffected
  expect(await pledgeStateOf(pid1)).toBe('released');
  expect(push.sent).toEqual([{ token: dpush(2), payload: { type: 'REQUEST_CLOSED', alertId: d2 } }]);

  await db.query(`UPDATE donor SET push_token = $2 WHERE donor_id = $1::uuid`, [did(1), dpush(1)]);
});

test('a throwing PushSender changes neither the committed state nor the response', async () => {
  const throwing = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(new Map([[TOK_A, { uid: 'uid-req-a', phone: null }]])),
    db,
    push: {
      send: () => {
        throw new Error('FCM is down');
      },
    },
    logger: false,
  });
  await throwing.ready();
  try {
    const reqId = await seedRequest(requesterAId, 'covered', 2);
    await seedDispatch(reqId, did(1));
    const pid = await seedPledge(reqId, did(1));

    const res = await throwing.inject({
      method: 'POST',
      url: `/requests/${reqId}/cancel`,
      headers: { authorization: `Bearer ${TOK_A}` },
    });
    expect(res.statusCode).toBe(200); // not a 500
    expect(res.json()).toEqual({ requestState: 'cancelled', pledgesReleased: 1 });
    expect(await reqState(reqId)).toBe('cancelled'); // committed before the send
    expect(await pledgeStateOf(pid)).toBe('released');
  } finally {
    await throwing.close();
  }
});

test('cancel again → 409 already_closed; cancel an expired request → 409', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  expect((await cancel(reqId, TOK_A)).statusCode).toBe(200);

  const again = await cancel(reqId, TOK_A);
  expect(again.statusCode).toBe(409);
  expect(again.json()).toEqual({ error: 'already_closed', state: 'cancelled' });

  const expiredReq = await seedRequest(requesterAId, 'expired', 2);
  const exp = await cancel(expiredReq, TOK_A);
  expect(exp.statusCode).toBe(409);
  expect(exp.json()).toEqual({ error: 'already_closed', state: 'expired' });
});

test.each([
  ['donated', donated],
  ['no-show', noShow],
])('uniform 404 trio on requester route %s (foreign / nonexistent / malformed)', async (_name, callRoute) => {
  const foreignReq = await seedRequest(requesterBId, 'partially_pledged', 2);
  const foreignPid = await seedPledge(foreignReq, did(8));
  for (const res of [
    await callRoute(foreignPid, TOK_A), // A is not the owning requester of B's request
    await callRoute(ABSENT_UUID, TOK_A), // well-formed but nonexistent
    await callRoute('not-a-uuid', TOK_A), // malformed → same 404
  ]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  }
  expect(await pledgeStateOf(foreignPid)).toBe('active'); // never touched by the misses
});

test('uniform 404 trio on donor route withdraw (foreign / nonexistent / malformed)', async () => {
  const reqId = await seedRequest(requesterAId, 'partially_pledged', 2);
  const pidD2 = await seedPledge(reqId, did(2)); // owned by d2
  for (const res of [
    await withdraw(pidD2, dtok(1)), // d1 is not the pledge's donor
    await withdraw(ABSENT_UUID, dtok(1)),
    await withdraw('not-a-uuid', dtok(1)),
  ]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  }
  expect(await pledgeStateOf(pidD2)).toBe('active');
});

test('uniform 404 trio on cancel (foreign / nonexistent / malformed)', async () => {
  const foreignReq = await seedRequest(requesterBId, 'partially_pledged', 2);
  for (const res of [
    await cancel(foreignReq, TOK_A), // A does not own B's request
    await cancel(ABSENT_UUID, TOK_A),
    await cancel('not-a-uuid', TOK_A),
  ]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  }
  expect(await reqState(foreignReq)).toBe('partially_pledged'); // request untouched
});
