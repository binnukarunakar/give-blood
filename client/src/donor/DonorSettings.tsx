// The Alerts card: availability, snooze, phone sharing, and consent. Every
// control writes through the API and takes the server's echoed DonorView as the
// new truth — nothing is optimistically flipped.
//
// Consent sits below a divider on purpose (DESIGN.md § Donor home): the three
// controls above it pause alerts, this one is the permission itself.
import { useState, type ReactElement } from 'react';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { DonorPatchInput, DonorView } from '../lib/apiTypes';
import { Banner, Button, Card, ConfirmSheet, Switch } from '../ui';
import { activeSnooze, formatDayTime, isFuture, SNOOZE_24H_MS, SNOOZE_7D_MS } from './donorFormat';
import { TravelRadiusPicker } from './TravelRadiusPicker';

const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const SAVE_FAILED = 'Could not save that change. Try again.';

const SHARE_PHONE_DESC =
  'The requester for that one request sees it after you accept, so they can reach you. Nobody can browse or search for donors.';
const CONSENT_NOTE =
  'Off means no alerts at all, not a pause — availability and snooze are the temporary controls.';
const OPT_OUT_CONSEQUENCE =
  'You will not be alerted again until you turn this back on. Your donor profile stays as it is.';

type Busy = 'available' | 'snooze' | 'phone' | 'consent' | 'radius' | null;

export interface DonorSettingsProps {
  donor: DonorView;
  onDonor: (donor: DonorView) => void;
}

export function DonorSettings({ donor, onDonor }: DonorSettingsProps): ReactElement {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingOptOut, setConfirmingOptOut] = useState(false);

  const snoozed = donor.snoozeUntil !== null && isFuture(donor.snoozeUntil);
  const active = activeSnooze(donor.snoozeUntil);

  async function patch(input: DonorPatchInput, field: Busy): Promise<void> {
    setBusy(field);
    setError(null);
    const result = await api.updateMe(input);
    setBusy(null);
    if (!result.ok) {
      setError(result.status === TRANSPORT_STATUS ? OFFLINE : SAVE_FAILED);
      return;
    }
    onDonor(result.data);
  }

  async function optOut(): Promise<void> {
    setConfirmingOptOut(false);
    await patch({ optedIn: false }, 'consent');
  }

  function snoozeFor(ms: number): void {
    void patch({ snoozeUntil: new Date(Date.now() + ms).toISOString() }, 'snooze');
  }

  return (
    <Card title="Alerts">
      <Switch
        label="Available to donate"
        description="Turn this off to pause alerts. Your account stays registered."
        checked={donor.available}
        disabled={busy === 'available'}
        onChange={(next) => void patch({ available: next }, 'available')}
      />

      <div className="snooze-block">
        <p className="snooze-note">
          {snoozed && donor.snoozeUntil !== null
            ? `Snoozed until ${formatDayTime(donor.snoozeUntil)}.`
            : 'Not snoozed. Alerts can arrive at any hour.'}
        </p>
        <div className="snooze-row">
          <Button
            variant="secondary"
            aria-pressed={active === '24h'}
            disabled={busy === 'snooze'}
            onClick={() => snoozeFor(SNOOZE_24H_MS)}
          >
            {active === '24h' ? <span className="snooze-dot" aria-hidden="true" /> : null}
            Snooze 24 hours
          </Button>
          <Button
            variant="secondary"
            aria-pressed={active === '7d'}
            disabled={busy === 'snooze'}
            onClick={() => snoozeFor(SNOOZE_7D_MS)}
          >
            {active === '7d' ? <span className="snooze-dot" aria-hidden="true" /> : null}
            Snooze 7 days
          </Button>
          <Button
            variant="ghost"
            disabled={busy === 'snooze' || donor.snoozeUntil === null}
            onClick={() => void patch({ snoozeUntil: null }, 'snooze')}
          >
            Clear snooze
          </Button>
        </div>
      </div>

      <div className="snooze-block">
        <TravelRadiusPicker
          value={donor.travelRadiusKm}
          disabled={busy === 'radius'}
          onChange={(next) => void patch({ travelRadiusKm: next }, 'radius')}
        />
      </div>

      <Switch
        label="Share my phone number when I accept"
        description={SHARE_PHONE_DESC}
        checked={donor.sharePhoneOnAccept}
        disabled={busy === 'phone'}
        onChange={(next) => void patch({ sharePhoneOnAccept: next }, 'phone')}
      />

      <div className="consent-block">
        <Switch
          label="Alert me when a nearby hospital needs my blood group"
          checked={donor.optedIn}
          disabled={busy === 'consent'}
          onChange={(next) => {
            if (next) void patch({ optedIn: true }, 'consent');
            else setConfirmingOptOut(true);
          }}
        />
        <p className="consent-note">{CONSENT_NOTE}</p>
      </div>

      {confirmingOptOut ? (
        <ConfirmSheet
          title="Turn off alerts?"
          consequence={OPT_OUT_CONSEQUENCE}
          confirmLabel="Yes, stop alerting me"
          cancelLabel="Keep alerts on"
          busy={busy === 'consent'}
          onConfirm={() => void optOut()}
          onCancel={() => setConfirmingOptOut(false)}
        />
      ) : null}

      {error === null ? null : <Banner tone="error">{error}</Banner>}
    </Card>
  );
}
