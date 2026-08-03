// The one picker the new-request form needs that the UI kit does not have: the
// units stepper.
//
// The blood-group grid used to live here too, as the requester's copy of the
// grid GB-29 wrote for donor onboarding. Both were the same markup to the same
// spec, so GB-31a folded them into src/ui/BloodGroupGrid; this form now labels
// that primitive the same way it labels the urgency control.
import { useId, type ReactElement } from 'react';
import { Button } from '../ui';
import { MAX_UNITS, MIN_UNITS } from './requesterCopy';

export interface UnitsStepperProps {
  units: number;
  onChange: (units: number) => void;
}

export function UnitsStepper({ units, onChange }: UnitsStepperProps): ReactElement {
  const labelId = useId();

  return (
    <div className="picker">
      <p className="picker-label" id={labelId}>
        Units needed
      </p>
      <div className="units-stepper" role="group" aria-labelledby={labelId}>
        <Button
          variant="secondary"
          aria-label="Fewer units"
          disabled={units <= MIN_UNITS}
          onClick={() => onChange(units - 1)}
        >
          −
        </Button>
        <output className="units-count">{units}</output>
        <Button
          variant="secondary"
          aria-label="More units"
          disabled={units >= MAX_UNITS}
          onClick={() => onChange(units + 1)}
        >
          +
        </Button>
      </div>
    </div>
  );
}
