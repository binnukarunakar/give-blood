import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDetail, AlertPledge, DonorView, RequestState } from '../lib/apiTypes';
import { AlertDetailPage } from './AlertDetail';

const apiMock = vi.hoisted(() => ({
  getAlert: vi.fn(),
  getMe: vi.fn(),
  acceptAlert: vi.fn(),
  declineAlert: vi.fn(),
  withdrawPledge: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock, TRANSPORT_STATUS: 0 }));

const ALERT_ID = 'a1b2c3';

const DONOR: DonorView = {
  donorId: 'd-1',
  handle: 'donor-one',
  bloodGroup: 'O-',
  geohash5: 'dr5ru',
  tz: 'America/New_York',
  optedIn: true,
  available: true,
  snoozeUntil: null,
  sharePhoneOnAccept: false,
  pushVerified: true,
  lastDonationAt: null,
  activePledge: null,
};

const ALERT: AlertDetail = {
  alertId: ALERT_ID,
  bloodGroup: 'B+',
  unitsNeeded: 2,
  urgency: 'critical',
  requestState: 'alerting',
  hospital: {
    name: 'Midtown Hospital',
    address: '1 Example Plaza',
    lat: 40.758,
    lng: -73.9855,
    bloodbankPhone: 'HOSPITAL_BLOODBANK_PHONE',
  },
  distanceKm: 3.4,
  createdAt: '2026-07-31T10:00:00.000Z',
  expiresAt: '2026-07-31T16:00:00.000Z',
  pledge: null,
};

/** The accept response. The screen no longer renders from it — it re-reads. */
const ACCEPTED = {
  pledgeId: 'p-1',
  requestState: 'partially_pledged' as RequestState,
  hospital: {
    name: 'Midtown Hospital',
    lat: 40.758,
    lng: -73.9855,
    bloodbankPhone: 'HOSPITAL_BLOODBANK_PHONE',
  },
  directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=40.758,-73.9855',
};

const ACTIVE_PLEDGE: AlertPledge = { pledgeId: 'p-1', state: 'active', etaBucket: 'le_30m' };

function alertOk(overrides: Partial<AlertDetail> = {}) {
  return { ok: true as const, status: 200, data: { ...ALERT, ...overrides } };
}

/** What the server answers once this donor has accepted: the pledge rides along. */
function pledgedOk(pledge: Partial<AlertPledge> = {}) {
  return alertOk({
    requestState: 'partially_pledged',
    pledge: { ...ACTIVE_PLEDGE, ...pledge },
  });
}

function renderAlert(): void {
  render(
    <MemoryRouter initialEntries={[`/alerts/${ALERT_ID}`]}>
      <Routes>
        <Route path="/alerts/:alertId" element={<AlertDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.getAlert.mockResolvedValue(alertOk());
  apiMock.getMe.mockResolvedValue({ ok: true, status: 200, data: DONOR });
  apiMock.acceptAlert.mockResolvedValue({ ok: true, status: 201, data: ACCEPTED });
  apiMock.declineAlert.mockResolvedValue({ ok: true, status: 204, data: null });
  apiMock.withdrawPledge.mockResolvedValue({
    ok: true,
    status: 200,
    data: { pledgeState: 'withdrawn', requestState: 'alerting' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AlertDetailPage', () => {
  it('loads on mount and shows what is needed, where, and how far', async () => {
    renderAlert();
    // Skeletons shaped like the layout, announced once (DESIGN.md § Skeleton).
    expect(screen.getByRole('status', { name: /loading this alert/i })).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'B+ 2 units' })).toBeInTheDocument();
    expect(apiMock.getAlert).toHaveBeenCalledWith(ALERT_ID);
    expect(screen.getByText('Midtown Hospital')).toBeInTheDocument();
    expect(screen.getByText('1 Example Plaza')).toBeInTheDocument();
    expect(screen.getByText(/3\.4 km/)).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('links the blood-bank phone as a tel: call-first action', async () => {
    renderAlert();

    const link = await screen.findByRole('link', { name: /call blood bank to confirm/i });
    expect(link).toHaveAttribute('href', 'tel:HOSPITAL_BLOODBANK_PHONE');
  });

  it.each<[RequestState, RegExp]>([
    ['fulfilled', /fulfilled/i],
    ['cancelled', /cancelled/i],
    ['expired', /expired/i],
    ['covered', /already pledged/i],
  ])('hides accept when the request is %s', async (requestState, copy) => {
    apiMock.getAlert.mockResolvedValue(alertOk({ requestState }));
    renderAlert();

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
  });

  it('sends the chosen eta bucket on accept, then re-reads and shows the pledge card', async () => {
    apiMock.getAlert.mockResolvedValueOnce(alertOk()).mockResolvedValue(pledgedOk());
    const user = userEvent.setup();
    renderAlert();
    await screen.findByRole('button', { name: 'Accept' });

    // Accept expands the window picker; the second press is the commit.
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: '30 min' }));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    await waitFor(() => {
      expect(apiMock.acceptAlert).toHaveBeenCalledWith(ALERT_ID, {
        etaBucket: 'le_30m',
        sharePhone: false,
      });
    });
    expect(await screen.findByText('You pledged')).toBeInTheDocument();
    // The card is built from the re-read, not from the accept response.
    expect(apiMock.getAlert).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: 'Directions' })).toHaveAttribute(
      'href',
      ACCEPTED.directionsUrl,
    );
  });

  it('renders the pledged card from the server on a cold load, with no accept in this session', async () => {
    apiMock.getAlert.mockResolvedValue(pledgedOk());
    renderAlert();

    // The 2am case: the donor accepted, locked her phone, and came back.
    expect(await screen.findByText('You pledged')).toBeInTheDocument();
    expect(apiMock.acceptAlert).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    // Everything she needs to get there: group, units, the address, the map.
    expect(screen.getByText('B+')).toBeInTheDocument();
    expect(screen.getByText('2 units')).toBeInTheDocument();
    expect(screen.getByText('Midtown Hospital')).toBeInTheDocument();
    expect(screen.getByText('1 Example Plaza')).toBeInTheDocument();
    expect(screen.getByText(/within 30 minutes/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Directions' })).toHaveAttribute(
      'href',
      ACCEPTED.directionsUrl,
    );
  });

  it('thanks a donor whose donation was recorded, even after the request expired', async () => {
    apiMock.getAlert.mockResolvedValue(
      alertOk({ requestState: 'expired', pledge: { ...ACTIVE_PLEDGE, state: 'donated' } }),
    );
    renderAlert();

    expect(await screen.findByText(/your donation is recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing is needed from you/i)).not.toBeInTheDocument();
  });

  it('opens the window picker on 30 min for a critical request', async () => {
    const user = userEvent.setup();
    renderAlert();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    await waitFor(() => {
      expect(apiMock.acceptAlert).toHaveBeenCalledWith(ALERT_ID, {
        etaBucket: 'le_30m',
        sharePhone: false,
      });
    });
  });

  it('opens the window picker on 1 hour for a standard request', async () => {
    apiMock.getAlert.mockResolvedValue(alertOk({ urgency: 'standard' }));
    const user = userEvent.setup();
    renderAlert();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    await waitFor(() => {
      expect(apiMock.acceptAlert).toHaveBeenCalledWith(ALERT_ID, {
        etaBucket: 'le_1h',
        sharePhone: false,
      });
    });
  });

  it('sends sharePhone when the donor ticks it', async () => {
    const user = userEvent.setup();
    renderAlert();
    await screen.findByRole('button', { name: 'Accept' });

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.click(screen.getByLabelText(/share my phone number/i));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    await waitFor(() => {
      expect(apiMock.acceptAlert).toHaveBeenCalledWith(ALERT_ID, {
        etaBucket: 'le_30m',
        sharePhone: true,
      });
    });
  });

  it('declines and confirms the decline was recorded', async () => {
    const user = userEvent.setup();
    renderAlert();
    await screen.findByRole('button', { name: 'Decline' });

    await user.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(apiMock.declineAlert).toHaveBeenCalledWith(ALERT_ID);
    });
    expect(await screen.findByText(/you declined this alert/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('turns a 409 request_closed accept into the closed screen', async () => {
    apiMock.acceptAlert.mockResolvedValue({
      ok: false,
      status: 409,
      error: { error: 'request_closed', requestState: 'fulfilled' },
    });
    const user = userEvent.setup();
    renderAlert();
    await screen.findByRole('button', { name: 'Accept' });

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    expect(await screen.findByText(/has been fulfilled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm accept' })).not.toBeInTheDocument();
  });

  it('explains the one-pledge rule on 409 active_pledge_exists', async () => {
    apiMock.acceptAlert.mockResolvedValue({
      ok: false,
      status: 409,
      error: { error: 'active_pledge_exists' },
    });
    const user = userEvent.setup();
    renderAlert();
    await screen.findByRole('button', { name: 'Accept' });

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/one pledge at a time/i);
    expect(screen.getByRole('button', { name: 'Confirm accept' })).toBeInTheDocument();
  });

  it('withdraws a pledge only after a confirmation, then re-reads', async () => {
    apiMock.getAlert
      .mockResolvedValueOnce(pledgedOk())
      .mockResolvedValue(pledgedOk({ state: 'withdrawn' }));
    const user = userEvent.setup();
    renderAlert();
    await screen.findByText('You pledged');

    await user.click(screen.getByRole('button', { name: 'Withdraw pledge' }));
    expect(apiMock.withdrawPledge).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yes, withdraw' }));

    await waitFor(() => {
      expect(apiMock.withdrawPledge).toHaveBeenCalledWith('p-1');
    });
    expect(await screen.findByText(/you withdrew your pledge/i)).toBeInTheDocument();
  });

  it('omits sharePhone when the donor record could not be read', async () => {
    apiMock.getMe.mockResolvedValue({ ok: false, status: 500, error: { error: 'internal' } });
    const user = userEvent.setup();
    renderAlert();
    await screen.findByRole('button', { name: 'Accept' });

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(screen.queryByLabelText(/share my phone number/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));

    await waitFor(() => {
      expect(apiMock.acceptAlert).toHaveBeenCalledWith(ALERT_ID, { etaBucket: 'le_30m' });
    });
  });

  it('shows an honest error with a retry when the alert cannot be loaded', async () => {
    apiMock.getAlert.mockResolvedValueOnce({ ok: false, status: 0, error: { error: 'network_error' } });
    renderAlert();

    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });

  it('reports a 404 as an unavailable alert, not a crash', async () => {
    apiMock.getAlert.mockResolvedValue({ ok: false, status: 404, error: { error: 'not_found' } });
    renderAlert();

    expect(await screen.findByRole('alert')).toHaveTextContent(/not available for your account/i);
  });
});
