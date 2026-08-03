// Fulfillment routes (GB-14): donated / no_show / withdraw / cancel.
//
// Thin Fastify + HTTP layer; the transaction machinery, SQL, and result types
// live in fulfillmentShared.ts (300-line-cap split). Canonical: docs/PROTOCOL.md
// §6 (fulfillment) & §7 (races); docs/DATA_MODEL.md (Pledge/Request FSMs).
//
// Requester-side routes (donated, no-show, cancel) resolve the caller as the
// OWNING requester; the donor-side route (withdraw) resolves the caller as the
// pledge's donor. Any ownership/existence/malformed-id miss returns a uniform
// 404 — a foreign or absent row must never be probeable.
//
// The two routes that CLOSE a request (cancel, and the donation that fulfils it)
// also send the closure notices PROTOCOL.md promises: best-effort REQUEST_CLOSED
// pushes to the donors whose active pledge that transaction released, sent after
// COMMIT so a push failure can never touch state or the response (GB-32).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { assertUnreachable } from '../domain/requestFsm.js';
import type { SqlClient } from '../matching/eligibility.js';
import type { PushSender } from '../push/pushSender.js';
import { sendClosureNotices } from './fulfillmentClosure.js';
import {
  type CancelResult,
  type DonatedResult,
  type ReleaseResult,
  runCancelTxn,
  runDonatedTxn,
  runNoShowTxn,
  runWithdrawTxn,
} from './fulfillmentShared.js';
import { UUID_RE } from './pledgesShared.js';

function sendDonatedResult(reply: FastifyReply, result: DonatedResult): FastifyReply {
  switch (result.kind) {
    case 'donated':
      return reply.code(200).send({
        pledgeState: result.pledgeState,
        requestState: result.requestState,
        unitsConfirmed: result.unitsConfirmed,
      });
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'not_active':
      return reply.code(409).send({ error: 'not_active', state: result.state });
    default:
      return assertUnreachable(result);
  }
}

function sendReleaseResult(reply: FastifyReply, result: ReleaseResult): FastifyReply {
  switch (result.kind) {
    case 'released':
      return reply
        .code(200)
        .send({ pledgeState: result.pledgeState, requestState: result.requestState });
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'not_active':
      return reply.code(409).send({ error: 'not_active', state: result.state });
    default:
      return assertUnreachable(result);
  }
}

function sendCancelResult(reply: FastifyReply, result: CancelResult): FastifyReply {
  switch (result.kind) {
    case 'cancelled':
      return reply
        .code(200)
        .send({ requestState: result.requestState, pledgesReleased: result.pledgesReleased });
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'already_closed':
      return reply.code(409).send({ error: 'already_closed', state: result.state });
    default:
      return assertUnreachable(result);
  }
}

export function registerFulfillmentRoutes(
  app: FastifyInstance,
  deps: { db: SqlClient; push: PushSender },
): void {
  app.post<{ Params: { pledgeId: string } }>(
    '/pledges/:pledgeId/donated',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        // app.authenticate guarantees request.user; this narrows the type.
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { pledgeId } = request.params;
      if (!UUID_RE.test(pledgeId)) return reply.code(404).send({ error: 'not_found' });
      const result = await runDonatedTxn(deps.db, pledgeId, uid);
      // Post-COMMIT: non-empty only when this donation fulfilled the request and
      // released siblings. Never the donor who donated — their pledge is 'donated'.
      if (result.kind === 'donated') await sendClosureNotices(deps.push, result.notices);
      return sendDonatedResult(reply, result);
    },
  );

  app.post<{ Params: { pledgeId: string } }>(
    '/pledges/:pledgeId/no-show',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { pledgeId } = request.params;
      if (!UUID_RE.test(pledgeId)) return reply.code(404).send({ error: 'not_found' });
      return sendReleaseResult(reply, await runNoShowTxn(deps.db, pledgeId, uid));
    },
  );

  app.post<{ Params: { pledgeId: string } }>(
    '/pledges/:pledgeId/withdraw',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { pledgeId } = request.params;
      if (!UUID_RE.test(pledgeId)) return reply.code(404).send({ error: 'not_found' });
      return sendReleaseResult(reply, await runWithdrawTxn(deps.db, pledgeId, uid));
    },
  );

  app.post<{ Params: { requestId: string } }>(
    '/requests/:requestId/cancel',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (uid === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const { requestId } = request.params;
      if (!UUID_RE.test(requestId)) return reply.code(404).send({ error: 'not_found' });
      const result = await runCancelTxn(deps.db, requestId, uid);
      // Post-COMMIT: one notice per donor whose active pledge this cancel released.
      if (result.kind === 'cancelled') await sendClosureNotices(deps.push, result.notices);
      return sendCancelResult(reply, result);
    },
  );
}
