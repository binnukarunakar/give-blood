// Blood compatibility — RED-CELL (whole-blood) matrix.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ SCOPE: This table is RED-CELL compatibility ONLY (recipient → acceptable   │
// │ donor groups) for WHOLE-BLOOD recruitment — see docs/DECISIONS.md #6.      │
// │                                                                            │
// │ WARNING TO FUTURE EDITORS: plasma compatibility is the INVERSE of this     │
// │ matrix (AB is the UNIVERSAL PLASMA DONOR). Do NOT "correct" this table     │
// │ toward plasma rules. Components other than whole blood are out of scope.   │
// │                                                                            │
// │ This is an immutable medical fact, encoded as a static in-code constant    │
// │ (never a DB row — an admin edit here kills someone). Changing it requires  │
// │ a deploy, which is the intended safety feature. Encoded exactly from       │
// │ docs/DATA_MODEL.md § "Blood compatibility — red-cell matrix". DO NOT ALTER.│
// └──────────────────────────────────────────────────────────────────────────┘

/** The eight ABO/Rh blood groups, in canonical (O−…AB+) order. */
export const BLOOD_GROUPS = [
  'O-',
  'O+',
  'A-',
  'A+',
  'B-',
  'B+',
  'AB-',
  'AB+',
] as const;

/** One of the eight blood groups. Derived from BLOOD_GROUPS — single source. */
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/**
 * Recipient → red-cell-acceptable donor groups.
 *
 * Deeply readonly and `as const`: no runtime mutation path (keys are readonly,
 * each donor list is a `readonly BloodGroup[]` with no push/splice). Each row
 * is transcribed directly from the ✓ cells of the DATA_MODEL.md matrix, read
 * left-to-right in BLOOD_GROUPS order.
 */
export const COMPAT: Readonly<Record<BloodGroup, readonly BloodGroup[]>> = {
  'O-': ['O-'],
  'O+': ['O-', 'O+'],
  'A-': ['O-', 'A-'],
  'A+': ['O-', 'O+', 'A-', 'A+'],
  'B-': ['O-', 'B-'],
  'B+': ['O-', 'O+', 'B-', 'B+'],
  'AB-': ['O-', 'A-', 'B-', 'AB-'],
  'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
} as const;

/** The red-cell-acceptable donor groups for a given recipient. */
export function compatibleDonorGroups(
  recipient: BloodGroup,
): readonly BloodGroup[] {
  return COMPAT[recipient];
}
