// The requester's own requests, newest first. Aggregates only — the list shows
// how many donors were alerted and how many pledged, never who they are.
//
// The whole card is the link: on a phone the target is the card, not a word
// inside it. The accessible name is spelled out so a screen reader's list of
// links reads on its own.
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { URGENCY_LABELS } from '../donor/alertCopy';
import { formatDayTime } from '../donor/donorFormat';
import type { RequestSummary } from '../lib/apiTypes';
import {
  BloodChip,
  Card,
  ChevronIcon,
  requestTone,
  StatChip,
  StatChipRow,
  StatusChip,
} from '../ui';
import { REQUEST_STATE_LABELS, unitsLabel } from './requesterCopy';

export function RequestList({ requests }: { requests: RequestSummary[] }): ReactElement {
  return (
    <ul className="req-list">
      {requests.map((request) => {
        const units = unitsLabel(request.unitsNeeded);
        return (
          <li key={request.requestId}>
            <Link
              className="req-link"
              to={`/requester/requests/${request.requestId}`}
              aria-label={`Open request: ${request.bloodGroup}, ${units}`}
            >
              <Card>
                <div className="req-top">
                  <BloodChip group={request.bloodGroup} size="sm" />
                  <span className="req-units">{units}</span>
                  <StatusChip
                    tone={requestTone(request.state)}
                    label={REQUEST_STATE_LABELS[request.state]}
                  />
                  <span className="req-chevron">
                    <ChevronIcon />
                  </span>
                </div>

                <StatChipRow>
                  <StatChip label="Alerted" value={request.donorsAlerted} />
                  <StatChip label="Pledged" value={request.activePledges} />
                  <StatChip
                    label="Confirmed"
                    value={`${String(request.unitsConfirmed)} of ${String(request.unitsNeeded)}`}
                  />
                </StatChipRow>

                {/* GET /requests/mine carries hospitalId and no hospital name
                    (server/src/routes/requestViews.ts), and every request an
                    account raises is at its own hospital anyway — so the footer
                    spends its line on urgency instead of a UUID. */}
                <p className="req-foot">
                  {URGENCY_LABELS[request.urgency]} · raised {formatDayTime(request.createdAt)}
                </p>
              </Card>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
