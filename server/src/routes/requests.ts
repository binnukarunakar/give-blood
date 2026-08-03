// POST /requests — request creation + validation gates.
//
// Canonical rules: docs/PROTOCOL.md §1 (validation gates) and §8 (named
// defaults). Every tunable number comes from src/domain/protocol.ts; the
// blood-group and state vocabularies come from the schema-mirroring constants.
// All DB access is parameterized.
//
// Creating a request writes the row in state 'open' ONLY. Tier-0 dispatch is
// NOT triggered here — the sweep picks up 'open' requests on its next 60 s
// pass. There is no patient-name / phone field on
// the body by construction (PROTOCOL.md §1), so nothing sensitive is ever
// logged or echoed; the zod schema strips any unknown key a client smuggles.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toPgArrayLiteral } from '../db/pgArray.js';
import { BLOOD_GROUPS } from '../matching/compatibility.js';
import type { SqlClient } from '../matching/eligibility.js';
import {
  DUP_WINDOW_H,
  MAX_OPEN_REQUESTS_PER_REQUESTER,
  MAX_UNITS_PER_REQUEST,
  OPEN_REQUEST_STATES,
  REQUEST_TTL_HOURS,
} from '../domain/protocol.js';

/** Milliseconds per hour — unit conversion for TTL/window math, not a protocol tunable. */
const MS_PER_HOUR = 3_600_000;

/** Soft-warning code (never blocks) when a DIFFERENT requester has a similar open request. */
const SIMILAR_WARNING = 'similar_open_request_exists';

// Request body contract. Unknown keys are stripped (zod default), so a client
// that smuggles a patient-name / phone field never has it stored or echoed.
const bodySchema = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS),
  unitsNeeded: z.number().int().min(1).max(MAX_UNITS_PER_REQUEST),
  urgency: z.enum(['critical', 'standard']),
  hospitalId: z.uuid(),
  differentPatient: z.boolean().optional(),
});
type RequestBody = z.infer<typeof bodySchema>;

interface RequesterRow {
  requester_id: string;
  verified: boolean;
}
interface PresentRow {
  present: number;
}
interface CountRow {
  n: number;
}
interface RequestIdRow {
  request_id: string;
}
interface InsertedRow {
  request_id: string;
  state: string;
}

interface CreateResponse {
  requestId: string;
  state: string;
  expiresAt: string;
  warning?: string;
}

/** Discriminated outcome of the cap+dedupe+insert transaction. */
type TxnResult =
  | { kind: 'created'; requestId: string; state: string; expiresAt: string; warning?: string }
  | { kind: 'cap' }
  | { kind: 'duplicate'; existingRequestId: string };

// Bound as a parameter and cast in SQL (see db/pgArray.ts); the values here are
// compile-time protocol constants, never client input.
const OPEN_STATES_LITERAL = toPgArrayLiteral(OPEN_REQUEST_STATES);

const RESOLVE_REQUESTER_SQL = `SELECT requester_id, verified FROM requester WHERE firebase_uid = $1`;

const HOSPITAL_EXISTS_SQL = `SELECT 1 AS present FROM hospital WHERE hospital_id = $1::uuid`;

const OPEN_COUNT_SQL = `
  SELECT count(*)::int AS n FROM request
  WHERE requester_id = $1::uuid AND state = ANY($2::request_state[])
`;

const SAME_REQUESTER_DUP_SQL = `
  SELECT request_id FROM request
  WHERE requester_id = $1::uuid
    AND hospital_id = $2::uuid
    AND blood_group = $3::blood_group
    AND state = ANY($4::request_state[])
    AND created_at >= $5::timestamptz
  ORDER BY created_at DESC
  LIMIT 1
`;

const CROSS_REQUESTER_DUP_SQL = `
  SELECT 1 AS present FROM request
  WHERE requester_id <> $1::uuid
    AND hospital_id = $2::uuid
    AND blood_group = $3::blood_group
    AND state = ANY($4::request_state[])
  LIMIT 1
`;

// state 'open' + radius_tier 0 + units_confirmed 0 are the mandated initial
// values (GB-9 spec; schema defaults concur). expires_at is bound as a
// pre-computed timestamp = now + REQUEST_TTL_HOURS[urgency].
const INSERT_REQUEST_SQL = `
  INSERT INTO request
    (requester_id, hospital_id, blood_group, units_needed, urgency,
     state, radius_tier, units_confirmed, expires_at)
  VALUES
    ($1::uuid, $2::uuid, $3::blood_group, $4::int, $5::request_urgency,
     'open', 0, 0, $6::timestamptz)
  RETURNING request_id, state
`;

function summarizeIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Cap + dedupe + insert, assuming a transaction is already open. */
async function createGuarded(
  db: SqlClient,
  requesterId: string,
  body: RequestBody,
  now: Date,
): Promise<TxnResult> {
  const capRes = await db.query<CountRow>(OPEN_COUNT_SQL, [requesterId, OPEN_STATES_LITERAL]);
  if ((capRes.rows[0]?.n ?? 0) >= MAX_OPEN_REQUESTS_PER_REQUESTER) {
    return { kind: 'cap' };
  }

  // Same-requester dedupe — skipped only on an explicit "different patient"
  // confirmation (PROTOCOL.md §1: hospital staff legitimately raise two
  // same-group requests in one shift).
  if (body.differentPatient !== true) {
    const windowStart = new Date(now.getTime() - DUP_WINDOW_H * MS_PER_HOUR);
    const dupRes = await db.query<RequestIdRow>(SAME_REQUESTER_DUP_SQL, [
      requesterId,
      body.hospitalId,
      body.bloodGroup,
      OPEN_STATES_LITERAL,
      windowStart.toISOString(),
    ]);
    const existing = dupRes.rows[0];
    if (existing !== undefined) {
      return { kind: 'duplicate', existingRequestId: existing.request_id };
    }
  }

  // Cross-requester similarity — soft warn only, NEVER block or merge
  // (PROTOCOL.md §1: false-merging two real patients starves one of them).
  const crossRes = await db.query<PresentRow>(CROSS_REQUESTER_DUP_SQL, [
    requesterId,
    body.hospitalId,
    body.bloodGroup,
    OPEN_STATES_LITERAL,
  ]);
  const warning = crossRes.rows[0] !== undefined ? SIMILAR_WARNING : undefined;

  const expiresAt = new Date(now.getTime() + REQUEST_TTL_HOURS[body.urgency] * MS_PER_HOUR);
  const insRes = await db.query<InsertedRow>(INSERT_REQUEST_SQL, [
    requesterId,
    body.hospitalId,
    body.bloodGroup,
    body.unitsNeeded,
    body.urgency,
    expiresAt.toISOString(),
  ]);
  const inserted = insRes.rows[0];
  if (inserted === undefined) {
    throw new Error('request insert returned no row');
  }
  return {
    kind: 'created',
    requestId: inserted.request_id,
    state: inserted.state,
    expiresAt: expiresAt.toISOString(),
    ...(warning !== undefined ? { warning } : {}),
  };
}

/** One transaction over cap + dedupe + insert (BEGIN/COMMIT on the single connection). */
async function runCreateTxn(
  db: SqlClient,
  requesterId: string,
  body: RequestBody,
  now: Date,
): Promise<TxnResult> {
  await db.query('BEGIN');
  try {
    const result = await createGuarded(db, requesterId, body, now);
    await db.query(result.kind === 'created' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

export function registerRequestRoutes(app: FastifyInstance, deps: { db: SqlClient }): void {
  app.post('/requests', { preHandler: app.authenticate }, async (request, reply) => {
    const uid = request.user?.uid;
    if (uid === undefined) {
      // app.authenticate guarantees request.user; this satisfies the type guard.
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const requesterRes = await deps.db.query<RequesterRow>(RESOLVE_REQUESTER_SQL, [uid]);
    const requester = requesterRes.rows[0];
    if (requester === undefined) {
      return reply.code(403).send({ error: 'not_a_requester' });
    }
    if (!requester.verified) {
      return reply.code(403).send({ error: 'not_verified' });
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: summarizeIssues(parsed.error) });
    }
    const body = parsed.data;

    const hospitalRes = await deps.db.query<PresentRow>(HOSPITAL_EXISTS_SQL, [body.hospitalId]);
    if (hospitalRes.rows[0] === undefined) {
      return reply.code(404).send({ error: 'unknown_hospital' });
    }

    const result = await runCreateTxn(deps.db, requester.requester_id, body, new Date());
    if (result.kind === 'cap') {
      return reply.code(429).send({ error: 'too_many_open_requests' });
    }
    if (result.kind === 'duplicate') {
      return reply
        .code(409)
        .send({ error: 'duplicate_request', existingRequestId: result.existingRequestId });
    }

    const responseBody: CreateResponse = {
      requestId: result.requestId,
      state: result.state,
      expiresAt: result.expiresAt,
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
    };
    return reply.code(201).send(responseBody);
  });
}
