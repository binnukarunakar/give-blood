// BloodChip — the identity element. The blood group is the one thing a donor
// or a requester scans for, so it gets the app's only red pill (DESIGN.md).
import type { ReactElement } from 'react';

export type BloodChipSize = 'sm' | 'md' | 'display';

export interface BloodChipProps {
  /** A blood group as the server states it: 'O-', 'AB+', … */
  group: string;
  size?: BloodChipSize;
}

export function BloodChip({ group, size = 'md' }: BloodChipProps): ReactElement {
  return <span className={`blood-chip blood-chip-${size}`}>{group}</span>;
}
