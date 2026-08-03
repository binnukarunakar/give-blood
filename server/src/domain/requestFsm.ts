/**
 * Request state machine (pure functions).
 *
 * Canonical source: docs/DATA_MODEL.md "Request state machine" and
 * docs/PROTOCOL.md §4 (accept guard) / §6 (fulfillment). The reconciled accept
 * guard is DECISIONS.md #2.
 *
 *   open → alerting → partially_pledged → covered → fulfilled
 *     \________\____________\_______________\______→ cancelled
 *                \____________\_______________\____→ expired
 *
 * Rules encoded here:
 *  - `alerting` is entered by the first dispatch (open only).
 *  - `pledge_created` moves open|alerting|partially_pledged → partially_pledged,
 *    and → covered once active pledges ≥ coveredThreshold = ceil(units × 1.5).
 *  - A slot release (withdraw/no_show) recounts: covered → partially_pledged,
 *    partially_pledged may stay or drop to alerting, alerting stays — driven by
 *    ctx.activePledges. Dispatch resumes on any regression.
 *  - `fulfilled` is requester-triggered only, from partially_pledged|covered.
 *  - Expire and cancel fire from any non-terminal state.
 *  - Terminal states (fulfilled, expired, cancelled) accept no event.
 *
 * Local string-literal unions only — no import from src/db or src/matching.
 * The schema ticket aligns the enum labels against the same DATA_MODEL.md.
 */

export type RequestState =
  | 'open'
  | 'alerting'
  | 'partially_pledged'
  | 'covered'
  | 'fulfilled'
  | 'expired'
  | 'cancelled';

/** Events as a discriminated union (discriminant: `type`). */
export type RequestEvent =
  | { type: 'first_dispatch_sent' }
  | { type: 'pledge_created' }
  | { type: 'pledge_released_slot' }
  | { type: 'units_confirmed_reached' }
  | { type: 'ttl_expired' }
  | { type: 'requester_cancelled' };

export type RequestEventType = RequestEvent['type'];

export interface RequestContext {
  activePledges: number;
  unitsNeeded: number;
  unitsConfirmed: number;
}

/** Terminal states — accept no event (DATA_MODEL.md marks these *(terminal)*). */
export const REQUEST_TERMINAL_STATES: ReadonlySet<RequestState> = new Set([
  'fulfilled',
  'expired',
  'cancelled',
]);

export function isRequestTerminal(state: RequestState): boolean {
  return REQUEST_TERMINAL_STATES.has(state);
}

/** OVERBOOK_FACTOR (PROTOCOL.md §8): ceil(units × 1.5) is the overbook ceiling. */
const OVERBOOK_FACTOR = 1.5;

export function coveredThreshold(unitsNeeded: number): number {
  return Math.ceil(unitsNeeded * OVERBOOK_FACTOR);
}

/**
 * Reconciled accept guard (DECISIONS.md #2, PROTOCOL.md §4): a pledge may be
 * accepted only while the request is open, alerting, or partially_pledged —
 * never covered (dispatch paused) or terminal.
 */
export function canAcceptPledge(state: RequestState): boolean {
  return (
    state === 'open' || state === 'alerting' || state === 'partially_pledged'
  );
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly machine: 'request' | 'pledge',
    public readonly from: string,
    public readonly event: string,
  ) {
    super(
      `Illegal ${machine} transition: event "${event}" is not permitted in state "${from}"`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/** Compile-time exhaustiveness guard; unreachable at runtime. */
export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable: unexpected value ${String(value)}`);
}

function illegalRequest(from: RequestState, event: RequestEventType): never {
  throw new IllegalTransitionError('request', from, event);
}

/**
 * Result of `pledge_created` from open|alerting|partially_pledged. A pledge now
 * exists (activePledges ≥ 1), so this never yields alerting — only
 * partially_pledged or covered at the overbook boundary.
 */
function afterPledgeCreated(ctx: RequestContext): RequestState {
  return ctx.activePledges >= coveredThreshold(ctx.unitsNeeded)
    ? 'covered'
    : 'partially_pledged';
}

/** Recount after a slot release (withdraw/no_show), driven by ctx.activePledges. */
function afterSlotRelease(ctx: RequestContext): RequestState {
  if (ctx.activePledges >= coveredThreshold(ctx.unitsNeeded)) return 'covered';
  if (ctx.activePledges >= 1) return 'partially_pledged';
  return 'alerting';
}

function fromOpen(event: RequestEvent, ctx: RequestContext): RequestState {
  switch (event.type) {
    case 'first_dispatch_sent':
      return 'alerting';
    case 'pledge_created':
      return afterPledgeCreated(ctx);
    case 'ttl_expired':
      return 'expired';
    case 'requester_cancelled':
      return 'cancelled';
    case 'pledge_released_slot':
    case 'units_confirmed_reached':
      return illegalRequest('open', event.type);
    default:
      return assertUnreachable(event);
  }
}

function fromAlerting(event: RequestEvent, ctx: RequestContext): RequestState {
  switch (event.type) {
    case 'pledge_created':
      return afterPledgeCreated(ctx);
    case 'pledge_released_slot':
      return afterSlotRelease(ctx);
    case 'ttl_expired':
      return 'expired';
    case 'requester_cancelled':
      return 'cancelled';
    case 'first_dispatch_sent':
    case 'units_confirmed_reached':
      return illegalRequest('alerting', event.type);
    default:
      return assertUnreachable(event);
  }
}

function fromPartiallyPledged(
  event: RequestEvent,
  ctx: RequestContext,
): RequestState {
  switch (event.type) {
    case 'pledge_created':
      return afterPledgeCreated(ctx);
    case 'pledge_released_slot':
      return afterSlotRelease(ctx);
    case 'units_confirmed_reached':
      return 'fulfilled';
    case 'ttl_expired':
      return 'expired';
    case 'requester_cancelled':
      return 'cancelled';
    case 'first_dispatch_sent':
      return illegalRequest('partially_pledged', event.type);
    default:
      return assertUnreachable(event);
  }
}

function fromCovered(event: RequestEvent, ctx: RequestContext): RequestState {
  switch (event.type) {
    case 'pledge_released_slot':
      return afterSlotRelease(ctx);
    case 'units_confirmed_reached':
      return 'fulfilled';
    case 'ttl_expired':
      return 'expired';
    case 'requester_cancelled':
      return 'cancelled';
    case 'first_dispatch_sent':
    case 'pledge_created':
      return illegalRequest('covered', event.type);
    default:
      return assertUnreachable(event);
  }
}

/**
 * Pure transition. Returns the next RequestState or throws
 * IllegalTransitionError for any (state, event) pair not on the diagram.
 */
export function transitionRequest(
  current: RequestState,
  event: RequestEvent,
  ctx: RequestContext,
): RequestState {
  switch (current) {
    case 'open':
      return fromOpen(event, ctx);
    case 'alerting':
      return fromAlerting(event, ctx);
    case 'partially_pledged':
      return fromPartiallyPledged(event, ctx);
    case 'covered':
      return fromCovered(event, ctx);
    case 'fulfilled':
    case 'expired':
    case 'cancelled':
      return illegalRequest(current, event.type);
    default:
      return assertUnreachable(current);
  }
}
