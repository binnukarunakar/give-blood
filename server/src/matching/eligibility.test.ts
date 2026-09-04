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
// The travel-radius boundary cell (GB-35 regression). Its CENTROID is 5.04 km
// out — just past the 5 km rung — but its NEAREST point is only 2.59 km away,
// so it can hold a donor comfortably inside a 5 km promise. Gating on the
// centroid excluded that donor; gating on the nearest point does not. In the
// tier-0 cover either way (5.04 <= 5 + half-diagonal).
const EDGE_CELL = ngeohash.encode(HOSPITAL_LAT + 0.024, HOSPITAL_LNG, 5);

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
  /** Omitted = column DEFAULT 25, i.e. the pre-GB-35 reach. */
  travelRadiusKm?: 5 | 10 | 25;
}

/** Baseline donor is fully eligible; each test flips exactly one gate. */
async function seedDonor(o: DonorSeed = {}): Promise<string> {
  seq += 1;
  const res = await db.query<{ donor_id: string }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                        push_verified_at, opted_in, available, snooze_until, last_donation_at,
                        travel_radius_km)
     VALUES ($11, $1, $2, $3, $4, 'DONOR_PHONE', $5, $6, $7, $8, $9, $10, $12::smallint)
     RETURNING donor_id`,
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
      o.travelRadiusKm ?? 25, // $12 — matches the column DEFAULT (migration 0003)
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

// ── Donor-chosen travel radius (GB-35) ──────────────────────────────────────
// The donor answers "how far will you travel?"; the matcher compares that to
// the distance to their own cell. The request's tier still decides WHEN a
// farther donor becomes reachable, so a willing-but-distant donor is only
// paged once the nearer tiers have failed to fill the request.

test('travel radius defaults to the widest rung, so pre-GB-35 reach is unchanged', async () => {
  const id = await seedDonor({ geohash5: FAR_CELL }); // no travelRadiusKm set
  expect(await runIds({ tierIdx: 2 })).toEqual([id]);
});

test('far donor willing to travel 25 km is reached at tier 2', async () => {
  const id = await seedDonor({ geohash5: FAR_CELL, travelRadiusKm: 25 });
  expect(await runIds({ tierIdx: 2 })).toEqual([id]);
});

test('far donor willing to travel 25 km is NOT reached at tier 0 — escalation still gates it', async () => {
  await seedDonor({ geohash5: FAR_CELL, travelRadiusKm: 25 });
  expect(await runIds({ tierIdx: 0 })).toEqual([]);
});

test('far donor who will only travel 10 km is excluded even at tier 2', async () => {
  await seedDonor({ geohash5: FAR_CELL, travelRadiusKm: 10 }); // cell centroid ~19.7 km out
  expect(await runIds({ tierIdx: 2 })).toEqual([]);
});

test('far donor who will only travel 5 km is excluded at every tier', async () => {
  await seedDonor({ geohash5: FAR_CELL, travelRadiusKm: 5 });
  for (const tierIdx of [0, 1, 2] as const) {
    expect(await runIds({ tierIdx })).toEqual([]);
  }
});

test('near donor who will only travel 5 km is still reached at tier 0', async () => {
  const id = await seedDonor({ geohash5: BASE_CELL, travelRadiusKm: 5 });
  expect(await runIds({ tierIdx: 0 })).toEqual([id]);
});

test('travel radius filters per donor, not per request: near 5 km in, far 10 km out', async () => {
  const near = await seedDonor({ geohash5: BASE_CELL, travelRadiusKm: 5 });
  await seedDonor({ geohash5: FAR_CELL, travelRadiusKm: 10 });
  expect(await runIds({ tierIdx: 2 })).toEqual([near]);
});

test('the DB rejects a travel radius off the ladder', async () => {
  await expect(
    db.query(
      `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone,
                          opted_in, available, travel_radius_km)
       VALUES ('uid_bad_radius', 'bad', 'B+', $1, 'America/New_York', 'DONOR_PHONE',
               true, true, 7::smallint)`,
      [BASE_CELL],
    ),
  ).rejects.toThrow();
});

// ── Travel radius is gated on the cell's NEAREST point, not its centroid ─────
// A precision-5 cell is ~4.9 km across, so its centroid is a poor stand-in for
// where a donor in it actually is. Comparing the donor's promise against the
// centroid silently dropped donors who were well inside the distance they
// agreed to travel; comparing against the nearest point drops only donors who
// certainly are not. Over-including costs a decline. Under-including means a
// donor minutes away never hears that someone needed blood.

test('GB-35 regression: donor whose cell centroid is past their radius, but who can be inside it, is still reached', async () => {
  // EDGE_CELL centroid 5.04 km (> 5), nearest point 2.59 km (< 5).
  const id = await seedDonor({ geohash5: EDGE_CELL, travelRadiusKm: 5 });
  expect(await runIds({ tierIdx: 0 })).toEqual([id]);
});

test('the nearest-point gate does not resurrect a donor who is genuinely out of range', async () => {
  // FAR_CELL nearest point is still ~17 km — a 10 km donor cannot be inside it.
  await seedDonor({ geohash5: FAR_CELL, travelRadiusKm: 10 });
  expect(await runIds({ tierIdx: 2 })).toEqual([]);
});

test('the nearest-point gate does not bypass escalation: edge donor is unreachable before their tier', async () => {
  // Same donor as the regression test, but the request has not escalated to a
  // tier whose cover contains EDGE_CELL yet — a tighter cover, not the radius
  // gate, is what keeps them out.
  const id = await seedDonor({ geohash5: EDGE_CELL, travelRadiusKm: 5 });
  const reached = await runIds({ tierIdx: 0 });
  expect(reached).toEqual([id]); // tier 0 already covers this cell
  await db.query(`UPDATE donor SET geohash5 = $1 WHERE donor_id = $2`, [FAR_CELL, id]);
  expect(await runIds({ tierIdx: 0 })).toEqual([]);
});
