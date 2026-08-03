// Who the server thinks this donor is, and whether alerts can reach them.
// The blood group and the handle are the identity element of the whole donor
// side, so they lead the screen (DESIGN.md § Donor home).
import type { ReactElement } from 'react';
import type { DonorView } from '../lib/apiTypes';
import { BloodChip, Card, StatusChip } from '../ui';
import { formatDayTime, isFuture } from './donorFormat';

export function DonorIdentityCard({ donor }: { donor: DonorView }): ReactElement {
  const snoozed = donor.snoozeUntil !== null && isFuture(donor.snoozeUntil);

  return (
    <Card>
      <div className="identity-row">
        <BloodChip group={donor.bloodGroup} size="md" />
        <h2 className="identity-handle">{donor.handle}</h2>
      </div>

      <p className="identity-meta">
        Area cell <span>{donor.geohash5}</span> · <span>{donor.tz}</span>
      </p>

      <div className="identity-status">
        <StatusChip
          tone={donor.pushVerified ? 'ok' : 'subtle'}
          label={donor.pushVerified ? 'Push verified' : 'Push not verified'}
        />
        {snoozed && donor.snoozeUntil !== null ? (
          <StatusChip tone="subtle" label={`Snoozed until ${formatDayTime(donor.snoozeUntil)}`} />
        ) : null}
      </div>

      {donor.pushVerified ? null : (
        <p className="page-note">
          You are not in the alert pool until this device is verified for notifications.
        </p>
      )}
    </Card>
  );
}
