import { PGlite } from '@electric-sql/pglite';
import ngeohash from 'ngeohash';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import type { BloodGroup } from './compatibility.js';
import { eligibleDonors, type EligibleDonorsArgs } from './eligibility.js';

// Hospital: Times Square, Manhattan. All instants are July 2026, so
// America/New_York = UTC-4 (EDT) and America/Los_Angeles = UTC-7 (PDT);
// no DST transition falls inside any tested window.
const HOSPITAL_LAT = 40.758;
const HOSPITAL_LNG = -73.9855;
const BASE_CELL = ngeohash.encode(HOSPITAL_LAT, HOSPITAL_LNG, 5);
// ~18 km due north: centroid ~19.7 km out — beyond tier-0 keep threshold
// (5 km + half diagonal ~8.5 km), well inside tier-2 (25 km).
const FAR_CELL = ngeohash.encode(HOSPITAL_LAT + 0.1618, HOSPITAL_LNG, 5);

const DAYTIME = new Date('2026-07-15T16:00:00Z'); // 12:00 donor-local in New York
const NY_2159 = new Date('2026-07-15T01:59:00Z');
const NY_2200 = new Date('2026-07-15T02:00:00Z');
const NY_0659 = new Date('2026-07-15T10:59:00Z');
const NY_0700 = new Date('2026-07-15T11:00:00Z');
const NY_23_LA_20 = new Date('2026-07-15T03:00:00Z'); // NY 23:00 (quiet) / LA 20:00 (awake)
const DAY_MS = 86_400_000;

let db: PGlite;
let request1: string;
let request2: string;
let seq = 0;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  // timestamptz - make_interval(days =>) does day arithmetic in the session
  // timezone; pinning UTC keeps the 56-day boundary exact on any host.
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
       VALUES ('uid_requester_elig', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
      [hospitalId],
    ),
  ).requester_id;
  const makeRequest = async (): Promise<string> =>
    firstRow(
      await db.query<{ request_id: string }>(
        `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, expires_at)
         VALUES ($1, $2, 'B+', 2, 'standard', now() + interval '1 day') RETURNING request_id`,
        [requesterId, hospitalId],
      ),
    ).request_id;
  request1 = await makeRequest();
  request2 = await makeRequest();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE donor CASCADE'); // cascades to pledge + dispatch; requests survive
});

interface DonorSeed {
  bloodGroup?: BloodGroup;
  geohash5?: string;
  tz?: string;
  pushToken?: string | null;
  pushVerifiedAt?: Date | null;
  optedIn?: boolean;
  available?: boolean;
  snoozeUntil?: Date | null;
  lastDonationAt?: Date | null;
}

/** Baseline donor is fully eligible; each test flips exactly one gate. */
async function seedDonor(o: DonorSeed = {}): Promise<string> {
  seq += 1;
  const res = await db.query<{ donor_id: string }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                        push_verified_at, opted_in, available, snooze_until, last_donation_at)
     VALUES ($11, $1, $2, $3, $4, 'DONOR_PHONE', $5, $6, $7, $8, $9, $10) RETURNING donor_id`,
    [
      `donor_${seq}`,
      o.bloodGroup ?? 'B+',
      o.geohash5 ?? BASE_CELL,
      o.tz ?? 'America/New_York',
      o.pushToken !== undefined ? o.pushToken : 'tok',
      (o.pushVerifiedAt !== undefined ? o.pushVerifiedAt : DAYTIME)?.toISOString() ?? null,
      o.optedIn ?? true,
      o.available ?? true,
      o.snoozeUntil?.toISOString() ?? null,
      o.lastDonationAt?.toISOString() ?? null,
      `uid_donor_${seq}`, // $11 — unique auth linkage per seeded donor (migration 0002)
    ],
  );
  return firstRow(res).donor_id;
}

async function pledgeFor(
  donorId: string,
  requestId: string,
  state: 'active' | 'released',
): Promise<void> {
  await db.query(
    `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
     VALUES ($1, $2, 'snap', 'B+', 'le_1h', $3)`,
    [requestId, donorId, state],
  );
}

async function dispatchFor(donorId: string, requestId: string): Promise<void> {
  await db.query(`INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1, $2, 0)`, [
    requestId,
    donorId,
  ]);
}

async function runIds(overrides: Partial<EligibleDonorsArgs> = {}): Promise<string[]> {
  const rows = await eligibleDonors(db, {
    bloodGroup: 'B+',
    hospitalLat: HOSPITAL_LAT,
    hospitalLng: HOSPITAL_LNG,
    tierIdx: 0,
    urgency: 'standard',
    requestId: null,
    now: DAYTIME,
    ...overrides,
  });
  return rows.map((r) => r.donorId);
}

test('happy path: baseline donor matches, full row shape', async () => {
  const id = await seedDonor();
  const rows = await eligibleDonors(db, {
    bloodGroup: 'B+',
    hospitalLat: HOSPITAL_LAT,
    hospitalLng: HOSPITAL_LNG,
    tierIdx: 0,
    urgency: 'standard',
    requestId: request1,
    now: DAYTIME,
  });
  expect(rows).toEqual([
    { donorId: id, bloodGroup: 'B+', geohash5: BASE_CELL, pushToken: 'tok', lastAlertedAt: null },
  ]);
});

test('opted_in = false excluded', async () => {
  await seedDonor({ optedIn: false });
  expect(await runIds()).toEqual([]);
});

test('available = false excluded', async () => {
  await seedDonor({ available: false });
  expect(await runIds()).toEqual([]);
});

test('push_verified_at NULL excluded', async () => {
  await seedDonor({ pushVerifiedAt: null });
  expect(await runIds()).toEqual([]);
});

test('push_token NULL (verified, token since cleared) excluded', async () => {
  await seedDonor({ pushToken: null });
  expect(await runIds()).toEqual([]);
});

test('snooze_until in the future excluded; in the past included', async () => {
  await seedDonor({ snoozeUntil: new Date(DAYTIME.getTime() + DAY_MS) });
  const past = await seedDonor({ snoozeUntil: new Date(DAYTIME.getTime() - DAY_MS) });
  expect(await runIds()).toEqual([past]);
});

test('cooldown: 55 days ago excluded; exactly 56 days ago included', async () => {
  await seedDonor({ lastDonationAt: new Date(DAYTIME.getTime() - 55 * DAY_MS) });
  const day56 = await seedDonor({ lastDonationAt: new Date(DAYTIME.getTime() - 56 * DAY_MS) });
  expect(await runIds()).toEqual([day56]);
});

test('incompatible group excluded (A+ donor), compatible non-exact included (O- donor)', async () => {
  await seedDonor({ bloodGroup: 'A+' });
  const universal = await seedDonor({ bloodGroup: 'O-' });
  expect(await runIds()).toEqual([universal]);
});

test('cell outside tier-0 cover excluded; same donor included at tier 2', async () => {
  const far = await seedDonor({ geohash5: FAR_CELL });
  expect(await runIds({ tierIdx: 0 })).toEqual([]);
  expect(await runIds({ tierIdx: 2 })).toEqual([far]);
});

test('active pledge on another request excluded', async () => {
  const id = await seedDonor();
  await pledgeFor(id, request2, 'active');
  expect(await runIds({ requestId: request1 })).toEqual([]);
});

test('released pledge does not exclude', async () => {
  const id = await seedDonor();
  await pledgeFor(id, request2, 'released');
  expect(await runIds({ requestId: request1 })).toEqual([id]);
});

test('prior dispatch for this request excluded', async () => {
  const id = await seedDonor();
  await dispatchFor(id, request1);
  expect(await runIds({ requestId: request1 })).toEqual([]);
});

test('dispatch for a different request does not exclude', async () => {
  const id = await seedDonor();
  await dispatchFor(id, request2);
  expect(await runIds({ requestId: request1 })).toEqual([id]);
});

test('requestId null skips the dispatch gate', async () => {
  const id = await seedDonor();
  await dispatchFor(id, request1);
  expect(await runIds({ requestId: null })).toEqual([id]);
});

test('quiet hours (standard): 21:59 donor-local included', async () => {
  const id = await seedDonor();
  expect(await runIds({ now: NY_2159 })).toEqual([id]);
});

test('quiet hours (standard): 22:00 donor-local excluded', async () => {
  await seedDonor();
  expect(await runIds({ now: NY_2200 })).toEqual([]);
});

test('quiet hours (standard): 06:59 donor-local excluded', async () => {
  await seedDonor();
  expect(await runIds({ now: NY_0659 })).toEqual([]);
});

test('quiet hours (standard): 07:00 donor-local included', async () => {
  const id = await seedDonor();
  expect(await runIds({ now: NY_0700 })).toEqual([id]);
});

test('critical pierces quiet hours at 22:00 donor-local', async () => {
  const id = await seedDonor();
  expect(await runIds({ now: NY_2200, urgency: 'critical' })).toEqual([id]);
});

test('tz independence: same UTC instant, NY 23:00 quiet vs LA 20:00 awake', async () => {
  await seedDonor(); // America/New_York — 23:00 local, inside quiet hours
  const la = await seedDonor({ tz: 'America/Los_Angeles' }); // 20:00 local, awake
  expect(await runIds({ now: NY_23_LA_20 })).toEqual([la]);
});
