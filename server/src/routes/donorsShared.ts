// Shared shapes for the donor endpoints (GB-8). Split out of donors.ts so that
// file stays under the 300-line ceiling: this module owns the zod contracts,
// the donor-view projection (the exact GET/PATCH response), and the dynamic —
// but still fully parameterized — PATCH update builder.
//
// Canonical field semantics: docs/DATA_MODEL.md § Donor. The projection here is
// the ONLY donor shape that leaves the server, and it deliberately omits
// push_token (a delivery address, never displayed) and firebase_uid (auth
// linkage) — see TRUST_PRIVACY.md.
import { z } from 'zod';
import type { RequestState } from '../domain/requestFsm.js';
import { BLOOD_GROUPS, type BloodGroup } from '../matching/compatibility.js';
import { TRAVEL_RADII_KM, type TravelRadiusKm } from '../matching/geo.js';

/** handle is 1..40 chars; the display name / pseudonym (DATA_MODEL: Donor.handle). */
const HANDLE_MIN = 1;
const HANDLE_MAX = 40;
const handleSchema = z.string().min(HANDLE_MIN).max(HANDLE_MAX);
const bloodGroupSchema = z.enum(BLOOD_GROUPS);

/**
 * "How far will you travel?" — one of the RADIUS_TIERS_KM rungs (GB-35). Mirrors
 * the DB CHECK, so a bad value is a 400 here rather than a 23514 from Postgres.
 */
const travelRadiusSchema = z.union(
  TRAVEL_RADII_KM.map((km) => z.literal(km)) as [
    z.ZodLiteral<TravelRadiusKm>,
    z.ZodLiteral<TravelRadiusKm>,
    ...z.ZodLiteral<TravelRadiusKm>[],
  ],
);

/** Widest rung: the pre-GB-35 behaviour, and the migration's column default. */
export const DEFAULT_TRAVEL_RADIUS_KM: TravelRadiusKm = 25;

// POST /donors body. `consent` is the opted_in gate made explicit — it must be
// the literal `true` (DATA_MODEL: consent has exactly one owner, the donor; no
// silent opt-in). geohash5 is validated for real by tzForGeohash at the route.
export const registerSchema = z.object({
  handle: handleSchema,
  bloodGroup: bloodGroupSchema,
  geohash5: z.string(),
  consent: z.literal(true),
  // Optional: an older client that does not send it keeps the widest reach.
  travelRadiusKm: travelRadiusSchema.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

// PATCH /donors/me body — every field optional (partial update). snoozeUntil is
// an ISO timestamp OR explicit null (donor clears the mute). Unknown keys are
// stripped by zod, so an all-unknown body reduces to `{}` and is rejected as
// empty at the route.
export const patchSchema = z.object({
  handle: handleSchema.optional(),
  available: z.boolean().optional(),
  optedIn: z.boolean().optional(),
  snoozeUntil: z.union([z.iso.datetime(), z.null()]).optional(),
  sharePhoneOnAccept: z.boolean().optional(),
  geohash5: z.string().optional(),
  bloodGroup: bloodGroupSchema.optional(),
  travelRadiusKm: travelRadiusSchema.optional(),
});
export type PatchInput = z.infer<typeof patchSchema>;

/** PUT /donors/me/push-token body — a non-empty FCM registration token. */
export const pushTokenSchema = z.object({ token: z.string().min(1) });

/** POST /donors/me/donations body — optional self-reported donation instant. */
export const donationSchema = z.object({ donatedAt: z.iso.datetime().optional() });

/** Flatten zod issues into a stable `{ path, message }[]` for 400 responses. */
export function summarizeIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

// The exact column list backing the donor view — reused by the GET select and
// every UPDATE ... RETURNING so GET and PATCH return byte-identical shapes.
// push_token and firebase_uid are deliberately absent.
export const DONOR_VIEW_COLUMNS = `
  donor_id, handle, blood_group, geohash5, tz, opted_in, available,
  snooze_until, share_phone_on_accept, push_verified_at, last_donation_at,
  travel_radius_km
`;

export interface DonorViewRow {
  donor_id: string;
  handle: string;
  blood_group: BloodGroup;
  geohash5: string;
  tz: string;
  opted_in: boolean;
  available: boolean;
  snooze_until: Date | null;
  share_phone_on_accept: boolean;
  push_verified_at: Date | null;
  last_donation_at: Date | null;
  /** smallint — pg may hand this back as a string depending on the driver. */
  travel_radius_km: number | string;
}

export interface DonorView {
  donorId: string;
  handle: string;
  bloodGroup: BloodGroup;
  geohash5: string;
  tz: string;
  optedIn: boolean;
  available: boolean;
  snoozeUntil: string | null;
  sharePhoneOnAccept: boolean;
  pushVerified: boolean;
  lastDonationAt: string | null;
  travelRadiusKm: TravelRadiusKm;
}

/**
 * Project a donor row into the wire shape. `pushVerified` collapses the
 * push_verified_at timestamp to a boolean (ARCHITECTURE: verification, not the
 * ack instant, is what the client needs); push_token is never sourced here.
 */
export function toDonorView(row: DonorViewRow): DonorView {
  return {
    donorId: row.donor_id,
    handle: row.handle,
    bloodGroup: row.blood_group,
    geohash5: row.geohash5,
    tz: row.tz,
    optedIn: row.opted_in,
    available: row.available,
    snoozeUntil: row.snooze_until === null ? null : row.snooze_until.toISOString(),
    sharePhoneOnAccept: row.share_phone_on_accept,
    pushVerified: row.push_verified_at !== null,
    lastDonationAt: row.last_donation_at === null ? null : row.last_donation_at.toISOString(),
    travelRadiusKm: toTravelRadius(row.travel_radius_km),
  };
}

/**
 * Narrow the smallint column back onto the ladder. The DB CHECK already
 * guarantees membership, so an off-ladder value means the constraint was
 * dropped or the column was written around; fall back to the widest rung rather
 * than emitting a value the client's type does not admit.
 */
function toTravelRadius(value: number | string): TravelRadiusKm {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return TRAVEL_RADII_KM.includes(n as TravelRadiusKm)
    ? (n as TravelRadiusKm)
    : DEFAULT_TRAVEL_RADIUS_KM;
}

// The caller's one ACTIVE pledge, with the dispatch id needed to reopen the
// alert it belongs to (GB-32: a reload must not lose the pledge — the donor's
// only route back to "you pledged" was in-memory client state). The partial
// unique index pledge_one_active_per_donor caps this at one row; LIMIT 1 makes
// that explicit. The LEFT JOIN keeps the pledge visible even if its dispatch row
// were ever missing (impossible by construction — a pledge exists iff its
// dispatch was accepted) instead of hiding the pledge entirely. Nothing here
// crosses a privacy line: it is the caller's own row, keyed by their own uid.
export const ACTIVE_PLEDGE_VIEW_SQL = `
  SELECT p.pledge_id AS pledge_id, r.state AS request_state, dp.dispatch_id AS dispatch_id
  FROM pledge p
  JOIN donor d   ON d.donor_id = p.donor_id
  JOIN request r ON r.request_id = p.request_id
  LEFT JOIN dispatch dp ON dp.request_id = p.request_id AND dp.donor_id = p.donor_id
  WHERE d.firebase_uid = $1 AND p.state = 'active'
  LIMIT 1
`;

export interface ActivePledgeRow {
  pledge_id: string;
  request_state: RequestState;
  dispatch_id: string | null;
}

export interface ActivePledgeView {
  pledgeId: string;
  /** The donor's own dispatch id — what GET /alerts/:alertId takes. */
  alertId: string | null;
  requestState: RequestState;
}

/** Project the active-pledge row, or null when the donor holds no active pledge. */
export function toActivePledge(row: ActivePledgeRow | undefined): ActivePledgeView | null {
  if (row === undefined) return null;
  return {
    pledgeId: row.pledge_id,
    alertId: row.dispatch_id,
    requestState: row.request_state,
  };
}

/**
 * Build the SET assignments + ordered params for a PATCH. Column names are a
 * fixed allowlist (never client input); only values are bound ($1..$n), so this
 * is fully parameterized. When geohash5 changes, tz (pre-derived by the caller
 * via tzForGeohash) is set in the SAME statement — geohash5 and tz update
 * atomically (DATA_MODEL: tz is derived from geohash5 at write). Returns null
 * when there is nothing to update.
 */
export function buildDonorUpdate(
  patch: PatchInput,
  derivedTz: string | undefined,
): { assignments: string[]; params: unknown[] } | null {
  const assignments: string[] = [];
  const params: unknown[] = [];
  const set = (columnExpr: string, value: unknown): void => {
    params.push(value);
    assignments.push(columnExpr.replace('?', `$${params.length}`));
  };

  if (patch.handle !== undefined) set('handle = ?', patch.handle);
  if (patch.available !== undefined) set('available = ?', patch.available);
  if (patch.optedIn !== undefined) set('opted_in = ?', patch.optedIn);
  if (patch.snoozeUntil !== undefined) set('snooze_until = ?::timestamptz', patch.snoozeUntil);
  if (patch.sharePhoneOnAccept !== undefined)
    set('share_phone_on_accept = ?', patch.sharePhoneOnAccept);
  if (patch.bloodGroup !== undefined) set('blood_group = ?::blood_group', patch.bloodGroup);
  if (patch.travelRadiusKm !== undefined) set('travel_radius_km = ?::smallint', patch.travelRadiusKm);
  if (patch.geohash5 !== undefined) {
    set('geohash5 = ?', patch.geohash5);
    // derivedTz is guaranteed present when geohash5 is (caller derives it first).
    set('tz = ?', derivedTz);
  }

  return assignments.length === 0 ? null : { assignments, params };
}
