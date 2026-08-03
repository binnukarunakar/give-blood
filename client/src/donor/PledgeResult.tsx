// The pledge card a donor keeps after accepting: what they promised, how to get
// there, who to call, and how to back out honestly if plans change. Withdraw is
// a quiet danger ghost in the bottom corner — never beside the actions that get
// them there.
//
// It renders from GET /alerts/:id, not from the accept response, so it survives
// a reload: at 2am the donor who has already tapped Accept still needs the
// address and the directions, and a screen that only existed in React state was
// gone the moment she locked her phone (GB-33).
import { useState, type ReactElement } from 'react';
import { api, TRANSPORT_STATUS } from '../lib/api';
import type { AlertDetail, AlertPledge } from '../lib/apiTypes';
import { directionsUrl } from '../lib/maps';
import { Banner, BloodChip, Button, Card, ConfirmSheet, StatusChip } from '../ui';
import { ETA_LABELS } from './alertCopy';

const OFFLINE = 'You appear to be offline. Reconnect and try again.';
const WITHDRAW_FAILED = 'Could not withdraw your pledge. Try again.';
const ALREADY_CLOSED = 'This pledge is no longer active. Nothing to withdraw.';
const WITHDRAW_CONSEQUENCE =
  'The hospital stops counting on you and other donors are alerted again.';

export interface PledgeResultProps {
  alert: AlertDetail;
  /** The caller's own active pledge on that alert. */
  pledge: AlertPledge;
  onWithdrawn: () => void;
}

export function PledgeResult({ alert, pledge, onWithdrawn }: PledgeResultProps): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const units = alert.unitsNeeded === 1 ? '1 unit' : `${String(alert.unitsNeeded)} units`;

  async function withdraw(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await api.withdrawPledge(pledge.pledgeId);
    setBusy(false);
    if (result.ok) {
      onWithdrawn();
      return;
    }
    setConfirming(false);
    if (result.status === 409) {
      setError(ALREADY_CLOSED);
      return;
    }
    setError(result.status === TRANSPORT_STATUS ? OFFLINE : WITHDRAW_FAILED);
  }

  return (
    <Card>
      <div className="identity-status">
        <StatusChip tone="ok" label="You pledged" />
        <BloodChip group={alert.bloodGroup} size="sm" />
        <span className="pledge-units">{units}</span>
      </div>

      <div className="hospital-block">
        <p className="hospital-name">{alert.hospital.name}</p>
        {/* The address, not just the name: a map deep link that fails to open
            leaves the donor with nothing else to type into another app. */}
        <p className="hospital-address">{alert.hospital.address}</p>
      </div>

      <p className="pledge-line">
        They are expecting you. Your window: {ETA_LABELS[pledge.etaBucket].toLowerCase()}.
      </p>

      <a
        className="btn btn-primary btn-lg btn-full"
        href={directionsUrl(alert.hospital.lat, alert.hospital.lng)}
        target="_blank"
        rel="noreferrer"
      >
        Directions
      </a>

      <a className="btn btn-secondary btn-full" href={`tel:${alert.hospital.bloodbankPhone}`}>
        Call blood bank to confirm
      </a>

      {confirming ? (
        <ConfirmSheet
          title="Withdraw your pledge?"
          consequence={WITHDRAW_CONSEQUENCE}
          confirmLabel="Yes, withdraw"
          cancelLabel="Keep my pledge"
          busy={busy}
          onConfirm={() => void withdraw()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="pledge-withdraw">
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Withdraw pledge
          </Button>
        </div>
      )}

      {error === null ? null : <Banner tone="error">{error}</Banner>}
    </Card>
  );
}
