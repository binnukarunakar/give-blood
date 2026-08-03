// The decision bar. Accept is the one primary action on the donor side, so it
// sits in the sticky bar at full width with Decline as a ghost beneath it
// (DESIGN.md § Alert detail).
//
// Accept expands before it commits: the ETA bucket is required — the requester
// plans around a window, not a promise of a minute — and phone sharing is
// opt-in per accept, stated in the row that sets it.
import { useState, type ReactElement } from 'react';
import { ETA_BUCKETS, type AcceptAlertInput, type EtaBucket, type Urgency } from '../lib/apiTypes';
import { Banner, Button, SegmentedControl, StickyBar, Switch, type SegmentOption } from '../ui';
import { ETA_SHORT } from './alertCopy';

export type AlertAction = 'accept' | 'decline' | null;

const ETA_OPTIONS: readonly SegmentOption<EtaBucket>[] = ETA_BUCKETS.map((bucket) => ({
  value: bucket,
  label: ETA_SHORT[bucket],
}));

const WHEN = 'When can you be there?';
const SHARE_PHONE_DESC = 'Shown to them only after you accept.';

/**
 * The window the picker opens on. A critical request is one a patient is being
 * kept alive through, so its default is the soonest bucket and a donor who
 * needs longer says so; a standard request opens on the middle one.
 */
function defaultEta(urgency: Urgency): EtaBucket {
  return urgency === 'critical' ? 'le_30m' : 'le_1h';
}

export interface AlertActionsProps {
  /** Sets which eta bucket the picker opens on. */
  urgency: Urgency;
  /**
   * The donor's current share-phone setting, pre-checked so an accept never
   * silently flips it. null = the setting could not be read, in which case the
   * field is omitted from the accept body and the server keeps what it has.
   */
  sharePhoneDefault: boolean | null;
  busy: AlertAction;
  error: string | null;
  onAccept: (input: AcceptAlertInput) => void;
  onDecline: () => void;
}

export function AlertActions({
  urgency,
  sharePhoneDefault,
  busy,
  error,
  onAccept,
  onDecline,
}: AlertActionsProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [etaBucket, setEtaBucket] = useState<EtaBucket>(() => defaultEta(urgency));
  const [sharePhone, setSharePhone] = useState(sharePhoneDefault ?? false);

  function primary(): void {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    onAccept(sharePhoneDefault === null ? { etaBucket } : { etaBucket, sharePhone });
  }

  return (
    <StickyBar label="Alert actions">
      {error === null ? null : <Banner tone="error">{error}</Banner>}

      {expanded ? (
        <div className="accept-expand">
          <p className="accept-hint">{WHEN}</p>
          <SegmentedControl
            label={WHEN}
            options={ETA_OPTIONS}
            value={etaBucket}
            onChange={setEtaBucket}
            disabled={busy !== null}
          />
          {sharePhoneDefault === null ? null : (
            <Switch
              label="Share my phone number with this requester"
              description={SHARE_PHONE_DESC}
              checked={sharePhone}
              disabled={busy !== null}
              onChange={setSharePhone}
            />
          )}
        </div>
      ) : null}

      <Button
        variant="primary"
        size="lg"
        fullWidth
        loading={busy === 'accept'}
        disabled={busy !== null}
        onClick={primary}
      >
        {expanded ? 'Confirm accept' : 'Accept'}
      </Button>

      <Button
        variant="ghost"
        fullWidth
        loading={busy === 'decline'}
        disabled={busy !== null}
        onClick={onDecline}
      >
        Decline
      </Button>
    </StickyBar>
  );
}
