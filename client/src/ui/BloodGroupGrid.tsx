// BloodGroupGrid — the 8-tile blood-group picker (DESIGN.md § Donor
// onboarding: 8 tiles 2x4, 56px, selected = --blood border + --blood-soft).
//
// Donor onboarding and the requester's new-request form had a copy each
// (GB-29, GB-30), identical in markup and in CSS. This is the one.
//
// The two call sites label it differently and both are correct: onboarding
// names the grid itself, the request form puts a visible label above it and
// points at that. So the label is a union — exactly one of the two, never both,
// never neither.
import type { ReactElement } from 'react';
import { BLOOD_GROUPS, type BloodGroup } from '../lib/apiTypes';

interface BloodGroupGridBase {
  selected: BloodGroup | null;
  onSelect: (group: BloodGroup) => void;
}

export type BloodGroupGridProps = BloodGroupGridBase &
  (
    | { /** Names the group for screen readers. */ label: string; labelledBy?: never }
    | { /** id of a visible element that already names it. */ labelledBy: string; label?: never }
  );

export function BloodGroupGrid({
  selected,
  onSelect,
  label,
  labelledBy,
}: BloodGroupGridProps): ReactElement {
  return (
    <div className="blood-grid" role="group" aria-label={label} aria-labelledby={labelledBy}>
      {BLOOD_GROUPS.map((group) => (
        <button
          key={group}
          type="button"
          className="blood-tile"
          aria-pressed={selected === group}
          onClick={() => onSelect(group)}
        >
          {group}
        </button>
      ))}
    </div>
  );
}
