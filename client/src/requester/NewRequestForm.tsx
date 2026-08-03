// Raise a request: hospital, blood group, units, urgency.
//
// There is no hospital picker with a list behind it because there is no
// hospitals endpoint — by design. The hospital registry is operator-seeded
// (docs/DATA_MODEL.md), so v0 takes the id the operator hands over at
// onboarding. The field says exactly that rather than pretending to search.
import { useEffect, useId, useState, type FormEvent, type ReactElement } from 'react';
import { DEMO_MODE } from '../demo/demoMode';
import { URGENCY_LABELS } from '../donor/alertCopy';
import { api, TRANSPORT_STATUS } from '../lib/api';
import {
  URGENCIES,
  type BloodGroup,
  type CreateRequestInput,
  type RequestCreated,
  type Urgency,
} from '../lib/apiTypes';
import {
  Banner,
  BloodGroupGrid,
  Button,
  Card,
  Field,
  SegmentedControl,
  type SegmentOption,
} from '../ui';
import { UnitsStepper } from './RequestFormPickers';
import { MIN_UNITS, NOT_A_REQUESTER, OFFLINE } from './requesterCopy';

const CREATE_FAILED = 'Could not raise this request. Try again.';
const UNKNOWN_HOSPITAL =
  'That hospital id is not in the registry. Check the id the operator gave you.';
const NOT_VERIFIED =
  'This requester account is not verified yet. The operator verifies hospital requesters before they can raise requests.';
const TOO_MANY =
  'You have reached the limit of open requests. Cancel or close one before raising another.';
const INVALID =
  'Check the form. The hospital id must be the identifier the operator gave you, exactly as issued.';
const HOSPITAL_HELPER =
  'Provided by the operator during onboarding. The app has no hospital directory: the registry is operator-seeded, so paste the id you were given.';

const URGENCY_OPTIONS: readonly SegmentOption<Urgency>[] = URGENCIES.map((value) => ({
  value,
  label: URGENCY_LABELS[value],
  critical: value === 'critical',
}));

export interface NewRequestFormProps {
  onCreated: (created: RequestCreated) => void;
  onCancel: () => void;
}

function createError(status: number, code: string): string {
  if (status === TRANSPORT_STATUS) return OFFLINE;
  if (code === 'unknown_hospital') return UNKNOWN_HOSPITAL;
  if (code === 'not_verified') return NOT_VERIFIED;
  if (code === 'not_a_requester') return NOT_A_REQUESTER;
  if (code === 'too_many_open_requests') return TOO_MANY;
  if (code === 'invalid_body') return INVALID;
  return CREATE_FAILED;
}

/**
 * Rejections that are about the one field the requester typed. They belong ON
 * that field — border, aria-invalid, message under the input — not in a banner
 * at the far end of the form, four controls away from the box to correct.
 */
function isHospitalIdError(code: string): boolean {
  return code === 'unknown_hospital' || code === 'invalid_body';
}

export function NewRequestForm({ onCreated, onCancel }: NewRequestFormProps): ReactElement {
  const bloodLabelId = useId();
  const [hospitalId, setHospitalId] = useState('');
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | null>(null);
  const [unitsNeeded, setUnitsNeeded] = useState(MIN_UNITS);
  const [urgency, setUrgency] = useState<Urgency>('critical');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hospitalError, setHospitalError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);

  const ready = hospitalId.trim() !== '' && bloodGroup !== null;

  // Demo builds fill the id in. There is no hospital directory endpoint and
  // never will be (docs/ARCHITECTURE.md), so in a real deployment this box can
  // only be pasted into — but in the demo the only id that exists is printed in
  // a server banner nobody running the browser has seen, which made the one
  // required field of the whole requester flow a guessing game.
  //
  // DEMO_MODE is a build-time constant, so in a production build this branch and
  // the import behind it fold away exactly as they do in main.tsx.
  useEffect(() => {
    if (!DEMO_MODE) return undefined;
    let live = true;
    void import('../demo/demoApi').then(async ({ fetchDemoHospitalId }) => {
      const result = await fetchDemoHospitalId();
      // Never overwrite typing that got there first.
      if (live && result.ok) setHospitalId((current) => (current === '' ? result.data : current));
    });
    return () => {
      live = false;
    };
  }, []);

  async function create(differentPatient: boolean): Promise<void> {
    if (bloodGroup === null) return;
    setSubmitting(true);
    setError(null);
    setHospitalError(null);
    const input: CreateRequestInput = {
      bloodGroup,
      unitsNeeded,
      urgency,
      hospitalId: hospitalId.trim(),
      ...(differentPatient ? { differentPatient: true } : {}),
    };
    const result = await api.createRequest(input);
    setSubmitting(false);
    if (result.ok) {
      onCreated(result.data);
      return;
    }
    if (result.status === 409 && result.error.error === 'duplicate_request') {
      setDuplicateId(result.error.existingRequestId ?? null);
      return;
    }
    const message = createError(result.status, result.error.error);
    if (result.status !== TRANSPORT_STATUS && isHospitalIdError(result.error.error)) {
      setHospitalError(message);
      return;
    }
    setError(message);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDuplicateId(null);
    void create(false);
  }

  return (
    <form className="request-form" onSubmit={submit}>
      <Card>
        <Field
          id="hospitalId"
          name="hospitalId"
          label="Hospital id"
          helper={HOSPITAL_HELPER}
          error={hospitalError ?? undefined}
          type="text"
          autoComplete="off"
          value={hospitalId}
          onChange={(event) => setHospitalId(event.target.value)}
          required
        />

        <div className="picker">
          <p className="picker-label" id={bloodLabelId}>
            Blood group needed
          </p>
          <BloodGroupGrid
            labelledBy={bloodLabelId}
            selected={bloodGroup}
            onSelect={setBloodGroup}
          />
        </div>

        <UnitsStepper units={unitsNeeded} onChange={setUnitsNeeded} />

        <div className="picker">
          <p className="picker-label">Urgency</p>
          <SegmentedControl
            label="Urgency"
            options={URGENCY_OPTIONS}
            value={urgency}
            onChange={setUrgency}
            disabled={submitting}
          />
        </div>
      </Card>

      {duplicateId === null ? null : (
        <div className="banner-stack">
          <Banner tone="warn" role="alert">
            You already have an open request for this hospital and blood group (id {duplicateId}).
            If this is a second patient, submit it again as a different patient.
          </Banner>
          <div className="confirm-sheet-actions">
            <Button variant="ghost" disabled={submitting} onClick={() => setDuplicateId(null)}>
              Keep the existing request
            </Button>
            <Button
              variant="secondary"
              loading={submitting}
              onClick={() => void create(true)}
            >
              Yes, different patient
            </Button>
          </div>
        </div>
      )}

      {error === null ? null : <Banner tone="error">{error}</Banner>}

      {ready ? null : (
        <p className="form-note">Still needed: a hospital id and a blood group.</p>
      )}

      <Button type="submit" variant="primary" fullWidth loading={submitting} disabled={!ready}>
        Send alert to donors
      </Button>
      <Button variant="ghost" fullWidth disabled={submitting} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
