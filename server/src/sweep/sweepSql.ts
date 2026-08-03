// Sweep SQL + row shapes, split out of sweep.ts to keep each product file
// under the 300-line cap (same split pattern as pledges.ts / pledgesShared.ts,
// ruled at GB-11 QA). sweep.ts owns the pass logic and the transaction; this
// file owns the statements it executes. All SQL is parameterized.
import { toPgArrayLiteral } from '../db/pgArray.js';
import { OPEN_REQUEST_STATES, TIER_WINDOW_MIN } from '../domain/protocol.js';
import type { RequestState } from '../domain/requestFsm.js';
import type { BloodGroup } from '../matching/compatibility.js';

export type Urgency = keyof typeof TIER_WINDOW_MIN;

/** States dispatching operates on: kicked-off, not yet covered/terminal. */
const DISPATCHABLE_STATES = ['alerting', 'partially_pledged'] as const;

// Bound as parameters and cast in SQL (see db/pgArray.ts); the values here are
// compile-time state constants, never client input.
export const OPEN_STATES_LITERAL = toPgArrayLiteral(OPEN_REQUEST_STATES);
export const DISPATCHABLE_STATES_LITERAL = toPgArrayLiteral(DISPATCHABLE_STATES);

// Pass a: every non-terminal request past its TTL. FOR UPDATE serializes
// against concurrent accept transactions (which lock the request row).
// Terminal states — 'cancelled' included — are excluded by construction:
// GB-14 releases a cancellation's own pledges; the sweep only expires.
export const EXPIRING_SQL = `
  SELECT request_id, state, units_needed, units_confirmed
  FROM request
  WHERE state = ANY($1::request_state[]) AND expires_at <= $2::timestamptz
  ORDER BY request_id
  FOR UPDATE
`;

// Terminal fan-out (DATA_MODEL): still-active pledges → 'released' (the
// pledgeFsm active→released edge, applied set-wise), returning each released
// donor's push_token + their own dispatch id for the closure notice. LEFT JOIN
// keeps the released COUNT honest even if a dispatch row were ever missing
// (impossible by construction — a pledge exists iff its dispatch was accepted).
export const RELEASE_PLEDGES_SQL = `
  WITH released AS (
    UPDATE pledge SET state = 'released'
    WHERE request_id = $1::uuid AND state = 'active'
    RETURNING donor_id
  )
  SELECT d.push_token AS push_token, dp.dispatch_id AS dispatch_id
  FROM released r
  JOIN donor d ON d.donor_id = r.donor_id
  LEFT JOIN dispatch dp ON dp.request_id = $1::uuid AND dp.donor_id = r.donor_id
`;

export const SET_REQUEST_STATE_SQL = `
  UPDATE request SET state = $2::request_state WHERE request_id = $1::uuid
`;

// Pass b: 'open' requests (any expired ones already left 'open' in pass a).
export const OPEN_REQUESTS_SQL = `
  SELECT request_id, state, units_needed, units_confirmed
  FROM request
  WHERE state = 'open'
  ORDER BY request_id
  FOR UPDATE
`;

// Pass c: tier-advance candidates (includes requests just kicked off in pass b).
export const ADVANCE_CANDIDATES_SQL = `
  SELECT request_id, urgency, radius_tier, created_at
  FROM request
  WHERE state = ANY($1::request_state[])
  ORDER BY request_id
  FOR UPDATE
`;

export const SET_TIER_SQL = `
  UPDATE request SET radius_tier = $2::int WHERE request_id = $1::uuid
`;

// Pass d: dispatch candidates + the hospital coordinates dispatchTier needs.
// Rows are already locked by the pass b/c selects within this transaction.
export const DISPATCH_CANDIDATES_SQL = `
  SELECT r.request_id, r.blood_group, r.urgency, r.radius_tier, h.lat, h.lng
  FROM request r
  JOIN hospital h ON h.hospital_id = r.hospital_id
  WHERE r.state = ANY($1::request_state[])
  ORDER BY r.request_id
`;

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface RequestStateRow {
  request_id: string;
  state: RequestState;
  units_needed: number;
  units_confirmed: number;
}
export interface NoticeRow {
  push_token: string | null;
  dispatch_id: string | null;
}
export interface AdvanceRow {
  request_id: string;
  urgency: Urgency;
  radius_tier: number;
  created_at: Date;
}
export interface DispatchCandidateRow {
  request_id: string;
  blood_group: BloodGroup;
  urgency: Urgency;
  radius_tier: number;
  lat: string; // numeric → string on the wire (pg / PGlite)
  lng: string;
}
