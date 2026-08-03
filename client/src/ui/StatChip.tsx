// StatChip — label over number. Three of them in a row is the whole progress
// story of a request (alerted / pledged / confirmed).
import type { ReactElement, ReactNode } from 'react';

export interface StatChipProps {
  label: string;
  value: string | number;
}

export function StatChip({ label, value }: StatChipProps): ReactElement {
  return (
    <div className="stat-chip">
      <span className="stat-chip-label">{label}</span>
      <span className="stat-chip-value">{value}</span>
    </div>
  );
}

export function StatChipRow({ children }: { children: ReactNode }): ReactElement {
  return <div className="stat-chip-row">{children}</div>;
}
