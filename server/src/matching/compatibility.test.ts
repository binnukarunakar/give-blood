import { describe, expect, test } from 'vitest';

import {
  BLOOD_GROUPS,
  COMPAT,
  compatibleDonorGroups,
  type BloodGroup,
} from './compatibility.js';

const GROUP_SET: ReadonlySet<BloodGroup> = new Set(BLOOD_GROUPS);

/** Order-independent, duplicate-tolerant set equality over blood groups. */
function sameSet(
  actual: readonly BloodGroup[],
  expected: readonly BloodGroup[],
): boolean {
  const a = new Set(actual);
  const b = new Set(expected);
  if (a.size !== b.size) return false;
  for (const g of a) if (!b.has(g)) return false;
  return true;
}

const isRhNegative = (g: BloodGroup): boolean => g.endsWith('-');
const isRhPositive = (g: BloodGroup): boolean => g.endsWith('+');

describe('COMPAT — red-cell compatibility matrix', () => {
  test('O- (universal donor) appears in every recipient list', () => {
    for (const recipient of BLOOD_GROUPS) {
      expect(COMPAT[recipient]).toContain('O-');
    }
  });

  test('AB+ (universal recipient) accepts all eight groups', () => {
    expect(sameSet(COMPAT['AB+'], BLOOD_GROUPS)).toBe(true);
    expect(COMPAT['AB+']).toHaveLength(8);
  });

  test('row sizes match the doc anchors in BLOOD_GROUPS order', () => {
    const expectedSizes: Record<BloodGroup, number> = {
      'O-': 1,
      'O+': 2,
      'A-': 2,
      'A+': 4,
      'B-': 2,
      'B+': 4,
      'AB-': 4,
      'AB+': 8,
    };
    const actual = BLOOD_GROUPS.map((g) => COMPAT[g].length);
    const expected = BLOOD_GROUPS.map((g) => expectedSizes[g]);
    expect(actual).toEqual(expected);
    // Spelled out for a direct eyeball against the doc: 1/2/2/4/2/4/4/8.
    expect(actual).toEqual([1, 2, 2, 4, 2, 4, 4, 8]);
  });

  test('no Rh-negative recipient accepts any Rh-positive donor', () => {
    for (const recipient of BLOOD_GROUPS) {
      if (!isRhNegative(recipient)) continue;
      for (const donor of COMPAT[recipient]) {
        expect(isRhPositive(donor)).toBe(false);
      }
    }
  });

  test("COMPAT['B+'] is exactly {B+, B-, O+, O-}", () => {
    expect(sameSet(COMPAT['B+'], ['B+', 'B-', 'O+', 'O-'])).toBe(true);
  });

  test("COMPAT['A-'] is exactly {A-, O-}", () => {
    expect(sameSet(COMPAT['A-'], ['A-', 'O-'])).toBe(true);
  });

  test('every listed donor group is a valid BloodGroup (no typos)', () => {
    for (const recipient of BLOOD_GROUPS) {
      for (const donor of COMPAT[recipient]) {
        expect(GROUP_SET.has(donor)).toBe(true);
      }
    }
  });

  test('reflexivity: every group can receive from itself', () => {
    for (const group of BLOOD_GROUPS) {
      expect(compatibleDonorGroups(group)).toContain(group);
    }
  });
});
