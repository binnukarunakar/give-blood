// Donor endpoints (GB-8): register, self-view, toggles, the push-token +
// verification handshake, and self-reported donation.
//
// Canonical rules: docs/DATA_MODEL.md § Donor (fields, the three independent
// gates, push_verified_at semantics), docs/ARCHITECTURE.md ("Alertable =
// push-verified"), docs/PROTOCOL.md §3 (dead token → re-verify),
// docs/TRUST_PRIVACY.md (donor data never over-shared). All routes are
// donor-authenticated (app.authenticate) and resolve the caller's row by the
// Firebase uid. All SQL is parameterized; response shapes come from
// donorsShared.ts so GET and PATCH stay identical.
import type { FastifyInstance } from 'fastify';
import type { SqlClient } from '../matching/eligibility.js';
import { tzForGeohash } from '../matching/geo.js';
import type { PushSender } from '../push/pushSender.js';
import {
  ACTIVE_PLEDGE_VIEW_SQL,
  type ActivePledgeRow,
  buildDonorUpdate,
  DONOR_VIEW_COLUMNS,
  type DonorViewRow,
  donationSchema,
  patchSchema,
  pushTokenSchema,
  registerSchema,
  summarizeIssues,
  toActivePledge,
  toDonorView,
} from './donorsShared.js';

const SELECT_VIEW_SQL = `SELECT ${DONOR_VIEW_COLUMNS} FROM donor WHERE firebase_uid = $1`;

const INSERT_DONOR_SQL = `
  INSERT INTO donor
    (firebase_uid, handle, blood_group, geohash5, tz, phone,
     opted_in, available, share_phone_on_accept)
  VALUES
    ($1, $2, $3::blood_group, $4, $5, $6, true, true, false)
  RETURNING donor_id, handle, blood_group, geohash5, tz
`;

const ACTIVE_PLEDGE_SQL = `SELECT 1 FROM pledge WHERE donor_id = $1 AND state = 'active' LIMIT 1`;

const SET_PUSH_TOKEN_SQL = `
  UPDATE donor SET push_token = $1, push_verified_at = NULL
  WHERE firebase_uid = $2 RETURNING donor_id
`;
const CLEAR_PUSH_TOKEN_SQL = `UPDATE donor SET push_token = NULL WHERE firebase_uid = $1`;

const SELECT_PUSH_TOKEN_SQL = `SELECT push_token FROM donor WHERE firebase_uid = $1`;
const SET_PUSH_VERIFIED_SQL = `
  UPDATE donor SET push_verified_at = $1::timestamptz WHERE firebase_uid = $2 RETURNING donor_id
`;

// GREATEST ignores NULLs and never moves the timestamp backward (DECISIONS #8:
// dual-path cooldown — requester confirm OR self-report, whichever is later).
const REPORT_DONATION_SQL = `
  UPDATE donor SET last_donation_at = GREATEST(last_donation_at, $1::timestamptz)
  WHERE firebase_uid = $2 RETURNING last_donation_at
`;

interface DonorIdRow {
  donor_id: string;
}
interface RegisteredRow {
  donor_id: string;
  handle: string;
  blood_group: string;
  geohash5: string;
  tz: string;
}
interface PushTokenRow {
  push_token: string | null;
}
interface LastDonationRow {
  last_donation_at: Date | null;
}

/** SQLSTATE 23505 (unique_violation) — a second register for the same uid. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

export function registerDonorRoutes(
  app: FastifyInstance,
  deps: { db: SqlClient; push: PushSender },
): void {
  // 1. Register. Donor identity IS the phone (DATA_MODEL) — a token with no
  // phone claim cannot register. opted_in/available default on; push creds NULL
  // until the browser grants permission (the register → verify handshake).
  app.post('/donors', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: summarizeIssues(parsed.error) });
    }
    const body = parsed.data;

    // tzForGeohash both validates the cell and derives tz; a bad cell throws
    // TypeError → 400 (not a 500).
    let tz: string;
    try {
      tz = tzForGeohash(body.geohash5);
    } catch (err) {
      if (err instanceof TypeError) {
        return reply.code(400).send({ error: 'invalid_geohash' });
      }
      throw err;
    }

    const phone = request.user?.phone;
    if (phone === null || phone === undefined) {
      return reply.code(403).send({ error: 'phone_auth_required' });
    }

    let row: RegisteredRow | undefined;
    try {
      const res = await deps.db.query<RegisteredRow>(INSERT_DONOR_SQL, [
        uid,
        body.handle,
        body.bloodGroup,
        body.geohash5,
        tz,
        phone,
      ]);
      row = res.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'already_registered' });
      }
      throw err;
    }
    if (row === undefined) throw new Error('donor insert returned no row');

    return reply.code(201).send({
      donorId: row.donor_id,
      handle: row.handle,
      bloodGroup: row.blood_group,
      geohash5: row.geohash5,
      tz: row.tz,
    });
  });

  // 2. Own row. Never leaks push_token or firebase_uid (projection in shared).
  // `activePledge` rides along (GB-32) so a donor who reloads sees their pledge:
  // it is the resume pointer back into GET /alerts/:alertId. PATCH does NOT
  // carry it — a toggle response is the donor row, not a pledge lookup.
  app.get('/donors/me', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) return reply.code(401).send({ error: 'unauthorized' });

    const { rows } = await deps.db.query<DonorViewRow>(SELECT_VIEW_SQL, [uid]);
    const row = rows[0];
    if (row === undefined) return reply.code(404).send({ error: 'not_found' });

    const pledge = await deps.db.query<ActivePledgeRow>(ACTIVE_PLEDGE_VIEW_SQL, [uid]);
    return reply.code(200).send({ ...toDonorView(row), activePledge: toActivePledge(pledge.rows[0]) });
  });

  // 3. Partial update. geohash5 re-derives tz atomically; bloodGroup is locked
  // while a pledge is active (DATA_MODEL). Empty body → 400.
  app.patch('/donors/me', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: summarizeIssues(parsed.error) });
    }
    const patch = parsed.data;

    let tz: string | undefined;
    if (patch.geohash5 !== undefined) {
      try {
        tz = tzForGeohash(patch.geohash5);
      } catch (err) {
        if (err instanceof TypeError) {
          return reply.code(400).send({ error: 'invalid_geohash' });
        }
        throw err;
      }
    }

    const update = buildDonorUpdate(patch, tz);
    if (update === null) return reply.code(400).send({ error: 'empty_update' });

    const donorRes = await deps.db.query<DonorIdRow>(`SELECT donor_id FROM donor WHERE firebase_uid = $1`, [uid]);
    const donor = donorRes.rows[0];
    if (donor === undefined) return reply.code(404).send({ error: 'not_found' });

    if (patch.bloodGroup !== undefined) {
      const pledgeRes = await deps.db.query<{ present: number }>(ACTIVE_PLEDGE_SQL, [donor.donor_id]);
      if (pledgeRes.rows[0] !== undefined) {
        return reply.code(409).send({ error: 'blood_group_locked' });
      }
    }

    // assignments use $1..$n; the uid WHERE param is appended as $n+1.
    const params = [...update.params, uid];
    const sql = `UPDATE donor SET ${update.assignments.join(', ')} WHERE firebase_uid = $${params.length} RETURNING ${DONOR_VIEW_COLUMNS}`;
    const { rows } = await deps.db.query<DonorViewRow>(sql, params);
    const row = rows[0];
    if (row === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(toDonorView(row));
  });

  // 4. Set push token. Storing a NEW address makes the donor unverified until
  // re-acked (ARCHITECTURE: verification gates the pool), so push_verified_at is
  // cleared and a VERIFY_PUSH is sent. A dead token → same rule as the dispatch
  // engine: NULL the token and 502; 'ok'/'error' → 202 (client may re-request).
  app.put('/donors/me/push-token', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = pushTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: summarizeIssues(parsed.error) });
    }
    const { token } = parsed.data;

    // Store the token (and clear verification) first, before the send.
    const stored = await deps.db.query<DonorIdRow>(SET_PUSH_TOKEN_SQL, [token, uid]);
    if (stored.rows[0] === undefined) return reply.code(404).send({ error: 'not_found' });

    const result = await deps.push.send(token, { type: 'VERIFY_PUSH' });
    if (result === 'dead_token') {
      await deps.db.query(CLEAR_PUSH_TOKEN_SQL, [uid]);
      return reply.code(502).send({ error: 'push_delivery_failed' });
    }
    return reply.code(202).send({ verificationSent: true });
  });

  // 5. Acknowledge the verification push. The client calls this only AFTER
  // receiving the VERIFY_PUSH — this is client-attested delivery, which is
  // acceptable for v0: the ack requires a live app instance holding the token.
  // A stronger challenge-nonce echo (server issues a nonce in the push, client
  // echoes it here) is a phase-2 hardening. Guard: a token must exist.
  app.post('/donors/me/push-verified', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) return reply.code(401).send({ error: 'unauthorized' });

    const tokenRes = await deps.db.query<PushTokenRow>(SELECT_PUSH_TOKEN_SQL, [uid]);
    const donor = tokenRes.rows[0];
    if (donor === undefined) return reply.code(404).send({ error: 'not_found' });
    if (donor.push_token === null) return reply.code(409).send({ error: 'no_push_token' });

    await deps.db.query(SET_PUSH_VERIFIED_SQL, [new Date().toISOString(), uid]);
    return reply.code(200).send({ pushVerified: true });
  });

  // 6. Self-report a donation (dual-path cooldown, DECISIONS #8). Future
  // timestamps are rejected; last_donation_at only ever advances (max semantics).
  app.post('/donors/me/donations', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = donationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: summarizeIssues(parsed.error) });
    }

    const now = new Date();
    const donatedAt = parsed.data.donatedAt === undefined ? now : new Date(parsed.data.donatedAt);
    if (donatedAt.getTime() > now.getTime()) {
      return reply.code(400).send({ error: 'future_donation' });
    }

    const { rows } = await deps.db.query<LastDonationRow>(REPORT_DONATION_SQL, [
      donatedAt.toISOString(),
      uid,
    ]);
    const row = rows[0];
    if (row === undefined) return reply.code(404).send({ error: 'not_found' });
    // last_donation_at is non-null after a GREATEST against a bound timestamp.
    return reply.code(200).send({ lastDonationAt: row.last_donation_at?.toISOString() ?? null });
  });
}
