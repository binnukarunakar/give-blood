// StatusChip — a dot and a word. Tone carries the state; the label carries the
// meaning. Colour mapping per DESIGN.md.
import type { ReactElement } from 'react';
import type { PledgeState, RequestState } from '../lib/apiTypes';

export type StatusTone = 'ok' | 'warn' | 'blood' | 'subtle';

export interface StatusChipProps {
  tone: StatusTone;
  label: string;
}

const REQUEST_TONES: Record<RequestState, StatusTone> = {
  open: 'warn',
  alerting: 'warn',
  partially_pledged: 'ok',
  covered: 'ok',
  fulfilled: 'ok',
  expired: 'subtle',
  cancelled: 'subtle',
};

const PLEDGE_TONES: Record<PledgeState, StatusTone> = {
  active: 'ok',
  donated: 'ok',
  withdrawn: 'subtle',
  no_show: 'subtle',
  released: 'subtle',
};

export function requestTone(state: RequestState): StatusTone {
  return REQUEST_TONES[state];
}

export function pledgeTone(state: PledgeState): StatusTone {
  return PLEDGE_TONES[state];
}

export function StatusChip({ tone, label }: StatusChipProps): ReactElement {
  return (
    <span className={`status-chip status-chip-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
