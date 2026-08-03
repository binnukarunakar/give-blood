// Fulfillment transaction machinery (GB-14), split from fulfillment.ts for the
// 300-line cap (fulfillment.ts owns the Fastify wiring + HTTP mapping). Canonical:
// docs/PROTOCOL.md §6 (two separated facts) & §7 (races); docs/DATA_MODEL.md
// (Pledge FSM: `donated` is the ONLY cooldown-stamping edge; bench deferral =
// released, never donated; a covered-slot release regresses the request and the
// SWEEP resumes dispatch — we only regress state). Every mutation is ONE
// BEGIN/COMMIT transaction on the single session (board ruling) with the request
// row locked FOR UPDATE before any recount/transition. Every state string written
// by an UPDATE is PRODUCED by transitionRequest/transitionPledge. Parameterized SQL only.
import { type PledgeEvent, type PledgeState, transitionPledge } from '../domain/pledgeFsm.js';
import { isRequestTerminal, type RequestState, transitionRequest } from '../domain/requestFsm.js';
import type { SqlClient } from '../matching/eligibility.js';
import { type ClosureNotice, collectNotices, RELEASE_ACTIVE_PLEDGES_SQL, type ReleasedPledgeRow } from './fulfillmentClosure.js';

// ── SQL (all parameterized) ──────────────────────────────────────────────────

// Ownership resolution. Requester-side routes resolve the caller as the OWNING
// requester of the pledge's request; the donor-side route resolves the caller as
// the pledge's donor. A miss on existence OR ownership yields zero rows → one
// uniform 404 (a foreign/absent pledge must never be probeable).
const RESOLVE_PLEDGE_BY_REQUESTER_SQL = `
  SELECT p.request_id AS request_id, p.donor_id AS donor_id
  FROM pledge p
  JOIN request r    ON r.request_id = p.request_id
  JOIN requester rq ON rq.requester_id = r.requester_id
  WHERE p.pledge_id = $1::uuid AND rq.firebase_uid = $2
`;
const RESOLVE_PLEDGE_BY_DONOR_SQL = `
  SELECT p.request_id AS request_id, p.donor_id AS donor_id
  FROM pledge p
  JOIN donor d ON d.donor_id = p.donor_id
  WHERE p.pledge_id = $1::uuid AND d.firebase_uid = $2
`;
const RESOLVE_REQUEST_BY_REQUESTER_SQL = `
  SELECT r.request_id AS request_id
  FROM request r
  JOIN requester rq ON rq.requester_id = r.requester_id
  WHERE r.request_id = $1::uuid AND rq.firebase_uid = $2
`;

// Lock the request row so guard + recount + transition are serialized against
// every other fulfillment mutation on the same request.
const LOCK_REQUEST_SQL = `
  SELECT state, units_needed, units_confirmed
  FROM request WHERE request_id = $1::uuid FOR UPDATE
`;

// Re-read the pledge state AFTER acquiring the request lock: the ownership query
// runs pre-lock, so a concurrent mutation could have moved the pledge between
// resolve and lock. Under the lock this value is the stable `active` guard input.
const READ_PLEDGE_STATE_SQL = `SELECT state FROM pledge WHERE pledge_id = $1::uuid`;

const COUNT_ACTIVE_PLEDGES_SQL = `
  SELECT count(*)::int AS n FROM pledge WHERE request_id = $1::uuid AND state = 'active'
`;
const UPDATE_PLEDGE_STATE_SQL = `
  UPDATE pledge SET state = $2::pledge_state WHERE pledge_id = $1::uuid
`;
const UPDATE_REQUEST_STATE_SQL = `
  UPDATE request SET state = $2::request_state WHERE request_id = $1::uuid
`;
const INCREMENT_UNITS_CONFIRMED_SQL = `
  UPDATE request SET units_confirmed = units_confirmed + 1
  WHERE request_id = $1::uuid RETURNING units_confirmed
`;

// Dual-path cooldown (PROTOCOL §6): requester confirm OR donor self-report,
// whichever first. GREATEST(...) never moves the stamp backward — a donor who
// already self-reported keeps the greater timestamp.
const STAMP_COOLDOWN_SQL = `
  UPDATE donor
  SET last_donation_at = GREATEST(COALESCE(last_donation_at, '-infinity'::timestamptz), now())
  WHERE donor_id = $1::uuid
`;

// The release fan-out + the closure notices it produces: fulfillmentClosure.ts.

// ── Row shapes ───────────────────────────────────────────────────────────────

interface ResolveRow {
  request_id: string;
  donor_id: string;
}
interface RequestLockRow {
  state: RequestState;
  units_needed: number;
  units_confirmed: number;
}
interface PledgeStateRow {
  state: PledgeState;
}
interface UnitsConfirmedRow {
  units_confirmed: number;
}

/** The locked, consistent view a pledge-side mutation operates on. */
interface PledgeContext {
  requestId: string;
  donorId: string;
  requestState: RequestState;
  unitsNeeded: number;
  unitsConfirmed: number;
  pledgeState: PledgeState;
}

type PledgeAuthSide = 'requester' | 'donor';

// ── Result types (discriminated per route family) ────────────────────────────

// `notices` is transport, not response: the routes send it after COMMIT and the
// HTTP mapping never serializes it (the wire shapes are unchanged).
export type DonatedResult =
  | { kind: 'donated'; pledgeState: PledgeState; requestState: RequestState; unitsConfirmed: number; notices: ClosureNotice[] }
  | { kind: 'not_found' }
  | { kind: 'not_active'; state: PledgeState };

export type ReleaseResult =
  | { kind: 'released'; pledgeState: PledgeState; requestState: RequestState }
  | { kind: 'not_found' }
  | { kind: 'not_active'; state: PledgeState };

export type CancelResult =
  | { kind: 'cancelled'; requestState: RequestState; pledgesReleased: number; notices: ClosureNotice[] }
  | { kind: 'not_found' }
  | { kind: 'already_closed'; state: RequestState };

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Resolve ownership (uniform 404 on any miss), lock the request row FOR UPDATE,
 * then re-read the pledge state under the lock. Assumes a transaction is open.
 */
async function resolvePledgeContext(
  db: SqlClient,
  pledgeId: string,
  uid: string,
  side: PledgeAuthSide,
): Promise<PledgeContext | null> {
  const resolveSql =
    side === 'requester' ? RESOLVE_PLEDGE_BY_REQUESTER_SQL : RESOLVE_PLEDGE_BY_DONOR_SQL;
  const resolved = await db.query<ResolveRow>(resolveSql, [pledgeId, uid]);
  const owned = resolved.rows[0];
  if (owned === undefined) return null;

  const locked = await db.query<RequestLockRow>(LOCK_REQUEST_SQL, [owned.request_id]);
  const req = locked.rows[0];
  if (req === undefined) return null; // FK guarantees presence; defensive.

  const pledge = await db.query<PledgeStateRow>(READ_PLEDGE_STATE_SQL, [pledgeId]);
  const pledgeRow = pledge.rows[0];
  if (pledgeRow === undefined) return null; // no deletes exist; defensive.

  return {
    requestId: owned.request_id,
    donorId: owned.donor_id,
    requestState: req.state,
    unitsNeeded: req.units_needed,
    unitsConfirmed: req.units_confirmed,
    pledgeState: pledgeRow.state,
  };
}

async function countActive(db: SqlClient, requestId: string): Promise<number> {
  const res = await db.query<{ n: number }>(COUNT_ACTIVE_PLEDGES_SQL, [requestId]);
  return res.rows[0]?.n ?? 0;
}

/** One BEGIN/COMMIT over `core`; COMMIT iff `committed(result)`, else ROLLBACK. */
async function runInTxn<T>(
  db: SqlClient,
  core: () => Promise<T>,
  committed: (result: T) => boolean,
): Promise<T> {
  await db.query('BEGIN');
  try {
    const result = await core();
    await db.query(committed(result) ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

// ── Guarded cores ────────────────────────────────────────────────────────────

async function donatedGuarded(db: SqlClient, pledgeId: string, uid: string): Promise<DonatedResult> {
  const ctx = await resolvePledgeContext(db, pledgeId, uid, 'requester');
  if (ctx === null) return { kind: 'not_found' };
  if (ctx.pledgeState !== 'active') return { kind: 'not_active', state: ctx.pledgeState };

  const pledgeState = transitionPledge('active', { type: 'requester_confirmed_donation' });
  await db.query(UPDATE_PLEDGE_STATE_SQL, [pledgeId, pledgeState]);
  const inc = await db.query<UnitsConfirmedRow>(INCREMENT_UNITS_CONFIRMED_SQL, [ctx.requestId]);
  const unitsConfirmed = inc.rows[0]?.units_confirmed ?? ctx.unitsConfirmed + 1;
  await db.query(STAMP_COOLDOWN_SQL, [ctx.donorId]); // dual-path; never backward

  // Recount active AFTER the pledge-state UPDATE. A donated pledge leaving
  // 'active' does NOT free a slot for regression — DATA_MODEL's named regression
  // triggers are no_show/withdraw only, so `pledge_released_slot` is never fired
  // here. If not yet fulfilled the request state stays as-is; the sweep's
  // dispatch anti-join tops the pool up. The recount only feeds the ctx below.
  const activePledges = await countActive(db, ctx.requestId);

  let requestState: RequestState = ctx.requestState;
  let notices: ClosureNotice[] = [];
  if (unitsConfirmed >= ctx.unitsNeeded) {
    requestState = transitionRequest(
      ctx.requestState,
      { type: 'units_confirmed_reached' },
      { activePledges, unitsNeeded: ctx.unitsNeeded, unitsConfirmed },
    );
    await db.query(UPDATE_REQUEST_STATE_SQL, [ctx.requestId, requestState]);
    // Fan-out: the just-donated pledge is no longer 'active', so the filter
    // releases only the remaining siblings — and only they get a closure notice.
    // The donor who donated holds a 'donated' pledge, not a released one.
    const releasedState = transitionPledge('active', { type: 'request_closed' });
    const released = await db.query<ReleasedPledgeRow>(RELEASE_ACTIVE_PLEDGES_SQL, [
      ctx.requestId,
      releasedState,
    ]);
    notices = collectNotices(released.rows);
  }
  return { kind: 'donated', pledgeState, requestState, unitsConfirmed, notices };
}

async function slotReleaseGuarded(
  db: SqlClient,
  pledgeId: string,
  uid: string,
  side: PledgeAuthSide,
  event: PledgeEvent,
): Promise<ReleaseResult> {
  const ctx = await resolvePledgeContext(db, pledgeId, uid, side);
  if (ctx === null) return { kind: 'not_found' };
  if (ctx.pledgeState !== 'active') return { kind: 'not_active', state: ctx.pledgeState };

  const pledgeState = transitionPledge('active', event); // → no_show | withdrawn
  await db.query(UPDATE_PLEDGE_STATE_SQL, [pledgeId, pledgeState]);

  // Recount AFTER the pledge-state UPDATE; the FSM decides the request state
  // (covered → partially_pledged/alerting regression — the sweep resumes dispatch).
  const activePledges = await countActive(db, ctx.requestId);
  const requestState = transitionRequest(
    ctx.requestState,
    { type: 'pledge_released_slot' },
    { activePledges, unitsNeeded: ctx.unitsNeeded, unitsConfirmed: ctx.unitsConfirmed },
  );
  if (requestState !== ctx.requestState) {
    await db.query(UPDATE_REQUEST_STATE_SQL, [ctx.requestId, requestState]);
  }
  return { kind: 'released', pledgeState, requestState };
}

async function cancelGuarded(db: SqlClient, requestId: string, uid: string): Promise<CancelResult> {
  const owned = await db.query<ResolveRow>(RESOLVE_REQUEST_BY_REQUESTER_SQL, [requestId, uid]);
  if (owned.rows[0] === undefined) return { kind: 'not_found' };

  const locked = await db.query<RequestLockRow>(LOCK_REQUEST_SQL, [requestId]);
  const req = locked.rows[0];
  if (req === undefined) return { kind: 'not_found' }; // defensive.
  if (isRequestTerminal(req.state)) return { kind: 'already_closed', state: req.state };

  const activePledges = await countActive(db, requestId);
  const requestState = transitionRequest(
    req.state,
    { type: 'requester_cancelled' },
    { activePledges, unitsNeeded: req.units_needed, unitsConfirmed: req.units_confirmed },
  );
  await db.query(UPDATE_REQUEST_STATE_SQL, [requestId, requestState]);

  // NOTE: cancelled is terminal; the sweep (GB-12) skips terminal states, so its
  // expiry close-fan-out won't re-release — the release below is the only one,
  // and so are its closure notices (sent post-COMMIT by the route).
  const releasedState = transitionPledge('active', { type: 'request_closed' });
  const released = await db.query<ReleasedPledgeRow>(RELEASE_ACTIVE_PLEDGES_SQL, [requestId, releasedState]);
  const notices = collectNotices(released.rows);
  return { kind: 'cancelled', requestState, pledgesReleased: released.rows.length, notices };
}

// ── Public transaction entry points ──────────────────────────────────────────

export function runDonatedTxn(db: SqlClient, pledgeId: string, uid: string): Promise<DonatedResult> {
  return runInTxn(db, () => donatedGuarded(db, pledgeId, uid), (r) => r.kind === 'donated');
}

export function runNoShowTxn(db: SqlClient, pledgeId: string, uid: string): Promise<ReleaseResult> {
  const core = () =>
    slotReleaseGuarded(db, pledgeId, uid, 'requester', { type: 'requester_marked_no_show' });
  return runInTxn(db, core, (r) => r.kind === 'released');
}

export function runWithdrawTxn(db: SqlClient, pledgeId: string, uid: string): Promise<ReleaseResult> {
  const core = () => slotReleaseGuarded(db, pledgeId, uid, 'donor', { type: 'donor_withdrew' });
  return runInTxn(db, core, (r) => r.kind === 'released');
}

export function runCancelTxn(db: SqlClient, requestId: string, uid: string): Promise<CancelResult> {
  return runInTxn(db, () => cancelGuarded(db, requestId, uid), (r) => r.kind === 'cancelled');
}
