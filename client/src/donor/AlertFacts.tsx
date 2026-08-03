// The facts a donor needs before deciding: what is needed, where, how far, and
// the number to call first. Fetched on tap — the push itself carries none of it.
//
// Hierarchy is the whole design here (DESIGN.md § Alert detail): urgency and
// expiry first as quiet chrome, the blood group as the visual centre, then one
// hospital card that ends in the call-first action.
import type { ReactElement } from 'react';
import type { AlertDetail } from '../lib/apiTypes';
import { BloodChip, Card, PinIcon, StatusChip } from '../ui';
import { expiresLabel, URGENCY_LABELS, urgencyTone } from './alertCopy';
import { HospitalPin } from './HospitalPin';

export function AlertFacts({ alert }: { alert: AlertDetail }): ReactElement {
  const units = alert.unitsNeeded === 1 ? '1 unit' : `${String(alert.unitsNeeded)} units`;

  return (
    <>
      <div className="alert-head">
        <div className="alert-status-row">
          <StatusChip tone={urgencyTone(alert.urgency)} label={URGENCY_LABELS[alert.urgency]} />
          <span className="alert-expires">{expiresLabel(alert.expiresAt)}</span>
        </div>

        {/* The space is for the accessible name ("B+ 2 units"); a white-space-only
            flex item is not rendered, so the visual gap stays the flex gap. */}
        <h2 className="alert-need">
          <BloodChip group={alert.bloodGroup} size="display" />{' '}
          <span className="alert-units">{units}</span>
        </h2>
      </div>

      <Card>
        <div className="hospital-block">
          <p className="hospital-name">{alert.hospital.name}</p>
          <p className="hospital-address">{alert.hospital.address}</p>
          <p className="hospital-distance">
            <PinIcon />~{alert.distanceKm.toFixed(1)} km from your area
          </p>
        </div>

        <HospitalPin name={alert.hospital.name} lat={alert.hospital.lat} lng={alert.hospital.lng} />

        <a className="btn btn-secondary btn-full" href={`tel:${alert.hospital.bloodbankPhone}`}>
          Call blood bank to confirm
        </a>
      </Card>
    </>
  );
}
