// Skeleton — the shape of the content that is coming. Full pages never spin
// (DESIGN.md); a skeleton says what will land where.
import type { CSSProperties, ReactElement } from 'react';

export interface SkeletonProps {
  /** Any CSS length. Defaults to the full row. */
  width?: string;
  /** Any CSS length. Defaults to one line of body text. */
  height?: string;
  radius?: 'ctl' | 'card' | 'pill';
  /** Announced once for the whole loading region — pass on the first skeleton only. */
  label?: string;
}

export function Skeleton({
  width = '100%',
  height = '16px',
  radius = 'ctl',
  label,
}: SkeletonProps): ReactElement {
  const style: CSSProperties = { width, height, borderRadius: `var(--r-${radius})` };
  return (
    <span
      className="skeleton"
      style={style}
      role={label === undefined ? undefined : 'status'}
      aria-label={label}
    />
  );
}
