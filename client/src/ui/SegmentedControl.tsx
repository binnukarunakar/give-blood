// SegmentedControl — two-or-three-way choice in one track. The critical
// segment marks itself with a red dot, never a red fill (DESIGN.md).
import type { ReactElement } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Adds the blood dot when selected — reserved for urgency=critical. */
  critical?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group for screen readers; there is no visible legend. */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedControlProps<T>): ReactElement {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={selected ? 'segment is-selected' : 'segment'}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.critical === true && selected ? (
              <span className="segment-dot" aria-hidden="true" />
            ) : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
