// Server entrypoint. Loads config from the environment, opens the single
// Postgres session, wires the real Firebase verifier and the real FCM sender,
// builds the Fastify app, and listens. Fails fast on bad config or a dead DB.
// Never imported by tests — the app factory (app.ts) is the test seam.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { FirebaseTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { FcmPushSender } from './push/fcmPushSender.js';

// Cloud Run (docs/ARCHITECTURE.md) requires binding all interfaces, not
// loopback. Fixed deployment constant — not part of the config surface.
const LISTEN_HOST = '0.0.0.0';

/** Where `npm run build` in client/ puts the bundle, relative to this package. */
const DEFAULT_STATIC_ROOT = '../client/dist';
const INDEX_HTML = 'index.html';

/** This package's root, whether running from src/ (tsx) or dist/ (built). */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Absolute bundle root, or undefined when there is no build there. A missing
 * bundle is not a config error: in dev the client runs on Vite, and an API-only
 * deploy is valid — so the server boots either way and only serves what exists.
 */
function resolveStaticRoot(configured: string | undefined): string | undefined {
  const root = path.resolve(PACKAGE_ROOT, configured ?? DEFAULT_STATIC_ROOT);
  return existsSync(path.join(root, INDEX_HTML)) ? root : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // pg.Client, NOT pg.Pool (standing ruling): the accept, cancel
  // and sweep paths run BEGIN/COMMIT, and a Pool hands each statement whichever
  // connection is free — the transaction would silently span sessions. One
  // session is sufficient at v0 scale; revisit with a checked-out PoolClient
  // per transaction when concurrency demands it.
  const db = new pg.Client({ connectionString: config.DATABASE_URL });

  const verifier = new FirebaseTokenVerifier(config.FIREBASE_PROJECT_ID);

  // The push logger forwards delivery failures into the app's pino instance.
  // The app is built two statements below, so the sink starts empty and is
  // filled in; the closure only runs during a send, long after that. This keeps
  // FCM failures in structured logs instead of console. The FcmPushSender
  // contract never hands the logger a raw device token.
  const logSink: { app?: FastifyInstance } = {};
  const push = new FcmPushSender({
    projectId: config.FIREBASE_PROJECT_ID,
    logger: (entry) => {
      logSink.app?.log[entry.level]({ status: entry.status, code: entry.code }, entry.msg);
    },
  });

  // Built before connecting: route registration issues no query, it only closes
  // over the client. Building first makes app.log available for the connection
  // failure below, so no boot path has to fall back to console.
  const staticRoot = resolveStaticRoot(config.STATIC_ROOT);
  const app = buildApp({ config, verifier, db, push, staticRoot });
  logSink.app = app;
  app.log.info(
    staticRoot === undefined
      ? 'no client bundle found, serving the API only'
      : `serving the client bundle from ${staticRoot}`,
  );

  // Crash-only at v0 (honest, and what Cloud Run expects): a pg.Client does not
  // reconnect, so a lost session leaves the process unable to serve anything.
  // Log and exit non-zero; the platform replaces the container.
  db.on('error', (err: Error) => {
    app.log.error({ err }, 'postgres session error, exiting');
    process.exit(1);
  });

  try {
    await db.connect();
  } catch (err) {
    app.log.error({ err }, 'failed to connect to postgres');
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    const address = await app.listen({ port: config.PORT, host: LISTEN_HOST });
    app.log.info(`listening on ${address}`);
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
