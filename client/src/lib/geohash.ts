// Geohash encoding — runs in the page, never against a network.
//
// PRIVACY INVARIANT (docs/TRUST_PRIVACY.md): a donor's
// exact coordinates never leave the browser. Whatever the map tap or the manual
// form produces is truncated HERE, on device, to a 5-character cell
// (~4.9 x 4.9 km), and only that cell is ever placed in a request body. No
// caller may pass raw lat/lng to the API.
//
// Standard geohash: bisect longitude and latitude alternately, starting with
// longitude; every five bits become one base-32 character.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const BITS_PER_CHAR = 5;

export const GEOHASH_PRECISION = 5;

const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

/** Human-readable reason the pair is unusable, or null when it is a valid point. */
export function coordinateProblem(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return 'Enter a number for both latitude and longitude.';
  }
  if (lat < LAT_MIN || lat > LAT_MAX) {
    return 'Latitude must be between -90 and 90.';
  }
  if (lng < LNG_MIN || lng > LNG_MAX) {
    return 'Longitude must be between -180 and 180.';
  }
  return null;
}

/**
 * The 5-character geohash cell containing the point. Throws on an out-of-range
 * pair rather than encoding nonsense — callers validate with
 * `coordinateProblem` first and show the message.
 */
export function encodeGeohash5(lat: number, lng: number): string {
  const problem = coordinateProblem(lat, lng);
  if (problem !== null) {
    throw new RangeError(problem);
  }

  let latLow = LAT_MIN;
  let latHigh = LAT_MAX;
  let lngLow = LNG_MIN;
  let lngHigh = LNG_MAX;

  let hash = '';
  let bits = 0;
  let value = 0;
  let splitLng = true;

  while (hash.length < GEOHASH_PRECISION) {
    if (splitLng) {
      const mid = (lngLow + lngHigh) / 2;
      if (lng >= mid) {
        value = value * 2 + 1;
        lngLow = mid;
      } else {
        value *= 2;
        lngHigh = mid;
      }
    } else {
      const mid = (latLow + latHigh) / 2;
      if (lat >= mid) {
        value = value * 2 + 1;
        latLow = mid;
      } else {
        value *= 2;
        latHigh = mid;
      }
    }
    splitLng = !splitLng;
    bits += 1;
    if (bits === BITS_PER_CHAR) {
      hash += BASE32.charAt(value);
      bits = 0;
      value = 0;
    }
  }

  return hash;
}

/** Shape check for a stored or typed cell — the server validates authoritatively. */
export function isGeohash5(value: string): boolean {
  if (value.length !== GEOHASH_PRECISION) return false;
  for (const char of value) {
    if (!BASE32.includes(char)) return false;
  }
  return true;
}
