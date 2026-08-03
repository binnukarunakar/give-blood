// GB-15 end-to-end harness. Shared fixtures + HTTP drivers for coreLoop.test.ts.
//
// The app under test is composed exactly as production composes it — buildApp
// owns the whole route surface (GB-17) — with three seams swapped for fakes:
// PGlite for Postgres, FakeTokenVerifier for Firebase, FakePushSender for FCM.
//
// E2E RULE: every product interaction goes through HTTP. Direct SQL appears in
// exactly three roles, each covering something that has NO endpoint by design:
//   1. seeding the hospital registry + the operator-verified requester row —
//      PROTOCOL §1 makes hospitals curated and requesters operator-verified, so
//      neither is self-service and no route creates them;
//   2. backdating request.created_at / expires_at to simulate elapsed time —
//      /internal/sweep stamps its own clock, so time cannot be injected;
//   3. read-only assertions on final DB state.
// Anything else — registration, push verification, request creation, dispatch,
// fetch-on-tap, accept, withdraw, donated, cancel — is an app.inject call.
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import ngeohash from 'ngeohash';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import type { AuthUser } from '../auth/verifier.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/migrate.js';
import { coverCells, haversineKm, RADIUS_TIERS_KM } from '../matching/geo.js';
import { FakePushSender } from '../push/fakePushSender.js';
import type { PushPayload } from '../push/pushSender.js';

export const SWEEP_SECRET = 'a-sufficiently-long-secret';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: SWEEP_SECRET,
  APP_BASE_URL: 'https://gb.example.com',
});

/** Times Square — the same fixture hospital the dispatch/sweep suites use. */
export const HOSPITAL = {
  name: 'Midtown Hospital',
  address: '1 Times Sq, New York',
  lat: 40.758,
  lng: -73.9855,
  bloodbankPhone: 'HOSPITAL_BLOODBANK_PHONE',
} as const;

/** The hospital's own geohash-5 cell (Manhattan, 'dr5ru') — covered at every tier. */
export const BASE_CELL = ngeohash.encode(HOSPITAL.lat, HOSPITAL.lng, 5);

/**
 * Wall clock the suite pins Date to. Quiet hours (22:00–07:00 donor-local) are
 * evaluated against the server's real clock for STANDARD requests, so an
 * unpinned suite would silently stop dispatching between 22:00 and 07:00 in
 * America/New_York. 16:00Z = 12:00 in the donors' tz — mid-window, unambiguous.
 */
export const NOW = new Date('2026-07-15T16:00:00Z');

const MS_PER_MIN = 60_000;
export function minutesBefore(base: Date, minutes: number): Date {
  return new Date(base.getTime() - minutes * MS_PER_MIN);
}

/** Distance from a cell centroid to the hospital, rounded like the alerts route. */
export function cellDistanceKm(cell: string): number {
  const { latitude, longitude } = ngeohash.decode(cell);
  return Math.round(haversineKm(latitude, longitude, HOSPITAL.lat, HOSPITAL.lng) * 10) / 10;
}

/**
 * The NEAREST cell covered at tier 1 (10 km) but not at tier 0 (5 km), derived
 * from the cover sets themselves so the fixture cannot drift out of sync with
 * the geo tolerance math. Its centroid sits ~8 km out: beyond the tier-0 radius,
 * inside the tier-1 one.
 */
function pickRingCell(): string {
  const tier0 = new Set(coverCells(HOSPITAL.lat, HOSPITAL.lng, RADIUS_TIERS_KM[0]));
  const ring = coverCells(HOSPITAL.lat, HOSPITAL.lng, RADIUS_TIERS_KM[1])
    .filter((cell) => !tier0.has(cell))
    .sort((a, b) => cellDistanceKm(a) - cellDistanceKm(b))[0];
  if (ring === undefined) throw new Error('no tier-1-only cell around the hospital');
  return ring;
}
export const RING_CELL = pickRingCell();

// ── Principals (FakeTokenVerifier: exactly one token per principal) ──────────

const REQUESTER_UID = 'uid-requester';
export const REQUESTER_TOKEN = 'tok-requester';
/** Donor slots the verifier knows about; scenarios use as many as they need. */
const DONOR_SLOTS = 5;
/** Firebase ID token for donor slot n. */
const donorToken = (n: number): string => `tok-d${n}`;
/** FCM registration token donor slot n saves — the key push history is read by. */
export const pushTokenOf = (n: number): string => `push-d${n}`;

export interface Harness {
  db: PGlite;
  app: FastifyInstance;
  push: FakePushSender;
  hospitalId: string;
}

function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

export async function startHarness(): Promise<Harness> {
  const db = new PGlite();
  await applyMigrations(db);
  // make_interval / quiet-hour extraction run in the session tz; pin UTC.
  await db.exec(`SET TIME ZONE 'UTC'`);

  const hospitalId = firstRow(
    await db.query<{ hospital_id: string }>(
      `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
       VALUES ($1, $2, $3::numeric, $4::numeric, $5) RETURNING hospital_id`,
      [HOSPITAL.name, HOSPITAL.address, HOSPITAL.lat, HOSPITAL.lng, HOSPITAL.bloodbankPhone],
    ),
  ).hospital_id;
  await db.query(
    `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
     VALUES ($1, true, $2::uuid, 'REQUESTER_PHONE')`,
    [REQUESTER_UID, hospitalId],
  );

  const principals: [string, AuthUser][] = [[REQUESTER_TOKEN, { uid: REQUESTER_UID, phone: null }]];
  for (let n = 1; n <= DONOR_SLOTS; n += 1) {
    // Donor identity IS the phone claim (DATA_MODEL) — registration requires it.
    principals.push([donorToken(n), { uid: `uid-d${n}`, phone: `DONOR_PHONE_${n}` }]);
  }

  const push = new FakePushSender();
  const app = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(new Map(principals)),
    db,
    push,
    logger: false,
  });
  await app.ready();
  return { db, app, push, hospitalId };
}

/** Per-test isolation: requests + donors go, hospital + requester fixtures stay. */
export async function resetState(h: Harness): Promise<void> {
  await h.db.exec('TRUNCATE request, donor CASCADE'); // cascades to dispatch + pledge
  h.push.sent.length = 0;
}

// ── HTTP drivers ─────────────────────────────────────────────────────────────

type Res = Promise<LightMyRequestResponse>;

/** One authenticated call; `payload` is omitted for GETs and bodiless POSTs. */
function call(
  h: Harness,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  payload?: Record<string, unknown>,
): Res {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

export const registerDonor = (h: Harness, n: number, handle: string, geohash5: string): Res =>
  call(h, 'POST', '/donors', donorToken(n), { handle, bloodGroup: 'B+', geohash5, consent: true });

export const putPushToken = (h: Harness, n: number): Res =>
  call(h, 'PUT', '/donors/me/push-token', donorToken(n), { token: pushTokenOf(n) });

export const confirmPushVerified = (h: Harness, n: number): Res =>
  call(h, 'POST', '/donors/me/push-verified', donorToken(n));

export const getMe = (h: Harness, n: number): Res => call(h, 'GET', '/donors/me', donorToken(n));

export const getAlert = (h: Harness, n: number, alertId: string): Res =>
  call(h, 'GET', `/alerts/${alertId}`, donorToken(n));

export const accept = (h: Harness, n: number, alertId: string, etaBucket: string): Res =>
  call(h, 'POST', `/alerts/${alertId}/accept`, donorToken(n), { etaBucket });

export const withdrawPledge = (h: Harness, n: number, pledgeId: string): Res =>
  call(h, 'POST', `/pledges/${pledgeId}/withdraw`, donorToken(n));

export const postRequest = (
  h: Harness,
  body: { unitsNeeded: number; urgency: 'critical' | 'standard' },
): Res =>
  call(h, 'POST', '/requests', REQUESTER_TOKEN, {
    bloodGroup: 'B+',
    hospitalId: h.hospitalId,
    ...body,
  });

export const getRequest = (h: Harness, requestId: string): Res =>
  call(h, 'GET', `/requests/${requestId}`, REQUESTER_TOKEN);

export const markDonated = (h: Harness, pledgeId: string): Res =>
  call(h, 'POST', `/pledges/${pledgeId}/donated`, REQUESTER_TOKEN);

export const cancelRequest = (h: Harness, requestId: string): Res =>
  call(h, 'POST', `/requests/${requestId}/cancel`, REQUESTER_TOKEN);

/** The Cloud Scheduler heartbeat — machine auth, not a Firebase principal. */
export const sweep = (h: Harness): Res =>
  h.app.inject({
    method: 'POST',
    url: '/internal/sweep',
    headers: { 'x-sweep-secret': SWEEP_SECRET },
  });

/** Register → save push token → ack the verification push, all over HTTP. */
export async function onboardDonor(h: Harness, n: number, geohash5 = BASE_CELL): Promise<void> {
  const steps: [string, number, LightMyRequestResponse][] = [
    ['register', 201, await registerDonor(h, n, `donor${n}`, geohash5)],
    ['push-token', 202, await putPushToken(h, n)],
    ['push-verified', 200, await confirmPushVerified(h, n)],
  ];
  for (const [step, expected, res] of steps) {
    if (res.statusCode !== expected) {
      throw new Error(`onboard d${n}: ${step} returned ${res.statusCode} — ${res.body}`);
    }
  }
}

// ── Push inspection (the donor's device history) ─────────────────────────────

export function pushesTo(h: Harness, n: number): PushPayload[] {
  return h.push.sent.filter((s) => s.token === pushTokenOf(n)).map((s) => s.payload);
}

/** The opaque alertId the donor's BLOOD_ALERT carried — a client's only handle. */
export function alertIdFor(h: Harness, n: number): string {
  const alert = pushesTo(h, n).find((p) => p.type === 'BLOOD_ALERT');
  if (alert === undefined) throw new Error(`donor d${n} never received a BLOOD_ALERT`);
  return alert.alertId;
}

// ── Time control + read-only state assertions (the only direct SQL) ──────────

export async function backdateCreatedAt(h: Harness, requestId: string, at: Date): Promise<void> {
  await h.db.query(`UPDATE request SET created_at = $2::timestamptz WHERE request_id = $1::uuid`, [
    requestId,
    at.toISOString(),
  ]);
}

export async function backdateExpiresAt(h: Harness, requestId: string, at: Date): Promise<void> {
  await h.db.query(`UPDATE request SET expires_at = $2::timestamptz WHERE request_id = $1::uuid`, [
    requestId,
    at.toISOString(),
  ]);
}

/** Single-value read of one row, keyed by a uuid. Read-only, assertions only. */
async function scalar<T>(h: Harness, sql: string, id: string): Promise<T> {
  return firstRow(await h.db.query<{ v: T }>(sql, [id])).v;
}

export const pledgeStateOf = (h: Harness, pledgeId: string): Promise<string> =>
  scalar(h, `SELECT state AS v FROM pledge WHERE pledge_id = $1::uuid`, pledgeId);

export const dispatchResponseOf = (h: Harness, dispatchId: string): Promise<string> =>
  scalar(h, `SELECT response AS v FROM dispatch WHERE dispatch_id = $1::uuid`, dispatchId);

export const pledgeCountFor = (h: Harness, requestId: string): Promise<number> =>
  scalar(h, `SELECT count(*)::int AS v FROM pledge WHERE request_id = $1::uuid`, requestId);
