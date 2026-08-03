import { describe, expect, test } from 'vitest';
import {
  IllegalTransitionError,
  REQUEST_TERMINAL_STATES,
  canAcceptPledge,
  coveredThreshold,
  isRequestTerminal,
  transitionRequest,
  type RequestContext,
  type RequestEvent,
  type RequestEventType,
  type RequestState,
} from './requestFsm.js';

const REQUEST_STATES: readonly RequestState[] = [
  'open',
  'alerting',
  'partially_pledged',
  'covered',
  'fulfilled',
  'expired',
  'cancelled',
];

const REQUEST_EVENTS: readonly RequestEvent[] = [
  { type: 'first_dispatch_sent' },
  { type: 'pledge_created' },
  { type: 'pledge_released_slot' },
  { type: 'units_confirmed_reached' },
  { type: 'ttl_expired' },
  { type: 'requester_cancelled' },
];

/** units=2 → coveredThreshold=3, so activePledges 1,2 = partial, 3 = covered. */
const ctx = (activePledges: number, unitsConfirmed = 0): RequestContext => ({
  activePledges,
  unitsNeeded: 2,
  unitsConfirmed,
});

const DEFAULT_CTX = ctx(0);

type Cell = { outcome: RequestState; ctx: RequestContext } | { outcome: 'throws' };

/**
 * The full (state × event) truth table, transcribed from the DATA_MODEL.md
 * diagram — NOT re-derived from the implementation. The `Record` keys force
 * every one of the 42 cells to be present (compile-time totality).
 */
const ORACLE: Record<RequestState, Record<RequestEventType, Cell>> = {
  open: {
    first_dispatch_sent: { outcome: 'alerting', ctx: ctx(0) },
    pledge_created: { outcome: 'partially_pledged', ctx: ctx(1) },
    pledge_released_slot: { outcome: 'throws' },
    units_confirmed_reached: { outcome: 'throws' },
    ttl_expired: { outcome: 'expired', ctx: ctx(0) },
    requester_cancelled: { outcome: 'cancelled', ctx: ctx(0) },
  },
  alerting: {
    first_dispatch_sent: { outcome: 'throws' },
    pledge_created: { outcome: 'partially_pledged', ctx: ctx(1) },
    pledge_released_slot: { outcome: 'alerting', ctx: ctx(0) },
    units_confirmed_reached: { outcome: 'throws' },
    ttl_expired: { outcome: 'expired', ctx: ctx(0) },
    requester_cancelled: { outcome: 'cancelled', ctx: ctx(0) },
  },
  partially_pledged: {
    first_dispatch_sent: { outcome: 'throws' },
    pledge_created: { outcome: 'covered', ctx: ctx(3) },
    pledge_released_slot: { outcome: 'partially_pledged', ctx: ctx(1) },
    units_confirmed_reached: { outcome: 'fulfilled', ctx: ctx(1, 2) },
    ttl_expired: { outcome: 'expired', ctx: ctx(1) },
    requester_cancelled: { outcome: 'cancelled', ctx: ctx(1) },
  },
  covered: {
    first_dispatch_sent: { outcome: 'throws' },
    pledge_created: { outcome: 'throws' },
    pledge_released_slot: { outcome: 'partially_pledged', ctx: ctx(2) },
    units_confirmed_reached: { outcome: 'fulfilled', ctx: ctx(3, 2) },
    ttl_expired: { outcome: 'expired', ctx: ctx(3) },
    requester_cancelled: { outcome: 'cancelled', ctx: ctx(3) },
  },
  fulfilled: allThrows(),
  expired: allThrows(),
  cancelled: allThrows(),
};

function allThrows(): Record<RequestEventType, Cell> {
  return {
    first_dispatch_sent: { outcome: 'throws' },
    pledge_created: { outcome: 'throws' },
    pledge_released_slot: { outcome: 'throws' },
    units_confirmed_reached: { outcome: 'throws' },
    ttl_expired: { outcome: 'throws' },
    requester_cancelled: { outcome: 'throws' },
  };
}

describe('transitionRequest — exhaustive (state × event) matrix', () => {
  for (const state of REQUEST_STATES) {
    for (const event of REQUEST_EVENTS) {
      const cell = ORACLE[state][event.type];
      if (cell.outcome === 'throws') {
        test(`${state} --${event.type}--> ILLEGAL`, () => {
          expect(() => transitionRequest(state, event, DEFAULT_CTX)).toThrow(
            IllegalTransitionError,
          );
        });
      } else {
        test(`${state} --${event.type}--> ${cell.outcome}`, () => {
          expect(transitionRequest(state, event, cell.ctx)).toBe(cell.outcome);
        });
      }
    }
  }
});

describe('coveredThreshold = ceil(units × 1.5)', () => {
  test.each([
    [1, 2],
    [2, 3],
    [3, 5],
    [4, 6],
    [6, 9],
  ])('coveredThreshold(%i) = %i', (units, threshold) => {
    expect(coveredThreshold(units)).toBe(threshold);
  });
});

describe('pledge_created boundary (units=2, threshold=3)', () => {
  const ev: RequestEvent = { type: 'pledge_created' };
  for (const src of ['open', 'alerting', 'partially_pledged'] as const) {
    test(`${src}: activePledges 1,2 → partially_pledged`, () => {
      expect(transitionRequest(src, ev, ctx(1))).toBe('partially_pledged');
      expect(transitionRequest(src, ev, ctx(2))).toBe('partially_pledged');
    });
    test(`${src}: activePledges 3 (= threshold) → covered`, () => {
      expect(transitionRequest(src, ev, ctx(3))).toBe('covered');
    });
  }
  test('covered rejects further pledge_created (dispatch paused)', () => {
    expect(() => transitionRequest('covered', ev, ctx(3))).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('pledge_released_slot recount', () => {
  const ev: RequestEvent = { type: 'pledge_released_slot' };
  test('covered → partially_pledged when count drops below threshold', () => {
    expect(transitionRequest('covered', ev, ctx(2))).toBe('partially_pledged');
  });
  test('covered stays covered while still at/above threshold', () => {
    expect(transitionRequest('covered', ev, ctx(3))).toBe('covered');
  });
  test('covered → alerting if all pledges released', () => {
    expect(transitionRequest('covered', ev, ctx(0))).toBe('alerting');
  });
  test('partially_pledged stays while ≥ 1 pledge remains', () => {
    expect(transitionRequest('partially_pledged', ev, ctx(1))).toBe(
      'partially_pledged',
    );
  });
  test('partially_pledged → alerting on release to zero', () => {
    expect(transitionRequest('partially_pledged', ev, ctx(0))).toBe('alerting');
  });
  test('alerting stays alerting (no pledges to release)', () => {
    expect(transitionRequest('alerting', ev, ctx(0))).toBe('alerting');
  });
});

describe('canAcceptPledge — accept guard (DECISIONS.md #2)', () => {
  test.each([
    ['open', true],
    ['alerting', true],
    ['partially_pledged', true],
    ['covered', false],
    ['fulfilled', false],
    ['expired', false],
    ['cancelled', false],
  ] as const)('canAcceptPledge(%s) = %s', (state, allowed) => {
    expect(canAcceptPledge(state)).toBe(allowed);
  });
});

describe('terminal set + fulfilled reachability', () => {
  test('REQUEST_TERMINAL_STATES = {fulfilled, expired, cancelled}', () => {
    expect([...REQUEST_TERMINAL_STATES].sort()).toEqual([
      'cancelled',
      'expired',
      'fulfilled',
    ]);
  });
  test('isRequestTerminal matches the set', () => {
    for (const state of REQUEST_STATES) {
      expect(isRequestTerminal(state)).toBe(REQUEST_TERMINAL_STATES.has(state));
    }
  });
  test('fulfilled is unreachable directly from open or alerting', () => {
    const ev: RequestEvent = { type: 'units_confirmed_reached' };
    expect(() => transitionRequest('open', ev, ctx(0))).toThrow(
      IllegalTransitionError,
    );
    expect(() => transitionRequest('alerting', ev, ctx(0))).toThrow(
      IllegalTransitionError,
    );
  });
  test('IllegalTransitionError carries machine="request"', () => {
    try {
      transitionRequest('fulfilled', { type: 'pledge_created' }, DEFAULT_CTX);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).machine).toBe('request');
    }
  });
});
