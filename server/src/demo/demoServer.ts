// The local demo entrypoint (GB-24): one process, no cloud accounts, click
// through the whole loop in a browser.
//
// DEMO ONLY, and one-directional: this file IMPORTS buildApp and hands it fake
// adapters. Production (src/index.ts) neither imports nor knows about anything
// under src/demo/, and no env var can make it behave like this — the fake
// verifier is passed in here, by hand, and nowhere else.
//
// Swapped for fakes: Postgres -> PGlite (in memory), Firebase -> four scripted
// personas, FCM -> an in-memory inbox, Cloud Scheduler -> POST /demo/sweep.
// Everything else — routes, matching, dispatch, FSMs, sweep — is the real code.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { FakeTokenVerifier } from '../auth/fakeVerifier.js';
import { loadConfig } from '../config.js';
import {
  cellDistanceKm,
  DEMO_DONORS,
  DEMO_HOSPITAL,
  DEMO_REQUESTER,
  demoPrincipals,
  handleForPushToken,
  verifyDemoGeometry,
} from './demoPersonas.js';
import { DemoPushSender } from './demoPushSender.js';
import { registerDemoRoutes } from './demoRoutes.js';
import { createDemoDb, seedDemo } from './demoSeed.js';

const DEMO_PORT = 8787;

// Loopback, NOT the 0.0.0.0 production binds for Cloud Run: a server that
// accepts 'demo-asha' as an identity must not be reachable from the network.
const LISTEN_HOST = '127.0.0.1';
const DEMO_URL = `http://localhost:${DEMO_PORT}`;

/** This package's root — the demo always runs from src/ under tsx. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATIC_ROOT = path.resolve(PACKAGE_ROOT, '../client/dist');
const INDEX_HTML = 'index.html';

// Every value the schema demands, none of it real. DATABASE_URL is required by
// the schema but unused (PGlite needs no DSN), so it points at a .invalid host
// that cannot resolve; SWEEP_SHARED_SECRET is a fixed, obviously-fake demo
// string — the sweep route is not what the demo drives (POST /demo/sweep is).
const DEMO_ENV = {
  DATABASE_URL: 'postgres://give-blood-demo.invalid/unused-by-pglite',
  FIREBASE_PROJECT_ID: 'give-blood-demo',
  SWEEP_SHARED_SECRET: 'demo-sweep-secret-not-a-real-secret',
  APP_BASE_URL: DEMO_URL,
  PORT: String(DEMO_PORT),
  // The banner is the point of the console here; pino's per-request JSON would
  // bury it. Warnings and errors still surface.
  LOG_LEVEL: 'warn',
};

const RULE = '='.repeat(78);

/** The built PWA, or undefined when the client has not been built yet. */
function resolveStaticRoot(): string | undefined {
  return existsSync(path.join(STATIC_ROOT, INDEX_HTML)) ? STATIC_ROOT : undefined;
}

function personaLines(): string[] {
  const donors = DEMO_DONORS.map((d) => {
    const tier = d.tier === 0 ? 'tier 0' : 'tier 1 only';
    return [
      `    ${d.token.padEnd(12)}`,
      `donor      ${d.handle.padEnd(6)}`,
      `${d.bloodGroup.padEnd(3)}`,
      `cell ${d.geohash5}`,
      `${String(cellDistanceKm(d.geohash5)).padStart(4)} km`,
      tier,
    ].join('  ');
  });
  return [
    ...donors,
    `    ${DEMO_REQUESTER.token.padEnd(12)}  requester  ${DEMO_HOSPITAL.name} (verified)`,
  ];
}

function banner(staticRoot: string | undefined): string {
  const lines = [
    '',
    RULE,
    '  GIVE BLOOD - DEMO MODE',
    RULE,
    '  Fake auth. Fake push. In-memory database. Restarting wipes everything.',
    '  No Firebase, no FCM, no Postgres, no cloud account is contacted.',
    '',
    `  Open:  ${DEMO_URL}`,
    staticRoot === undefined
      ? '  NO CLIENT BUNDLE - API only. Build it:  npm --prefix ../client run build'
      : `  Serving the client bundle from ${staticRoot}`,
    '',
    '  Sign in as any persona by sending: Authorization: Bearer <token>',
    ...personaLines(),
    '',
    `  Hospital id for the POST /requests body:  ${DEMO_HOSPITAL.hospitalId}`,
    '',
    '  Demo-only controls (this entrypoint never runs in production):',
    '    GET  /demo/pushes   the device inbox - exactly what FCM would carry',
    '    GET  /demo/state    every request with its state and radius tier',
    '    POST /demo/sweep    one sweep pass by hand (production: Cloud Scheduler, 60 s)',
    '    POST /demo/expire   { requestId } - backdate its TTL so the next sweep expires it',
    '    POST /demo/reset    reseed the database and empty the inbox',
    '',
    '  Urgency picks the opening radius (PROTOCOL.md §5):',
    "    'critical'  opens at tier 1 (10 km) - alerts Asha AND Ravi on the first sweep",
    "    'standard'  opens at tier 0 (5 km)  - Asha only, widening after 30 minutes,",
    '                and it will not dispatch at all between 22:00 and 07:00',
    '                donor-local (America/New_York) - quiet hours.',
    '  Meera shares Asha cell (both read 0.3 km) and is never alerted for B+: A+',
    '  is not a compatible donor group. That is the matcher, not a bug.',
    RULE,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const config = loadConfig(DEMO_ENV);

  const db = await createDemoDb();
  await seedDemo(db);

  const push = new DemoPushSender(handleForPushToken);
  const staticRoot = resolveStaticRoot();

  const app = buildApp({
    config,
    verifier: new FakeTokenVerifier(demoPrincipals()),
    db,
    push,
    staticRoot,
  });

  // Registered on THIS instance only, after buildApp and before listen. buildApp
  // is untouched, so the production app has no /demo surface to disable.
  registerDemoRoutes(app, { db, push });

  // A drifted fixture makes a confusing demo, not an unsafe one: warn, continue.
  for (const problem of verifyDemoGeometry()) {
    app.log.warn(`demo geometry drift: ${problem}`);
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    await app.close();
    await db.close();
    process.stdout.write(`\nstopped (${signal})\n`);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: DEMO_PORT, host: LISTEN_HOST });
  } catch (err) {
    app.log.error({ err }, 'demo server failed to start');
    process.exit(1);
  }

  // Written straight to stdout, not through pino: this block is for a human
  // reading a terminal, not for a log aggregator.
  process.stdout.write(banner(staticRoot));
}

void main();
