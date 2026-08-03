// GET /requests/mine + GET /requests/:requestId — the requester's poll view.
//
// Canonical: docs/PROTOCOL.md §5 (the poll is the requester's window; honest
// numbers), docs/DATA_MODEL.md § "Sensitivity model" + Pledge/Dispatch tables,
// docs/TRUST_PRIVACY.md § "Donor anonymity & contact" (the disclosure ratchet).
//
// The governing rule: the requester sees AGGREGATES about who was alerted, never
// a roster. Donor identity reaches the requester ONLY through Pledge snapshot
// columns (donor_handle / donor_blood_group / donor_phone), written at accept —
// never through a live join to the Donor table. This module therefore:
//   - reports donorsAlerted as count(dispatch) and activePledges as
//     count(pledge WHERE state='active') — plain integers, no per-row rows;
//   - selects pledge cards from the pledge table ONLY (snapshot columns), and
//     never joins donor, so donor_id / geohash5 / tz / phone-live cannot leak;
//   - shows only the requester-visible pledge states (active/donated/no_show);
//     withdrawn and released pledges disappear from the view (a withdrawal is
//     penalty-free and only decrements the count — TRUST_PRIVACY.md).
//
// Both routes are requester-authenticated and ownership-scoped, mirroring
// requests.ts: resolve the requester by firebase_uid (no row → 403); the detail
// route's WHERE requires the request to belong to the caller, so a foreign or
// nonexistent id is one indistinguishable 404. `verified` is NOT required to
// view one's own requests. All SQL is parameterized.
import type { FastifyInstance } from 'fastify';
import { toPgArrayLiteral } from '../db/pgArray.js';
import type { SqlClient } from '../matching/eligibility.js';

/** Malformed ids reveal nothing either — same 404, and avoids a uuid-cast throw. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** List cap (compile-time integer constant, not user input): newest 50 requests. */
const REQUESTS_LIST_CAP = 50;

/**
 * Pledge states the requester may see (docs/TRUST_PRIVACY.md ratchet table):
 * active + the terminal outcomes the requester needs (donated confirms the
 * unit; no_show is a requester-set fact). withdrawn and released are absent by
 * construction — the query never selects them.
 */
const VISIBLE_PLEDGE_STATES = ['active', 'donated', 'no_show'] as const;

/** Bound as a parameter and cast in SQL (see db/pgArray.ts); compile-time constants. */
const VISIBLE_PLEDGE_STATES_LITERAL = toPgArrayLiteral(VISIBLE_PLEDGE_STATES);

const RESOLVE_REQUESTER_SQL = `SELECT requester_id FROM requester WHERE firebase_uid = $1`;

// Summary columns shared by both routes. donors_alerted / active_pledges are
// scalar aggregates (count(*)::int) — the requester NEVER sees the dispatch or
// pledge rows themselves, only the totals (PROTOCOL.md §5, DATA_MODEL.md).
const SUMMARY_COLUMNS = `
  r.request_id      AS request_id,
  r.blood_group     AS blood_group,
  r.units_needed    AS units_needed,
  r.units_confirmed AS units_confirmed,
  r.urgency         AS urgency,
  r.state           AS state,
  r.radius_tier     AS radius_tier,
  r.hospital_id     AS hospital_id,
  r.created_at      AS created_at,
  r.expires_at      AS expires_at,
  (SELECT count(*)::int FROM dispatch dp WHERE dp.request_id = r.request_id) AS donors_alerted,
  (SELECT count(*)::int FROM pledge p WHERE p.request_id = r.request_id AND p.state = 'active')
    AS active_pledges
`;

// The caller's requests, newest first, capped. LIMIT interpolates a compile-time
// integer constant (never user input), so it stays injection-free.
const LIST_MINE_SQL = `
  SELECT ${SUMMARY_COLUMNS}
  FROM request r
  WHERE r.requester_id = $1::uuid
  ORDER BY r.created_at DESC, r.request_id DESC
  LIMIT ${REQUESTS_LIST_CAP}
`;

// One request the caller owns, plus its public hospital fields. The ownership
// predicate ($2) makes a foreign or nonexistent id return zero rows → a single
// 404 shape (indistinguishable, per TRUST_PRIVACY.md).
const REQUEST_DETAIL_SQL = `
  SELECT
    ${SUMMARY_COLUMNS},
    h.name            AS hospital_name,
    h.address         AS hospital_address,
    h.bloodbank_phone AS bloodbank_phone
  FROM request r
  JOIN hospital h ON h.hospital_id = r.hospital_id
  WHERE r.request_id = $1::uuid
    AND r.requester_id = $2::uuid
`;

// Pledge cards — snapshot columns ONLY, straight off the pledge table. There is
// deliberately NO join to donor: the requester's view is never a live window
// into the Donor table (DATA_MODEL.md), so donor_id / geohash5 / tz can never be
// selected here. withdrawn + released are excluded by the state filter.
const PLEDGE_CARDS_SQL = `
  SELECT
    p.pledge_id         AS pledge_id,
    p.donor_handle      AS donor_handle,
    p.donor_blood_group AS donor_blood_group,
    p.donor_phone       AS donor_phone,
    p.eta_bucket        AS eta_bucket,
    p.state             AS state,
    p.created_at        AS created_at
  FROM pledge p
  WHERE p.request_id = $1::uuid
    AND p.state = ANY($2::pledge_state[])
  ORDER BY p.created_at ASC, p.pledge_id ASC
`;

interface RequesterRow {
  requester_id: string;
}

interface RequestSummaryRow {
  request_id: string;
  blood_group: string;
  units_needed: number;
  units_confirmed: number;
  urgency: string;
  state: string;
  radius_tier: number;
  hospital_id: string;
  created_at: Date;
  expires_at: Date;
  donors_alerted: number;
  active_pledges: number;
}

interface RequestDetailRow extends RequestSummaryRow {
  hospital_name: string;
  hospital_address: string;
  bloodbank_phone: string;
}

interface PledgeCardRow {
  pledge_id: string;
  donor_handle: string;
  donor_blood_group: string;
  donor_phone: string | null;
  eta_bucket: string;
  state: string;
  created_at: Date;
}

interface RequestSummaryOut {
  requestId: string;
  bloodGroup: string;
  unitsNeeded: number;
  unitsConfirmed: number;
  urgency: string;
  state: string;
  radiusTier: number;
  hospitalId: string;
  createdAt: string;
  expiresAt: string;
  donorsAlerted: number;
  activePledges: number;
}

interface HospitalOut {
  name: string;
  address: string;
  bloodbankPhone: string;
}

interface PledgeCardOut {
  pledgeId: string;
  donorHandle: string;
  donorBloodGroup: string;
  donorPhone: string | null;
  etaBucket: string;
  state: string;
  createdAt: string;
}

interface RequestDetailOut extends RequestSummaryOut {
  hospital: HospitalOut;
  pledges: PledgeCardOut[];
}

/** Map a summary row (or the wider detail row) to the wire shape. */
function toSummary(row: RequestSummaryRow): RequestSummaryOut {
  return {
    requestId: row.request_id,
    bloodGroup: row.blood_group,
    unitsNeeded: row.units_needed,
    unitsConfirmed: row.units_confirmed,
    urgency: row.urgency,
    state: row.state,
    radiusTier: row.radius_tier,
    hospitalId: row.hospital_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    donorsAlerted: row.donors_alerted,
    activePledges: row.active_pledges,
  };
}

/** Map a pledge row to a card — snapshot fields only; donorPhone stays null when unset. */
function toPledgeCard(row: PledgeCardRow): PledgeCardOut {
  return {
    pledgeId: row.pledge_id,
    donorHandle: row.donor_handle,
    donorBloodGroup: row.donor_blood_group,
    donorPhone: row.donor_phone,
    etaBucket: row.eta_bucket,
    state: row.state,
    createdAt: row.created_at.toISOString(),
  };
}

/** Resolve the requester_id for a firebase uid, or null when no requester row exists. */
async function resolveRequesterId(db: SqlClient, uid: string): Promise<string | null> {
  const res = await db.query<RequesterRow>(RESOLVE_REQUESTER_SQL, [uid]);
  return res.rows[0]?.requester_id ?? null;
}

export function registerRequestViewRoutes(app: FastifyInstance, deps: { db: SqlClient }): void {
  app.get('/requests/mine', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) {
      // app.authenticate guarantees request.user; this narrows the type.
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const requesterId = await resolveRequesterId(deps.db, uid);
    if (requesterId === null) {
      return reply.code(403).send({ error: 'not_a_requester' });
    }
    const { rows } = await deps.db.query<RequestSummaryRow>(LIST_MINE_SQL, [requesterId]);
    return reply.code(200).send(rows.map(toSummary));
  });

  app.get<{ Params: { requestId: string } }>(
    '/requests/:requestId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const requesterId = await resolveRequesterId(deps.db, uid);
      if (requesterId === null) {
        return reply.code(403).send({ error: 'not_a_requester' });
      }

      const { requestId } = request.params;
      // Malformed id reveals nothing either — same 404 as foreign/nonexistent.
      if (!UUID_RE.test(requestId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const detailRes = await deps.db.query<RequestDetailRow>(REQUEST_DETAIL_SQL, [
        requestId,
        requesterId,
      ]);
      const row = detailRes.rows[0];
      if (row === undefined) {
        // Not owned by the caller, or does not exist — one indistinguishable 404.
        return reply.code(404).send({ error: 'not_found' });
      }

      const pledgeRes = await deps.db.query<PledgeCardRow>(PLEDGE_CARDS_SQL, [
        requestId,
        VISIBLE_PLEDGE_STATES_LITERAL,
      ]);

      const detail: RequestDetailOut = {
        ...toSummary(row),
        hospital: {
          name: row.hospital_name,
          address: row.hospital_address,
          bloodbankPhone: row.bloodbank_phone,
        },
        pledges: pledgeRes.rows.map(toPledgeCard),
      };
      return reply.code(200).send(detail);
    },
  );
}
