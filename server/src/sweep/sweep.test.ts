import { PGlite } from '@electric-sql/pglite';
import ngeohash from 'ngeohash';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { BASE_TIER } from '../domain/protocol.js';
import { coverCells, RADIUS_TIERS_KM } from '../matching/geo.js';
import { FakePushSender } from '../push/fakePushSender.js';
import type { PushResult } from '../push/pushSender.js';
import { runSweep, type SweepReport } from './sweep.js';

// Hospital: Times Square (same fixture as the eligibility/dispatch suites).
// July 2026 → America/New_York = UTC-4; no DST edge inside the tested window.
const HOSPITAL_LAT = 40.758;
const HOSPITAL_LNG = -73.9855;
const BASE_CELL = ngeohash.encode(HOSPITAL_LAT, HOSPITAL_LNG, 5);

/**
 * A cell newly covered at tier 1 (10 km) but NOT at tier 0 (5 km) — derived
 * from the cover sets themselves so the fixture cannot drift out of sync with
 * the geo tolerance math.
 */
function pickRingCell(): string {
  const t0 = new Set(coverCells(HOSPITAL_LAT, HOSPITAL_LNG, RADIUS_TIERS_KM[0]));
  const cell = coverCells(HOSPITAL_LAT, HOSPITAL_LNG, RADIUS_TIERS_KM[1]).find((c) => !t0.has(c));
  if (cell === undefined) throw new Error('no tier-1-only cell around the hospital');
  return cell;
}
const RING_CELL = pickRingCell();

const NOW = new Date('2026-07-15T16:00:00Z'); // 12:00 donor-local NY — outside quiet hours
const NIGHT = new Date('2026-07-15T03:00:00Z'); // 23:00 donor-local NY (Jul 14) — quiet
const MORNING = new Date('2026-07-15T12:00:00Z'); // 08:00 donor-local NY — quiet window over
const MS_PER_MIN = 60_000;

function minutesBefore(base: Date, min: number): Date {
  return new Date(base.getTime() - min * MS_PER_MIN);
}
function hoursAfter(base: Date, h: number): Date {
  return new Date(base.getTime() + h * 60 * MS_PER_MIN);
}

const ZERO: SweepReport = {
  opened: 0,
  tiersAdvanced: 0,
  dispatched: 0,
  expired: 0,
  pledgesReleased: 0,
  closureNotices: 0,
};
function report(overrides: Partial<SweepReport> = {}): SweepReport {
  return { ...ZERO, ...overrides };
}

let db: PGlite;
let hospitalId: string;
let requesterId: string;
let seq = 0;

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

async function seedDonor(
  o: { geohash5?: string; pushToken?: string } = {},
): Promise<{ donorId: string; token: string }> {
  seq += 1;
  const token = o.pushToken ?? `tok_${seq}`;
  const res = await db.query<{ donor_id: string }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token,
                        push_verified_at, opted_in, available)
     VALUES ($1, $2, 'B+', $3, 'America/New_York', 'DONOR_PHONE', $4, $5::timestamptz, true, true)
     RETURNING donor_id`,
    [`uid_${seq}`, `donor_${seq}`, o.geohash5 ?? BASE_CELL, token, NOW.toISOString()],
  );
  return { donorId: firstRow(res).donor_id, token };
}

interface RequestSeed {
  urgency?: 'critical' | 'standard';
  state?: string;
  radiusTier?: number;
  createdAt?: Date;
  expiresAt?: Date;
}

async function seedRequest(o: RequestSeed = {}): Promise<string> {
  const res = await db.query<{ request_id: string }>(
    `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency,
                          state, radius_tier, expires_at, created_at)
     VALUES ($1, $2, 'B+', 2, $3::request_urgency, $4::request_state, $5,
             $6::timestamptz, $7::timestamptz)
     RETURNING request_id`,
    [
      requesterId,
      hospitalId,
      o.urgency ?? 'standard',
      o.state ?? 'open',
      o.radiusTier ?? 0,
      (o.expiresAt ?? hoursAfter(NOW, 24)).toISOString(),
      (o.createdAt ?? NOW).toISOString(),
    ],
  );
  return firstRow(res).request_id;
}

async function seedDispatch(
  requestId: string,
  donorId: string,
  response: 'accepted' | 'declined',
): Promise<string> {
  const res = await db.query<{ dispatch_id: string }>(
    `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send, sent_at, response, responded_at)
     VALUES ($1, $2, 0, $3::timestamptz, $4::dispatch_response, $3::timestamptz)
     RETURNING dispatch_id`,
    [requestId, donorId, minutesBefore(NOW, 60).toISOString(), response],
  );
  return firstRow(res).dispatch_id;
}

async function seedPledge(
  requestId: string,
  donorId: string,
  state: 'active' | 'donated',
): Promise<string> {
  const res = await db.query<{ pledge_id: string }>(
    `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
     VALUES ($1, $2, 'handle', 'B+', 'le_1h', $3::pledge_state)
     RETURNING pledge_id`,
    [requestId, donorId, state],
  );
  return firstRow(res).pledge_id;
}

interface RequestRow {
  state: string;
  radius_tier: number;
}
async function requestRow(id: string): Promise<RequestRow> {
  return firstRow(
    await db.query<RequestRow>(
      `SELECT state, radius_tier FROM request WHERE request_id = $1::uuid`,
      [id],
    ),
  );
}

async function pledgeStateOf(id: string): Promise<string> {
  return firstRow(
    await db.query<{ state: string }>(`SELECT state FROM pledge WHERE pledge_id = $1::uuid`, [id]),
  ).state;
}

async function dispatchIdFor(requestId: string, donorId: string): Promise<string | undefined> {
  const res = await db.query<{ dispatch_id: string }>(
    `SELECT dispatch_id FROM dispatch WHERE request_id = $1::uuid AND donor_id = $2::uuid`,
    [requestId, donorId],
  );
  return res.rows[0]?.dispatch_id;
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  // make_interval / quiet-hour math run in the session tz; pin UTC for determinism.
  await db.exec(`SET TIME ZONE 'UTC'`);

  hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ('Midtown Hospital', 'Times Square', 40.758000, -73.985500, 'HOSPITAL_BLOODBANK_PHONE')
       RETURNING hospital_id`,
    ),
  ).hospital_id;
  requesterId = firstRow(
    await db.query<{ requester_id: string }>(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ('uid_requester_sweep', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
      [hospitalId],
    ),
  ).requester_id;
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // Cascades clear dispatch + pledge; hospital + requester survive.
  await db.exec('TRUNCATE request, donor CASCADE');
});

test('open critical request: one cycle → alerting at BASE_TIER.critical (tier 1), donor dispatched', async () => {
  const reqId = await seedRequest({ urgency: 'critical', createdAt: NOW });
  const donor = await seedDonor();
  const push = new FakePushSender();

  const rep = await runSweep(db, push, NOW);

  expect(rep).toEqual(report({ opened: 1, tiersAdvanced: 1, dispatched: 1 }));
  const row = await requestRow(reqId);
  expect(row.state).toBe('alerting');
  expect(row.radius_tier).toBe(BASE_TIER.critical); // critical starts at 10 km — tier 1
  expect(push.sent).toHaveLength(1);
  expect(push.sent[0]?.token).toBe(donor.token);
  expect(push.sent[0]?.payload).toEqual({
    type: 'BLOOD_ALERT',
    alertId: await dispatchIdFor(reqId, donor.donorId),
  });
});

test('open standard request: one cycle → alerting at BASE_TIER.standard (tier 0)', async () => {
  const reqId = await seedRequest({ urgency: 'standard', createdAt: NOW });

  const rep = await runSweep(db, new FakePushSender(), NOW);

  expect(rep).toEqual(report({ opened: 1 })); // no eligible donors → 0 dispatched
  const row = await requestRow(reqId);
  expect(row.state).toBe('alerting');
  expect(row.radius_tier).toBe(BASE_TIER.standard);
});

test('standard alerting aged 31 min: tier 0 → 1, newly-covered ring-cell donor dispatched', async () => {
  const reqId = await seedRequest({ state: 'alerting', createdAt: minutesBefore(NOW, 31) });
  const ring = await seedDonor({ geohash5: RING_CELL });
  const push = new FakePushSender();

  const rep = await runSweep(db, push, NOW);

  expect(rep).toEqual(report({ tiersAdvanced: 1, dispatched: 1 }));
  expect((await requestRow(reqId)).radius_tier).toBe(1);
  expect(push.sent.map((s) => s.token)).toEqual([ring.token]);
});

test('standard alerting aged 90 min: tier capped at 2 — never 3', async () => {
  const reqId = await seedRequest({ state: 'alerting', createdAt: minutesBefore(NOW, 90) });

  const rep = await runSweep(db, new FakePushSender(), NOW);

  expect(rep).toEqual(report({ tiersAdvanced: 1 }));
  expect((await requestRow(reqId)).radius_tier).toBe(2); // min(2, 0 + floor(90/30)) = 2
});

test('radius_tier is monotonic: seeded above target, never lowered', async () => {
  const reqId = await seedRequest({
    state: 'alerting',
    createdAt: minutesBefore(NOW, 31), // target tier 1
    radiusTier: 2,
  });

  const rep = await runSweep(db, new FakePushSender(), NOW);

  expect(rep).toEqual(report()); // no advance counted
  expect((await requestRow(reqId)).radius_tier).toBe(2);
});

test('re-running the same cycle is a no-op: all-zero report', async () => {
  await seedRequest({ urgency: 'critical', createdAt: NOW });
  await seedDonor();
  const push = new FakePushSender();

  const first = await runSweep(db, push, NOW);
  expect(first).toEqual(report({ opened: 1, tiersAdvanced: 1, dispatched: 1 }));

  const second = await runSweep(db, push, NOW);
  expect(second).toEqual(report());
  expect(push.sent).toHaveLength(1); // never re-paged (dispatch anti-join)
});

test('quiet-hours pickup: skipped at night, dispatched next cycle after the window, no tier change', async () => {
  const reqId = await seedRequest({
    state: 'alerting',
    radiusTier: 2,
    createdAt: minutesBefore(NIGHT, 120), // schedule target already 2 → no advance either cycle
    expiresAt: hoursAfter(NOW, 24),
  });
  const donor = await seedDonor();
  const push = new FakePushSender();

  const night = await runSweep(db, push, NIGHT); // 23:00 donor-local — quiet, standard respects
  expect(night).toEqual(report()); // skipped, not excluded
  expect(push.sent).toHaveLength(0);

  const morning = await runSweep(db, push, MORNING); // 08:00 donor-local — window over
  expect(morning).toEqual(report({ dispatched: 1 }));
  expect(push.sent.map((s) => s.token)).toEqual([donor.token]);
  expect((await requestRow(reqId)).radius_tier).toBe(2); // no tier change
});

test('expiry: request expired, active pledge released with exact closure payload; donated + declined untouched', async () => {
  const reqId = await seedRequest({ state: 'partially_pledged', expiresAt: minutesBefore(NOW, 1) });
  const active = await seedDonor();
  const donated = await seedDonor();
  const declined = await seedDonor();
  const dispActive = await seedDispatch(reqId, active.donorId, 'accepted');
  await seedDispatch(reqId, donated.donorId, 'accepted');
  await seedDispatch(reqId, declined.donorId, 'declined');
  const activePledge = await seedPledge(reqId, active.donorId, 'active');
  const donatedPledge = await seedPledge(reqId, donated.donorId, 'donated');
  const push = new FakePushSender();

  const rep = await runSweep(db, push, NOW);

  expect(rep).toEqual(report({ expired: 1, pledgesReleased: 1, closureNotices: 1 }));
  expect((await requestRow(reqId)).state).toBe('expired');
  expect(await pledgeStateOf(activePledge)).toBe('released');
  expect(await pledgeStateOf(donatedPledge)).toBe('donated'); // terminal pledge untouched
  expect(push.sent).toHaveLength(1); // the declined donor gets nothing
  expect(push.sent[0]?.token).toBe(active.token);
  // Payload is EXACTLY { type, alertId: <their dispatch_id> } — opaque, no request content.
  expect(Object.keys(push.sent[0]?.payload ?? {}).sort()).toEqual(['alertId', 'type']);
  expect(push.sent[0]?.payload).toEqual({ type: 'REQUEST_CLOSED', alertId: dispActive });
});

test('covered request: neither advanced nor dispatched, but does expire with fan-out', async () => {
  const reqId = await seedRequest({
    state: 'covered',
    createdAt: minutesBefore(NOW, 40), // schedule would say tier 1 — must not apply
    expiresAt: hoursAfter(NOW, 1),
  });
  await seedDonor(); // free eligible donor — proves non-dispatch is the state filter
  const pledger = await seedDonor();
  const disp = await seedDispatch(reqId, pledger.donorId, 'accepted');
  const pledge = await seedPledge(reqId, pledger.donorId, 'active');
  const push = new FakePushSender();

  const live = await runSweep(db, push, NOW);
  expect(live).toEqual(report()); // dispatch paused, tier frozen
  expect(await requestRow(reqId)).toEqual({ state: 'covered', radius_tier: 0 });

  const later = await runSweep(db, push, hoursAfter(NOW, 2)); // past expires_at
  expect(later).toEqual(report({ expired: 1, pledgesReleased: 1, closureNotices: 1 }));
  expect((await requestRow(reqId)).state).toBe('expired');
  expect(await pledgeStateOf(pledge)).toBe('released');
  expect(push.sent.map((s) => s.payload)).toEqual([{ type: 'REQUEST_CLOSED', alertId: disp }]);
});

test('cancelled request: untouched — GB-14 owns its pledge release, the sweep only expires', async () => {
  const reqId = await seedRequest({ state: 'cancelled', expiresAt: minutesBefore(NOW, 5) });
  const pledger = await seedDonor();
  await seedDispatch(reqId, pledger.donorId, 'accepted');
  const pledge = await seedPledge(reqId, pledger.donorId, 'active');
  const push = new FakePushSender();

  const rep = await runSweep(db, push, NOW);

  expect(rep).toEqual(report());
  expect((await requestRow(reqId)).state).toBe('cancelled');
  expect(await pledgeStateOf(pledge)).toBe('active'); // not double-handled
  expect(push.sent).toHaveLength(0);
});

test("closure push failure ('error') is continued, not fatal: state persists, report intact", async () => {
  const reqId = await seedRequest({ state: 'partially_pledged', expiresAt: minutesBefore(NOW, 1) });
  const failing = await seedDonor({ pushToken: 'tok-err' });
  const ok = await seedDonor();
  await seedDispatch(reqId, failing.donorId, 'accepted');
  await seedDispatch(reqId, ok.donorId, 'accepted');
  const failingPledge = await seedPledge(reqId, failing.donorId, 'active');
  const okPledge = await seedPledge(reqId, ok.donorId, 'active');
  const push = new FakePushSender(new Map<string, PushResult>([['tok-err', 'error']]));

  const rep = await runSweep(db, push, NOW);

  expect(rep).toEqual(report({ expired: 1, pledgesReleased: 2, closureNotices: 2 }));
  expect((await requestRow(reqId)).state).toBe('expired'); // committed before any send
  expect(await pledgeStateOf(failingPledge)).toBe('released');
  expect(await pledgeStateOf(okPledge)).toBe('released');
  expect(push.sent.map((s) => s.token).sort()).toEqual(['tok-err', ok.token].sort());
});
