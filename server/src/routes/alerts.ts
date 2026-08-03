// Fetch-on-tap alert detail (docs/PROTOCOL.md §3, docs/TRUST_PRIVACY.md).
//
// The push carries only an opaque dispatch id; the app calls this route on tap
// to render the request. It is donor-authenticated and ownership-scoped: the
// dispatch must belong to the caller's donor row. Existence and ownership are
// checked in ONE query, and a miss on EITHER returns an identical 404 — the
// endpoint never reveals whether a dispatch id exists (donor-roster privacy:
// Dispatch is private; a declined/foreign alert must not be probeable).
//
// The response is the public alert view only. It NEVER includes requester
// identity/phone, patient data (no such field exists), other donors, or
// dispatch counts. The one donor-scoped addition is `pledge`: the CALLER's own
// pledge on this request (GB-32) — the client renders the pledged state from
// the server after a reload instead of from lost in-memory state.
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import ngeohash from 'ngeohash';
import type { SqlClient } from '../matching/eligibility.js';
import { haversineKm } from '../matching/geo.js';
import { INDEX_HTML, wantsHtmlDocument } from './spaShell.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single query: resolve the caller's donor by firebase_uid AND require it to own
// the dispatch. Unknown uid, nonexistent id, and someone-else's dispatch all
// produce zero rows → one 404 shape.
const ALERT_DETAIL_SQL = `
  SELECT
    dp.dispatch_id        AS dispatch_id,
    d.geohash5            AS geohash5,
    r.blood_group         AS blood_group,
    r.units_needed        AS units_needed,
    r.urgency             AS urgency,
    r.state               AS state,
    r.created_at          AS created_at,
    r.expires_at          AS expires_at,
    h.name                AS hospital_name,
    h.address             AS hospital_address,
    h.lat                 AS hospital_lat,
    h.lng                 AS hospital_lng,
    h.bloodbank_phone     AS bloodbank_phone,
    p.pledge_id           AS pledge_id,
    p.state               AS pledge_state,
    p.eta_bucket          AS eta_bucket
  FROM dispatch dp
  JOIN donor d    ON d.donor_id = dp.donor_id
  JOIN request r  ON r.request_id = dp.request_id
  JOIN hospital h ON h.hospital_id = r.hospital_id
  -- The caller's OWN pledge on this request, or no row. LATERAL + LIMIT 1 keeps
  -- the result exactly one row: a donor can hold at most one pledge per request
  -- (dispatch is unique per (request, donor) and accepts once), and the ORDER BY
  -- makes the pick deterministic even if that ever stopped holding.
  LEFT JOIN LATERAL (
    SELECT pl.pledge_id, pl.state, pl.eta_bucket
    FROM pledge pl
    WHERE pl.request_id = dp.request_id AND pl.donor_id = dp.donor_id
    ORDER BY pl.created_at DESC
    LIMIT 1
  ) p ON true
  WHERE dp.dispatch_id = $1::uuid
    AND d.firebase_uid = $2
`;

interface AlertDetailRow {
  dispatch_id: string;
  geohash5: string;
  blood_group: string;
  units_needed: number;
  urgency: string;
  state: string;
  created_at: Date;
  expires_at: Date;
  hospital_name: string;
  hospital_address: string;
  hospital_lat: string; // numeric → string on the wire (pg / PGlite)
  hospital_lng: string;
  bloodbank_phone: string;
  // NULL unless the caller pledged on this request (LEFT JOIN LATERAL).
  pledge_id: string | null;
  pledge_state: string | null;
  eta_bucket: string | null;
}

/** The caller's own pledge on this request, as it goes on the wire. */
interface AlertPledgeView {
  pledgeId: string;
  state: string;
  etaBucket: string;
}

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Project the lateral pledge columns; all three are NULL together, or none are. */
function toPledgeView(row: AlertDetailRow): AlertPledgeView | null {
  if (row.pledge_id === null || row.pledge_state === null || row.eta_bucket === null) return null;
  return { pledgeId: row.pledge_id, state: row.pledge_state, etaBucket: row.eta_bucket };
}

export function registerAlertRoutes(app: FastifyInstance, deps: { db: SqlClient }): void {
  // BEFORE app.authenticate: a push deep link arrives as a browser document load
  // with no Authorization header, and this path is a registered API route, so
  // Fastify never reaches the not-found handler that serves the shell. Answer a
  // document load with the SPA and let it fetch this same URL with a token.
  // JSON clients (application/json, */*) never match and fall through untouched.
  const shellForDocumentLoads: preHandlerHookHandler = async (request, reply) => {
    if (!app.hasStatic || !wantsHtmlDocument(request.headers.accept)) return;
    // Awaiting the reply resolves when the response has been flushed, so the
    // chain stops here (Fastify skips the remaining hooks once reply.sent).
    await reply.sendFile(INDEX_HTML);
    return reply;
  };

  app.get<{ Params: { dispatchId: string } }>(
    '/alerts/:dispatchId',
    { preHandler: [shellForDocumentLoads, app.authenticate] },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        // authenticate already guards this; the check narrows the type.
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const { dispatchId } = request.params;
      // Malformed ids reveal nothing either — same 404 (and avoids a uuid cast throw).
      if (!UUID_RE.test(dispatchId)) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      const { rows } = await deps.db.query<AlertDetailRow>(ALERT_DETAIL_SQL, [dispatchId, uid]);
      const row = rows[0];
      if (row === undefined) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      const hospitalLat = Number(row.hospital_lat);
      const hospitalLng = Number(row.hospital_lng);
      const { latitude, longitude } = ngeohash.decode(row.geohash5);
      const distanceKm = round1(haversineKm(latitude, longitude, hospitalLat, hospitalLng));

      await reply.code(200).send({
        alertId: row.dispatch_id,
        bloodGroup: row.blood_group,
        unitsNeeded: row.units_needed,
        urgency: row.urgency,
        // Included so stale pushes self-correct on tap: a closed/expired/cancelled
        // request renders "fulfilled — thank you" client-side (PROTOCOL §3). The
        // API just reports state.
        requestState: row.state,
        hospital: {
          name: row.hospital_name,
          address: row.hospital_address,
          lat: hospitalLat,
          lng: hospitalLng,
          bloodbankPhone: row.bloodbank_phone,
        },
        distanceKm,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        // The caller's own pledge, or null. Survives a reload — the client no
        // longer needs in-memory state to know it already accepted (GB-32).
        pledge: toPledgeView(row),
      });
    },
  );
}
