// Accept / decline — the atomic pledge transaction (docs/PROTOCOL.md §4, §7;
// docs/DATA_MODEL.md Pledge/Dispatch; docs/DECISIONS.md #2 accept guard, #4
// phone-reveal-by-toggle).
//
// Both routes are donor-authenticated and ownership-scoped: the dispatch must
// belong to the caller's donor row. Existence and ownership are resolved in one
// query; a miss on EITHER returns an identical 404 (Dispatch is private — a
// foreign/absent alert must never be probeable, mirroring alerts.ts).
//
// This file is the thin Fastify + HTTP layer; the transaction machinery, SQL,
// and result types live in pledgesShared.ts (300-line-cap split).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { assertUnreachable } from '../domain/requestFsm.js';
import type { SqlClient } from '../matching/eligibility.js';
import {
  type AcceptResult,
  acceptBodySchema,
  type DeclineResult,
  runAcceptTxn,
  runDecline,
  summarizeIssues,
  UUID_RE,
} from './pledgesShared.js';

function sendAcceptResult(reply: FastifyReply, result: AcceptResult): FastifyReply {
  switch (result.kind) {
    case 'accepted':
      return reply.code(200).send({
        pledgeId: result.pledgeId,
        requestState: result.requestState,
        hospital: result.hospital,
        directionsUrl: result.directionsUrl,
      });
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'request_closed':
      return reply.code(409).send({ error: 'request_closed', requestState: result.requestState });
    case 'already_responded':
      return reply.code(409).send({ error: 'already_responded', response: result.response });
    case 'active_pledge_exists':
      return reply.code(409).send({ error: 'active_pledge_exists' });
    default:
      return assertUnreachable(result);
  }
}

function sendDeclineResult(reply: FastifyReply, result: DeclineResult): FastifyReply {
  switch (result.kind) {
    case 'declined':
      return reply.code(204).send();
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'already_responded':
      return reply.code(409).send({ error: 'already_responded', response: result.response });
    default:
      return assertUnreachable(result);
  }
}

export function registerPledgeRoutes(app: FastifyInstance, deps: { db: SqlClient }): void {
  app.post<{ Params: { dispatchId: string } }>(
    '/alerts/:dispatchId/accept',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        // app.authenticate guarantees request.user; this narrows the type.
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { dispatchId } = request.params;
      if (!UUID_RE.test(dispatchId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const parsed = acceptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: summarizeIssues(parsed.error) });
      }
      const result = await runAcceptTxn(deps.db, dispatchId, uid, parsed.data);
      return sendAcceptResult(reply, result);
    },
  );

  app.post<{ Params: { dispatchId: string } }>(
    '/alerts/:dispatchId/decline',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { dispatchId } = request.params;
      if (!UUID_RE.test(dispatchId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const result = await runDecline(deps.db, dispatchId, uid);
      return sendDeclineResult(reply, result);
    },
  );
}
