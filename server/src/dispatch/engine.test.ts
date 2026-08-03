import { PGlite } from '@electric-sql/pglite';
import ngeohash from 'ngeohash';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import type { BloodGroup } from '../matching/compatibility.js';
import { FakePushSender } from '../push/fakePushSender.js';
import type { PushResult } from '../push/pushSender.js';
import { dispatchTier, type DispatchRequest } from './engine.js';

// Hospital: Times Square (same fixture as the eligibility suite). July 2026 →
// America/New_York = UTC-4; no DST edge inside the tested window.
const HOSPITAL_LAT = 40.758;
const HOSPITAL_LNG = -73.9855;
const BASE_CELL = ngeohash.encode(HOSPITAL_LAT, HOSPITAL_LNG, 5); // ~at hospital
const FAR_CELL = ngeohash.encode(HOSPITAL_LAT + 0.1618, HOSPITAL_LNG, 5); // ~19.7 km, inside tier 2

const DAYTIME = new Date('2026-07-15T16:00:00Z'); // 12:00 donor-local NY
const RECENT = new Date(DAYTIME.getTime() - 3_600_000); // alerted 1 h ago

let db: PGlite;
let requestId: string;
let seq = 0;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

interface DonorSeed {
  bloodGroup?: BloodGroup;
  geohash5?: string;
  pushToken?: string;
  lastAlertedAt?: Date | null;
}

async function seedDonor(o: DonorSeed = {}): Promise<string> {
  seq += 1;
  const res = await db.query<{ donor_id: string }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                        push_verified_at, opted_in, available, last_alerted_at)
     VALUES ($1, $2, $3, $4, 'America/New_York', 'DONOR_PHONE', $5, $6, true, true, $7)
     RETURNING donor_id`,
    [
      `uid_${seq}`,
      `donor_${seq}`,
      o.bloodGroup ?? 'B+',
      o.geohash5 ?? BASE_CELL,
      o.pushToken ?? `tok_${seq}`,
      DAYTIME.toISOString(),
      o.lastAlertedAt !== undefined ? (o.lastAlertedAt?.toISOString() ?? null) : null,
    ],
  );
  return firstRow(res).donor_id;
}

interface DonorRow {
  push_token: string | null;
  push_verified_at: Date | null;
  last_alerted_at: Date | null;
}

async function donorRow(donorId: string): Promise<DonorRow> {
  return firstRow(
    await db.query<DonorRow>(
      `SELECT push_token, push_verified_at, last_alerted_at FROM donor WHERE donor_id = $1`,
      [donorId],
    ),
  );
}

async function dispatchCount(reqId: string): Promise<number> {
  const { count } = firstRow(
    await db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM dispatch WHERE request_id = $1`,
      [reqId],
    ),
  );
  return Number(count);
}

async function dispatchIdFor(reqId: string, donorId: string): Promise<string | undefined> {
  const res = await db.query<{ dispatch_id: string }>(
    `SELECT dispatch_id FROM dispatch WHERE request_id = $1 AND donor_id = $2`,
    [reqId, donorId],
  );
  return res.rows[0]?.dispatch_id;
}

const REQ: DispatchRequest = {
  requestId: '', // set per test to the shared requestId
  bloodGroup: 'B+',
  hospitalLat: HOSPITAL_LAT,
  hospitalLng: HOSPITAL_LNG,
  urgency: 'standard',
  radiusTier: 0,
};

function reqWith(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return { ...REQ, requestId, ...overrides };
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);

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
       VALUES ('uid_requester_disp', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
      [hospitalId],
    ),
  ).requester_id;
  requestId = firstRow(
    await db.query<{ request_id: string }>(
      `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, expires_at)
       VALUES ($1, $2, 'B+', 2, 'standard', now() + interval '1 day') RETURNING request_id`,
      [requesterId, hospitalId],
    ),
  ).request_id;
  // 20 s hook timeout: a fresh in-process Postgres cold start can exceed
  // vitest's 10 s default hookTimeout under the full parallel suite.
}, 20_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE donor CASCADE'); // cascades to dispatch + pledge; request survives
});

test('happy path: dispatches all eligible donors, writes rows + last_alerted_at, exact opaque payload', async () => {
  const donors = [
    { id: await seedDonor({ pushToken: 'h1' }), token: 'h1' },
    { id: await seedDonor({ pushToken: 'h2' }), token: 'h2' },
    { id: await seedDonor({ pushToken: 'h3' }), token: 'h3' },
  ];
  const push = new FakePushSender();

  const result = await dispatchTier(db, push, reqWith(), DAYTIME);

  expect(result).toEqual({ dispatched: 3, deadTokens: 0 });
  expect(await dispatchCount(requestId)).toBe(3);
  expect(push.sent).toHaveLength(3);

  for (const donor of donors) {
    const row = await donorRow(donor.id);
    expect(row.last_alerted_at?.toISOString()).toBe(DAYTIME.toISOString());
  }

  for (const sent of push.sent) {
    // Payload is EXACTLY { type, alertId } — no request content leaks to the wire.
    expect(Object.keys(sent.payload).sort()).toEqual(['alertId', 'type']);
    const donor = donors.find((d) => d.token === sent.token);
    expect(donor).toBeDefined();
    // ...and alertId is the dispatch row id for this donor. One exact-object
    // assertion now that RecordedSend.payload is the full PushPayload union
    // (GB-15 cleanup b): `.alertId` is not a property of every member.
    expect(sent.payload).toEqual({
      type: 'BLOOD_ALERT',
      alertId: await dispatchIdFor(requestId, donor!.id),
    });
  }
});

test('ORDER: exact before O−, key2 (B− before O−), nearer before farther, never-alerted before recent', async () => {
  await seedDonor({ bloodGroup: 'B+', geohash5: BASE_CELL, lastAlertedAt: null, pushToken: 't1' });
  await seedDonor({ bloodGroup: 'B+', geohash5: FAR_CELL, lastAlertedAt: null, pushToken: 't2' });
  await seedDonor({ bloodGroup: 'B+', geohash5: BASE_CELL, lastAlertedAt: RECENT, pushToken: 't3' });
  await seedDonor({ bloodGroup: 'O-', geohash5: BASE_CELL, lastAlertedAt: null, pushToken: 't4' });
  await seedDonor({ bloodGroup: 'B-', geohash5: BASE_CELL, lastAlertedAt: null, pushToken: 't5' });

  const push = new FakePushSender();
  const result = await dispatchTier(db, push, reqWith({ radiusTier: 2 }), DAYTIME);

  expect(result.dispatched).toBe(5);
  // t1 exact/near/never; t3 exact/near/recent; t2 exact/far; t5 B− (non-exact, not O−); t4 O− last.
  expect(push.sent.map((s) => s.token)).toEqual(['t1', 't3', 't2', 't5', 't4']);
});

test('re-run is a no-op (dispatch anti-join)', async () => {
  await seedDonor({ pushToken: 'r1' });
  await seedDonor({ pushToken: 'r2' });
  const push = new FakePushSender();

  const first = await dispatchTier(db, push, reqWith(), DAYTIME);
  expect(first.dispatched).toBe(2);

  const second = await dispatchTier(db, push, reqWith(), DAYTIME);
  expect(second).toEqual({ dispatched: 0, deadTokens: 0 });
  expect(push.sent).toHaveLength(2); // no new sends
  expect(await dispatchCount(requestId)).toBe(2); // no duplicate rows
});

test('dead_token: donor push fields nulled + counted; dispatch row kept', async () => {
  const okId = await seedDonor({ pushToken: 'tok-ok' });
  const deadId = await seedDonor({ pushToken: 'tok-dead' });
  const scripted = new Map<string, PushResult>([['tok-dead', 'dead_token']]);
  const push = new FakePushSender(scripted);

  const result = await dispatchTier(db, push, reqWith(), DAYTIME);

  expect(result).toEqual({ dispatched: 2, deadTokens: 1 });

  const dead = await donorRow(deadId);
  expect(dead.push_token).toBeNull();
  expect(dead.push_verified_at).toBeNull();
  expect(await dispatchIdFor(requestId, deadId)).toBeDefined(); // row REMAINS

  const ok = await donorRow(okId);
  expect(ok.push_token).toBe('tok-ok');
  expect(ok.push_verified_at).not.toBeNull();
});

test("'error' result: dispatch row kept, donor untouched, engine completes", async () => {
  const errId = await seedDonor({ pushToken: 'tok-err' });
  const scripted = new Map<string, PushResult>([['tok-err', 'error']]);
  const push = new FakePushSender(scripted);

  const result = await dispatchTier(db, push, reqWith(), DAYTIME);

  expect(result).toEqual({ dispatched: 1, deadTokens: 0 });
  const row = await donorRow(errId);
  expect(row.push_token).toBe('tok-err'); // untouched
  expect(row.push_verified_at).not.toBeNull();
  expect(await dispatchIdFor(requestId, errId)).toBeDefined();
});
