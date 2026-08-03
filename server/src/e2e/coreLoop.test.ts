// GB-15 — the core loop end to end, plus the PROTOCOL §7 races.
//
// Every product interaction here is an HTTP call against the app buildApp
// composes (GB-17). Nothing reaches into a route module, an engine, or a
// transaction directly: a donor exists because POST /donors created one, an
// alert exists because /internal/sweep dispatched it, and the alertId a donor
// taps comes out of the recorded push payload — exactly the handle a real
// client has. Direct SQL is confined to the three roles support.ts documents
// (seed hospital/requester, backdate the clock, read-only assertions).
//
// Scenarios: 1 happy loop · 2 overbook ceiling · 3 withdraw → regression →
// re-dispatch · 4 escalation reaches a far donor · 5 expiry with honest
// numbers · 6 cancel mid-flight.
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { BASE_TIER, TIER_WINDOW_MIN } from '../domain/protocol.js';
import { RADIUS_TIERS_KM } from '../matching/geo.js';
import {
  accept, alertIdFor, backdateCreatedAt, backdateExpiresAt, BASE_CELL, cancelRequest,
  cellDistanceKm, confirmPushVerified, dispatchResponseOf, getAlert, getMe, getRequest,
  type Harness, HOSPITAL, markDonated, minutesBefore, NOW, onboardDonor, pledgeCountFor,
  pledgeStateOf, postRequest, pushesTo, putPushToken, registerDonor, resetState, RING_CELL,
  startHarness, sweep, withdrawPledge,
} from './support.js';

// Response shapes this file reads values out of; everything else is asserted
// structurally with toEqual / toMatchObject.
interface DonorMe {
  handle: string;
  tz: string;
  pushVerified: boolean;
  lastDonationAt: string | null;
}
interface CreatedRequest {
  requestId: string;
  state: string;
}
interface SweepBody {
  opened: number;
  tiersAdvanced: number;
  dispatched: number;
  expired: number;
  pledgesReleased: number;
  closureNotices: number;
}
interface AlertBody {
  requestState: string;
  distanceKm: number;
}
interface Accepted {
  pledgeId: string;
  requestState: string;
}
interface RequestView {
  state: string;
  radiusTier: number;
  donorsAlerted: number;
  activePledges: number;
  unitsConfirmed: number;
  pledges: { pledgeId: string; state: string }[];
}

let h: Harness;

const ZERO: SweepBody = {
  opened: 0,
  tiersAdvanced: 0,
  dispatched: 0,
  expired: 0,
  pledgesReleased: 0,
  closureNotices: 0,
};
const report = (overrides: Partial<SweepBody> = {}): SweepBody => ({ ...ZERO, ...overrides });

/** POST /requests, then put created_at on the app's clock (see below). */
async function newRequest(urgency: 'critical' | 'standard', unitsNeeded: number): Promise<string> {
  const res = await postRequest(h, { unitsNeeded, urgency });
  expect(res.statusCode).toBe(201);
  const created = res.json<CreatedRequest>();
  expect(created.state).toBe('open');
  // request.created_at defaults to the DATABASE clock while the app clock is
  // pinned (support.NOW). The sweep's tier schedule is now − created_at, so
  // both must come from one clock or the elapsed time is meaningless.
  await backdateCreatedAt(h, created.requestId, NOW);
  return created.requestId;
}

async function runSweep(): Promise<SweepBody> {
  const res = await sweep(h);
  expect(res.statusCode).toBe(200);
  return res.json<SweepBody>();
}

async function view(requestId: string): Promise<RequestView> {
  const res = await getRequest(h, requestId);
  expect(res.statusCode).toBe(200);
  return res.json<RequestView>();
}

async function acceptOk(n: number, alertId: string, etaBucket: string): Promise<Accepted> {
  const res = await accept(h, n, alertId, etaBucket);
  expect(res.statusCode).toBe(200);
  return res.json<Accepted>();
}

/**
 * Shared setup for the two race scenarios: three onboarded donors, one
 * units=1 critical request (overbook ceiling = ceil(1 × 1.5) = 2), all three
 * alerted by one sweep, two accepts taken → `covered`.
 */
async function coveredByTwoOfThree(): Promise<{
  requestId: string;
  firstPledge: string;
  secondPledge: string;
}> {
  for (const n of [1, 2, 3]) await onboardDonor(h, n);
  const requestId = await newRequest('critical', 1);
  expect(await runSweep()).toEqual(report({ opened: 1, tiersAdvanced: 1, dispatched: 3 }));

  const first = await acceptOk(1, alertIdFor(h, 1), 'le_30m');
  expect(first.requestState).toBe('partially_pledged'); // 1 of 2 slots
  const second = await acceptOk(2, alertIdFor(h, 2), 'le_1h');
  expect(second.requestState).toBe('covered'); // ceiling reached
  return { requestId, firstPledge: first.pledgeId, secondPledge: second.pledgeId };
}

beforeAll(async () => {
  h = await startHarness();
  // Pin ONLY Date. Quiet hours (22:00–07:00 donor-local) gate every STANDARD
  // dispatch against the server's wall clock, so an unpinned suite would stop
  // dispatching for nine hours out of every twenty-four. Timers stay real —
  // Fastify and PGlite need them.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
}, 20_000);

afterAll(async () => {
  vi.useRealTimers();
  await h.app.close();
  await h.db.close();
});

beforeEach(async () => {
  await resetState(h);
});

test('1. happy loop: register → verify → alert → tap → accept → donated → fulfilled', async () => {
  // ── Donor onboarding, entirely over HTTP ──────────────────────────────────
  const reg = await registerDonor(h, 1, 'nightbird', BASE_CELL);
  expect(reg.statusCode).toBe(201);
  expect(reg.json()).toMatchObject({
    handle: 'nightbird',
    bloodGroup: 'B+',
    geohash5: BASE_CELL,
    tz: 'America/New_York', // derived from the cell, never sent by the client
  });

  const saved = await putPushToken(h, 1);
  expect(saved.statusCode).toBe(202);
  expect(saved.json()).toEqual({ verificationSent: true });
  // The verification probe carries its discriminator and nothing else — no id,
  // no request context, nothing a lock screen could leak.
  expect(pushesTo(h, 1)).toEqual([{ type: 'VERIFY_PUSH' }]);

  expect((await confirmPushVerified(h, 1)).statusCode).toBe(200);
  const me = (await getMe(h, 1)).json<DonorMe>();
  expect(me).toMatchObject({ handle: 'nightbird', pushVerified: true, lastDonationAt: null });

  // ── The hospital raises a critical B+ request ─────────────────────────────
  const requestId = await newRequest('critical', 1);

  // ── One sweep: kick-off, critical base tier, tier blast ───────────────────
  expect(await runSweep()).toEqual(report({ opened: 1, tiersAdvanced: 1, dispatched: 1 }));
  expect(await view(requestId)).toMatchObject({
    state: 'alerting',
    radiusTier: BASE_TIER.critical, // critical opens at T1 (10 km)
    donorsAlerted: 1,
    activePledges: 0,
  });

  const alertId = alertIdFor(h, 1);
  expect(pushesTo(h, 1)).toEqual([{ type: 'VERIFY_PUSH' }, { type: 'BLOOD_ALERT', alertId }]);

  // ── Fetch-on-tap: the push was opaque, the detail is behind donor auth ────
  const tapped = await getAlert(h, 1, alertId);
  expect(tapped.statusCode).toBe(200);
  expect(tapped.json()).toMatchObject({
    alertId,
    bloodGroup: 'B+',
    unitsNeeded: 1,
    urgency: 'critical',
    requestState: 'alerting',
    hospital: {
      name: HOSPITAL.name,
      address: HOSPITAL.address,
      lat: HOSPITAL.lat,
      lng: HOSPITAL.lng,
      bloodbankPhone: HOSPITAL.bloodbankPhone, // call to verify before travelling
    },
  });
  expect(tapped.json<AlertBody>().distanceKm).toBe(cellDistanceKm(BASE_CELL));

  // ── Accept → the requester's poll grows a pledge card ─────────────────────
  const pledge = await acceptOk(1, alertId, 'le_1h');
  expect(pledge.requestState).toBe('partially_pledged');

  const pledged = await view(requestId);
  expect(pledged).toMatchObject({
    state: 'partially_pledged',
    donorsAlerted: 1,
    activePledges: 1,
    unitsConfirmed: 0,
  });
  expect(pledged.pledges).toHaveLength(1);
  expect(pledged.pledges[0]).toMatchObject({
    pledgeId: pledge.pledgeId,
    donorHandle: 'nightbird',
    donorBloodGroup: 'B+',
    donorPhone: null, // share_phone_on_accept defaults off
    etaBucket: 'le_1h',
    state: 'active',
  });

  // ── The requester confirms the unit ───────────────────────────────────────
  const donated = await markDonated(h, pledge.pledgeId);
  expect(donated.statusCode).toBe(200);
  expect(donated.json()).toEqual({
    pledgeState: 'donated',
    requestState: 'fulfilled',
    unitsConfirmed: 1,
  });
  expect(await view(requestId)).toMatchObject({
    state: 'fulfilled',
    unitsConfirmed: 1,
    activePledges: 0,
  });
  // Cooldown started (DECISIONS #8) — visible on the donor's own row.
  expect((await getMe(h, 1)).json<DonorMe>().lastDonationAt).not.toBeNull();

  // Exactly two pushes ever left the server: the verify probe and one alert.
  expect(pushesTo(h, 1)).toHaveLength(2);
  expect(h.push.sent).toHaveLength(2);
});

test('2. overbook ceiling: the third acceptor loses the race and sees the honest closed screen', async () => {
  const { requestId } = await coveredByTwoOfThree();

  const loser = alertIdFor(h, 3);
  const late = await accept(h, 3, loser, 'le_2h');
  expect(late.statusCode).toBe(409);
  expect(late.json()).toEqual({ error: 'request_closed', requestState: 'covered' });

  // Fetch-on-tap renders the same truth the accept refused on.
  expect((await getAlert(h, 3, loser)).json<AlertBody>().requestState).toBe('covered');

  // No phantom pledge, and the loser's dispatch never left 'none'.
  expect(await dispatchResponseOf(h, loser)).toBe('none');
  expect(await pledgeCountFor(h, requestId)).toBe(2);
  expect(await view(requestId)).toMatchObject({
    state: 'covered',
    donorsAlerted: 3,
    activePledges: 2,
  });
});

test('3. withdraw regresses the request and the next sweep reaches a newly-registered donor', async () => {
  const { requestId, secondPledge } = await coveredByTwoOfThree();
  const before = [1, 2, 3].map((n) => pushesTo(h, n).length);
  expect(before).toEqual([2, 2, 2]); // verify + alert each, nothing more

  const withdrawn = await withdrawPledge(h, 2, secondPledge);
  expect(withdrawn.statusCode).toBe(200);
  expect(withdrawn.json()).toEqual({ pledgeState: 'withdrawn', requestState: 'partially_pledged' });

  // A donor who registers AFTER the first sweep: the dispatch anti-join has no
  // row for them, so the resumed dispatch picks them up and nobody else.
  await onboardDonor(h, 4);
  expect(pushesTo(h, 4)).toEqual([{ type: 'VERIFY_PUSH' }]);

  expect(await runSweep()).toEqual(report({ dispatched: 1 }));

  const fresh = alertIdFor(h, 4);
  expect(pushesTo(h, 4)).toEqual([{ type: 'VERIFY_PUSH' }, { type: 'BLOOD_ALERT', alertId: fresh }]);
  // Pledged, withdrawn and never-answered alike: no donor is re-paged.
  expect([1, 2, 3].map((n) => pushesTo(h, n).length)).toEqual(before);

  expect(await view(requestId)).toMatchObject({
    state: 'partially_pledged',
    donorsAlerted: 4,
    activePledges: 1,
  });
});

test('4. escalation: a donor outside tier 0 is unreachable until the tier window elapses', async () => {
  await onboardDonor(h, 1, RING_CELL);
  const requestId = await newRequest('standard', 1);

  // Standard opens at T0 (5 km). The ring donor sits outside it.
  expect(await runSweep()).toEqual(report({ opened: 1 }));
  expect(pushesTo(h, 1)).toEqual([{ type: 'VERIFY_PUSH' }]);
  expect(await view(requestId)).toMatchObject({
    state: 'alerting',
    radiusTier: BASE_TIER.standard,
    donorsAlerted: 0,
  });

  // One TIER_WINDOW_STANDARD elapses (31 min): the schedule raises the tier.
  await backdateCreatedAt(h, requestId, minutesBefore(NOW, TIER_WINDOW_MIN.standard + 1));
  expect(await runSweep()).toEqual(report({ tiersAdvanced: 1, dispatched: 1 }));
  expect(await view(requestId)).toMatchObject({ radiusTier: 1, donorsAlerted: 1 });

  const alertId = alertIdFor(h, 1);
  expect(pushesTo(h, 1)).toEqual([{ type: 'VERIFY_PUSH' }, { type: 'BLOOD_ALERT', alertId }]);

  const detail = (await getAlert(h, 1, alertId)).json<AlertBody>();
  expect(detail.distanceKm).toBe(cellDistanceKm(RING_CELL));
  expect(detail.distanceKm).toBeGreaterThan(RADIUS_TIERS_KM[0]); // tier 0 could not have reached
});

test('5. expiry: the pledger gets a closure notice, the requester gets honest numbers', async () => {
  await onboardDonor(h, 1);
  await onboardDonor(h, 2);
  const requestId = await newRequest('critical', 2);
  expect(await runSweep()).toEqual(report({ opened: 1, tiersAdvanced: 1, dispatched: 2 }));

  const alert1 = alertIdFor(h, 1);
  const alert2 = alertIdFor(h, 2); // d2 never answers
  const pledge = await acceptOk(1, alert1, 'le_1h');
  expect(pledge.requestState).toBe('partially_pledged');

  await backdateExpiresAt(h, requestId, minutesBefore(NOW, 1));
  expect(await runSweep()).toEqual(report({ expired: 1, pledgesReleased: 1, closureNotices: 1 }));

  // The closure notice is keyed by the donor's OWN dispatch id — still opaque.
  expect(pushesTo(h, 1)).toEqual([
    { type: 'VERIFY_PUSH' },
    { type: 'BLOOD_ALERT', alertId: alert1 },
    { type: 'REQUEST_CLOSED', alertId: alert1 },
  ]);
  // d2 pledged nothing, so there is nothing to stand down from.
  expect(pushesTo(h, 2)).toEqual([
    { type: 'VERIFY_PUSH' },
    { type: 'BLOOD_ALERT', alertId: alert2 },
  ]);

  const closed = await view(requestId);
  expect(closed).toMatchObject({
    state: 'expired',
    donorsAlerted: 2, // the honest number survives the close
    activePledges: 0,
    unitsConfirmed: 0,
  });
  expect(closed.pledges).toEqual([]); // a released pledge leaves the card list
  expect(await pledgeStateOf(h, pledge.pledgeId)).toBe('released');
});

test('6. cancel mid-flight: pledges released, a late tap on the sent alert is refused', async () => {
  await onboardDonor(h, 1);
  await onboardDonor(h, 2);
  const requestId = await newRequest('critical', 1);
  expect(await runSweep()).toEqual(report({ opened: 1, tiersAdvanced: 1, dispatched: 2 }));

  const alert2 = alertIdFor(h, 2); // delivered, untouched
  const pledge = await acceptOk(1, alertIdFor(h, 1), 'le_30m');

  const cancelled = await cancelRequest(h, requestId);
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json()).toEqual({ requestState: 'cancelled', pledgesReleased: 1 });
  expect(await pledgeStateOf(h, pledge.pledgeId)).toBe('released');

  const late = await accept(h, 2, alert2, 'le_1h');
  expect(late.statusCode).toBe(409);
  expect(late.json()).toEqual({ error: 'request_closed', requestState: 'cancelled' });
  expect(await dispatchResponseOf(h, alert2)).toBe('none');

  // The pledged donor is told the request closed (GB-32) — same opaque notice
  // the expiry sweep sends, keyed by their OWN dispatch id. A tap self-corrects
  // either way (PROTOCOL §3), but a donor who committed to show up is not left
  // to discover it.
  expect((await getAlert(h, 2, alert2)).json<AlertBody>().requestState).toBe('cancelled');
  expect(pushesTo(h, 1)).toEqual([
    { type: 'VERIFY_PUSH' },
    { type: 'BLOOD_ALERT', alertId: alertIdFor(h, 1) },
    { type: 'REQUEST_CLOSED', alertId: alertIdFor(h, 1) },
  ]);
  // d2 pledged nothing, so there is nothing to stand down from.
  expect(pushesTo(h, 2)).toHaveLength(2);
});
