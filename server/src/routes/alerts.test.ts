import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import ngeohash from 'ngeohash';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import type { AuthUser } from '../auth/verifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import { haversineKm } from '../matching/geo.js';
import { FakePushSender } from '../push/fakePushSender.js';

const HOSPITAL_LAT = 40.758;
const HOSPITAL_LNG = -73.9855;
const BASE_CELL = ngeohash.encode(HOSPITAL_LAT, HOSPITAL_LNG, 5);
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
});

const DONOR1_TOKEN = 'tok-donor1';
const GHOST_TOKEN = 'tok-ghost'; // valid token, uid with no donor row
const DONOR1: AuthUser = { uid: 'uid-donor-1', phone: null };
const GHOST: AuthUser = { uid: 'uid-ghost', phone: null };

let db: PGlite;
let app: FastifyInstance;
let dispatch1Id: string; // donor1's dispatch on the open request
let dispatch2Id: string; // donor2's dispatch (someone else's)
let cancelledDispatchId: string; // donor1's dispatch on a cancelled request
let openRequestId: string;
let donor1Id: string;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

async function seedDonor(uid: string, handle: string): Promise<string> {
  return firstRow(
    await db.query<{ donor_id: string }>(
      `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                          push_verified_at, opted_in, available)
       VALUES ($1, $2, 'B+', $3, 'America/New_York', 'DONOR_PHONE', 'tok', now(), true, true)
       RETURNING donor_id`,
      [uid, handle, BASE_CELL],
    ),
  ).donor_id;
}

async function seedDispatch(reqId: string, donorId: string): Promise<string> {
  return firstRow(
    await db.query<{ dispatch_id: string }>(
      `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1, $2, 0)
       RETURNING dispatch_id`,
      [reqId, donorId],
    ),
  ).dispatch_id;
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);

  const hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown Hospital', '1 Times Sq, New York', 40.758000, -73.985500, 'HOSPITAL_BLOODBANK_PHONE')
       RETURNING hospital_id`,
    ),
  ).hospital_id;
  const requesterId = firstRow(
    await db.query<{ requester_id: string }>(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ('uid_requester_alerts', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
      [hospitalId],
    ),
  ).requester_id;

  const makeRequest = async (state: string): Promise<string> =>
    firstRow(
      await db.query<{ request_id: string }>(
        `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, state, expires_at)
         VALUES ($1, $2, 'B+', 2, 'standard', $3, now() + interval '1 day') RETURNING request_id`,
        [requesterId, hospitalId, state],
      ),
    ).request_id;

  openRequestId = await makeRequest('open');
  const cancelledRequestId = await makeRequest('cancelled');

  donor1Id = await seedDonor('uid-donor-1', 'alice');
  const donor2Id = await seedDonor('uid-donor-2', 'bob');

  dispatch1Id = await seedDispatch(openRequestId, donor1Id);
  dispatch2Id = await seedDispatch(openRequestId, donor2Id);
  cancelledDispatchId = await seedDispatch(cancelledRequestId, donor1Id);

  const verifier = new FakeTokenVerifier(
    new Map([
      [DONOR1_TOKEN, DONOR1],
      [GHOST_TOKEN, GHOST],
    ]),
  );
  app = buildApp({
    config: CONFIG,
    verifier,
    db,
    push: new FakePushSender(),
    logger: false,
  });
  await app.ready();
  // 20 s hook timeout: this fixture migrates a fresh in-process Postgres and
  // seeds several rows; under the full parallel suite a cold PGlite start can
  // exceed vitest's 10 s default hookTimeout (cf. vitest.config testTimeout note).
}, 20_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

function get(dispatchId: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: `/alerts/${dispatchId}`,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

/** A browser DOCUMENT load of the push deep link: no Authorization, Accept: text/html. */
function documentLoad(instance: FastifyInstance, dispatchId: string) {
  return instance.inject({
    method: 'GET',
    url: `/alerts/${dispatchId}`,
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
}

test('401 when no token is presented', async () => {
  const res = await get(dispatch1Id);
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'unauthorized' });
});

test('404 for an unknown uid (valid token, no donor row)', async () => {
  const res = await get(dispatch1Id, GHOST_TOKEN);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'not_found' });
});

test("404 for someone else's dispatch (same 404 — no existence leak)", async () => {
  const res = await get(dispatch2Id, DONOR1_TOKEN);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'not_found' });
});

test('404 for a well-formed but nonexistent dispatch id', async () => {
  const res = await get(ABSENT_UUID, DONOR1_TOKEN);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'not_found' });
});

test('200 happy path: public alert shape, no requester/donor PII', async () => {
  const res = await get(dispatch1Id, DONOR1_TOKEN);
  expect(res.statusCode).toBe(200);
  const body = res.json() as Record<string, unknown>;

  expect(body.alertId).toBe(dispatch1Id);
  expect(body.bloodGroup).toBe('B+');
  expect(body.unitsNeeded).toBe(2);
  expect(body.urgency).toBe('standard');
  expect(body.requestState).toBe('open');
  expect(typeof body.createdAt).toBe('string');
  expect(typeof body.expiresAt).toBe('string');

  const hospital = body.hospital as Record<string, unknown>;
  expect(hospital.name).toBe('Midtown Hospital');
  expect(hospital.address).toBe('1 Times Sq, New York');
  expect(hospital.lat).toBe(HOSPITAL_LAT);
  expect(hospital.lng).toBe(HOSPITAL_LNG);
  expect(hospital.bloodbankPhone).toBe('HOSPITAL_BLOODBANK_PHONE'); // present

  const { latitude, longitude } = ngeohash.decode(BASE_CELL);
  const expectedDist = Math.round(haversineKm(latitude, longitude, HOSPITAL_LAT, HOSPITAL_LNG) * 10) / 10;
  expect(body.distanceKm).toBe(expectedDist);

  // Absence of anything requester- or patient-identifying, and of dispatch counts.
  for (const forbidden of ['requesterId', 'requesterPhone', 'phone', 'donorId', 'donorPhone', 'patient', 'dispatchCount']) {
    expect(body).not.toHaveProperty(forbidden);
  }
  expect(hospital).not.toHaveProperty('requesterPhone');
  expect(hospital).not.toHaveProperty('phone');
});

test('closed request: state is reflected on tap (stale-push self-correction)', async () => {
  const res = await get(cancelledDispatchId, DONOR1_TOKEN);
  expect(res.statusCode).toBe(200);
  const body = res.json() as Record<string, unknown>;
  expect(body.alertId).toBe(cancelledDispatchId);
  expect(body.requestState).toBe('cancelled');
});

// GB-32 (a): the pledge the caller already made must come back from the server —
// before this, a reload lost the only record that the donor had accepted.
test('pledge: null with no pledge, the caller own pledge once one exists', async () => {
  expect((await get(dispatch1Id, DONOR1_TOKEN)).json<{ pledge: unknown }>().pledge).toBeNull();

  const pledgeId = firstRow(
    await db.query<{ pledge_id: string }>(
      `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
       VALUES ($1::uuid, $2::uuid, 'alice', 'B+', 'le_30m', 'active') RETURNING pledge_id`,
      [openRequestId, donor1Id],
    ),
  ).pledge_id;

  const res = await get(dispatch1Id, DONOR1_TOKEN);
  expect(res.statusCode).toBe(200);
  expect(res.json<{ pledge: unknown }>().pledge).toEqual({
    pledgeId,
    state: 'active',
    etaBucket: 'le_30m',
  });

  // Another donor's dispatch on the SAME request still resolves to its own 404 —
  // the pledge join never widens what a caller can see.
  expect((await get(dispatch2Id, DONOR1_TOKEN)).statusCode).toBe(404);

  await db.query(`DELETE FROM pledge WHERE pledge_id = $1::uuid`, [pledgeId]);
});

// GB-32 (1): the SW deep-links to /alerts/<id>, which is a registered JSON API
// route, so a browser navigation used to render {"error":"unauthorized"}.
describe('push deep link: document load vs API client', () => {
  const SHELL = '<!doctype html><title>Give Blood</title><div id="root"></div>';
  let staticRoot: string;
  let staticApp: FastifyInstance;

  beforeAll(async () => {
    staticRoot = mkdtempSync(path.join(tmpdir(), 'gb-alerts-static-'));
    writeFileSync(path.join(staticRoot, 'index.html'), SHELL, 'utf8');
    staticApp = buildApp({
      config: CONFIG,
      verifier: new FakeTokenVerifier(new Map([[DONOR1_TOKEN, DONOR1]])),
      db,
      push: new FakePushSender(),
      logger: false,
      staticRoot,
    });
    await staticApp.ready();
  }, 20_000);

  afterAll(async () => {
    await staticApp.close();
    rmSync(staticRoot, { recursive: true, force: true });
  });

  test('static on: an unauthenticated document load gets the SPA shell, not JSON', async () => {
    const res = await documentLoad(staticApp, dispatch1Id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(SHELL);
  });

  test('static on: a document load for an unknown id also gets the shell (no id oracle)', async () => {
    const res = await documentLoad(staticApp, ABSENT_UUID);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SHELL);
  });

  test('static on: JSON clients are untouched — */* and application/json still auth', async () => {
    for (const accept of ['application/json', '*/*']) {
      const res = await staticApp.inject({
        method: 'GET',
        url: `/alerts/${dispatch1Id}`,
        headers: { accept },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  test('static on: the authenticated API call still returns the alert JSON', async () => {
    const res = await staticApp.inject({
      method: 'GET',
      url: `/alerts/${dispatch1Id}`,
      headers: { accept: 'application/json', authorization: `Bearer ${DONOR1_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ alertId: string }>().alertId).toBe(dispatch1Id);
  });

  test('static OFF: the same document load keeps the JSON API behaviour it has today', async () => {
    const res = await documentLoad(app, dispatch1Id);
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('<!doctype html>');

    const authed = await app.inject({
      method: 'GET',
      url: `/alerts/${ABSENT_UUID}`,
      headers: { accept: 'text/html', authorization: `Bearer ${DONOR1_TOKEN}` },
    });
    expect(authed.statusCode).toBe(404);
    expect(authed.json()).toEqual({ error: 'not_found' });
  });
});
