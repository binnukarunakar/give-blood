import ngeohash from 'ngeohash';
import tzLookup from 'tz-lookup';

/**
 * Geohash cover + timezone derivation for donor matching.
 *
 * Canonical (docs/DATA_MODEL.md, "Geo-indexing"): a donor location is a
 * geohash precision-5 cell (~4.9 x 4.9 km); matching enumerates the
 * precision-5 cells intersecting a radius circle around the hospital and
 * filters donors by `geohash5 IN cover(...)`. Radius ladder: 5 / 10 / 25 km.
 *
 * Pure functions only: no DB, no I/O.
 */

export const GEOHASH_PRECISION = 5;
export const RADIUS_TIERS_KM = [5, 10, 25] as const;

/**
 * What a donor may choose as "how far I will travel" (GB-35). Deliberately the
 * same ladder as RADIUS_TIERS_KM: the donor's answer is compared against the
 * distance to their cell, and the request's tier controls WHEN a farther donor
 * becomes reachable, so keeping one set of numbers keeps both legible.
 */
export const TRAVEL_RADII_KM = RADIUS_TIERS_KM;
export type TravelRadiusKm = (typeof TRAVEL_RADII_KM)[number];

export function isTravelRadiusKm(value: unknown): value is TravelRadiusKm {
  return TRAVEL_RADII_KM.includes(value as TravelRadiusKm);
}

/** A cover cell with its distance from the hospital, centroid and nearest-point. */
export interface CoverCell {
  cell: string;
  /** Centroid distance in km. Coarse by construction: the cell is ~4.9 km across. */
  distanceKm: number;
  /**
   * Distance in km from the hospital to the NEAREST point of the cell — i.e. the
   * smallest distance any donor in this cell can possibly be from the hospital.
   *
   * This, not `distanceKm`, is what a donor's chosen travel radius is compared
   * against (GB-35). Gating on the centroid silently excluded willing donors: a
   * cell whose centroid is 7.46 km out can hold a donor 4.46 km from the
   * hospital, so a donor who answered "I will travel 5 km" was never alerted
   * even though they were well inside their own stated range. Gating on the
   * nearest point asks the answerable question — COULD this donor be within the
   * distance they agreed to? — and so excludes only donors who certainly are
   * not. It keeps the same bias the cover itself is built around (see
   * `coverCells`): over-include and let the donor decline, never silently drop
   * someone who would have come.
   */
  nearestKm: number;
}

// Precision-5 geohash = 25 bits, split 13 longitude / 12 latitude. So a cell
// spans 360/2^13 deg in longitude and 180/2^12 deg in latitude.
const GEOHASH5_LAT_BITS = 12;
const GEOHASH5_LNG_BITS = 13;

// Kilometers per degree. 111.32 is the mean for latitude and the equatorial
// value for longitude (cos 0 = 1) — i.e. the MAX km/deg longitude anywhere.
// Using it for both cell dimensions makes CELL_DIAGONAL_KM a strict global
// upper bound on the true cell diagonal (max true diagonal ~6.90 km, at the
// equator). That direction matters: the tolerance must never UNDER-estimate
// the cell size, or an intersecting edge cell could be dropped and donors
// silently lost. Over-estimating only over-covers, which is safe.
const KM_PER_DEG = 111.32;

const CELL_HEIGHT_KM = (180 / 2 ** GEOHASH5_LAT_BITS) * KM_PER_DEG; // ~4.89
const CELL_WIDTH_KM = (360 / 2 ** GEOHASH5_LNG_BITS) * KM_PER_DEG; // ~4.89 (equatorial max)

/** Upper bound on a precision-5 cell's diagonal in km (~6.92). */
const CELL_DIAGONAL_KM = Math.hypot(CELL_HEIGHT_KM, CELL_WIDTH_KM);

const EARTH_RADIUS_KM = 6371;
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'; // base32, no a/i/l/o
const MIN_COS_LAT = 0.01; // clamps the longitude margin from blowing up near the poles

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in km. Internal: assumes inputs already validated. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function assertLatLng(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new TypeError(`latitude out of range [-90, 90]: ${lat}`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new TypeError(`longitude out of range [-180, 180]: ${lng}`);
  }
}

function isValidGeohash5(cell: string): boolean {
  if (typeof cell !== 'string' || cell.length !== GEOHASH_PRECISION) {
    return false;
  }
  for (const ch of cell) {
    if (!GEOHASH_ALPHABET.includes(ch)) {
      return false;
    }
  }
  return true;
}

/**
 * Haversine great-circle distance between two points, in km.
 * Exported for reuse by dispatch ranking (least-distance tiebreaks).
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  assertLatLng(lat1, lng1);
  assertLatLng(lat2, lng2);
  return distanceKm(lat1, lng1, lat2, lng2);
}

/**
 * Distance in km from (lat, lng) to the nearest point of `cell`'s bounding box.
 * Zero when the point is inside the cell.
 *
 * The cell is a lat/lng rectangle, so the nearest point is found by clamping
 * each coordinate into the cell's range. At a ~4.9 km cell size the difference
 * between that and the true great-circle nearest point is sub-metre.
 */
function nearestPointKm(lat: number, lng: number, cell: string): number {
  const [minLat, minLng, maxLat, maxLng] = ngeohash.decode_bbox(cell);
  const nLat = Math.min(Math.max(lat, minLat), maxLat);
  const nLng = Math.min(Math.max(lng, minLng), maxLng);
  return distanceKm(lat, lng, nLat, nLng);
}

/**
 * All precision-5 geohash cells intersecting the circle of `radiusKm` around
 * (lat, lng).
 *
 * Method: enumerate candidate cells over a bounding box (padded by radius +
 * one full cell diagonal so no qualifying cell falls outside it), then keep a
 * cell iff its centroid is within `radiusKm + CELL_DIAGONAL_KM / 2` of the
 * point. Because a cell intersects the circle only if its nearest point is
 * within radiusKm, and its centroid is at most half a diagonal beyond that,
 * this predicate keeps EVERY intersecting cell (under-cover is impossible).
 * It may keep a few non-intersecting cells; over-cover only adds candidates
 * downstream, which is safe.
 */
export function coverCells(lat: number, lng: number, radiusKm: number): string[] {
  return coverCellsWithDistance(lat, lng, radiusKm).map((c) => c.cell);
}

/**
 * `coverCells` plus, for each cell, its centroid distance from (lat, lng) and
 * the distance to its nearest point.
 *
 * Both are computed here — once, beside the cover — rather than re-derived by
 * the caller. They answer different questions and are not interchangeable:
 *
 *   distanceKm  centroid: a single representative number for the cell. Coarse
 *               by construction — a donor anywhere in the cell is within
 *               ~3.46 km (half a diagonal) either side of it.
 *   nearestKm   the floor: no donor in this cell can be closer than this. What
 *               the donor's chosen travel radius is gated on (GB-35), because
 *               it is the only one of the two that cannot exclude a donor who
 *               is genuinely inside the range they agreed to.
 *
 * The ~3.46 km spread is why the travel radii are a coarse 5/10/25 ladder
 * rather than a fine slider: a finer control would imply a precision that a
 * ~4.9 km cell does not carry.
 */
export function coverCellsWithDistance(lat: number, lng: number, radiusKm: number): CoverCell[] {
  assertLatLng(lat, lng);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new TypeError(`radiusKm must be > 0: ${radiusKm}`);
  }

  const marginKm = radiusKm + CELL_DIAGONAL_KM;
  const latDelta = marginKm / KM_PER_DEG;
  const cosLat = Math.max(Math.cos(toRadians(lat)), MIN_COS_LAT);
  const lngDelta = marginKm / (KM_PER_DEG * cosLat);

  const minLat = Math.max(lat - latDelta, -90);
  const maxLat = Math.min(lat + latDelta, 90);
  const minLng = Math.max(lng - lngDelta, -180);
  const maxLng = Math.min(lng + lngDelta, 180);

  const candidates = ngeohash.bboxes(minLat, minLng, maxLat, maxLng, GEOHASH_PRECISION);
  const keepThresholdKm = radiusKm + CELL_DIAGONAL_KM / 2;

  const byCell = new Map<string, CoverCell>();
  for (const cell of candidates) {
    const { latitude, longitude } = ngeohash.decode(cell);
    const d = distanceKm(lat, lng, latitude, longitude);
    if (d <= keepThresholdKm) {
      byCell.set(cell, { cell, distanceKm: d, nearestKm: nearestPointKm(lat, lng, cell) });
    }
  }
  return [...byCell.values()];
}

/**
 * IANA timezone for a precision-5 geohash cell: decode the cell centroid and
 * look it up. Enables donor-local quiet-hours computation (DATA_MODEL: Donor.tz
 * is "derived from geohash5 at write").
 */
export function tzForGeohash(cell: string): string {
  if (!isValidGeohash5(cell)) {
    throw new TypeError(`not a valid 5-char geohash: ${cell}`);
  }
  const { latitude, longitude } = ngeohash.decode(cell);
  return tzLookup(latitude, longitude);
}
