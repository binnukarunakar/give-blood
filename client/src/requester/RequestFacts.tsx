// The header of a request: what is needed, where it stands, the three
// aggregates the requester plans around, and the hospital the donors are being
// sent to. No card chrome — this is the top of the page, not a panel on it.
//
// `live` is passed in rather than derived here so the dot pulses on exactly the
// condition the page polls on, and stops the moment polling does.
import type { ReactElement } from 'react';
import { URGENCY_LABELS } from '../donor/alertCopy';
import { formatDayTime } from '../donor/donorFormat';
import type { RequestDetail } from '../lib/apiTypes';
import { BloodChip, requestTone, StatChip, StatChipRow, StatusChip } from '../ui';
import {
  isTerminal,
  POLL_SECONDS,
  radiusLabel,
  REQUEST_STATE_LABELS,
  unitsLabel,
} from './requesterCopy';

export interface RequestFactsProps {
  request: RequestDetail;
  /** True while the page is polling; drives the pulsing live line. */
  live: boolean;
}

export function RequestFacts({ request, live }: RequestFactsProps): ReactElement {
  // A finished request has no expiry to wait for and no radius to widen. The
  // banner under this header says what happened; a stale "expires 7:11 AM" line
  // beside it only invites the reader to work out whether it still matters.
  const closed = isTerminal(request.state);

  return (
    <header className="facts">
      <div className="facts-top">
        <BloodChip group={request.bloodGroup} size="md" />
        <span className="facts-units">{unitsLabel(request.unitsNeeded)}</span>
        <StatusChip
          tone={request.urgency === 'critical' ? 'blood' : 'subtle'}
          label={URGENCY_LABELS[request.urgency]}
        />
        <StatusChip
          tone={requestTone(request.state)}
          label={REQUEST_STATE_LABELS[request.state]}
        />
      </div>

      <p className="facts-hospital">
        {request.hospital.name} · {request.hospital.address}
      </p>

      <StatChipRow>
        <StatChip label="Alerted" value={request.donorsAlerted} />
        <StatChip label="Pledged" value={request.activePledges} />
        <StatChip
          label="Confirmed"
          value={`${String(request.unitsConfirmed)} of ${String(request.unitsNeeded)}`}
        />
      </StatChipRow>

      {closed ? null : (
        <p className="facts-meta">
          Expires {formatDayTime(request.expiresAt)} · {radiusLabel(request.radiusTier)}
        </p>
      )}

      {live ? (
        <p className="live-line">
          <span className="live-dot" aria-hidden="true" />
          Live — updates every {POLL_SECONDS} s
        </p>
      ) : null}
    </header>
  );
}
