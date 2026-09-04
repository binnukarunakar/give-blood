// TravelRadiusPicker (GB-35) — "how far will you travel?", shared by donor
// onboarding and donor settings so the question is worded identically in both.
//
// SegmentedControl is keyed on strings, the wire value is a number, and the
// conversion lives here rather than at each call site.
import type { ReactElement } from 'react';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TRAVEL_RADII_KM, type TravelRadiusKm } from '../lib/apiTypes';

const OPTIONS = TRAVEL_RADII_KM.map((km) => ({ value: String(km), label: `${km} km` }));

export interface TravelRadiusPickerProps {
  value: TravelRadiusKm;
  onChange: (next: TravelRadiusKm) => void;
  disabled?: boolean;
  /** Onboarding wants the explainer; the settings card already has a divider. */
  hint?: boolean;
}

export function TravelRadiusPicker({
  value,
  onChange,
  disabled = false,
  hint = true,
}: TravelRadiusPickerProps): ReactElement {
  return (
    <div className="field">
      <span className="field-label">How far will you travel to donate?</span>
      <SegmentedControl
        label="How far will you travel to donate?"
        options={OPTIONS}
        value={String(value)}
        onChange={(next) => onChange(Number(next) as TravelRadiusKm)}
        disabled={disabled}
      />
      {hint ? (
        <p className="field-note">
          A wider range never moves you up the queue. A hospital always asks the closest
          donors first, and only reaches further out when nobody nearer can come.
        </p>
      ) : null}
    </div>
  );
}
