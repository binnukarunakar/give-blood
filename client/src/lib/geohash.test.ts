import { describe, expect, it } from 'vitest';
import { coordinateProblem, encodeGeohash5, isGeohash5 } from './geohash';

// Vectors cross-checked against the server's ngeohash (the library that decodes
// these same cells in routes/alerts.ts) at precision 5.
const VECTORS: [name: string, lat: number, lng: number, cell: string][] = [
  ['Times Square, New York', 40.758, -73.9855, 'dr5ru'],
  ['San Francisco', 37.7749, -122.4194, '9q8yy'],
  ['London', 51.5074, -0.1278, 'gcpvj'],
  ['Sydney', -33.8688, 151.2093, 'r3gx2'],
  ['Mumbai', 19.076, 72.8777, 'te7ud'],
  ['north-east extreme', 90, 180, 'zzzzz'],
  ['south-west extreme', -90, -180, '00000'],
  // Exactly on both bisectors: the midpoint goes to the upper half, as
  // geohash.org does. Only exact-boundary points are affected.
  ['null island', 0, 0, 's0000'],
];

describe('encodeGeohash5', () => {
  it.each(VECTORS)('encodes %s', (_name, lat, lng, cell) => {
    expect(encodeGeohash5(lat, lng)).toBe(cell);
  });

  it('always returns five characters', () => {
    expect(encodeGeohash5(40.758, -73.9855)).toHaveLength(5);
    expect(encodeGeohash5(-33.8688, 151.2093)).toHaveLength(5);
  });

  it('truncates: two points inside one cell encode identically', () => {
    // ~150 m apart, both inside dr5ru. This is the privacy property: the cell
    // is what leaves the device, so the exact point is not recoverable from it.
    expect(encodeGeohash5(40.758, -73.9855)).toBe(encodeGeohash5(40.7592, -73.9865));
  });

  it('rejects out-of-range coordinates instead of encoding nonsense', () => {
    expect(() => encodeGeohash5(91, 0)).toThrow(RangeError);
    expect(() => encodeGeohash5(0, 181)).toThrow(RangeError);
    expect(() => encodeGeohash5(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe('coordinateProblem', () => {
  it('passes a valid pair', () => {
    expect(coordinateProblem(40.758, -73.9855)).toBeNull();
  });

  it('names the offending axis', () => {
    expect(coordinateProblem(120, 0)).toMatch(/latitude/i);
    expect(coordinateProblem(0, -200)).toMatch(/longitude/i);
    expect(coordinateProblem(Number.NaN, 0)).toMatch(/number/i);
  });
});

describe('isGeohash5', () => {
  it('accepts a five-character base-32 cell', () => {
    expect(isGeohash5('dr5ru')).toBe(true);
  });

  it('rejects wrong lengths and non-base-32 characters', () => {
    expect(isGeohash5('dr5r')).toBe(false);
    expect(isGeohash5('dr5rus')).toBe(false);
    // a, i, l and o are not in the geohash alphabet.
    expect(isGeohash5('dr5ai')).toBe(false);
  });
});
