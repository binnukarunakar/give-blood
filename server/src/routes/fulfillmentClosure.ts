// Closure notices for the fulfillment routes (GB-32).
//
// PROTOCOL.md promises a donor whose ACTIVE pledge is released by a closure
// hears about it. Only the sweep's expiry pass delivered that; a requester
// cancel and the donation that fulfils a request close a request too, and both
// released pledges silently. This module supplies the two pieces those paths
// were missing: a release statement that returns the delivery pairs, and the
// post-COMMIT send loop.
//
// Split out of fulfillmentShared.ts for the 300-line cap. sweep.ts implements
// the same post-commit pattern inline against its own report counter; that
// duplication is deliberate here — sweep/ is outside this ticket's file scope,
// and folding it onto this helper is a follow-up, not a drive-by.
import type { PushSender } from '../push/pushSender.js';

// Fan-out release of every still-active pledge when a request closes. The CTE
// shape mirrors sweepSql.RELEASE_PLEDGES_SQL: the UPDATE returns the released
// donors, the SELECT resolves each one's push token and their OWN dispatch id
// (the opaque pointer the notice carries). LEFT JOIN keeps the released COUNT
// honest even if a dispatch row were ever missing — impossible by construction,
// since a pledge exists iff its dispatch was accepted.
export const RELEASE_ACTIVE_PLEDGES_SQL = `
  WITH released AS (
    UPDATE pledge SET state = $2::pledge_state
    WHERE request_id = $1::uuid AND state = 'active'
    RETURNING pledge_id, donor_id
  )
  SELECT rel.pledge_id AS pledge_id, d.push_token AS push_token, dp.dispatch_id AS dispatch_id
  FROM released rel
  JOIN donor d ON d.donor_id = rel.donor_id
  LEFT JOIN dispatch dp ON dp.request_id = $1::uuid AND dp.donor_id = rel.donor_id
`;

export interface ReleasedPledgeRow {
  pledge_id: string;
  push_token: string | null;
  dispatch_id: string | null;
}

/** One closure notice collected in-transaction, sent after COMMIT. */
export interface ClosureNotice {
  pushToken: string;
  dispatchId: string;
}

/**
 * Keep only the released donors that can actually be reached. A donor whose
 * push credentials were since cleared is skipped — best-effort by design;
 * fetch-on-tap shows the closed state regardless (PROTOCOL.md §3).
 */
export function collectNotices(rows: ReleasedPledgeRow[]): ClosureNotice[] {
  const notices: ClosureNotice[] = [];
  for (const row of rows) {
    if (row.push_token !== null && row.dispatch_id !== null) {
      notices.push({ pushToken: row.push_token, dispatchId: row.dispatch_id });
    }
  }
  return notices;
}

/**
 * Post-COMMIT fan-out, best-effort: the state change IS the transaction, so a
 * failed push must never roll it back or change the response. The PushSender
 * contract never throws ('error' is a return value, logged by the sender), so
 * the catch is a defensive belt that keeps one contract-violating sender from
 * aborting the remaining notices. Returns the number attempted.
 */
export async function sendClosureNotices(
  push: PushSender,
  notices: ClosureNotice[],
): Promise<number> {
  let attempted = 0;
  for (const notice of notices) {
    try {
      await push.send(notice.pushToken, { type: 'REQUEST_CLOSED', alertId: notice.dispatchId });
    } catch {
      // swallowed by design: state is committed; delivery is best-effort
    }
    attempted += 1;
  }
  return attempted;
}
