// Switch — a settings row, not a checkbox. Label and one-line description on
// the left, track on the right, row at least 44px (DESIGN.md).
import { useId, type ReactElement } from 'react';

export interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function Switch({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: SwitchProps): ReactElement {
  const labelId = useId();
  const descriptionId = `${labelId}-desc`;

  return (
    <div className="switch-row">
      <span className="switch-text">
        <span className="switch-label" id={labelId}>
          {label}
        </span>
        {description === undefined ? null : (
          <span className="switch-desc" id={descriptionId}>
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
