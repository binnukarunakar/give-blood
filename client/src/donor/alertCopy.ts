// Copy and state rules shared by the alert screens.
import type { EtaBucket, PledgeState, RequestState, Urgency } from '../lib/apiTypes';
import type { StatusTone } from '../ui';

/** Full sentences — used where the window is read back, not chosen. */
export const ETA_LABELS: Record<EtaBucket, string> = {
  le_30m: 'Within 30 minutes',
  le_1h: 'Within 1 hour',
  le_2h: 'Within 2 hours',
};

/** Segment labels. The control's own label asks "When can you be there?". */
export const ETA_SHORT: Record<EtaBucket, string> = {
  le_30m: '30 min',
  le_1h: '1 hour',
  le_2h: '2 hours',
};

export const URGENCY_LABELS: Record<Urgency, string> = {
  critical: 'Critical',
  standard: 'Standard',
};

/** Critical is the one place urgency earns the blood dot (DESIGN.md). */
export function urgencyTone(urgency: Urgency): StatusTone {
  return urgency === 'critical' ? 'blood' : 'subtle';
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** "Expires in 4h" / "Expires in 25m" / "Expired" — one line, never a countdown. */
export function expiresLabel(expiresAt: string, now: Date = new Date()): string {
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return 'Expiry unknown';
  const minutes = Math.floor((at - now.getTime()) / MS_PER_MINUTE);
  if (minutes <= 0) return 'Expired';
  if (minutes < MINUTES_PER_HOUR) return `Expires in ${String(minutes)}m`;
  return `Expires in ${String(Math.floor(minutes / MINUTES_PER_HOUR))}h`;
}

/**
 * Mirrors canAcceptPledge in server/src/domain/requestFsm.ts. The server is
 * still the arbiter — an accept on a stale screen is rejected with 409
 * request_closed and this screen re-renders as closed.
 */
export function isAcceptable(state: RequestState): boolean {
  return state === 'open' || state === 'alerting' || state === 'partially_pledged';
}

export interface ClosedCopy {
  /** The 20px line: what happened. */
  title: string;
  /** The 15px line: what it means for this donor. */
  note: string;
}

const THANKS = 'Thank you for being ready to help.';
const NOTHING_NEEDED = 'Nothing is needed from you. Thank you.';

/** What to tell a donor who arrives after the request stopped needing them. */
export function closedCopy(state: RequestState): ClosedCopy {
  switch (state) {
    case 'fulfilled':
      return { title: 'This request has been fulfilled', note: THANKS };
    case 'covered':
      return { title: 'Enough donors have already pledged', note: THANKS };
    case 'cancelled':
      return { title: 'This request was cancelled', note: NOTHING_NEEDED };
    case 'expired':
      return { title: 'This request has expired', note: NOTHING_NEEDED };
    default:
      return { title: 'This request is closed', note: THANKS };
  }
}

/** Every pledge state that is over. An active one gets the card, not a line. */
export type ClosedPledgeState = Exclude<PledgeState, 'active'>;

/**
 * What to tell a donor about their OWN pledge, which outranks whatever happened
 * to the request. A donor who gave blood must never read "nothing was needed
 * from you" because the request later expired for its remaining units.
 */
export function pledgeCopy(state: ClosedPledgeState): ClosedCopy {
  switch (state) {
    case 'donated':
      return {
        title: 'Thank you — your donation is recorded',
        note: 'The hospital confirmed it. Your 56-day cooldown starts from today.',
      };
    case 'withdrawn':
      return {
        title: 'You withdrew your pledge',
        note: 'The request is counting on other donors again.',
      };
    case 'no_show':
      return {
        title: 'This pledge was closed',
        note: 'The hospital recorded that you did not arrive. Nothing is needed from you.',
      };
    case 'released':
      return { title: 'Your pledge was released', note: NOTHING_NEEDED };
  }
}
