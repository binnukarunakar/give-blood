// The demo control surface (GB-32): the expire lever.
//
// A demo cannot wait out a real TTL, and faking the expiry by writing
// state='expired' would demo nothing — the interesting behaviour (pledges
// released, closure notices sent) lives in the sweep. So the lever moves the
// DEADLINE and lets the real sweep do the work; this test proves exactly that.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import { loadConfig } from '../config.js';
import { DEMO_HOSPITAL, demoPrincipals, handleForPushToken } from './demoPersonas.js';
import { DemoPushSender } from './demoPushSender.js';
import { registerDemoRoutes } from './demoRoutes.js';
import { createDemoDb, type DemoDb, seedDemo } from './demoSeed.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://give-blood-demo.invalid/unused-by-pglite',
  FIREBASE_PROJECT_ID: 'give-blood-demo',
  SWEEP_SHARED_SECRET: 'demo-sweep-secret-not-a-real-secret',
  APP_BASE_URL: 'http://localhost:8787',
});

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

let db: DemoDb & { close: () => Promise<void> };
let app: FastifyInstance;

beforeAll(async () => {
  db = await createDemoDb();
  await seedDemo(db);
  // One sender, as demoServer.ts wires it: the inbox the app writes to IS the
  // inbox /demo/pushes reads.
  const push = new DemoPushSender(handleForPushToken);
  app = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(demoPrincipals()),
    db,
    push,
    logger: false,
  });
  registerDemoRoutes(app, { db, push });
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

test('POST /demo/expire backdates the TTL so the next sweep expires the request', async () => {
  const requesterId = (
    await db.query<{ requester_id: string }>('SELECT requester_id FROM requester LIMIT 1')
  ).rows[0]?.requester_id;
  const requestId = (
    await db.query<{ request_id: string }>(
      `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, state, expires_at)
       VALUES ($1::uuid, $2::uuid, 'B+', 1, 'critical', 'alerting', now() + interval '4 hours')
       RETURNING request_id`,
      [requesterId, DEMO_HOSPITAL.hospitalId],
    )
  ).rows[0]?.request_id;
  if (requestId === undefined) throw new Error('failed to seed the demo request');

  const bad = await app.inject({ method: 'POST', url: '/demo/expire', payload: { requestId: 'nope' } });
  expect(bad.statusCode).toBe(400);
  const absent = await app.inject({ method: 'POST', url: '/demo/expire', payload: { requestId: ABSENT_UUID } });
  expect(absent.statusCode).toBe(404);

  const res = await app.inject({ method: 'POST', url: '/demo/expire', payload: { requestId } });
  expect(res.statusCode).toBe(200);
  expect(res.json<{ requestId: string }>().requestId).toBe(requestId);
  expect(new Date(res.json<{ expiresAt: string }>().expiresAt).getTime()).toBeLessThan(Date.now());
  // The lever moves the deadline only — the state is still the sweep's to change.
  const stateBefore = (
    await db.query<{ state: string }>('SELECT state FROM request WHERE request_id = $1::uuid', [requestId])
  ).rows[0]?.state;
  expect(stateBefore).toBe('alerting');

  const swept = await app.inject({ method: 'POST', url: '/demo/sweep' });
  expect(swept.statusCode).toBe(200);
  expect(swept.json<{ expired: number }>().expired).toBe(1);
  const stateAfter = (
    await db.query<{ state: string }>('SELECT state FROM request WHERE request_id = $1::uuid', [requestId])
  ).rows[0]?.state;
  expect(stateAfter).toBe('expired');
});
