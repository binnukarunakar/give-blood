// Tier-blast dispatch engine (docs/PROTOCOL.md §2, §3, §5).
//
// One call alerts every eligible donor in a request's current radius tier, in a
// deterministic four-key order, sending each an opaque push. It is idempotent by
// construction: the eligibility anti-join excludes donors already dispatched to
// for this request, so re-runs (the 60 s sweep re-invoking this) are no-ops.
//
// This engine does NOT transition request state. Entering `alerting`, tier
// advance, expiry, and close fan-out are the sweep's job (GB-12); the engine
// only writes Dispatch rows, stamps last_alerted_at, and pushes.
import ngeohash from 'ngeohash';
import type { BloodGroup } from '../matching/compatibility.js';
import { eligibleDonors, type EligibleDonor, type SqlClient } from '../matching/eligibility.js';
import { haversineKm } from '../matching/geo.js';
import type { PushSender } from '../push/pushSender.js';

export interface DispatchRequest {
  requestId: string;
  bloodGroup: BloodGroup;
  hospitalLat: number;
  hospitalLng: number;
  urgency: 'critical' | 'standard';
  /** Index into RADIUS_TIERS_KM (5 / 10 / 25 km). */
  radiusTier: 0 | 1 | 2;
}

export interface DispatchResult {
  /** Dispatch rows written and pushed this call (includes dead-token sends). */
  dispatched: number;
  /** Subset of `dispatched` whose push reported a permanently dead token. */
  deadTokens: number;
}

/**
 * Sort weight so that null (never alerted) sorts BEFORE any real timestamp, then
 * oldest → newest (least-recently-alerted first).
 */
function lastAlertedWeight(at: Date | null): number {
  return at === null ? Number.NEGATIVE_INFINITY : at.getTime();
}

/**
 * Deterministic four-key order (PROTOCOL.md §2), donor_id as the final tiebreak:
 *   1. exact group match before merely-compatible
 *   2. O− donors last, for non-O− requests only (for an O− request every
 *      compatible donor is O−, so keys 1–2 collapse to equal)
 *   3. distance ascending (donor cell centroid → hospital)
 *   4. least-recently-alerted first (null last_alerted_at = never = FIRST)
 *   5. donor_id ascending (deterministic tiebreak)
 */
function rankCandidates(candidates: EligibleDonor[], req: DispatchRequest): EligibleDonor[] {
  const requestIsOMinus = req.bloodGroup === 'O-';
  const weight = new Map<string, { exact: number; oMinus: number; distance: number; recency: number }>();
  for (const d of candidates) {
    const { latitude, longitude } = ngeohash.decode(d.geohash5);
    weight.set(d.donorId, {
      exact: d.bloodGroup === req.bloodGroup ? 0 : 1,
      oMinus: !requestIsOMinus && d.bloodGroup === 'O-' ? 1 : 0,
      distance: haversineKm(latitude, longitude, req.hospitalLat, req.hospitalLng),
      recency: lastAlertedWeight(d.lastAlertedAt),
    });
  }
  const keyOf = (id: string): { exact: number; oMinus: number; distance: number; recency: number } => {
    const w = weight.get(id);
    if (w === undefined) throw new Error(`missing rank key for donor ${id}`);
    return w;
  };
  return [...candidates].sort((a, b) => {
    const ka = keyOf(a.donorId);
    const kb = keyOf(b.donorId);
    if (ka.exact !== kb.exact) return ka.exact - kb.exact;
    if (ka.oMinus !== kb.oMinus) return ka.oMinus - kb.oMinus;
    if (ka.distance !== kb.distance) return ka.distance - kb.distance;
    if (ka.recency !== kb.recency) return ka.recency - kb.recency;
    return a.donorId < b.donorId ? -1 : a.donorId > b.donorId ? 1 : 0;
  });
}

const INSERT_DISPATCH_SQL = `
  INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send, sent_at)
  VALUES ($1::uuid, $2::uuid, $3::int, $4::timestamptz)
  ON CONFLICT (request_id, donor_id) DO NOTHING
  RETURNING dispatch_id
`;

const STAMP_ALERTED_SQL = `UPDATE donor SET last_alerted_at = $1::timestamptz WHERE donor_id = $2::uuid`;

// Token rotation clears verification (DATA_MODEL: push_verified_at "cleared on
// token rotation until re-verified"). A dead FCM token is exactly that — the
// donor drops out of the matching pool until the app re-verifies.
const CLEAR_DEAD_TOKEN_SQL = `
  UPDATE donor SET push_token = NULL, push_verified_at = NULL WHERE donor_id = $1::uuid
`;

/**
 * Alert every eligible donor in `req`'s current tier, in ranked order.
 *
 * Per candidate: INSERT the Dispatch row (ON CONFLICT DO NOTHING absorbs the
 * concurrent-sweep unique-violation race silently), stamp last_alerted_at, then
 * push the opaque alert id. On a dead token, clear the donor's push credentials
 * — but the Dispatch row REMAINS: it was sent to a then-valid address, and the
 * never-re-page invariant stays conservative (a donor is never re-alerted for a
 * request they were already dispatched to).
 */
export async function dispatchTier(
  db: SqlClient,
  push: PushSender,
  req: DispatchRequest,
  now: Date,
): Promise<DispatchResult> {
  const candidates = await eligibleDonors(db, {
    bloodGroup: req.bloodGroup,
    hospitalLat: req.hospitalLat,
    hospitalLng: req.hospitalLng,
    tierIdx: req.radiusTier,
    urgency: req.urgency,
    requestId: req.requestId,
    now,
  });

  const nowIso = now.toISOString();
  let dispatched = 0;
  let deadTokens = 0;

  for (const donor of rankCandidates(candidates, req)) {
    const inserted = await db.query<{ dispatch_id: string }>(INSERT_DISPATCH_SQL, [
      req.requestId,
      donor.donorId,
      req.radiusTier,
      nowIso,
    ]);
    const dispatchId = inserted.rows[0]?.dispatch_id;
    if (dispatchId === undefined) continue; // lost the insert race — another sweep dispatched this donor

    await db.query(STAMP_ALERTED_SQL, [nowIso, donor.donorId]);
    dispatched += 1;

    const result = await push.send(donor.pushToken, { type: 'BLOOD_ALERT', alertId: dispatchId });
    if (result === 'dead_token') {
      await db.query(CLEAR_DEAD_TOKEN_SQL, [donor.donorId]);
      deadTokens += 1;
    }
    // 'error' is transient: leave the donor untouched, keep the Dispatch row, continue.
  }

  return { dispatched, deadTokens };
}
