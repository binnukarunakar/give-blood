// Accept / decline route tests — PGlite + migrations + buildApp + FakeTokenVerifier
// + inject. Hospital, requester and a donor pool are seeded once; each test seeds
// its own request/dispatch/pledge rows and truncates them between runs.
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import type { AuthUser } from '../auth/verifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import { coveredThreshold } from '../domain/requestFsm.js';
import { FakePushSender } from '../push/fakePushSender.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
});

// Hospital coords come back as numeric strings; Number() gives the payload form.
const HOSPITAL_LAT = 40.758;
const HOSPITAL_LNG = -73.9855;
const EXPECTED_DIRECTIONS = `https://www.google.com/maps/dir/?api=1&destination=${HOSPITAL_LAT},${HOSPITAL_LNG}`;
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

// Eight donors (d1..d8); token for donor n is `tok-d${n}`, handle is HANDLES[n-1].
const HANDLES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'] as const;
const GHOST_TOKEN = 'tok-ghost'; // valid token, uid with no donor row

interface DispatchStateRow {
  response: string;
  responded_at: Date | null;
}

let db: PGlite;
let app: FastifyInstance;
let donorIds: string[] = [];
let hospitalId: string;
let requesterId: string;

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

async function seedDonor(uid: string, handle: string, phone: string): Promise<string> {
  return firstRow(
    await db.query<{ donor_id: string }>(
      `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                          push_verified_at, opted_in, available)
       VALUES ($1, $2, 'B+', 'dr5ru', 'America/New_York', $3, 'tok', now(), true, true) RETURNING donor_id`,
      [uid, handle, phone],
    ),
  ).donor_id;
}
async function seedRequest(state: string, unitsNeeded = 2): Promise<string> {
  return firstRow(
    await db.query<{ request_id: string }>(
      `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, state, expires_at)
       VALUES ($1, $2, 'B+', $3::int, 'standard', $4::request_state, now() + interval '1 day') RETURNING request_id`,
      [requesterId, hospitalId, unitsNeeded, state],
    ),
  ).request_id;
}
async function seedDispatch(reqId: string, donorId: string): Promise<string> {
  return firstRow(
    await db.query<{ dispatch_id: string }>(
      `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1, $2, 0) RETURNING dispatch_id`,
      [reqId, donorId],
    ),
  ).dispatch_id;
}
/** Pre-existing active pledge for a donor on a request (occupies a slot). */
async function seedActivePledge(reqId: string, donorId: string): Promise<void> {
  await db.query(
    `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
     VALUES ($1, $2, 'seed', 'B+', 'le_1h', 'active')`,
    [reqId, donorId],
  );
}

// Read accessors used across assertions.
async function reqState(id: string): Promise<string> {
  return firstRow(await db.query<{ state: string }>(`SELECT state FROM request WHERE request_id = $1::uuid`, [id])).state;
}
async function activeCount(id: string): Promise<number> {
  return firstRow(
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pledge WHERE request_id = $1::uuid AND state = 'active'`, [id]),
  ).n;
}
async function pledgeCount(id: string): Promise<number> {
  return firstRow(await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pledge WHERE request_id = $1::uuid`, [id])).n;
}
async function dispatchRow(id: string): Promise<DispatchStateRow> {
  return firstRow(
    await db.query<DispatchStateRow>(`SELECT response, responded_at FROM dispatch WHERE dispatch_id = $1::uuid`, [id]),
  );
}
async function pledgePhone(id: string): Promise<string | null> {
  return firstRow(await db.query<{ donor_phone: string | null }>(`SELECT donor_phone FROM pledge WHERE pledge_id = $1::uuid`, [id]))
    .donor_phone;
}

function accept(dispatchId: string, token?: string, body: Record<string, unknown> = { etaBucket: 'le_1h' }) {
  return app.inject({
    method: 'POST',
    url: `/alerts/${dispatchId}/accept`,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    payload: body,
  });
}
function decline(dispatchId: string, token?: string) {
  return app.inject({
    method: 'POST',
    url: `/alerts/${dispatchId}/decline`,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

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
  requesterId = firstRow(
    await db.query<{ requester_id: string }>(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ('uid_requester', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
      [hospitalId],
    ),
  ).requester_id;

  const verifierEntries: [string, AuthUser][] = [[GHOST_TOKEN, { uid: 'uid-ghost', phone: null }]];
  donorIds = [];
  for (let n = 1; n <= HANDLES.length; n += 1) {
    donorIds.push(await seedDonor(`uid-d${n}`, HANDLES[n - 1] ?? `donor${n}`, `DONOR_PHONE_${n}`));
    verifierEntries.push([dtok(n), { uid: `uid-d${n}`, phone: null }]);
  }

  app = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(new Map(verifierEntries)),
    db,
    push: new FakePushSender(),
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
  await db.query(`UPDATE donor SET share_phone_on_accept = false`); // clean toggle baseline
});

test('401 when no token is presented (accept + decline)', async () => {
  expect((await accept(ABSENT_UUID)).statusCode).toBe(401);
  expect((await decline(ABSENT_UUID)).statusCode).toBe(401);
});

test('404 uniform: unknown uid, foreign dispatch, nonexistent id, malformed id', async () => {
  const dOfD1 = await seedDispatch(await seedRequest('open'), did(1));
  for (const res of [
    await accept(dOfD1, GHOST_TOKEN), // valid token, no donor row
    await accept(dOfD1, dtok(2)), // d2 does not own d1's dispatch
    await accept(ABSENT_UUID, dtok(1)), // well-formed but nonexistent
    await accept('not-a-uuid', dtok(1)), // malformed → same 404
    await decline(dOfD1, dtok(2)), // decline mirrors the uniform 404
  ]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  }
  expect((await dispatchRow(dOfD1)).response).toBe('none'); // never touched by the misses
});

test('accept happy: 200 shape, snapshots, dispatch accepted, request open→partially_pledged', async () => {
  const reqId = await seedRequest('open', 2);
  const dId = await seedDispatch(reqId, did(1));

  const res = await accept(dId, dtok(1), { etaBucket: 'le_1h' });
  expect(res.statusCode).toBe(200);
  const body = res.json() as Record<string, unknown>;
  expect(typeof body.pledgeId).toBe('string');
  expect(body.requestState).toBe('partially_pledged');
  expect(body.directionsUrl).toBe(EXPECTED_DIRECTIONS);
  expect(body.hospital).toEqual({
    name: 'Midtown Hospital',
    lat: HOSPITAL_LAT,
    lng: HOSPITAL_LNG,
    bloodbankPhone: 'HOSPITAL_BLOODBANK_PHONE',
  });

  // No donor coordinates anywhere — destination only, never an origin.
  expect(body.directionsUrl as string).not.toContain('origin');
  for (const k of ['geohash5', 'donorLat', 'donorLng', 'origin', 'distanceKm', 'donorId']) {
    expect(body).not.toHaveProperty(k);
  }
  expect(body.hospital as Record<string, unknown>).not.toHaveProperty('geohash5');

  // Pledge row snapshots, field-by-field; phone NULL because the toggle is off.
  const pledge = firstRow(
    await db.query<Record<string, unknown>>(
      `SELECT request_id, donor_id, donor_handle, donor_blood_group, donor_phone, eta_bucket, state
       FROM pledge WHERE pledge_id = $1::uuid`,
      [body.pledgeId as string],
    ),
  );
  expect(pledge).toEqual({
    request_id: reqId,
    donor_id: did(1),
    donor_handle: 'alice',
    donor_blood_group: 'B+',
    donor_phone: null,
    eta_bucket: 'le_1h',
    state: 'active',
  });

  const disp = await dispatchRow(dId);
  expect(disp.response).toBe('accepted');
  expect(disp.responded_at).not.toBeNull();
  expect(await reqState(reqId)).toBe('partially_pledged');
});

test('sharePhone:true updates the donor toggle AND snapshots the phone', async () => {
  const dId = await seedDispatch(await seedRequest('open'), did(2));
  const res = await accept(dId, dtok(2), { etaBucket: 'le_30m', sharePhone: true });
  expect(res.statusCode).toBe(200);
  expect(await pledgePhone(res.json<{ pledgeId: string }>().pledgeId)).toBe('DONOR_PHONE_2');
  const donor = firstRow(
    await db.query<{ share_phone_on_accept: boolean }>(`SELECT share_phone_on_accept FROM donor WHERE donor_id = $1::uuid`, [did(2)]),
  );
  expect(donor.share_phone_on_accept).toBe(true);
});

test('sharePhone absent but donor toggle already true → snapshot phone present', async () => {
  await db.query(`UPDATE donor SET share_phone_on_accept = true WHERE donor_id = $1::uuid`, [did(3)]);
  const dId = await seedDispatch(await seedRequest('open'), did(3));
  const res = await accept(dId, dtok(3), { etaBucket: 'le_2h' }); // no sharePhone key
  expect(res.statusCode).toBe(200);
  expect(await pledgePhone(res.json<{ pledgeId: string }>().pledgeId)).toBe('DONOR_PHONE_3');
});

test('covered boundary: units=2 (threshold 3), 3 accepts then 4th → 409 request_closed/covered', async () => {
  expect(coveredThreshold(2)).toBe(3);
  const reqId = await seedRequest('open', 2);

  const states: string[] = [];
  for (const n of [1, 2, 3]) {
    const res = await accept(await seedDispatch(reqId, did(n)), dtok(n), { etaBucket: 'le_1h' });
    expect(res.statusCode).toBe(200);
    states.push(res.json<{ requestState: string }>().requestState);
  }
  expect(states).toEqual(['partially_pledged', 'partially_pledged', 'covered']);

  const fourth = await accept(await seedDispatch(reqId, did(4)), dtok(4), { etaBucket: 'le_1h' });
  expect(fourth.statusCode).toBe(409);
  expect(fourth.json()).toEqual({ error: 'request_closed', requestState: 'covered' });
  expect(await activeCount(reqId)).toBe(3); // never overbooked past the ceiling
});

test('overbook ceiling (step c): state partially_pledged but active==threshold → 409 covered', async () => {
  const reqId = await seedRequest('partially_pledged', 2); // threshold 3
  for (const n of [5, 6, 7]) await seedActivePledge(reqId, did(n)); // 3 active == threshold, state left lagging
  const res = await accept(await seedDispatch(reqId, did(1)), dtok(1), { etaBucket: 'le_1h' });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'request_closed', requestState: 'covered' });
  expect(await activeCount(reqId)).toBe(3); // no 4th pledge inserted
});

test('slot race: one remaining slot → first accept 200, second 409, DB consistent', async () => {
  const reqId = await seedRequest('partially_pledged', 2); // threshold 3
  await seedActivePledge(reqId, did(5)); // two slots taken → one remains
  await seedActivePledge(reqId, did(6));
  const dA = await seedDispatch(reqId, did(1));
  const dB = await seedDispatch(reqId, did(2));

  const first = await accept(dA, dtok(1), { etaBucket: 'le_1h' });
  expect(first.statusCode).toBe(200);
  expect(first.json<{ requestState: string }>().requestState).toBe('covered');

  const second = await accept(dB, dtok(2), { etaBucket: 'le_1h' });
  expect(second.statusCode).toBe(409);
  expect(second.json<{ error: string }>().error).toBe('request_closed');

  expect(await activeCount(reqId)).toBe(3); // exactly threshold active pledges
  expect((await dispatchRow(dB)).response).toBe('none'); // loser's dispatch untouched
});

// cancel + expired cover the closed-request guard; 'covered' also proves the
// canAcceptPledge guard runs BEFORE transitionRequest — a 409, never a 500.
test.each(['cancelled', 'expired', 'covered'])('accept on a %s request → 409 request_closed', async (state) => {
  const dId = await seedDispatch(await seedRequest(state), did(1));
  const res = await accept(dId, dtok(1), { etaBucket: 'le_1h' });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'request_closed', requestState: state });
});

test('one-active-pledge: active on A, accepting B → 409 active_pledge_exists, dispatch B rolled back', async () => {
  const reqA = await seedRequest('partially_pledged');
  const reqB = await seedRequest('open');
  await seedActivePledge(reqA, did(7)); // d7 already holds an active pledge on A
  const dB = await seedDispatch(reqB, did(7));

  const res = await accept(dB, dtok(7), { etaBucket: 'le_1h' });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'active_pledge_exists' });

  // The none→accepted transition on dispatch B must NOT have been consumed.
  const disp = await dispatchRow(dB);
  expect(disp.response).toBe('none');
  expect(disp.responded_at).toBeNull();
  expect(await reqState(reqB)).toBe('open'); // request B unchanged
  expect(await pledgeCount(reqB)).toBe(0); // no pledge landed on B
});

test('decline: 204, dispatch declined, request unchanged, no pledge; repeat + accept-after → 409', async () => {
  const reqId = await seedRequest('open');
  const dId = await seedDispatch(reqId, did(1));

  const res = await decline(dId, dtok(1));
  expect(res.statusCode).toBe(204);
  expect(res.body).toBe('');
  const disp = await dispatchRow(dId);
  expect(disp.response).toBe('declined');
  expect(disp.responded_at).not.toBeNull();
  expect(await reqState(reqId)).toBe('open'); // no request-state effect
  expect(await pledgeCount(reqId)).toBe(0); // declines are never itemized

  const secondDecline = await decline(dId, dtok(1));
  expect(secondDecline.statusCode).toBe(409);
  expect(secondDecline.json()).toEqual({ error: 'already_responded', response: 'declined' });

  const acceptAfter = await accept(dId, dtok(1), { etaBucket: 'le_1h' });
  expect(acceptAfter.statusCode).toBe(409);
  expect(acceptAfter.json()).toEqual({ error: 'already_responded', response: 'declined' });
});

test('400 on an invalid accept body (bad etaBucket)', async () => {
  const dId = await seedDispatch(await seedRequest('open'), did(1));
  const res = await accept(dId, dtok(1), { etaBucket: 'tomorrow' });
  expect(res.statusCode).toBe(400);
  expect(res.json<{ error: string }>().error).toBe('invalid_body');
});
