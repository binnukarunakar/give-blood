import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { applyMigrations } from './migrate.js';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await applyMigrations(db);
});

afterEach(async () => {
  await db.close();
});

/** noUncheckedIndexedAccess-safe first-row accessor (no `!`, no `any`). */
function firstRow<T>(res: { rows: T[] }): T {
  const row = res.rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

async function names(sqlText: string, column: string): Promise<string[]> {
  const res = await db.query<Record<string, string>>(sqlText);
  return res.rows.map((r) => r[column] ?? '');
}

test('all 6 tables exist', async () => {
  const tables = await names(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    'table_name',
  );
  for (const t of ['hospital', 'donor', 'requester', 'request', 'dispatch', 'pledge']) {
    expect(tables).toContain(t);
  }
});

test('all 6 enums exist', async () => {
  const enums = await names(`SELECT typname FROM pg_type WHERE typtype = 'e'`, 'typname');
  for (const e of [
    'blood_group',
    'request_urgency',
    'request_state',
    'dispatch_response',
    'pledge_state',
    'eta_bucket',
  ]) {
    expect(enums).toContain(e);
  }
});

test('all 4 load-bearing indexes exist', async () => {
  const indexes = await names(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    'indexname',
  );
  for (const i of [
    'dispatch_request_donor_uq',
    'pledge_one_active_per_donor',
    'donor_pool',
    'request_state_idx',
  ]) {
    expect(indexes).toContain(i);
  }
});

test('migration 0002 applied: firebase_uid columns exist and are NOT NULL', async () => {
  const cols = await db.query<{ table_name: string; is_nullable: string }>(
    `SELECT table_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'firebase_uid'
     ORDER BY table_name`,
  );
  expect(cols.rows).toEqual([
    { table_name: 'donor', is_nullable: 'NO' },
    { table_name: 'requester', is_nullable: 'NO' },
  ]);
});

test('duplicate donor firebase_uid rejected', async () => {
  await seedCoreRows(); // seeds a donor with firebase_uid 'uid_donor_1'
  await expect(
    db.query(
      `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, opted_in, available)
       VALUES ('uid_donor_1', 'other', 'O-', 'dr5ru', 'America/New_York', 'DONOR_PHONE', true, true)`,
    ),
  ).rejects.toThrow();
});

test('duplicate requester firebase_uid rejected', async () => {
  const { hospitalId } = await seedCoreRows(); // seeds a requester with firebase_uid 'uid_requester_1'
  await expect(
    db.query(
      `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
       VALUES ('uid_requester_1', false, $1, 'REQUESTER_PHONE')`,
      [hospitalId],
    ),
  ).rejects.toThrow();
});

test('donor insert without push_token succeeds — null until browser grants push permission', async () => {
  const res = await db.query<{ donor_id: string; push_token: string | null }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, opted_in, available)
     VALUES ('uid_no_push', 'no-push-yet', 'O-', 'dr5ru', 'America/New_York', 'DONOR_PHONE', true, false)
     RETURNING donor_id, push_token`,
  );
  const row = firstRow(res);
  expect(row.donor_id).toBeTruthy();
  expect(row.push_token).toBeNull();
});

interface Seeded {
  hospitalId: string;
  donorId: string;
  requestId: string;
}

async function seedCoreRows(): Promise<Seeded> {
  const hospital = await db.query<{ hospital_id: string }>(
    `INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
     VALUES ('City Hospital', '1 Main St', 40.712800, -74.006000, 'HOSPITAL_BLOODBANK_PHONE')
     RETURNING hospital_id`,
  );
  const hospitalId = firstRow(hospital).hospital_id;

  const donor = await db.query<{ donor_id: string }>(
    `INSERT INTO donor (firebase_uid, handle, blood_group, geohash5, tz, phone, push_token, opted_in, available)
     VALUES ('uid_donor_1', 'anon', 'B+', 'dr5ru', 'America/New_York', 'DONOR_PHONE', 'tok_1', true, true)
     RETURNING donor_id`,
  );
  const donorId = firstRow(donor).donor_id;

  const requester = await db.query<{ requester_id: string }>(
    `INSERT INTO requester (firebase_uid, verified, hospital_id, phone)
     VALUES ('uid_requester_1', true, $1, 'REQUESTER_PHONE') RETURNING requester_id`,
    [hospitalId],
  );
  const requesterId = firstRow(requester).requester_id;

  const request = await db.query<{ request_id: string }>(
    `INSERT INTO request (requester_id, hospital_id, blood_group, units_needed, urgency, expires_at)
     VALUES ($1, $2, 'B+', 2, 'critical', now() + interval '6 hours')
     RETURNING request_id`,
    [requesterId, hospitalId],
  );
  const requestId = firstRow(request).request_id;

  return { hospitalId, donorId, requestId };
}

test('dispatch is unique per (request_id, donor_id) — second insert fails', async () => {
  const { donorId, requestId } = await seedCoreRows();

  await db.query(
    `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1, $2, 0)`,
    [requestId, donorId],
  );

  await expect(
    db.query(
      `INSERT INTO dispatch (request_id, donor_id, radius_tier_at_send) VALUES ($1, $2, 1)`,
      [requestId, donorId],
    ),
  ).rejects.toThrow();
});

test('at most one active pledge per donor; a released pledge is exempt', async () => {
  const { donorId, requestId } = await seedCoreRows();

  // First active pledge — succeeds.
  await db.query(
    `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket)
     VALUES ($1, $2, 'anon', 'B+', 'le_1h')`,
    [requestId, donorId],
  );

  // Second active pledge for the same donor — violates the partial unique index.
  await expect(
    db.query(
      `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket)
       VALUES ($1, $2, 'anon', 'B+', 'le_2h')`,
      [requestId, donorId],
    ),
  ).rejects.toThrow();

  // A 'released' pledge for the same donor — excluded by WHERE state='active', so it succeeds.
  await expect(
    db.query(
      `INSERT INTO pledge (request_id, donor_id, donor_handle, donor_blood_group, eta_bucket, state)
       VALUES ($1, $2, 'anon', 'B+', 'le_2h', 'released')`,
      [requestId, donorId],
    ),
  ).resolves.toBeDefined();
});
