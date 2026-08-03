// The donation record: when they last gave, when they are eligible again, and
// the self-report that starts the cooldown. The 56-day arithmetic is display
// only — the server still decides who is eligible (server-authoritative).
import { useState, type ReactElement } from 'react';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { DonorView } from '../lib/apiTypes';
import { Banner, Button, Card, ConfirmSheet } from '../ui';
import { DONATION_COOLDOWN_DAYS, eligibleAgainAt, formatDay } from './donorFormat';

const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const DONATION_FAILED = 'Could not record your donation. Try again.';
const COOLDOWN_HINT = `${String(DONATION_COOLDOWN_DAYS)} days after your last donation`;
const CONSEQUENCE = `This starts your ${String(DONATION_COOLDOWN_DAYS)}-day cooldown, so you will not be alerted until it ends.`;

export interface DonorDonationCardProps {
  donor: DonorView;
  onDonor: (donor: DonorView) => void;
}

export function DonorDonationCard({ donor, onDonor }: DonorDonationCardProps): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cooldownEnd = donor.lastDonationAt === null ? null : eligibleAgainAt(donor.lastDonationAt);
  const inCooldown = cooldownEnd !== null && cooldownEnd.getTime() > Date.now();

  async function reportDonation(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await api.reportDonation({});
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.status === TRANSPORT_STATUS ? OFFLINE : DONATION_FAILED);
      return;
    }
    onDonor({ ...donor, lastDonationAt: result.data.lastDonationAt });
  }

  return (
    <Card title="Donation">
      <div className="donation-lines">
        <p className="donation-line">
          Last donation{' '}
          <span className="donation-value">
            {donor.lastDonationAt === null ? 'None recorded' : formatDay(donor.lastDonationAt)}
          </span>
        </p>
        <p className="donation-line">
          Eligible again{' '}
          <span className="donation-value">
            {inCooldown && cooldownEnd !== null ? formatDay(cooldownEnd) : 'Now'}
          </span>{' '}
          {inCooldown ? <span>{COOLDOWN_HINT}</span> : null}
        </p>
      </div>

      {confirming ? (
        <ConfirmSheet
          title="Record a donation today?"
          consequence={CONSEQUENCE}
          confirmLabel="Yes, I donated today"
          cancelLabel="Cancel"
          busy={busy}
          onConfirm={() => void reportDonation()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="donation-action">
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            I donated today
          </Button>
        </div>
      )}

      {error === null ? null : <Banner tone="error">{error}</Banner>}
    </Card>
  );
}
