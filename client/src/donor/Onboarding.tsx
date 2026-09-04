// Donor onboarding: handle, blood group, consent, area cell, then push setup.
//
// The body posted to POST /donors carries geohash5 only. No latitude or
// longitude is held in this component's state at any point — LocationPicker
// hands up the truncated cell and nothing else.
//
// Three numbered section Cards, one sticky primary (DESIGN.md § Donor
// onboarding). The primary is disabled until all four answers exist, and the
// line above it names what is still missing rather than leaving a dead button.
import { useCallback, useId, useState, type FormEvent, type ReactElement } from 'react';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { BloodGroup, TravelRadiusKm } from '../lib/apiTypes';
import { Banner, BloodGroupGrid, Button, Card, Field, StickyBar, Switch } from '../ui';
import { LocationPicker } from './LocationPicker';
import { TravelRadiusPicker } from './TravelRadiusPicker';
import { PushSetup } from './PushSetup';

const HANDLE_MAX = 40;

const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const BAD_AREA = 'That area is not a usable map cell. Pick your area again.';
const NEEDS_PHONE = 'Register with a phone sign-in. Sign out and sign in with your number.';
const REGISTER_FAILED = 'Could not create your donor profile. Try again.';

const CONSENT_LABEL = 'Send me alerts when a nearby hospital needs my blood group';
const CONSENT_DESC = 'Alerts only, nothing else. You can opt out at any time.';
const AREA_NOTE = 'Stored as a ~5 km cell — your exact location never leaves this phone.';

type Phase = 'form' | 'push';

export interface OnboardingProps {
  /** Called when the donor record exists and this screen should hand over. */
  onComplete: () => void;
}

function registerError(status: number, code: string): string {
  if (status === TRANSPORT_STATUS) return OFFLINE;
  if (code === 'invalid_geohash') return BAD_AREA;
  if (code === 'phone_auth_required') return NEEDS_PHONE;
  return REGISTER_FAILED;
}

export function Onboarding({ onComplete }: OnboardingProps): ReactElement {
  // StickyBar renders into document.body, so the primary is not a DOM
  // descendant of the form it submits. Form ownership is DOM ancestry unless
  // the button says otherwise, so it says otherwise.
  const formId = useId();
  const [handle, setHandle] = useState('');
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | null>(null);
  const [geohash5, setGeohash5] = useState<string | null>(null);
  // Defaults to the widest rung: the donor can narrow it, but the pool starts
  // as reachable as possible (GB-35).
  const [travelRadiusKm, setTravelRadiusKm] = useState<TravelRadiusKm>(25);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [verified, setVerified] = useState(false);

  const onLocation = useCallback((cell: string) => setGeohash5(cell), []);

  const ready = handle.trim() !== '' && bloodGroup !== null && geohash5 !== null && consent;
  const missing = [
    handle.trim() === '' ? 'a display name' : null,
    bloodGroup === null ? 'your blood group' : null,
    geohash5 === null ? 'your area' : null,
    consent ? null : 'your consent',
  ].filter((item): item is string => item !== null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (bloodGroup === null || geohash5 === null || !consent) return;
    setSubmitting(true);
    setError(null);
    const result = await api.registerDonor({
      handle: handle.trim(),
      bloodGroup,
      geohash5,
      consent: true,
      travelRadiusKm,
    });
    setSubmitting(false);
    if (result.ok) {
      setPhase('push');
      return;
    }
    if (result.status === 409 && result.error.error === 'already_registered') {
      onComplete();
      return;
    }
    setError(registerError(result.status, result.error.error));
  }

  if (phase === 'push') {
    return (
      <section>
        <h2>Almost done</h2>
        <p className="page-sub">Your donor profile is saved. One step left.</p>

        <PushSetup onVerified={() => setVerified(true)} />

        {verified ? null : (
          <p className="page-note">
            Until this device is verified you will not be sent alerts.
          </p>
        )}

        <StickyBar label="Finish setup">
          {verified ? (
            <Button variant="primary" size="lg" fullWidth onClick={onComplete}>
              Open your donor profile
            </Button>
          ) : (
            <Button variant="ghost" fullWidth onClick={onComplete}>
              Continue without notifications
            </Button>
          )}
        </StickyBar>
      </section>
    );
  }

  return (
    <section>
      <h2>Set up your donor profile</h2>
      <p className="page-sub">Four answers. You can change every one of them later.</p>

      <form id={formId} className="onboard-form" onSubmit={(event) => void submit(event)}>
        <Card step="01" title="Identity">
          <Field
            id="handle"
            name="handle"
            label="Display name requesters see when you accept"
            type="text"
            maxLength={HANDLE_MAX}
            autoComplete="nickname"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            required
          />
          <BloodGroupGrid
            label="Your blood group"
            selected={bloodGroup}
            onSelect={setBloodGroup}
          />
        </Card>

        <Card step="02" title="Consent">
          <Switch
            label={CONSENT_LABEL}
            description={CONSENT_DESC}
            checked={consent}
            onChange={setConsent}
          />
        </Card>

        <Card step="03" title="Area">
          <LocationPicker value={geohash5} onChange={onLocation} />
          <p className="privacy-note">{AREA_NOTE}</p>
          <TravelRadiusPicker value={travelRadiusKm} onChange={setTravelRadiusKm} />
        </Card>

        {error === null ? null : <Banner tone="error">{error}</Banner>}

        {ready ? null : <p className="onboard-missing">Still needed: {missing.join(', ')}.</p>}

        <StickyBar label="Create profile">
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={!ready}
          >
            Create donor profile
          </Button>
        </StickyBar>
      </form>
    </section>
  );
}
