// Copy and state rules shared by the requester screens.
//
// The vocabularies come from lib/apiTypes (mirrored from the server FSMs).
// Nothing here decides anything: the server is the arbiter of every transition,
// and these labels only put a word on a state the server already sent.
import type { PledgeState, RequestState } from '../lib/apiTypes';

export const REQUEST_STATE_LABELS: Record<RequestState, string> = {
  open: 'Open',
  alerting: 'Alerting donors',
  partially_pledged: 'Donors pledged',
  covered: 'Covered',
  fulfilled: 'Fulfilled',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/**
 * Only active / donated / no_show ever reach a requester (the server's view
 * filters the rest), but the map is total so a state can never render blank.
 */
export const PLEDGE_STATE_LABELS: Record<PledgeState, string> = {
  active: 'On the way',
  donated: 'Donated',
  no_show: 'Did not arrive',
  withdrawn: 'Withdrawn',
  released: 'Released',
};

/** Mirrors server/src/domain/protocol.ts MAX_UNITS_PER_REQUEST. */
export const MAX_UNITS = 6;
export const MIN_UNITS = 1;

/**
 * The detail page's poll interval, stated once: the live line promises this
 * number to the requester, so it must be the same number the timer uses.
 */
export const POLL_SECONDS = 12;
export const POLL_MS = POLL_SECONDS * 1000;

/** The one soft advisory POST /requests can return with a 201 (never blocks). */
export const SIMILAR_WARNING = 'similar_open_request_exists';

/** Shared failure copy — same wording as the donor screens. */
export const OFFLINE = 'You appear to be offline. Reconnect and try again.';

export const NOT_A_REQUESTER =
  'This account is not a hospital requester. Requester accounts are created by the operator when a hospital is onboarded; the app cannot grant one.';

const TERMINAL_STATES: readonly RequestState[] = ['fulfilled', 'expired', 'cancelled'];

/** Terminal = the server will not move this request again, so polling stops. */
export function isTerminal(state: RequestState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** What to tell a requester whose request has stopped moving. Null while live. */
export function terminalMessage(state: RequestState): string | null {
  switch (state) {
    case 'fulfilled':
      return 'Fulfilled. Every unit you asked for is confirmed and no donor is being alerted.';
    case 'expired':
      return 'Expired. Donors are no longer being alerted. Raise a new request if the patient still needs blood.';
    case 'cancelled':
      return 'Cancelled. Pledged donors were released and are not expected at the hospital.';
    default:
      return null;
  }
}

export function unitsLabel(units: number): string {
  return units === 1 ? '1 unit' : `${String(units)} units`;
}

/**
 * Mirrors RADIUS_TIERS_KM in server/src/matching/geo.ts. "Tier 1" is an index
 * into a table only this codebase has; a hospital clerk needs the distance.
 */
const RADIUS_TIERS_KM = [5, 10, 25];

/** "Searching within ~10 km" — the tier as the thing it actually means. */
export function radiusLabel(tier: number): string {
  const km = RADIUS_TIERS_KM[tier] ?? RADIUS_TIERS_KM[RADIUS_TIERS_KM.length - 1];
  return `Searching within ~${String(km)} km`;
}

/**
 * How long a raised request waits before donors hear about it: the sweep runs
 * every 60 s in production (docs/PROTOCOL.md §5). "The next sweep" is the
 * mechanism; this is the promise.
 */
export const ALERT_DELAY = 'alerted within a minute';
