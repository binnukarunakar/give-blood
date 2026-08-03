// GB-17 wiring tests. Two things nothing else covers:
//
// 1. The APP-OWNED route surface. Every other suite used to mount its own
//    module by hand, so "buildApp forgot to register X" was unprovable. Here
//    buildApp is the ONLY registrar, and each module is probed once through a
//    response that is not 404-route-missing — proving it is mounted, reachable,
//    and wired to the same db/push/sweep-secret the entrypoint passes.
// 2. The FCM notification mapping (buildFcmMessage), which no network test can
//    reach: a closure notice or verify probe must not wear the alert title.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from './app.js';
import { FakeTokenVerifier } from './auth/fakeVerifier.js';
import type { AuthUser } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { applyMigrations } from './db/migrate.js';
import { FakePushSender } from './push/fakePushSender.js';
import { buildFcmMessage } from './push/fcmPushSender.js';
import {
  ALERT_NOTIFICATION_BODY,
  ALERT_NOTIFICATION_TITLE,
  REQUEST_CLOSED_BODY,
  REQUEST_CLOSED_TITLE,
  VERIFY_PUSH_BODY,
  VERIFY_PUSH_TITLE,
} from './push/pushSender.js';

const SWEEP_SECRET = 'a-sufficiently-long-secret';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: SWEEP_SECRET,
  APP_BASE_URL: 'https://gb.example.com',
});

// Manhattan geohash-5 — resolves to America/New_York via tz-lookup, so the
// register route derives a real tz instead of rejecting the cell.
const MANHATTAN = 'dr5ru';
/** Well-formed but absent dispatch id: proves the 404 is "no such alert", not "bad uuid". */
const ABSENT_UUID = '11111111-2222-4333-8444-555555555555';

const DONOR_TOKEN = 'tok-donor';
const DONOR: AuthUser = { uid: 'uid-donor', phone: 'DONOR_PHONE' };
const REGISTER_BODY = {
  handle: 'nightbird',
  bloodGroup: 'O-',
  geohash5: MANHATTAN,
  consent: true,
};

let db: PGlite;
let app: FastifyInstance;
let push: FakePushSender;

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);

  push = new FakePushSender();
  // The production composition, minus the network: same factory, same deps
  // shape, same sweep secret source (config.SWEEP_SHARED_SECRET). No route is
  // registered by this file — every one below comes from buildApp.
  app = buildApp({
    config: CONFIG,
    verifier: new FakeTokenVerifier(new Map([[DONOR_TOKEN, DONOR]])),
    db,
    push,
    logger: false,
  });
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('route surface owned by buildApp', () => {
  test('GET /healthz — 200, no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test('POST /donors — 201: the register flow runs end to end through buildApp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/donors',
      headers: auth(DONOR_TOKEN),
      payload: REGISTER_BODY,
    });
    expect(res.statusCode).toBe(201);
    // tz was derived from the cell, so the route reached the DB via deps.db.
    expect(res.json()).toMatchObject({ handle: 'nightbird', tz: 'America/New_York' });
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM donor');
    expect(rows[0]?.n).toBe(1);
  });

  test('POST /requests — 401 without a token (requests module is mounted and authed)', async () => {
    const res = await app.inject({ method: 'POST', url: '/requests', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  test('GET /requests/mine — 403 for a uid with no requester row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/requests/mine',
      headers: auth(DONOR_TOKEN),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_a_requester' });
  });

  test('GET /alerts/:id — 404 for an authed donor with no such dispatch', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/alerts/${ABSENT_UUID}`,
      headers: auth(DONOR_TOKEN),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  test('POST /alerts/:id/accept — 404, not 401: the pledge module is mounted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/alerts/${ABSENT_UUID}/accept`,
      headers: auth(DONOR_TOKEN),
      // A body the route accepts, so the 404 comes from the transaction finding
      // no such dispatch — not from validation short-circuiting before it.
      payload: { etaBucket: 'le_1h' },
    });
    expect(res.statusCode).toBe(404);
  });

  test('POST /pledges/:id/donated — 404, not 401: the fulfillment module is mounted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/pledges/${ABSENT_UUID}/donated`,
      headers: auth(DONOR_TOKEN),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  test('POST /internal/sweep — 401 without the shared secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/sweep' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  test('POST /internal/sweep — 200 with the secret buildApp took from config', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sweep',
      headers: { 'x-sweep-secret': CONFIG.SWEEP_SHARED_SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ opened: 0, dispatched: 0, expired: 0 });
  });

  // GB-23: this app was built with no staticRoot, so nothing about the static
  // mount may leak into it — an unknown path stays a JSON 404 even for a
  // browser-shaped request.
  test('no staticRoot — an unmatched HTML GET is still a JSON 404, not a shell', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/donor',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('<!doctype html>');
  });
});

// GB-23 static mount. A temp dir stands in for client/dist: the point under
// test is the wiring (bundle served, SPA fallback, API untouched), not Vite.
describe('static bundle + SPA fallback (deps.staticRoot)', () => {
  const SHELL = '<!doctype html><title>Give Blood</title><div id="root"></div>';
  let staticRoot: string;
  let staticApp: FastifyInstance;

  beforeAll(async () => {
    staticRoot = mkdtempSync(path.join(tmpdir(), 'gb-static-'));
    writeFileSync(path.join(staticRoot, 'index.html'), SHELL, 'utf8');
    staticApp = buildApp({
      config: CONFIG,
      verifier: new FakeTokenVerifier(new Map([[DONOR_TOKEN, DONOR]])),
      db,
      push,
      logger: false,
      staticRoot,
    });
    await staticApp.ready();
  }, 20_000);

  afterAll(async () => {
    await staticApp.close();
    rmSync(staticRoot, { recursive: true, force: true });
  });

  test('GET /donor — the SPA shell, so a deep link survives a reload', async () => {
    const res = await staticApp.inject({
      method: 'GET',
      url: '/donor',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(SHELL);
  });

  test('GET /healthz — still the API JSON, not the shell', async () => {
    const res = await staticApp.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test('GET /index.html — the bundle itself is served from the root', async () => {
    const res = await staticApp.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SHELL);
  });

  test('an unknown path asking for JSON keeps the JSON 404 — the guard is Accept', async () => {
    const res = await staticApp.inject({
      method: 'GET',
      url: '/no-such-endpoint',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  test('a non-GET to an unmatched path is never answered with the shell', async () => {
    const res = await staticApp.inject({
      method: 'POST',
      url: '/donor',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<!doctype html>');
  });
});

describe('buildFcmMessage — notification copy is chosen by payload type', () => {
  const TOKEN = 'device-token';
  const ALERT_ID = 'dispatch-abc';

  test('BLOOD_ALERT carries the alert copy and its alert_id', () => {
    const { message } = buildFcmMessage(TOKEN, { type: 'BLOOD_ALERT', alertId: ALERT_ID });
    expect(message.token).toBe(TOKEN);
    expect(message.notification).toEqual({
      title: ALERT_NOTIFICATION_TITLE,
      body: ALERT_NOTIFICATION_BODY,
    });
    expect(message.data).toEqual({ type: 'BLOOD_ALERT', alert_id: ALERT_ID });
  });

  test('REQUEST_CLOSED carries closure copy — NOT the blood-alert title (GB-12 finding)', () => {
    const { message } = buildFcmMessage(TOKEN, { type: 'REQUEST_CLOSED', alertId: ALERT_ID });
    expect(message.notification).toEqual({
      title: REQUEST_CLOSED_TITLE,
      body: REQUEST_CLOSED_BODY,
    });
    expect(message.notification.title).not.toBe(ALERT_NOTIFICATION_TITLE);
    expect(message.data).toEqual({ type: 'REQUEST_CLOSED', alert_id: ALERT_ID });
  });

  test('VERIFY_PUSH carries verify copy and NO alert_id — it has no request context', () => {
    const { message } = buildFcmMessage(TOKEN, { type: 'VERIFY_PUSH' });
    expect(message.notification).toEqual({ title: VERIFY_PUSH_TITLE, body: VERIFY_PUSH_BODY });
    expect(message.notification.title).not.toBe(ALERT_NOTIFICATION_TITLE);
    expect(message.data).toEqual({ type: 'VERIFY_PUSH' });
    expect(message.data).not.toHaveProperty('alert_id');
  });

  test('every payload type gets a distinct title, and data always carries type', () => {
    const titles = (
      [
        { type: 'BLOOD_ALERT', alertId: ALERT_ID },
        { type: 'REQUEST_CLOSED', alertId: ALERT_ID },
        { type: 'VERIFY_PUSH' },
      ] as const
    ).map((p) => {
      const { message } = buildFcmMessage(TOKEN, p);
      expect(message.data.type).toBe(p.type);
      return message.notification.title;
    });
    expect(new Set(titles).size).toBe(titles.length);
  });
});
