import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from './app.js';
import { FakeTokenVerifier } from './auth/fakeVerifier.js';
import { type AuthUser } from './auth/verifier.js';
import { loadConfig } from './config.js';
import type { SqlClient } from './matching/eligibility.js';
import { FakePushSender } from './push/fakePushSender.js';

// buildApp mounts every route module, so it needs a db + push seam. This suite
// exercises only /healthz and the authenticate decorator — no route it calls
// touches Postgres, so the db seam is a stub that fails loudly if one ever
// does. Deliberately not a PGlite instance: the standing PGlite ruling is that
// WASM cold starts are the suite's binding constraint, and a bootstrap test has
// no business booting a database.
const DB: SqlClient = {
  query: () => {
    throw new Error('app.test.ts must not reach the database');
  },
};

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
});

const GOOD_TOKEN = 'good-token';
const GOOD_USER: AuthUser = { uid: 'donor-1', phone: '+15555550100' };

let app: FastifyInstance;

beforeEach(async () => {
  const verifier = new FakeTokenVerifier(new Map([[GOOD_TOKEN, GOOD_USER]]));
  app = buildApp({
    config: CONFIG,
    verifier,
    db: DB,
    push: new FakePushSender(),
    logger: false,
  });
  // A stand-in for GB-8+ routes: exercises the authenticate decorator and
  // echoes request.user so the test can assert the principal was attached.
  app.get('/protected', { preHandler: app.authenticate }, (request) => ({
    user: request.user,
  }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  test('returns 200 { ok: true } with no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('authenticate decorator', () => {
  test('401 when the Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  test('401 when the header is malformed (no Bearer scheme)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Token ${GOOD_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  test('401 when the bearer token is unknown (AuthError)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  test('200 and request.user is the verified principal for a valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: GOOD_USER });
  });
});
