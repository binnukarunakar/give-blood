// The three demo levers, as ghost buttons on the right of the persona strip.
//
// "Sweep" fires POST /demo/sweep by hand. In production that call is made by
// Cloud Scheduler every 60 s and it is what advances the radius tier, expires
// requests and sends closure notices (docs/PROTOCOL.md, "At a glance") — no
// in-process timers exist, so nothing moves in a demo until it is called.
//
// "Expire" backdates the open request's TTL so the next Sweep expires it. A
// real request lives 12 to 24 hours, which is longer than anyone will sit in
// front of a demo, so without this the expired state — closure notices, pledges
// released — is reachable only by curl (GB-33c).
//
// "Reset" reseeds the in-memory database and clears the push log.
//
// No button prints its own status: DESIGN.md gives the strip ONE status line,
// and the strip owns it, so outcomes are handed up through onReport.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '../ui';
import {
  expireDemoRequest,
  fetchDemoOpenRequestId,
  resetDemoData,
  runDemoSweep,
  type DemoSweepReport,
} from './demoApi';

type Busy = 'sweep' | 'expire' | 'reset' | null;

/** Same cadence as the push inbox: a request raised on another screen shows up
 *  here without the operator having to press anything first. */
const OPEN_POLL_MS = 3_000;

export interface DemoReport {
  message: string;
  tone: 'info' | 'error';
}

export interface DemoControlsProps {
  /** Fired after a successful sweep or reset, so the push inbox re-reads. */
  onChanged: () => void;
  /** Every outcome, success or failure, for the strip's one status line. */
  onReport: (report: DemoReport) => void;
}

const RESET_DONE = 'Demo data reseeded. Requests, pledges and the push inbox are cleared.';
const EXPIRE_DONE =
  'Deadline moved into the past. Press Sweep to expire the request for real — pledges released, closure notices sent.';
const NO_OPEN_REQUEST = 'No open request to expire.';

function sweepMessage(report: DemoSweepReport): string {
  return [
    `Sweep ran: ${String(report.opened)} requests opened`,
    `${String(report.dispatched)} donors alerted`,
    `${String(report.tiersAdvanced)} radius tiers advanced`,
    `${String(report.expired)} expired.`,
  ].join(', ');
}

export function DemoControls({ onChanged, onReport }: DemoControlsProps): ReactElement {
  const [busy, setBusy] = useState<Busy>(null);
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);

  // `live` gates the write, not the fetch: a poll that lands after the strip is
  // gone (a persona switch remounts the whole subtree) must not set state on a
  // component nobody is looking at any more.
  const live = useRef(true);
  const readOpen = useCallback(async (): Promise<void> => {
    const result = await fetchDemoOpenRequestId();
    if (live.current) setOpenRequestId(result.ok ? result.data : null);
  }, []);

  useEffect(() => {
    live.current = true;
    void readOpen();
    const timer = setInterval(() => void readOpen(), OPEN_POLL_MS);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [readOpen]);

  async function sweep(): Promise<void> {
    setBusy('sweep');
    const result = await runDemoSweep();
    setBusy(null);
    if (!result.ok) {
      onReport({ message: result.error, tone: 'error' });
      return;
    }
    onReport({ message: sweepMessage(result.data), tone: 'info' });
    void readOpen();
    onChanged();
  }

  async function expire(): Promise<void> {
    if (openRequestId === null) return;
    setBusy('expire');
    const result = await expireDemoRequest(openRequestId);
    setBusy(null);
    if (!result.ok) {
      onReport({ message: result.error, tone: 'error' });
      return;
    }
    onReport({ message: EXPIRE_DONE, tone: 'info' });
    onChanged();
  }

  async function reset(): Promise<void> {
    setBusy('reset');
    const result = await resetDemoData();
    setBusy(null);
    if (!result.ok) {
      onReport({ message: result.error, tone: 'error' });
      return;
    }
    onReport({ message: RESET_DONE, tone: 'info' });
    setOpenRequestId(null);
    onChanged();
  }

  return (
    <div className="demo-actions">
      <Button variant="ghost" disabled={busy !== null} onClick={() => void sweep()}>
        {busy === 'sweep' ? 'Sweeping…' : 'Sweep'}
      </Button>
      <Button
        variant="ghost"
        disabled={busy !== null || openRequestId === null}
        title={openRequestId === null ? NO_OPEN_REQUEST : undefined}
        onClick={() => void expire()}
      >
        {busy === 'expire' ? 'Expiring…' : 'Expire'}
      </Button>
      <Button variant="ghost" disabled={busy !== null} onClick={() => void reset()}>
        {busy === 'reset' ? 'Resetting…' : 'Reset'}
      </Button>
    </div>
  );
}
