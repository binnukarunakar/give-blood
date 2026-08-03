import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PledgeCard, RequestDetail } from '../lib/apiTypes';
import { RequestDetailPage } from './RequestDetail';

const apiMock = vi.hoisted(() => ({
  getRequest: vi.fn(),
  markPledgeDonated: vi.fn(),
  markPledgeNoShow: vi.fn(),
  cancelRequest: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock, TRANSPORT_STATUS: 0 }));

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const POLL_MS = 12_000;

const PLEDGE: PledgeCard = {
  pledgeId: 'p-1',
  donorHandle: 'nightbird',
  donorBloodGroup: 'O-',
  donorPhone: 'DONOR_PHONE',
  etaBucket: 'le_30m',
  state: 'active',
  createdAt: '2026-07-31T10:05:00.000Z',
};

const DETAIL: RequestDetail = {
  requestId: REQUEST_ID,
  bloodGroup: 'B+',
  unitsNeeded: 2,
  unitsConfirmed: 0,
  urgency: 'critical',
  state: 'partially_pledged',
  radiusTier: 1,
  hospitalId: '22222222-3333-4444-8555-666666666666',
  createdAt: '2026-07-31T10:00:00.000Z',
  expiresAt: '2026-07-31T16:00:00.000Z',
  donorsAlerted: 12,
  activePledges: 1,
  hospital: {
    name: 'Midtown Hospital',
    address: '1 Example Plaza',
    bloodbankPhone: 'HOSPITAL_BLOODBANK_PHONE',
  },
  pledges: [PLEDGE],
};

function detailOk(overrides: Partial<RequestDetail> = {}) {
  return { ok: true as const, status: 200, data: { ...DETAIL, ...overrides } };
}

/** `state` is what RequesterHome hands over after POST /requests. */
function renderDetail(state?: { created?: boolean; warning?: string }): void {
  render(
    <MemoryRouter
      initialEntries={[{ pathname: `/requester/requests/${REQUEST_ID}`, state }]}
    >
      <Routes>
        <Route path="/requester/requests/:requestId" element={<RequestDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Flush pending promises and timers together — the poll tests run on fake timers. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  apiMock.getRequest.mockResolvedValue(detailOk());
  apiMock.markPledgeDonated.mockResolvedValue({
    ok: true,
    status: 200,
    data: { pledgeState: 'donated', requestState: 'fulfilled', unitsConfirmed: 1 },
  });
  apiMock.markPledgeNoShow.mockResolvedValue({
    ok: true,
    status: 200,
    data: { pledgeState: 'no_show', requestState: 'alerting' },
  });
  apiMock.cancelRequest.mockResolvedValue({
    ok: true,
    status: 200,
    data: { requestState: 'cancelled', pledgesReleased: 2 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('RequestDetailPage', () => {
  it('shows the aggregates header and the pledge cards it was sent', async () => {
    renderDetail();
    expect(screen.getByRole('status', { name: 'Loading this request' })).toBeInTheDocument();

    expect(await screen.findByText('2 units')).toBeInTheDocument();
    expect(screen.getByText('B+')).toBeInTheDocument();
    expect(apiMock.getRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('0 of 2')).toBeInTheDocument();
    expect(screen.getByText(/Midtown Hospital/)).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'nightbird' })).toBeInTheDocument();
    expect(screen.getByText('O-')).toBeInTheDocument();
    expect(screen.getByText('Within 30 minutes')).toBeInTheDocument();
    expect(screen.getByText('On the way')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'DONOR_PHONE' })).toHaveAttribute(
      'href',
      'tel:DONOR_PHONE',
    );
  });

  it('says a phone was not shared instead of inventing a link', async () => {
    apiMock.getRequest.mockResolvedValue(
      detailOk({ pledges: [{ ...PLEDGE, donorPhone: null }] }),
    );
    renderDetail();

    expect(await screen.findByText('Phone not shared')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /DONOR_PHONE/ })).not.toBeInTheDocument();
  });

  it('shows an empty pledge state before any donor accepts', async () => {
    apiMock.getRequest.mockResolvedValue(detailOk({ pledges: [], activePledges: 0 }));
    renderDetail();

    expect(await screen.findByText(/no donor has accepted yet/i)).toBeInTheDocument();
  });

  it('confirms before marking a donor as arrived and donated', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('2 units');

    await user.click(screen.getByRole('button', { name: 'Donated' }));
    expect(apiMock.markPledgeDonated).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yes, they donated' }));

    await waitFor(() => {
      expect(apiMock.markPledgeDonated).toHaveBeenCalledWith('p-1');
    });
    // The server's view is re-read rather than patched locally.
    expect(apiMock.getRequest).toHaveBeenCalledTimes(2);
  });

  it('confirms before recording a no-show', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('2 units');

    await user.click(screen.getByRole('button', { name: 'No-show' }));
    expect(apiMock.markPledgeNoShow).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yes, they did not arrive' }));

    await waitFor(() => {
      expect(apiMock.markPledgeNoShow).toHaveBeenCalledWith('p-1');
    });
  });

  it('backs out of a pledge confirmation without calling anything', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('2 units');

    await user.click(screen.getByRole('button', { name: 'Donated' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(apiMock.markPledgeDonated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Donated' })).toBeInTheDocument();
  });

  it('cancels the request only after a confirmation and reports the released pledges', async () => {
    apiMock.getRequest
      .mockResolvedValueOnce(detailOk())
      .mockResolvedValue(detailOk({ state: 'cancelled' }));
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText('2 units');

    await user.click(screen.getByRole('button', { name: 'Cancel this request' }));
    expect(apiMock.cancelRequest).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yes, cancel the request' }));

    await waitFor(() => {
      expect(apiMock.cancelRequest).toHaveBeenCalledWith(REQUEST_ID);
    });
    expect(await screen.findByText(/2 pledged donors were released/i)).toBeInTheDocument();
    expect(screen.getByText(/cancelled\. pledged donors were released/i)).toBeInTheDocument();
  });

  it.each([
    ['fulfilled' as const, /fulfilled\./i],
    ['expired' as const, /expired\./i],
  ])('shows the %s banner and hides the cancel button', async (state, copy) => {
    apiMock.getRequest.mockResolvedValue(detailOk({ state }));
    renderDetail();

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel this request' })).not.toBeInTheDocument();
  });

  it('states the search radius in kilometres, not as a tier index', async () => {
    renderDetail();

    expect(await screen.findByText(/searching within ~10 km/i)).toBeInTheDocument();
    expect(screen.queryByText(/radius tier/i)).not.toBeInTheDocument();
  });

  it('drops the expiry, the live line and the pledge hint once the request is over', async () => {
    apiMock.getRequest.mockResolvedValue(detailOk({ state: 'expired', pledges: [] }));
    renderDetail();

    expect(await screen.findByText(/expired\./i)).toBeInTheDocument();
    expect(screen.queryByText(/^expires /i)).not.toBeInTheDocument();
    expect(screen.queryByText(/searching within/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/updates every/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no donor has accepted yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Pledges')).not.toBeInTheDocument();
  });

  it('keeps the pledge cards on a closed request that had donors', async () => {
    apiMock.getRequest.mockResolvedValue(
      detailOk({ state: 'fulfilled', pledges: [{ ...PLEDGE, state: 'donated' }] }),
    );
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'nightbird' })).toBeInTheDocument();
    expect(screen.getByText('Pledges')).toBeInTheDocument();
  });

  it('shows the raised-just-now banner handed over by the requester home', async () => {
    apiMock.getRequest.mockResolvedValue(detailOk({ donorsAlerted: 0, pledges: [] }));
    renderDetail({ created: true });

    expect(
      await screen.findByText(/request raised\. donors are alerted within a minute/i),
    ).toBeInTheDocument();
  });

  it('retires that banner once donors have actually been alerted', async () => {
    // Data, not a timer: the promise goes when the thing it promised happened.
    apiMock.getRequest.mockResolvedValue(detailOk({ donorsAlerted: 12 }));
    renderDetail({ created: true });

    await screen.findByText('2 units');
    expect(screen.queryByText(/request raised/i)).not.toBeInTheDocument();
  });

  it('keeps the banner up while a slow sweep has alerted nobody yet', async () => {
    apiMock.getRequest
      .mockResolvedValueOnce(detailOk({ donorsAlerted: 0, pledges: [] }))
      .mockResolvedValue(detailOk({ donorsAlerted: 3 }));
    vi.useFakeTimers();
    renderDetail({ created: true });
    await tick(0);
    expect(screen.getByText(/request raised/i)).toBeInTheDocument();

    // The next poll finds the sweep has run; the sentence is now about the past.
    await tick(POLL_MS);
    expect(screen.queryByText(/request raised/i)).not.toBeInTheDocument();
  });

  it('shows the similar-request warning handed over with the navigation', async () => {
    renderDetail({ created: true, warning: 'similar_open_request_exists' });

    expect(
      await screen.findByText(/another requester already has an open request/i),
    ).toBeInTheDocument();
  });

  it('polls every 12 seconds while the request is still live', async () => {
    vi.useFakeTimers();
    renderDetail();
    await tick(0);
    expect(apiMock.getRequest).toHaveBeenCalledTimes(1);

    await tick(POLL_MS);
    expect(apiMock.getRequest).toHaveBeenCalledTimes(2);

    await tick(POLL_MS);
    expect(apiMock.getRequest).toHaveBeenCalledTimes(3);
  });

  it('stops polling once the request reaches a terminal state', async () => {
    vi.useFakeTimers();
    apiMock.getRequest
      .mockResolvedValueOnce(detailOk())
      .mockResolvedValue(detailOk({ state: 'fulfilled' }));
    renderDetail();
    await tick(0);
    await tick(POLL_MS);
    expect(apiMock.getRequest).toHaveBeenCalledTimes(2);

    await tick(POLL_MS * 5);
    expect(apiMock.getRequest).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good view when a background poll fails', async () => {
    vi.useFakeTimers();
    apiMock.getRequest
      .mockResolvedValueOnce(detailOk())
      .mockResolvedValue({ ok: false, status: 0, error: { error: 'network_error' } });
    renderDetail();
    await tick(0);

    await tick(POLL_MS);

    expect(screen.getByText('2 units')).toBeInTheDocument();
    expect(screen.getByText(/may be out of date/i)).toBeInTheDocument();
  });

  it('reports a 404 as an unavailable request, with a retry', async () => {
    apiMock.getRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: { error: 'not_found' },
    });
    renderDetail();

    expect(await screen.findByRole('alert')).toHaveTextContent(/not available for your account/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 units')).toBeInTheDocument();
    expect(screen.getByText('B+')).toBeInTheDocument();
  });

  it('explains a 403 as "not a requester"', async () => {
    apiMock.getRequest.mockResolvedValue({
      ok: false,
      status: 403,
      error: { error: 'not_a_requester' },
    });
    renderDetail();

    expect(await screen.findByText(/not a hospital requester/i)).toBeInTheDocument();
  });
});
