// Simulated device notifications, as the floating inbox DESIGN.md § Demo
// chrome specifies: a collapsed pill with a badge count, expanding to a 320px
// card (a bottom sheet on a phone) of quiet mono rows, newest first.
//
// Real web push needs HTTPS and a live FCM project, so on a laptop a donor
// would never see an alert and the core loop would be invisible. This panel
// polls the demo server for the pushes it has sent.
//
// The fetch-on-tap architecture is preserved exactly (docs/PROTOCOL.md §3): a
// row shows the payload and nothing else, and opening it navigates to
// /alerts/<alertId>, where the page fetches the request behind donor auth. The
// raw JSON is on screen on purpose, so it is visible that the payload carries a
// type and an opaque id and no medical detail whatsoever.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Button, CloseIcon } from '../ui';
import { fetchDemoPushes, pushAlertId, pushType, type DemoPush } from './demoApi';
import { usePillPlacement } from './pillPlacement';

const POLL_MS = 3_000;

const TITLE = 'Push inbox — what each phone would receive';
const LOADING = 'Loading simulated notifications…';
const EMPTY = 'No notifications yet. Raise a request as City Hospital, then run a sweep.';

/**
 * Newest first. The server returns send order, so reversing is enough; the
 * sort then corrects any clock ordering and keeps ties in reversed order.
 */
function newestFirst(pushes: DemoPush[]): DemoPush[] {
  return [...pushes].reverse().sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

function clockTime(sentAt: string): string {
  const at = new Date(sentAt);
  return Number.isNaN(at.getTime()) ? sentAt : at.toLocaleTimeString();
}

/** Clearance between the pill and the bar it sits above. */
const PILL_GAP_PX = 8;


interface ObstructionState {
  /** True while a StickyBar is mounted anywhere. */
  bar: boolean;
  /** Its measured height, or 0 when there is none (and under jsdom, always). */
  barHeight: number;
  /** True while a ConfirmSheet is open anywhere. */
  sheet: boolean;
}

/**
 * Watches the two surfaces the inbox has to keep clear of (DESIGN.md — demo
 * chrome may never overlap the decision bar; GB-33 extends that to the confirm
 * sheet, which the pill was landing on top of, covering the confirm button of
 * "Confirm this donor arrived and donated?").
 *
 * Both are shared primitives this file does not own, so the check is for their
 * elements rather than a prop or a body class each would have to set. StickyBar
 * portals into document.body, which the subtree watch below still sees.
 *
 * Height as well as presence, for the bar: Accept expands it with an eta row
 * and a switch, more than doubling it, and the pill rides above whatever it
 * becomes. Presence is deliberately NOT derived from height — a layout-less DOM
 * (jsdom) measures every element at zero, and the rules must still hold there.
 *
 * A sheet gets no height treatment because it is in normal flow and can be
 * anywhere down the page: there is no "above" to move to, so the pill goes.
 */
function useObstructions(): ObstructionState {
  const [state, setState] = useState<ObstructionState>({
    bar: false,
    barHeight: 0,
    sheet: false,
  });

  useEffect(() => {
    // Returns the SAME state object when nothing moved, so React bails out of
    // the render. Without that, the mutation observer below would see its own
    // re-render as a change and measure again, forever.
    const measure = (bar: Element | null): void => {
      const next: ObstructionState = {
        bar: bar !== null,
        barHeight: bar === null ? 0 : bar.getBoundingClientRect().height,
        sheet: document.querySelector('.confirm-sheet') !== null,
      };
      setState((current) =>
        current.bar === next.bar &&
        current.barHeight === next.barHeight &&
        current.sheet === next.sheet
          ? current
          : next,
      );
    };

    // Absent in jsdom. The expand-tracking is then simply not available, which
    // costs a test environment nothing: it has no layout to track.
    const sizes =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry !== undefined) measure(entry.target);
          });
    let watched: Element | null = null;

    const check = (): void => {
      const bar = document.querySelector('.sticky-bar');
      if (bar !== watched) {
        if (watched !== null) sizes?.unobserve(watched);
        watched = bar;
        if (bar !== null) sizes?.observe(bar);
      }
      measure(bar);
    };

    check();
    const tree = new MutationObserver(check);
    tree.observe(document.body, { childList: true, subtree: true });
    return () => {
      tree.disconnect();
      sizes?.disconnect();
    };
  }, []);

  return state;
}

export function PushInbox({ refreshToken }: { refreshToken: number }): ReactElement {
  const [pushes, setPushes] = useState<DemoPush[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { bar: stickyBar, barHeight, sheet } = useObstructions();
  const open = expanded && !stickyBar && !sheet;
  const pillRef = useRef<HTMLButtonElement>(null);
  // Above the bar, never inside it. demo.css reads --inbox-bottom for the pill
  // at both sizes; unset, its own safe-area default stands. No inset is added
  // here — the bar we are clearing already sits on top of it. This is the
  // pill's resting place; usePillPlacement climbs from it.
  const barClearance =
    barHeight > 0
      ? ({ '--inbox-bottom': `${String(barHeight + PILL_GAP_PX)}px` } as CSSProperties)
      : undefined;

  const load = useCallback(async (): Promise<void> => {
    const result = await fetchDemoPushes();
    if (result.ok) {
      setPushes(newestFirst(result.data));
      setError(null);
      return;
    }
    setError(result.error);
  }, []);

  // Polls whether open or collapsed: the badge count is the whole point of the
  // pill. refreshToken re-runs the effect right after a sweep or reset instead
  // of making the demo wait out the poll interval.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, refreshToken]);

  const count = pushes?.length ?? 0;
  const { lift, ghost } = usePillPlacement(
    pillRef,
    `${String(open)}|${String(sheet)}|${String(count)}`,
  );

  return (
    // Gone, not dimmed, while a confirm sheet is open: the sheet can be anywhere
    // down the page, so there is no position left that is guaranteed to clear
    // it, and a demo instrument may not stand between a requester and the button
    // that records a donation. `hidden` also takes it out of the hit test —
    // demoInbox.css restores the display:none the .demo-inbox rule would win.
    <aside className="demo-inbox" aria-label="Demo push inbox" style={barClearance} hidden={sheet}>
      {open ? (
        <div className="inbox-card">
          <div className="inbox-head">
            <p className="inbox-title">{TITLE}</p>
            <Button variant="ghost" aria-label="Close push inbox" onClick={() => setExpanded(false)}>
              <CloseIcon size={16} />
            </Button>
          </div>

          {error === null ? null : (
            <p className="inbox-error" role="alert">
              {error}
            </p>
          )}

          {pushes === null && error === null ? <p className="inbox-note">{LOADING}</p> : null}
          {pushes !== null && pushes.length === 0 ? <p className="inbox-note">{EMPTY}</p> : null}

          <ul className="inbox-rows">
            {(pushes ?? []).map((push) => (
              <PushRow key={push.id} push={push} />
            ))}
          </ul>
        </div>
      ) : (
        <button
          ref={pillRef}
          type="button"
          className={ghost ? 'inbox-pill is-ghost' : 'inbox-pill'}
          style={lift === 0 ? undefined : { transform: `translateY(-${String(lift)}px)` }}
          disabled={stickyBar}
          title={
            stickyBar
              ? 'Collapsed while an action bar is on screen'
              : ghost
                ? 'Dimmed while it sits over a control'
                : undefined
          }
          onClick={() => setExpanded(true)}
        >
          Push inbox
          {count === 0 ? null : <span className="inbox-badge">{count}</span>}
        </button>
      )}
    </aside>
  );
}

function PushRow({ push }: { push: DemoPush }): ReactElement {
  const alertId = pushAlertId(push.payload);
  return (
    <li className="inbox-row">
      <div className="inbox-row-head">
        <span className="inbox-type">{pushType(push.payload)}</span>
        <span>to {push.toHandle}</span>
        <span className="inbox-time">{clockTime(push.sentAt)}</span>
        {alertId === null ? null : (
          <Link
            className="inbox-open"
            aria-label="Open this alert"
            to={`/alerts/${encodeURIComponent(alertId)}`}
          >
            Open
          </Link>
        )}
      </div>
      <code className="inbox-payload">{JSON.stringify(push.payload)}</code>
    </li>
  );
}
