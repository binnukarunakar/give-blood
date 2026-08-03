// Accept / decline transaction machinery, split out of pledges.ts to keep each
// file under the 300-line cap. pledges.ts owns the Fastify wiring + HTTP mapping;
// this file owns the SQL, the row shapes, and the two guarded operations.
//
// Canonical: docs/PROTOCOL.md §4 (accept/decline) & §7 (races); docs/DATA_MODEL.md
// (Pledge snapshots, one-active-pledge index, Dispatch single transition);
// docs/DECISIONS.md #2 (accept guard) & #4 (phone reveal via toggle only). All
// DB access is parameterized; the accept path is one BEGIN/COMMIT transaction on
// the single session (board ruling) with the request row locked FOR UPDATE.
import { z } from 'zod';
import {
  canAcceptPledge,
  coveredThreshold,
  type RequestState,
  transitionRequest,
} from '../domain/requestFsm.js';
import type { SqlClient } from '../matching/eligibility.js';

// Malformed ids reveal nothing either — same 404, and avoids a uuid-cast throw.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SQLSTATE 23505 = unique_violation; the only unique index the pledge INSERT can
// trip is the one-active-pledge partial index (DATA_MODEL.md). Matching the
// constraint name keeps an unrelated violation from being misreported.
const PG_UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_PLEDGE_CONSTRAINT = 'pledge_one_active_per_donor';

export const acceptBodySchema = z.object({
  etaBucket: z.enum(['le_30m', 'le_1h', 'le_2h']),
  sharePhone: z.boolean().optional(),
});
export type AcceptBody = z.infer<typeof acceptBodySchema>;

export function summarizeIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

// ── SQL (all parameterized) ──────────────────────────────────────────────────

// (a) Resolve the caller-owned dispatch + the donor snapshot fields + the public
// hospital fields the success payload needs. Unknown uid, nonexistent id, and
// someone-else's dispatch all yield zero rows → one 404 shape (Dispatch privacy).
const RESOLVE_ACCEPT_SQL = `
  SELECT
    dp.dispatch_id            AS dispatch_id,
    dp.request_id             AS request_id,
    dp.response               AS response,
    d.donor_id                AS donor_id,
    d.handle                  AS handle,
    d.blood_group             AS blood_group,
    d.phone                   AS phone,
    d.share_phone_on_accept   AS share_phone_on_accept,
    h.name                    AS hospital_name,
    h.lat                     AS hospital_lat,
    h.lng                     AS hospital_lng,
    h.bloodbank_phone         AS bloodbank_phone
  FROM dispatch dp
  JOIN donor d    ON d.donor_id = dp.donor_id
  JOIN request r  ON r.request_id = dp.request_id
  JOIN hospital h ON h.hospital_id = r.hospital_id
  WHERE dp.dispatch_id = $1::uuid
    AND d.firebase_uid = $2
`;

// (b) Lock the request row so the guard + slot claim are serialized.
const LOCK_REQUEST_SQL = `
  SELECT state, units_needed, units_confirmed
  FROM request WHERE request_id = $1::uuid FOR UPDATE
`;

const COUNT_ACTIVE_PLEDGES_SQL = `
  SELECT count(*)::int AS n FROM pledge WHERE request_id = $1::uuid AND state = 'active'
`;

const UPDATE_SHARE_PHONE_SQL = `
  UPDATE donor SET share_phone_on_accept = $2 WHERE donor_id = $1::uuid
`;

const ACCEPT_DISPATCH_SQL = `
  UPDATE dispatch SET response = 'accepted', responded_at = now() WHERE dispatch_id = $1::uuid
`;

const INSERT_PLEDGE_SQL = `
  INSERT INTO pledge
    (request_id, donor_id, donor_handle, donor_blood_group, donor_phone, eta_bucket, state)
  VALUES
    ($1::uuid, $2::uuid, $3, $4::blood_group, $5, $6::eta_bucket, 'active')
  RETURNING pledge_id
`;

const UPDATE_REQUEST_STATE_SQL = `
  UPDATE request SET state = $2::request_state WHERE request_id = $1::uuid
`;

// Decline resolves the same way, but needs only the response value.
const RESOLVE_DECLINE_SQL = `
  SELECT dp.dispatch_id AS dispatch_id, dp.response AS response
  FROM dispatch dp
  JOIN donor d ON d.donor_id = dp.donor_id
  WHERE dp.dispatch_id = $1::uuid
    AND d.firebase_uid = $2
`;

const DECLINE_DISPATCH_SQL = `
  UPDATE dispatch SET response = 'declined', responded_at = now() WHERE dispatch_id = $1::uuid
`;

// ── Row shapes ───────────────────────────────────────────────────────────────

interface AcceptResolveRow {
  dispatch_id: string;
  request_id: string;
  response: string;
  donor_id: string;
  handle: string;
  blood_group: string;
  phone: string;
  share_phone_on_accept: boolean;
  hospital_name: string;
  hospital_lat: string; // numeric → string on the wire (pg / PGlite)
  hospital_lng: string;
  bloodbank_phone: string;
}
interface RequestLockRow {
  state: RequestState;
  units_needed: number;
  units_confirmed: number;
}
interface CountRow {
  n: number;
}
interface PledgeIdRow {
  pledge_id: string;
}
interface DeclineResolveRow {
  dispatch_id: string;
  response: string;
}

export interface HospitalOut {
  name: string;
  lat: number;
  lng: number;
  bloodbankPhone: string;
}

/** Discriminated outcome of the accept transaction. */
export type AcceptResult =
  | {
      kind: 'accepted';
      pledgeId: string;
      requestState: RequestState;
      hospital: HospitalOut;
      directionsUrl: string;
    }
  | { kind: 'not_found' }
  | { kind: 'request_closed'; requestState: RequestState }
  | { kind: 'already_responded'; response: string }
  | { kind: 'active_pledge_exists' };

/** Discriminated outcome of the decline operation. */
export type DeclineResult =
  | { kind: 'declined' }
  | { kind: 'not_found' }
  | { kind: 'already_responded'; response: string };

/** Only the one-active-pledge partial index can trip on the pledge INSERT. */
function isOneActivePledgeViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === ONE_ACTIVE_PLEDGE_CONSTRAINT;
}

/**
 * Steps (a)-(g) of PROTOCOL.md §4, assuming a transaction is already open.
 * Returns a discriminated result; the caller COMMITs on `accepted` and ROLLs
 * BACK on every other outcome. Throws only on a pledge unique-violation (mapped
 * to `active_pledge_exists` by runAcceptTxn) or a genuine fault.
 */
async function acceptGuarded(
  db: SqlClient,
  dispatchId: string,
  uid: string,
  body: AcceptBody,
): Promise<AcceptResult> {
  // (a) resolve donor + dispatch (uniform 404 on any miss).
  const resolved = await db.query<AcceptResolveRow>(RESOLVE_ACCEPT_SQL, [dispatchId, uid]);
  const row = resolved.rows[0];
  if (row === undefined) return { kind: 'not_found' };

  // (b) lock the request; reject a closed/covered/terminal request honestly.
  const locked = await db.query<RequestLockRow>(LOCK_REQUEST_SQL, [row.request_id]);
  const req = locked.rows[0];
  if (req === undefined) return { kind: 'not_found' }; // FK guarantees presence; defensive.
  if (!canAcceptPledge(req.state)) {
    return { kind: 'request_closed', requestState: req.state };
  }

  // (c) overbook ceiling — DB-as-arbiter, independent of the state field.
  const before = await db.query<CountRow>(COUNT_ACTIVE_PLEDGES_SQL, [row.request_id]);
  const activeBefore = before.rows[0]?.n ?? 0;
  if (activeBefore >= coveredThreshold(req.units_needed)) {
    return { kind: 'request_closed', requestState: 'covered' };
  }

  // (d) the dispatch must be an untouched alert (single transition from 'none').
  if (row.response !== 'none') {
    return { kind: 'already_responded', response: row.response };
  }

  // (0/e) the accept screen carries the toggle (DECISIONS #4): if present, update
  // it first, then the snapshot follows the (possibly-updated) toggle.
  const effectiveSharePhone = body.sharePhone ?? row.share_phone_on_accept;
  if (body.sharePhone !== undefined) {
    await db.query(UPDATE_SHARE_PHONE_SQL, [row.donor_id, body.sharePhone]);
  }

  // (e) dispatch none→accepted, then INSERT the pledge with its snapshots.
  await db.query(ACCEPT_DISPATCH_SQL, [dispatchId]);
  const snapshotPhone = effectiveSharePhone ? row.phone : null;
  const inserted = await db.query<PledgeIdRow>(INSERT_PLEDGE_SQL, [
    row.request_id,
    row.donor_id,
    row.handle,
    row.blood_group,
    snapshotPhone,
    body.etaBucket,
  ]);
  const pledgeId = inserted.rows[0]?.pledge_id;
  if (pledgeId === undefined) throw new Error('pledge insert returned no row');

  // (f) recount and apply the request-state transition if it changed. The step-b
  // guard means canAcceptPledge(req.state) is true, so pledge_created is always
  // legal here — IllegalTransitionError cannot surface.
  const after = await db.query<CountRow>(COUNT_ACTIVE_PLEDGES_SQL, [row.request_id]);
  const activeAfter = after.rows[0]?.n ?? 0;
  const nextState = transitionRequest(
    req.state,
    { type: 'pledge_created' },
    { activePledges: activeAfter, unitsNeeded: req.units_needed, unitsConfirmed: req.units_confirmed },
  );
  if (nextState !== req.state) {
    await db.query(UPDATE_REQUEST_STATE_SQL, [row.request_id, nextState]);
  }

  // (g) success payload — hospital coords are the map destination ONLY; the donor
  // origin is NEVER included (TRUST_PRIVACY §Location privacy).
  const lat = Number(row.hospital_lat);
  const lng = Number(row.hospital_lng);
  return {
    kind: 'accepted',
    pledgeId,
    requestState: nextState,
    hospital: { name: row.hospital_name, lat, lng, bloodbankPhone: row.bloodbank_phone },
    directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
  };
}

/** One transaction over the accept guards + slot claim (BEGIN/COMMIT/ROLLBACK). */
export async function runAcceptTxn(
  db: SqlClient,
  dispatchId: string,
  uid: string,
  body: AcceptBody,
): Promise<AcceptResult> {
  await db.query('BEGIN');
  try {
    const result = await acceptGuarded(db, dispatchId, uid, body);
    await db.query(result.kind === 'accepted' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    if (isOneActivePledgeViolation(err)) return { kind: 'active_pledge_exists' };
    throw err;
  }
}

/**
 * Decline: resolve (uniform 404), require an untouched dispatch, flip
 * none→declined. No request-state effect, no pledge row (PROTOCOL §4). A single
 * guarded UPDATE — atomic on its own, no explicit transaction needed.
 */
export async function runDecline(
  db: SqlClient,
  dispatchId: string,
  uid: string,
): Promise<DeclineResult> {
  const resolved = await db.query<DeclineResolveRow>(RESOLVE_DECLINE_SQL, [dispatchId, uid]);
  const row = resolved.rows[0];
  if (row === undefined) return { kind: 'not_found' };
  if (row.response !== 'none') return { kind: 'already_responded', response: row.response };
  await db.query(DECLINE_DISPATCH_SQL, [dispatchId]);
  return { kind: 'declined' };
}
