// The 60-second heartbeat: escalation + expiry sweep (docs/PROTOCOL.md §5,
// canonical). Cloud Scheduler POSTs /internal/sweep (src/routes/internal.ts);
// each call runs ONE idempotent pass, in this order:
//
//   a. expiry       — expires_at passed → 'expired'; still-active pledges →
//                     'released'; closure notices collected for post-COMMIT send
//   b. kick-off     — 'open' requests → 'alerting' (dispatched in pass d of this
//                     same cycle; alerting = "dispatch attempted", even at zero
//                     matched donors)
//   c. tier advance — radius_tier raised to the DETERMINISTIC created_at
//                     schedule (architect ruling — no schema column), applied
//                     monotonically: never lowered. Idempotent, self-correcting
//                     after downtime.
//   d. dispatch     — dispatchTier re-runs for EVERY alerting/partially_pledged
//                     request at its (possibly just-raised) tier. The dispatch
//                     anti-join makes this a no-op unless newly eligible donors
//                     exist (quiet hours ended, fresh registrations, freed
//                     pledges) — this IS the quiet-hours pickup. Covered
//                     requests: neither advanced nor dispatched (dispatch
//                     paused — DATA_MODEL), but they DO expire in pass a.
//
// TRANSACTION BOUNDARY (deliberate): passes a–d run inside one BEGIN/COMMIT on
// a single-session SqlClient (standing ruling). ALERT pushes are
// sent mid-transaction by dispatchTier: each pairs with its Dispatch insert,
// and if the process dies mid-pass the anti-join resumes cleanly next cycle.
// CLOSURE notices are the exception — their state change (pledge released,
// request expired) IS the transaction, so they are only collected during the
// pass and sent AFTER COMMIT: a failed push must never roll back state.
// Best-effort is safe because fetch-on-tap self-corrects (PROTOCOL.md §3).
//
// SQL statements + row shapes live in sweepSql.ts (300-line-cap split).
import { dispatchTier } from '../dispatch/engine.js';
import { BASE_TIER, TIER_WINDOW_MIN } from '../domain/protocol.js';
import { transitionRequest } from '../domain/requestFsm.js';
import type { SqlClient } from '../matching/eligibility.js';
import { RADIUS_TIERS_KM } from '../matching/geo.js';
import type { PushSender } from '../push/pushSender.js';
import {
  ADVANCE_CANDIDATES_SQL,
  type AdvanceRow,
  DISPATCH_CANDIDATES_SQL,
  DISPATCHABLE_STATES_LITERAL,
  type DispatchCandidateRow,
  EXPIRING_SQL,
  type NoticeRow,
  OPEN_REQUESTS_SQL,
  OPEN_STATES_LITERAL,
  RELEASE_PLEDGES_SQL,
  type RequestStateRow,
  SET_REQUEST_STATE_SQL,
  SET_TIER_SQL,
  type Urgency,
} from './sweepSql.js';

export interface SweepReport {
  /** Requests kicked off open → alerting this cycle. */
  opened: number;
  /** Requests whose radius_tier was raised this cycle. */
  tiersAdvanced: number;
  /** Dispatch rows written (donors alerted) across all requests this cycle. */
  dispatched: number;
  /** Requests transitioned to 'expired' this cycle. */
  expired: number;
  /** Active pledges released by expiry fan-out this cycle. */
  pledgesReleased: number;
  /** Closure notices sent (best-effort, post-commit) this cycle. */
  closureNotices: number;
}

/** Milliseconds per minute — unit conversion, not a protocol tunable. */
const MS_PER_MIN = 60_000;

/** Highest radius tier (T2, 25 km cap — canonical ladder in matching/geo.ts). */
const MAX_TIER = RADIUS_TIERS_KM.length - 1;

/**
 * The deterministic tier schedule (architect ruling):
 * min(cap, BASE_TIER + floor(elapsed / TIER_WINDOW)). Clamped below by
 * BASE_TIER (clock skew must not undershoot the base) and above by the T2
 * cap. The caller applies it monotonically vs. the stored radius_tier.
 */
function targetTier(urgency: Urgency, createdAt: Date, now: Date): number {
  const windowMs = TIER_WINDOW_MIN[urgency] * MS_PER_MIN;
  const elapsedWindows = Math.floor((now.getTime() - createdAt.getTime()) / windowMs);
  return Math.min(MAX_TIER, BASE_TIER[urgency] + Math.max(0, elapsedWindows));
}

/** Narrows a stored radius_tier to a dispatchable index (defensive clamp at the cap). */
function toTierIdx(tier: number): 0 | 1 | 2 {
  if (tier <= 0) return 0;
  if (tier === 1) return 1;
  return 2;
}

/** A closure notice collected in-transaction, sent post-commit. */
interface ClosureNotice {
  pushToken: string;
  dispatchId: string;
}

/** Pass a: expire TTL-passed requests, release their pledges, collect notices. */
async function expirePass(
  db: SqlClient,
  now: Date,
  report: SweepReport,
  notices: ClosureNotice[],
): Promise<void> {
  const { rows } = await db.query<RequestStateRow>(EXPIRING_SQL, [
    OPEN_STATES_LITERAL,
    now.toISOString(),
  ]);
  for (const row of rows) {
    const released = await db.query<NoticeRow>(RELEASE_PLEDGES_SQL, [row.request_id]);
    report.pledgesReleased += released.rows.length;
    for (const n of released.rows) {
      // A donor whose push credentials were since cleared cannot be notified —
      // best-effort by design; fetch-on-tap shows the closed state regardless.
      if (n.push_token !== null && n.dispatch_id !== null) {
        notices.push({ pushToken: n.push_token, dispatchId: n.dispatch_id });
      }
    }
    const next = transitionRequest(
      row.state,
      { type: 'ttl_expired' },
      { activePledges: 0, unitsNeeded: row.units_needed, unitsConfirmed: row.units_confirmed },
    );
    await db.query(SET_REQUEST_STATE_SQL, [row.request_id, next]);
    report.expired += 1;
  }
}

/** Pass b: kick off 'open' requests into 'alerting' (dispatched in pass d). */
async function kickoffPass(db: SqlClient, report: SweepReport): Promise<void> {
  const { rows } = await db.query<RequestStateRow>(OPEN_REQUESTS_SQL);
  for (const row of rows) {
    const next = transitionRequest(
      row.state,
      { type: 'first_dispatch_sent' },
      { activePledges: 0, unitsNeeded: row.units_needed, unitsConfirmed: row.units_confirmed },
    );
    await db.query(SET_REQUEST_STATE_SQL, [row.request_id, next]);
    report.opened += 1;
  }
}

/** Pass c: raise radius_tier to the created_at schedule (monotonic — never lower). */
async function advancePass(db: SqlClient, now: Date, report: SweepReport): Promise<void> {
  const { rows } = await db.query<AdvanceRow>(ADVANCE_CANDIDATES_SQL, [
    DISPATCHABLE_STATES_LITERAL,
  ]);
  for (const row of rows) {
    const target = targetTier(row.urgency, row.created_at, now);
    if (target > row.radius_tier) {
      await db.query(SET_TIER_SQL, [row.request_id, target]);
      report.tiersAdvanced += 1;
    }
  }
}

/** Pass d: re-run dispatchTier for every dispatchable request at its current tier. */
async function dispatchPass(
  db: SqlClient,
  push: PushSender,
  now: Date,
  report: SweepReport,
): Promise<void> {
  const { rows } = await db.query<DispatchCandidateRow>(DISPATCH_CANDIDATES_SQL, [
    DISPATCHABLE_STATES_LITERAL,
  ]);
  for (const row of rows) {
    const result = await dispatchTier(
      db,
      push,
      {
        requestId: row.request_id,
        bloodGroup: row.blood_group,
        hospitalLat: Number(row.lat),
        hospitalLng: Number(row.lng),
        urgency: row.urgency,
        radiusTier: toTierIdx(row.radius_tier),
      },
      now,
    );
    report.dispatched += result.dispatched;
  }
}

/**
 * One full sweep cycle. `db` MUST be a single-session client (standing
 * ruling) — BEGIN/COMMIT across a pool would silently span connections.
 */
export async function runSweep(db: SqlClient, push: PushSender, now: Date): Promise<SweepReport> {
  const report: SweepReport = {
    opened: 0,
    tiersAdvanced: 0,
    dispatched: 0,
    expired: 0,
    pledgesReleased: 0,
    closureNotices: 0,
  };
  const notices: ClosureNotice[] = [];

  await db.query('BEGIN');
  try {
    await expirePass(db, now, report, notices);
    await kickoffPass(db, report);
    await advancePass(db, now, report);
    await dispatchPass(db, push, now, report);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  // Post-commit closure fan-out — best-effort. The PushSender contract never
  // throws ('error' is a return value, logged by the sender itself); the catch
  // is a defensive belt so a contract-violating sender still cannot lose the
  // committed state or abort the remaining notices.
  for (const notice of notices) {
    try {
      await push.send(notice.pushToken, { type: 'REQUEST_CLOSED', alertId: notice.dispatchId });
    } catch {
      // swallowed by design: state is committed; delivery is best-effort
    }
    report.closureNotices += 1;
  }
  return report;
}
