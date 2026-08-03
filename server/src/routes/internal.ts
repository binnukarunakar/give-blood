// POST /internal/sweep — the Cloud Scheduler heartbeat (docs/ARCHITECTURE.md;
// sweep semantics: docs/PROTOCOL.md §5, implemented in src/sweep/sweep.ts).
//
// Auth is deliberately NOT app.authenticate: the caller is Cloud Scheduler,
// not a Firebase principal. The shared secret arrives in the `x-sweep-secret`
// header and is compared in constant time — both sides are SHA-256-hashed
// first so the buffers handed to timingSafeEqual are always equal-length. A
// wrong-LENGTH secret therefore 401s like any other miss instead of throwing,
// and the comparison leaks neither content nor length. The Authorization
// header is ignored entirely on this route.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SqlClient } from '../matching/eligibility.js';
import type { PushSender } from '../push/pushSender.js';
import { runSweep } from '../sweep/sweep.js';

/** Constant-time secret comparison over equal-length SHA-256 digests. */
function secretMatches(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerInternalRoutes(
  app: FastifyInstance,
  deps: { db: SqlClient; push: PushSender; sweepSecret: string },
): void {
  app.post('/internal/sweep', async (request, reply) => {
    const header = request.headers['x-sweep-secret'];
    if (typeof header !== 'string' || !secretMatches(header, deps.sweepSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const report = await runSweep(deps.db, deps.push, new Date());
    return reply.code(200).send(report);
  });
}
