import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoControls, type DemoReport } from './DemoControls';

const fetchMock = vi.fn<typeof fetch>();

/** Field names mirror server/src/sweep/sweep.ts SweepReport. */
const SWEEP_REPORT = {
  opened: 1,
  tiersAdvanced: 1,
  dispatched: 3,
  expired: 0,
  pledgesReleased: 0,
  closureNotices: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderControls() {
  const onChanged = vi.fn();
  const onReport = vi.fn<(report: DemoReport) => void>();
  render(<DemoControls onChanged={onChanged} onReport={onReport} />);
  return { onChanged, onReport };
}

/** Answer each demo endpoint separately — the strip now reads /demo/state too. */
function routeByPath(responses: Record<string, unknown>): void {
  fetchMock.mockImplementation((input) =>
    Promise.resolve(jsonResponse(responses[String(input)] ?? {})),
  );
}

/** GET /demo/state with one live request and one that is already over. */
const STATE_WITH_OPEN = {
  hospital: { hospitalId: 'h-1' },
  requests: [
    { requestId: 'req-done', state: 'expired', radiusTier: 2 },
    { requestId: 'req-open', state: 'alerting', radiusTier: 1 },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('demo controls', () => {
  it('posts the sweep and hands its counters to the strip', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(SWEEP_REPORT)));
    const { onChanged, onReport } = renderControls();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sweep' }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/demo/sweep',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => {
      expect(onReport).toHaveBeenCalledWith({
        tone: 'info',
        message:
          'Sweep ran: 1 requests opened, 3 donors alerted, 1 radius tiers advanced, 0 expired.',
      });
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while the sweep is running', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderControls();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sweep' }));

    expect(screen.getByRole('button', { name: 'Sweeping…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  it('posts the reset and confirms it', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const { onChanged, onReport } = renderControls();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Reset' }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/demo/reset',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => {
      expect(onReport).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'info', message: expect.stringMatching(/reseeded/i) }),
      );
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('offers no Expire while there is no open request to expire', async () => {
    routeByPath({ '/demo/state': { requests: [{ requestId: 'req-done', state: 'cancelled' }] } });
    renderControls();

    const expire = screen.getByRole('button', { name: 'Expire' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/demo/state', expect.anything());
    });
    expect(expire).toBeDisabled();
    expect(expire).toHaveAttribute('title', 'No open request to expire.');
  });

  it('backdates the open request and sends the operator to Sweep', async () => {
    routeByPath({
      '/demo/state': STATE_WITH_OPEN,
      '/demo/expire': { requestId: 'req-open', expiresAt: '2026-08-02T00:00:00.000Z' },
    });
    const { onChanged, onReport } = renderControls();

    const expire = screen.getByRole('button', { name: 'Expire' });
    await waitFor(() => {
      expect(expire).toBeEnabled();
    });

    await userEvent.setup().click(expire);

    // It picks the request the sweep would still act on, not the closed one.
    expect(fetchMock).toHaveBeenCalledWith(
      '/demo/expire',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId: 'req-open' }) }),
    );
    await waitFor(() => {
      expect(onReport).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'info', message: expect.stringMatching(/press sweep/i) }),
      );
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a failed expire instead of pretending the clock moved', async () => {
    routeByPath({ '/demo/state': STATE_WITH_OPEN });
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input) === '/demo/expire'
          ? jsonResponse({ error: 'not_found' }, 404)
          : jsonResponse(STATE_WITH_OPEN),
      ),
    );
    const { onChanged, onReport } = renderControls();

    const expire = screen.getByRole('button', { name: 'Expire' });
    await waitFor(() => {
      expect(expire).toBeEnabled();
    });

    await userEvent.setup().click(expire);

    await waitFor(() => {
      expect(onReport).toHaveBeenCalledWith({
        tone: 'error',
        message: 'The demo server answered 404 for /demo/expire.',
      });
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports a failed sweep instead of pretending it ran', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'internal' }, 500)));
    const { onChanged, onReport } = renderControls();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sweep' }));

    await waitFor(() => {
      expect(onReport).toHaveBeenCalledWith({
        tone: 'error',
        message: 'The demo server answered 500 for /demo/sweep.',
      });
    });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
