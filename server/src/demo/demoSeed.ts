// The demo's in-memory database: PGlite + the production migrations + the four
// contract personas (GB-24).
//
// DEMO ONLY — never imported by production code. Production opens a real
// pg.Client in src/index.ts; nothing here changes that.
//
// The seed writes rows no endpoint creates by design — the curated hospital and
// the operator-verified requester (PROTOCOL.md §1) — plus three donors already
// past the push-verification handshake, so the pool is populated the moment the
// browser opens. All SQL is parameterized.
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, type SqlExecutor } from '../db/migrate.js';
import type { SqlClient } from '../matching/eligibility.js';
import { DEMO_DONORS, DEMO_HOSPITAL, DEMO_REQUESTER } from './demoPersonas.js';

/** What the demo routes need of the database: parameterized queries + raw batches. */
export type DemoDb = SqlClient & SqlExecutor;

const INSERT_HOSPITAL_SQL = `
  INSERT INTO hospital (hospital_id, name, address, lat, lng, bloodbank_phone)
  VALUES ($1::uuid, $2, $3, $4::numeric, $5::numeric, $6)
`;

const INSERT_REQUESTER_SQL = `
  INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
  VALUES ($1, true, $2::uuid, $3)
`;

// opted_in + available + a push token + push_verified_at are the four gates the
// eligibility predicate checks (DATA_MODEL § "Donor eligibility predicate"), so
// every seeded donor is alertable immediately. share_phone_on_accept is true:
// these personas opted in, which lets the demo show the pledge reveal
// (TRUST_PRIVACY.md — the phone is revealed only with donor consent).
const INSERT_DONOR_SQL = `
  INSERT INTO donor
    (firebase_uid, handle, blood_group, geohash5, tz, phone,
     push_token, push_verified_at, share_phone_on_accept, opted_in, available)
  VALUES
    ($1, $2, $3::blood_group, $4, $5, $6, $7, $8::timestamptz, true, true, true)
`;

// Order matters only for readability — CASCADE clears the dependents either way.
const TRUNCATE_SQL = 'TRUNCATE hospital, requester, request, dispatch, pledge, donor CASCADE';

/**
 * A migrated, empty PGlite instance. The session timezone is pinned to UTC for
 * the same reason the E2E harness pins it: `make_interval` day arithmetic and
 * the quiet-hours HOUR extraction both run in the session zone (see
 * matching/eligibility.ts), and production runs UTC.
 */
export async function createDemoDb(): Promise<PGlite> {
  const db = new PGlite();
  await applyMigrations(db);
  await db.exec(`SET TIME ZONE 'UTC'`);
  return db;
}

/** Writes the hospital, the verified requester and the three donors. */
export async function seedDemo(db: SqlClient, now: Date = new Date()): Promise<void> {
  await db.query(INSERT_HOSPITAL_SQL, [
    DEMO_HOSPITAL.hospitalId,
    DEMO_HOSPITAL.name,
    DEMO_HOSPITAL.address,
    DEMO_HOSPITAL.lat,
    DEMO_HOSPITAL.lng,
    DEMO_HOSPITAL.bloodbankPhone,
  ]);
  await db.query(INSERT_REQUESTER_SQL, [
    DEMO_REQUESTER.uid,
    DEMO_HOSPITAL.hospitalId,
    DEMO_REQUESTER.phone,
  ]);
  for (const donor of DEMO_DONORS) {
    await db.query(INSERT_DONOR_SQL, [
      donor.uid,
      donor.handle,
      donor.bloodGroup,
      donor.geohash5,
      donor.tz,
      donor.phone,
      donor.pushToken,
      now.toISOString(),
    ]);
  }
}

/**
 * Back to the opening position: every request, dispatch and pledge the session
 * produced is dropped and the fixtures are rewritten. The PGlite instance is
 * NOT replaced — the app closes over it.
 */
export async function resetDemo(db: DemoDb): Promise<void> {
  await db.exec(TRUNCATE_SQL);
  await seedDemo(db);
}
