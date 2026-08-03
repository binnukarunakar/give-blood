/**
 * Pledge state machine (pure functions).
 *
 * Canonical source: docs/DATA_MODEL.md "Pledge state machine" and
 * docs/PROTOCOL.md §6 (fulfillment & close). Cooldown dual-path: DECISIONS.md #8.
 *
 *   active → donated    (terminal; the ONLY edge that stamps Donor.last_donation_at)
 *   active → withdrawn  (terminal; donor cancels, no penalty)
 *   active → no_show    (terminal; requester marks; no punitive scoring in v1)
 *   active → released   (terminal; request closed OR hospital-bench deferral)
 *
 * `active` is the only non-terminal state. Every terminal state rejects every
 * event — all transitions are one-way; a pledge never returns to active
 * (dispatch uniqueness makes re-accept impossible), so history stays linear
 * and auditable.
 *
 * Local string-literal unions only — no import from src/db or src/matching.
 */

import { IllegalTransitionError, assertUnreachable } from './requestFsm.js';

export type PledgeState =
  | 'active'
  | 'donated'
  | 'withdrawn'
  | 'no_show'
  | 'released';

/** Events as a discriminated union (discriminant: `type`). */
export type PledgeEvent =
  | { type: 'requester_confirmed_donation' }
  | { type: 'donor_withdrew' }
  | { type: 'requester_marked_no_show' }
  | { type: 'request_closed' };

export type PledgeEventType = PledgeEvent['type'];

/** Terminal states — accept no event. `active` is the sole non-terminal. */
export const PLEDGE_TERMINAL_STATES: ReadonlySet<PledgeState> = new Set([
  'donated',
  'withdrawn',
  'no_show',
  'released',
]);

export function isPledgeTerminal(state: PledgeState): boolean {
  return PLEDGE_TERMINAL_STATES.has(state);
}

/**
 * Side-effect contract for the terminal transitions. Documentation only — the
 * FSM is pure and performs NONE of these; the callers in src/db and the sweep
 * apply them. Reproduced here so the invariants travel with the state names:
 *
 *  - `donated` is the ONLY transition that stamps `Donor.last_donation_at`
 *    (starting the 56-day cooldown) and increments `Request.units_confirmed`.
 *    The dual-path stamp — requester confirm OR donor self-report, whichever
 *    first (DECISIONS.md #8) — is handled elsewhere; this machine models the
 *    requester-confirm edge only.
 *  - `withdrawn` / `no_show` trigger a Request slot recount (possible
 *    covered → partially_pledged regression); no punitive scoring in v1.
 *  - `released` is the mapping for a closed request AND for hospital-bench
 *    deferral (donor showed, failed screening): `released`, NEVER `donated` —
 *    a deferred donor must not incur a 56-day cooldown for blood not given.
 */
export const PLEDGE_SIDE_EFFECTS = {
  donated:
    'stamps Donor.last_donation_at (56-day cooldown) + increments Request.units_confirmed',
  withdrawn: 'Request slot recount; no penalty',
  no_show: 'Request slot recount; no punitive scoring in v1',
  released:
    'request closed OR bench deferral; NO cooldown — no blood given, never donated',
} as const satisfies Record<Exclude<PledgeState, 'active'>, string>;

function fromActive(event: PledgeEvent): PledgeState {
  switch (event.type) {
    case 'requester_confirmed_donation':
      return 'donated';
    case 'donor_withdrew':
      return 'withdrawn';
    case 'requester_marked_no_show':
      return 'no_show';
    case 'request_closed':
      return 'released';
    default:
      return assertUnreachable(event);
  }
}

/**
 * Pure transition. Returns the next PledgeState or throws
 * IllegalTransitionError — only `active` accepts events; every terminal state
 * rejects all four.
 */
export function transitionPledge(
  current: PledgeState,
  event: PledgeEvent,
): PledgeState {
  switch (current) {
    case 'active':
      return fromActive(event);
    case 'donated':
    case 'withdrawn':
    case 'no_show':
    case 'released':
      throw new IllegalTransitionError('pledge', current, event.type);
    default:
      return assertUnreachable(current);
  }
}
