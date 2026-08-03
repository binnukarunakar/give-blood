import ngeohash from 'ngeohash';
import { describe, expect, test } from 'vitest';
import {
  coverCells,
  GEOHASH_PRECISION,
  haversineKm,
  RADIUS_TIERS_KM,
  tzForGeohash,
} from './geo.js';

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'; // base32, no a/i/l/o
const KM_PER_DEG_LAT = 111.32;

// Real-world query points (hospital-scale). Manhattan, a Dallas suburb
// (Richardson TX), London — spread across latitudes and hemispheres.
const PLACES = [
  { name: 'Manhattan', lat: 40.758, lng: -73.9855 },
  { name: 'Richardson TX', lat: 32.9483, lng: -96.7299 },
  { name: 'London', lat: 51.5074, lng: -0.1278 },
] as const;

function isValidCell(cell: string): boolean {
  return (
    cell.length === GEOHASH_PRECISION && [...cell].every((ch) => GEOHASH_ALPHABET.includes(ch))
  );
}

/** Offset a coordinate due north by `km` (pure latitude shift). */
function offsetNorth(lat: number, km: number): number {
  return lat + km / KM_PER_DEG_LAT;
}

describe('constants', () => {
  test('geohash precision is 5 and tiers are 5/10/25', () => {
    expect(GEOHASH_PRECISION).toBe(5);
    expect(RADIUS_TIERS_KM).toEqual([5, 10, 25]);
  });
});

describe('coverCells — monotonicity across tiers', () => {
  for (const { name, lat, lng } of PLACES) {
    test(`${name}: set(5km) ⊆ set(10km) ⊆ set(25km)`, () => {
      const s5 = new Set(coverCells(lat, lng, 5));
      const s10 = new Set(coverCells(lat, lng, 10));
      const s25 = new Set(coverCells(lat, lng, 25));
      for (const cell of s5) expect(s10.has(cell)).toBe(true);
      for (const cell of s10) expect(s25.has(cell)).toBe(true);
      // strict growth (radius genuinely widens the cover)
      expect(s10.size).toBeGreaterThan(s5.size);
      expect(s25.size).toBeGreaterThan(s10.size);
    });
  }
});

describe('coverCells — output shape', () => {
  for (const { name, lat, lng } of PLACES) {
    test(`${name}: every tier returns unique, valid 5-char cells`, () => {
      for (const radius of RADIUS_TIERS_KM) {
        const cells = coverCells(lat, lng, radius);
        expect(new Set(cells).size).toBe(cells.length); // unique
        for (const cell of cells) expect(isValidCell(cell)).toBe(true);
      }
    });

    test(`${name}: the query point's own cell is always in the cover`, () => {
      const originCell = ngeohash.encode(lat, lng, GEOHASH_PRECISION);
      for (const radius of RADIUS_TIERS_KM) {
        expect(coverCells(lat, lng, radius)).toContain(originCell);
      }
    });
  }
});

describe('coverCells — 25 km cover size is sane', () => {
  // DATA_MODEL.md estimates ~80–90 intersecting cells; the tolerance rule that
  // guarantees no edge cell is dropped adds a ring, so allow up to 200.
  for (const { name, lat, lng } of PLACES) {
    test(`${name}: 25 km cover has > 25 and < 200 cells`, () => {
      const size = coverCells(lat, lng, 25).length;
      expect(size).toBeGreaterThan(25);
      expect(size).toBeLessThan(200);
    });
  }
});

describe('coverCells — no runaway over-inclusion / no under-cover', () => {
  const { lat, lng } = PLACES[0]; // Manhattan

  test('a cell ~30 km away is NOT in the 25 km cover', () => {
    const farLat = offsetNorth(lat, 30);
    const farCell = ngeohash.encode(farLat, lng, GEOHASH_PRECISION);
    // sanity: the far cell's centroid really is beyond the 25 km tier
    const c = ngeohash.decode(farCell);
    expect(haversineKm(lat, lng, c.latitude, c.longitude)).toBeGreaterThan(25);
    expect(coverCells(lat, lng, 25)).not.toContain(farCell);
  });

  test('a donor cell ~4 km away IS in the 5 km cover', () => {
    const nearLat = offsetNorth(lat, 4);
    const nearCell = ngeohash.encode(nearLat, lng, GEOHASH_PRECISION);
    expect(haversineKm(lat, lng, nearLat, lng)).toBeLessThan(5);
    expect(coverCells(lat, lng, 5)).toContain(nearCell);
  });
});

describe('haversineKm', () => {
  test('NYC → LA is ~3936 km (within 1%)', () => {
    const d = haversineKm(40.758, -73.9855, 34.0522, -118.2437);
    expect(d).toBeGreaterThan(3900);
    expect(d).toBeLessThan(3980);
  });

  test('zero distance to self', () => {
    expect(haversineKm(51.5074, -0.1278, 51.5074, -0.1278)).toBe(0);
  });
});

describe('tzForGeohash', () => {
  test('an NYC-area geohash resolves to America/New_York', () => {
    const nycCell = ngeohash.encode(40.758, -73.9855, GEOHASH_PRECISION); // 'dr5ru'
    expect(tzForGeohash(nycCell)).toBe('America/New_York');
  });

  test('an LA-area geohash resolves to America/Los_Angeles', () => {
    const laCell = ngeohash.encode(34.0522, -118.2437, GEOHASH_PRECISION); // '9q5ct'
    expect(tzForGeohash(laCell)).toBe('America/Los_Angeles');
  });
});

describe('input validation — throws TypeError', () => {
  test('latitude out of range (91)', () => {
    expect(() => coverCells(91, 0, 5)).toThrow(TypeError);
    expect(() => haversineKm(91, 0, 0, 0)).toThrow(TypeError);
  });

  test('longitude out of range (181)', () => {
    expect(() => coverCells(0, 181, 5)).toThrow(TypeError);
  });

  test('non-positive radius (0 and negative)', () => {
    expect(() => coverCells(40.758, -73.9855, 0)).toThrow(TypeError);
    expect(() => coverCells(40.758, -73.9855, -5)).toThrow(TypeError);
  });

  test('non-finite inputs', () => {
    expect(() => coverCells(Number.NaN, 0, 5)).toThrow(TypeError);
    expect(() => coverCells(0, 0, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  test('invalid geohash cell (wrong length)', () => {
    expect(() => tzForGeohash('zzzzzz')).toThrow(TypeError); // 6 chars
    expect(() => tzForGeohash('abc')).toThrow(TypeError); // 3 chars
  });

  test('invalid geohash cell (bad alphabet, right length)', () => {
    // 'a', 'i', 'l', 'o' are not in the base32 geohash alphabet
    expect(() => tzForGeohash('ailoa')).toThrow(TypeError);
  });
});
