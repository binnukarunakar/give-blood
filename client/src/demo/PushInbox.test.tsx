import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushInbox } from './PushInbox';

const fetchMock = vi.fn<typeof fetch>();

const POLL_MS = 3_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ALERT_PUSH = {
  id: 'push-1',
  toHandle: 'nightbird',
  payload: { type: 'BLOOD_ALERT', alertId: 'alert-9' },
  sentAt: '2026-07-31T10:00:00.000Z',
};

const VERIFY_PUSH = {
  id: 'push-2',
  toHandle: 'nightbird',
  payload: { type: 'VERIFY_PUSH' },
  sentAt: '2026-07-31T10:01:00.000Z',
};

/** Stands in for the real alert route: proves where the tap lands. */
function AlertProbe(): ReactElement {
  const { alertId } = useParams<{ alertId: string }>();
  return <p>{`alert page ${alertId ?? ''}`}</p>;
}

function renderInbox(): void {
  render(
    <MemoryRouter initialEntries={['/donor']}>
      <Routes>
        <Route path="/donor" element={<PushInbox refreshToken={0} />} />
        <Route path="/alerts/:alertId" element={<AlertProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The inbox opens as a pill (DESIGN.md); every content test expands it first. */
async function openInbox(): Promise<void> {
  await userEvent.setup().click(await screen.findByRole('button', { name: /^push inbox/i }));
}

/** A StickyBar rendered by some other screen, as far as the DOM is concerned. */
function mountStickyBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'sticky-bar';
  document.body.appendChild(bar);
  return bar;
}

/** Likewise a ConfirmSheet: the inbox watches for the element, not for a prop. */
function mountConfirmSheet(): HTMLElement {
  const sheet = document.createElement('div');
  sheet.className = 'confirm-sheet';
  document.body.appendChild(sheet);
  return sheet;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * jsdom has no layout, so the overlap check is fed rects by selector. Anything
 * not listed measures zero, which the check reads as "not on screen".
 */
const RECTS = new Map<string, Box>();

function stubGeometry(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const entry = [...RECTS].find(([selector]) => this.matches(selector));
    const box: Box = entry?.[1] ?? { left: 0, top: 0, right: 0, bottom: 0 };
    // jsdom lays nothing out, so the transform the component uses to climb out
    // of the way has to be honoured here or the search would measure a pill
    // that never moves.
    const shift = /translateY\((-?[\d.]+)px\)/.exec(this.style.transform);
    const dy = shift === null ? 0 : Number(shift[1]);
    return {
      ...box,
      top: box.top + dy,
      bottom: box.bottom + dy,
      x: box.left,
      y: box.top + dy,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

let controls = 0;

/** A control belonging to the page under the pill, at a known position. */
function mountControl(tag: 'button' | 'a', box: Box): HTMLElement {
  const marker = `page-control-${String(controls)}`;
  controls += 1;
  const node = document.createElement(tag);
  node.className = `page-control ${marker}`;
  document.body.appendChild(node);
  RECTS.set(`.${marker}`, box);
  return node;
}

/** How far up the pill has climbed, in px. */
function liftOf(pill: HTMLElement): number {
  const shift = /translateY\((-?[\d.]+)px\)/.exec(pill.style.transform);
  return shift === null ? 0 : -Number(shift[1]);
}

/** The pill occupies the bottom-right corner of a 390x844 phone. */
const PILL_BOX: Box = { left: 250, top: 780, right: 358, bottom: 816 };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  RECTS.clear();
  controls = 0;
  for (const node of document.querySelectorAll('.sticky-bar, .confirm-sheet, .page-control')) {
    node.remove();
  }
});

describe('push inbox', () => {
  it('renders a blood alert with the payload that crossed the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();
    await openInbox();

    expect(screen.getByText('BLOOD_ALERT')).toBeInTheDocument();
    expect(screen.getByText('to nightbird')).toBeInTheDocument();
    expect(screen.getByText(/"alertId":"alert-9"/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/demo/pushes',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('counts the waiting notifications on the collapsed pill', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH, VERIFY_PUSH] }));
    renderInbox();

    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.queryByText('BLOOD_ALERT')).not.toBeInTheDocument();
  });

  it('opens /alerts/<alertId> when a blood alert is tapped', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();
    await openInbox();
    const open = await screen.findByRole('link', { name: 'Open this alert' });

    await userEvent.setup().click(open);

    expect(screen.getByText('alert page alert-9')).toBeInTheDocument();
  });

  it('gives a verification probe no tap target: it carries no alert id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [VERIFY_PUSH] }));
    renderInbox();
    await openInbox();

    expect(screen.getByText('VERIFY_PUSH')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open this alert' })).not.toBeInTheDocument();
  });

  it('lists the newest notification first', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH, VERIFY_PUSH] }));
    renderInbox();
    await openInbox();

    const rows = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('VERIFY_PUSH');
    expect(rows[1]).toContain('BLOOD_ALERT');
  });

  it('says the inbox is empty rather than showing a blank card', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [] }));
    renderInbox();
    await openInbox();

    expect(await screen.findByText(/no notifications yet/i)).toBeInTheDocument();
  });

  it('says so when the demo server is not answering', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    renderInbox();
    await openInbox();

    expect(await screen.findByRole('alert')).toHaveTextContent(/demo server did not answer/i);
  });

  it('collapses to the pill while a sticky action bar is on screen', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();
    await openInbox();
    expect(screen.getByText('BLOOD_ALERT')).toBeInTheDocument();

    const bar = mountStickyBar();

    expect(await screen.findByRole('button', { name: /^push inbox/i })).toBeDisabled();
    expect(screen.queryByText('BLOOD_ALERT')).not.toBeInTheDocument();

    bar.remove();

    expect(await screen.findByText('BLOOD_ALERT')).toBeInTheDocument();
  });

  it('takes itself off screen entirely while a confirm sheet is open', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();
    await openInbox();

    const sheet = mountConfirmSheet();

    // Not collapsed to a pill, as it is for the sticky bar: the sheet sits in
    // normal flow anywhere down the page, so the only position guaranteed to
    // clear the confirm button is off the screen (GB-33 — the pill was landing
    // on "Yes, they donated").
    await waitFor(() => {
      expect(screen.getByLabelText('Demo push inbox')).not.toBeVisible();
    });
    expect(screen.queryByText('BLOOD_ALERT')).not.toBeInTheDocument();

    sheet.remove();

    expect(await screen.findByText('BLOOD_ALERT')).toBeInTheDocument();
    expect(screen.getByLabelText('Demo push inbox')).toBeVisible();
  });

  it('climbs clear of a control instead of sitting on it', async () => {
    RECTS.set('.inbox-pill', PILL_BOX);
    // A switch parked at the foot of the viewport, under the pill — the donor
    // home consent row from the GB-33 finding.
    mountControl('button', { left: 300, top: 790, right: 340, bottom: 814 });
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    await waitFor(() => {
      expect(liftOf(pill)).toBeGreaterThan(0);
    });
    // Moved, not dimmed: the inbox is still openable where it now sits.
    expect(pill).not.toHaveClass('is-ghost');
    expect(pill).toBeEnabled();
    // 8px steps, and it stops at the first clear one rather than fleeing.
    expect(liftOf(pill) % 8).toBe(0);
    expect(PILL_BOX.top - liftOf(pill)).toBeLessThan(790);
  });

  it('opens on a click at its landing position', async () => {
    RECTS.set('.inbox-pill', PILL_BOX);
    mountControl('button', { left: 300, top: 790, right: 340, bottom: 814 });
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    await waitFor(() => {
      expect(liftOf(pill)).toBeGreaterThan(0);
    });

    await userEvent.setup().click(pill);

    expect(screen.getByText('BLOOD_ALERT')).toBeInTheDocument();
  });

  it('stays home when nothing interactive is underneath', async () => {
    RECTS.set('.inbox-pill', PILL_BOX);
    // Same overlap, but it is prose. Copy is not something anyone taps.
    const text = document.createElement('p');
    text.className = 'page-control';
    document.body.appendChild(text);
    RECTS.set('.page-control', { left: 300, top: 790, right: 340, bottom: 814 });
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(liftOf(pill)).toBe(0);
    expect(pill).not.toHaveClass('is-ghost');
  });

  it('climbs for a control that only arrives after its fetch resolves', async () => {
    // Donor home renders skeletons first: the switch the pill ends up covering
    // appears with no scroll and no resize to announce it.
    RECTS.set('.inbox-pill', PILL_BOX);
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    expect(liftOf(pill)).toBe(0);

    mountControl('button', { left: 300, top: 790, right: 340, bottom: 814 });

    await waitFor(() => {
      expect(liftOf(pill)).toBeGreaterThan(0);
    });
  });

  it('drops back home once scrolling clears the overlap', async () => {
    RECTS.set('.inbox-pill', PILL_BOX);
    mountControl('a', { left: 300, top: 790, right: 340, bottom: 814 });
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    await waitFor(() => {
      expect(liftOf(pill)).toBeGreaterThan(0);
    });

    // The page scrolls; the control moves up and out from under the pill.
    RECTS.set('.page-control-0', { left: 300, top: 300, right: 340, bottom: 324 });
    window.dispatchEvent(new Event('scroll'));

    await waitFor(() => {
      expect(liftOf(pill)).toBe(0);
    });
  });

  it('ghosts only when there is nowhere clear to climb to', async () => {
    RECTS.set('.inbox-pill', PILL_BOX);
    // A control tall enough to block every candidate within the 40% ceiling.
    mountControl('button', { left: 200, top: 100, right: 390, bottom: 830 });
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    await waitFor(() => {
      expect(pill).toHaveClass('is-ghost');
    });
    // Back home and inert, so the tap lands on the control instead.
    expect(liftOf(pill)).toBe(0);
    expect(pill).toBeVisible();
  });

  it('does not climb away from its own chrome', async () => {
    // The pill's own rect trivially overlaps the pill. Demo chrome is skipped,
    // so the only thing under it is not counted against it.
    RECTS.set('.inbox-pill', PILL_BOX);
    stubGeometry();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [ALERT_PUSH] }));
    renderInbox();

    const pill = await screen.findByRole('button', { name: /^push inbox/i });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(liftOf(pill)).toBe(0);
    expect(pill).not.toHaveClass('is-ghost');
  });

  it('polls every 3 seconds so an alert appears without a reload', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ pushes: [] }));
    renderInbox();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
