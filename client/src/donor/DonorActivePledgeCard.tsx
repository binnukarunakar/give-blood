// "You are expected somewhere" — the first thing on donor home when this donor
// is holding a pledge.
//
// It exists for one person: the donor who accepted at 2am, locked her phone,
// and came back to the app with no notification left to tap. Without this she
// has no route back to the address and the directions — the alert URL is in a
// push she has already dismissed. The card is deliberately a pointer and not a
// copy of the pledge screen: one link, to the screen that owns the detail.
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import type { ActivePledge } from '../lib/apiTypes';
import { Card, StatusChip } from '../ui';

const NOTE = 'A hospital is expecting you. Open the alert for the address and directions.';
const NO_ALERT =
  'A hospital is expecting you. Call the blood bank on the number they gave you to confirm.';

export function DonorActivePledgeCard({ pledge }: { pledge: ActivePledge }): ReactElement {
  const { alertId } = pledge;

  return (
    <Card title="Active pledge">
      <div className="identity-status">
        <StatusChip tone="ok" label="You pledged" />
      </div>

      <p className="page-note">{alertId === null ? NO_ALERT : NOTE}</p>

      {/* No alert id means no screen to send her to. Saying so beats a link
          that lands on "This alert is not available for your account". */}
      {alertId === null ? null : (
        <Link className="btn btn-primary btn-full" to={`/alerts/${encodeURIComponent(alertId)}`}>
          Open alert
        </Link>
      )}
    </Card>
  );
}
