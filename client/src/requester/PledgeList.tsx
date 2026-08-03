// Pledge cards. Everything here is a snapshot the server wrote when the donor
// accepted — a handle, a group, a window, and a phone number only when that
// donor chose to share it. There is no roster and no lookup behind these cards.
//
// Both outcome buttons are destructive in one direction or the other (a unit
// counted, or a donor released), so each one asks first, in the shared
// ui/ConfirmSheet: title, one-line consequence, ghost cancel, primary confirm.
import { useState, type ReactElement } from 'react';
import { ETA_LABELS } from '../donor/alertCopy';
import type { PledgeCard } from '../lib/apiTypes';
import { formatPhone } from '../lib/phone';
import {
  BloodChip,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  PhoneIcon,
  pledgeTone,
  StatusChip,
} from '../ui';
import { PLEDGE_STATE_LABELS } from './requesterCopy';

export type PledgeAction = 'donated' | 'no_show';

interface Confirming {
  pledgeId: string;
  action: PledgeAction;
}

export interface PledgeListProps {
  pledges: PledgeCard[];
  /** The pledge whose call is in flight; its buttons are disabled. */
  busyPledgeId: string | null;
  /** True once the request is over: no donor is coming, so nothing is pending. */
  closed: boolean;
  onDonated: (pledgeId: string) => void;
  onNoShow: (pledgeId: string) => void;
}

const CONFIRM_TITLE: Record<PledgeAction, string> = {
  donated: 'Confirm this donor arrived and donated?',
  no_show: 'Mark this donor as not arrived?',
};

const CONFIRM_COPY: Record<PledgeAction, string> = {
  donated: 'It counts a unit toward this request and starts their donation cooldown.',
  no_show: 'Their pledge is released and other donors can be alerted again.',
};

const CONFIRM_BUTTON: Record<PledgeAction, string> = {
  donated: 'Yes, they donated',
  no_show: 'Yes, they did not arrive',
};

export function PledgeList({
  pledges,
  busyPledgeId,
  closed,
  onDonated,
  onNoShow,
}: PledgeListProps): ReactElement | null {
  const [confirming, setConfirming] = useState<Confirming | null>(null);

  if (pledges.length === 0) {
    // "No donor has accepted YET. This view refreshes on its own." is a promise
    // about a future that has already been cancelled once the request is over.
    if (closed) return null;
    return <EmptyState message="No donor has accepted yet. This view refreshes on its own." />;
  }

  function run(pledge: PledgeCard, action: PledgeAction): void {
    setConfirming(null);
    if (action === 'donated') onDonated(pledge.pledgeId);
    else onNoShow(pledge.pledgeId);
  }

  return (
    <ul className="pledge-list">
      {pledges.map((pledge) => {
        const busy = busyPledgeId === pledge.pledgeId;
        const open = confirming?.pledgeId === pledge.pledgeId ? confirming.action : null;
        return (
          <li key={pledge.pledgeId}>
            <Card>
              <div className="pledge-top">
                <h3 className="pledge-handle">{pledge.donorHandle}</h3>
                <BloodChip group={pledge.donorBloodGroup} size="sm" />
                <StatusChip
                  tone={pledgeTone(pledge.state)}
                  label={PLEDGE_STATE_LABELS[pledge.state]}
                />
              </div>

              <p className="pledge-eta">{ETA_LABELS[pledge.etaBucket]}</p>

              {pledge.donorPhone === null ? (
                <p className="pledge-note">Phone not shared</p>
              ) : (
                <a className="btn btn-ghost pledge-tel" href={`tel:${pledge.donorPhone}`}>
                  <PhoneIcon />
                  {formatPhone(pledge.donorPhone)}
                </a>
              )}

              {pledge.state !== 'active' ? null : open === null ? (
                <div className="pledge-actions">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirming({ pledgeId: pledge.pledgeId, action: 'donated' })}
                  >
                    Donated
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirming({ pledgeId: pledge.pledgeId, action: 'no_show' })}
                  >
                    No-show
                  </Button>
                </div>
              ) : (
                <ConfirmSheet
                  title={CONFIRM_TITLE[open]}
                  consequence={CONFIRM_COPY[open]}
                  confirmLabel={CONFIRM_BUTTON[open]}
                  cancelLabel="Back"
                  busy={busy}
                  onConfirm={() => run(pledge, open)}
                  onCancel={() => setConfirming(null)}
                />
              )}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
