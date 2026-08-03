// The /demo/* control surface (GB-24).
//
// DEMO ONLY. These routes are registered by src/demo/demoServer.ts and by
// NOTHING else — buildApp does not know they exist, so no deploy and no env
// flag can expose them. They are deliberately unauthenticated: the demo runs on
// loopback with fake personas and no real data.
//
// The endpoints replace the pieces the local demo has no infrastructure for:
// FCM (the push inbox), Cloud Scheduler (the sweep trigger), a dashboard
// (request state), a fresh database (reset), and the clock (expire).
import type { FastifyInstance } from 'fastify';
import { UUID_RE } from '../routes/pledgesShared.js';
import { runSweep } from '../sweep/sweep.js';
import { DEMO_HOSPITAL } from './demoPersonas.js';
import type { DemoPushSender } from './demoPushSender.js';
import { type DemoDb, resetDemo } from './demoSeed.js';

const REQUEST_STATE_SQL = `
  SELECT request_id, state, radius_tier, units_needed, units_confirmed
  FROM request
  ORDER BY created_at, request_id
`;

// Backdating expires_at is the only honest way to demo expiry: the sweep's
// expiry pass compares expires_at to now(), so moving the deadline into the past
// makes the NEXT /demo/sweep expire the request through the real code path. No
// state is written here — the request keeps its state until the sweep runs.
const EXPIRE_REQUEST_SQL = `
  UPDATE request SET expires_at = now() - interval '1 minute'
  WHERE request_id = $1::uuid
  RETURNING request_id, expires_at
`;

interface RequestStateRow {
  request_id: string;
  state: string;
  radius_tier: number;
  units_needed: number;
  units_confirmed: number;
}

interface ExpiredRow {
  request_id: string;
  expires_at: Date;
}

export interface DemoRouteDeps {
  db: DemoDb;
  push: DemoPushSender;
}

export function registerDemoRoutes(app: FastifyInstance, deps: DemoRouteDeps): void {
  // The device inbox. `payload` is the opaque push object verbatim (PROTOCOL.md
  // §3): a type and an alertId, no request content — that IS the demonstration.
  app.get('/demo/pushes', () => ({ pushes: deps.push.list() }));

  // Read-only observability. The hospital rides along because there is no
  // hospital-listing endpoint and the requester UI needs the id for POST
  // /requests (see demoPersonas.ts — the id is fixed for exactly this reason).
  app.get('/demo/state', async () => {
    const { rows } = await deps.db.query<RequestStateRow>(REQUEST_STATE_SQL);
    return {
      hospital: {
        hospitalId: DEMO_HOSPITAL.hospitalId,
        name: DEMO_HOSPITAL.name,
        address: DEMO_HOSPITAL.address,
        lat: DEMO_HOSPITAL.lat,
        lng: DEMO_HOSPITAL.lng,
      },
      requests: rows.map((row) => ({
        requestId: row.request_id,
        state: row.state,
        radiusTier: row.radius_tier,
        unitsNeeded: row.units_needed,
        unitsConfirmed: row.units_confirmed,
      })),
    };
  });

  // The heartbeat, by hand. Production has Cloud Scheduler POSTing
  // /internal/sweep every 60 s (PROTOCOL.md §5); the demo has a button. Same
  // runSweep, same single-session client — only the trigger differs.
  app.post('/demo/sweep', () => runSweep(deps.db, deps.push, new Date()));

  // The clock, by hand (GB-32). A demo has no patience for a real TTL, so this
  // moves one request's deadline a minute into the past; the next sweep expires
  // it, releases its pledges and fires the closure notices for real.
  app.post<{ Body: { requestId?: unknown } }>('/demo/expire', async (request, reply) => {
    const requestId = request.body?.requestId;
    if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
      return reply.code(400).send({ error: 'invalid_request_id' });
    }
    const { rows } = await deps.db.query<ExpiredRow>(EXPIRE_REQUEST_SQL, [requestId]);
    const row = rows[0];
    if (row === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send({
      requestId: row.request_id,
      expiresAt: row.expires_at.toISOString(),
    });
  });

  // Back to the opening position.
  app.post('/demo/reset', async () => {
    await resetDemo(deps.db);
    deps.push.clear();
    return { ok: true };
  });
}
