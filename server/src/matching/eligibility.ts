// Donor eligibility predicate — canonical: docs/DATA_MODEL.md
// § "Donor eligibility predicate"; quiet-hours tempo: docs/PROTOCOL.md §5.
//
// The compatible donor groups (COMPAT) and the geohash cover are computed in
// TypeScript and passed as array parameters; every remaining gate is enforced
// by ONE parameterized SQL statement — no string-built SQL branches. Urgency
// enters as a boolean parameter (critical pierces quiet hours), so the
// statement text is identical for every call.
import { toPgArrayLiteral } from '../db/pgArray.js';
import { compatibleDonorGroups, type BloodGroup } from './compatibility.js';
import { coverCellsWithDistance, RADIUS_TIERS_KM } from './geo.js';

/** Whole-blood cooldown, US standard (PROTOCOL.md §8). Exactly 56 elapsed days = eligible again. */
export const DONATION_COOLDOWN_DAYS = 56;

/** Quiet hours, donor-local (PROTOCOL.md §8): blocked from 22:00 (inclusive) to 07:00 (exclusive). */
export const QUIET_HOURS = { start: 22, end: 7 } as const;

/** Minimal SQL client — structurally satisfied by both PGlite and pg.Pool. */
export interface SqlClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface EligibleDonorsArgs {
  /** The REQUEST's blood group; acceptable donor groups are derived from it. */
  bloodGroup: BloodGroup;
  hospitalLat: number;
  hospitalLng: number;
  /** Index into RADIUS_TIERS_KM (5 / 10 / 25 km). */
  tierIdx: 0 | 1 | 2;
  urgency: 'critical' | 'standard';
  /** Enables the never-re-page anti-join; null skips it (no request context). */
  requestId: string | null;
  now: Date;
}

export interface EligibleDonor {
  donorId: string;
  bloodGroup: BloodGroup;
  geohash5: string;
  /** Non-null guaranteed by the SQL gate. */
  pushToken: string;
  lastAlertedAt: Date | null;
}

interface EligibleDonorRow {
  donor_id: string;
  blood_group: BloodGroup;
  geohash5: string;
  push_token: string;
  last_alerted_at: Date | null;
}

// Parameters (no magic numbers in the SQL — all named constants enter here):
//   $1 now (timestamptz)      $2 DONATION_COOLDOWN_DAYS   $3 compatible donor groups
//   $4 cover cells            $5 pierces quiet hours      $6 QUIET_HOURS.start
//   $7 QUIET_HOURS.end        $8 request id (nullable)    $9 per-cell nearest km
// $4 and $9 are PARALLEL arrays built together by coverCellsWithDistance, so
// unnest pairs each cell with its own distance. That join replaces the old
// `geohash5 = ANY($4)` membership test and is what lets the donor's chosen
// travel radius be compared against how far away they are (GB-35).
//
// $9 is the NEAREST-POINT distance, not the centroid. A ~4.9 km cell puts a
// donor up to ~3.46 km either side of its centroid, so gating on the centroid
// dropped donors who were inside the range they agreed to — a cell centred
// 7.46 km out can hold a donor 4.46 km from the hospital, and a "5 km" donor
// there was never alerted. The nearest point is the floor for the whole cell,
// so this clause excludes only donors who certainly will not travel far
// enough. Erring toward including them costs one decline; erring the other way
// means a willing donor minutes away never hears about the request.
// Note: `timestamptz - make_interval(days => n)` does day arithmetic in the
// SESSION timezone. Run servers (and test sessions) on UTC / a fixed-offset
// zone so the 56-day boundary is exact across DST transitions.
const ELIGIBLE_SQL = `
  SELECT d.donor_id, d.blood_group, d.geohash5, d.push_token, d.last_alerted_at
  FROM donor d
  JOIN unnest($4::text[], $9::numeric[]) AS cover(cell, nearest_km)
    ON cover.cell = d.geohash5
  WHERE d.opted_in
    AND d.available
    AND d.push_verified_at IS NOT NULL
    AND d.push_token IS NOT NULL -- verified donor whose token was since cleared must not match
    AND (d.snooze_until IS NULL OR d.snooze_until < $1::timestamptz)
    AND (d.last_donation_at IS NULL
         OR d.last_donation_at <= $1::timestamptz - make_interval(days => $2::int))
    AND d.blood_group = ANY($3::blood_group[])
    AND d.travel_radius_km >= cover.nearest_km -- donor's own "how far I will go"
    AND ($5::boolean
         OR NOT (EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE d.tz)) >= $6::int
                 OR EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE d.tz)) < $7::int))
    AND NOT EXISTS (SELECT 1
                    FROM pledge p
                    WHERE p.donor_id = d.donor_id AND p.state = 'active')
    AND ($8::uuid IS NULL
         OR NOT EXISTS (SELECT 1
                        FROM dispatch dp
                        WHERE dp.request_id = $8::uuid AND dp.donor_id = d.donor_id))
  ORDER BY d.donor_id
`;

/**
 * All donors eligible for a request at the given radius tier, per the
 * DATA_MODEL.md predicate. Deterministic ORDER BY donor_id — ranking is a
 * later ticket.
 */
export async function eligibleDonors(
  db: SqlClient,
  args: EligibleDonorsArgs,
): Promise<EligibleDonor[]> {
  const donorGroups = compatibleDonorGroups(args.bloodGroup);
  const cover = coverCellsWithDistance(
    args.hospitalLat,
    args.hospitalLng,
    RADIUS_TIERS_KM[args.tierIdx],
  );
  const { rows } = await db.query<EligibleDonorRow>(ELIGIBLE_SQL, [
    args.now.toISOString(),
    DONATION_COOLDOWN_DAYS,
    toPgArrayLiteral(donorGroups),
    toPgArrayLiteral(cover.map((c) => c.cell)),
    args.urgency === 'critical',
    QUIET_HOURS.start,
    QUIET_HOURS.end,
    args.requestId,
    // Parallel to $4 — same order, one nearest-point distance per cell.
    toPgArrayLiteral(cover.map((c) => c.nearestKm.toFixed(4))),
  ]);
  return rows.map((r) => ({
    donorId: r.donor_id,
    bloodGroup: r.blood_group,
    geohash5: r.geohash5,
    pushToken: r.push_token,
    lastAlertedAt: r.last_alerted_at,
  }));
}
