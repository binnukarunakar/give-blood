import { describe, expect, test } from 'vitest';
import { IllegalTransitionError } from './requestFsm.js';
import {
  PLEDGE_SIDE_EFFECTS,
  PLEDGE_TERMINAL_STATES,
  isPledgeTerminal,
  transitionPledge,
  type PledgeEvent,
  type PledgeEventType,
  type PledgeState,
} from './pledgeFsm.js';

const PLEDGE_STATES: readonly PledgeState[] = [
  'active',
  'donated',
  'withdrawn',
  'no_show',
  'released',
];

const PLEDGE_EVENTS: readonly PledgeEvent[] = [
  { type: 'requester_confirmed_donation' },
  { type: 'donor_withdrew' },
  { type: 'requester_marked_no_show' },
  { type: 'request_closed' },
];

type Cell = PledgeState | 'throws';

/**
 * Full (state × event) truth table from DATA_MODEL.md — only `active` has
 * outgoing edges; every terminal state rejects all four events. The `Record`
 * keys force all 20 cells to be present (compile-time totality).
 */
const ORACLE: Record<PledgeState, Record<PledgeEventType, Cell>> = {
  active: {
    requester_confirmed_donation: 'donated',
    donor_withdrew: 'withdrawn',
    requester_marked_no_show: 'no_show',
    request_closed: 'released',
  },
  donated: allThrows(),
  withdrawn: allThrows(),
  no_show: allThrows(),
  released: allThrows(),
};

function allThrows(): Record<PledgeEventType, Cell> {
  return {
    requester_confirmed_donation: 'throws',
    donor_withdrew: 'throws',
    requester_marked_no_show: 'throws',
    request_closed: 'throws',
  };
}

describe('transitionPledge — exhaustive (state × event) matrix', () => {
  for (const state of PLEDGE_STATES) {
    for (const event of PLEDGE_EVENTS) {
      const expected = ORACLE[state][event.type];
      if (expected === 'throws') {
        test(`${state} --${event.type}--> ILLEGAL`, () => {
          expect(() => transitionPledge(state, event)).toThrow(
            IllegalTransitionError,
          );
        });
      } else {
        test(`${state} --${event.type}--> ${expected}`, () => {
          expect(transitionPledge(state, event)).toBe(expected);
        });
      }
    }
  }
});

describe('terminal set', () => {
  test('PLEDGE_TERMINAL_STATES = {donated, withdrawn, no_show, released}', () => {
    expect([...PLEDGE_TERMINAL_STATES].sort()).toEqual([
      'donated',
      'no_show',
      'released',
      'withdrawn',
    ]);
  });
  test('active is the only non-terminal state', () => {
    for (const state of PLEDGE_STATES) {
      expect(isPledgeTerminal(state)).toBe(state !== 'active');
    }
  });
  test('every terminal state rejects every event', () => {
    for (const state of PLEDGE_STATES) {
      if (state === 'active') continue;
      for (const event of PLEDGE_EVENTS) {
        expect(() => transitionPledge(state, event)).toThrow(
          IllegalTransitionError,
        );
      }
    }
  });
});

describe('side-effect contract (documentation constant)', () => {
  test('keys are exactly the four terminal states — active has no side effect', () => {
    expect(Object.keys(PLEDGE_SIDE_EFFECTS).sort()).toEqual([
      'donated',
      'no_show',
      'released',
      'withdrawn',
    ]);
    expect(PLEDGE_SIDE_EFFECTS).not.toHaveProperty('active');
  });
  test('donated is the cooldown-stamping edge; released is not (bench deferral)', () => {
    expect(PLEDGE_SIDE_EFFECTS.donated).toContain('last_donation_at');
    expect(PLEDGE_SIDE_EFFECTS.released).toContain('NO cooldown');
    expect(PLEDGE_SIDE_EFFECTS.released).not.toContain('last_donation_at');
  });
});

describe('IllegalTransitionError shape', () => {
  test('carries machine="pledge" and the offending state/event', () => {
    try {
      transitionPledge('donated', { type: 'donor_withdrew' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      const e = err as IllegalTransitionError;
      expect(e.machine).toBe('pledge');
      expect(e.from).toBe('donated');
      expect(e.event).toBe('donor_withdrew');
    }
  });
});
