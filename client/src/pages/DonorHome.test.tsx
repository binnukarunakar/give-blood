import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DonorView } from '../lib/apiTypes';
import { DonorHome } from './DonorHome';

const apiMock = vi.hoisted(() => ({
  getMe: vi.fn(),
  updateMe: vi.fn(),
  reportDonation: vi.fn(),
  registerDonor: vi.fn(),
  setPushToken: vi.fn(),
  confirmPushVerified: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock, TRANSPORT_STATUS: 0 }));
vi.mock('../lib/firebase', () => ({ getFcmToken: vi.fn() }));

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

function donorOk(overrides: Partial<DonorView> = {}) {
  return { ok: true as const, status: 200, data: { ...DONOR, ...overrides } };
}

function renderHome(path = '/donor'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <DonorHome />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.getMe.mockResolvedValue(donorOk());
  apiMock.updateMe.mockImplementation(() => Promise.resolve(donorOk()));
  apiMock.reportDonation.mockResolvedValue({
    ok: true,
    status: 200,
    data: { lastDonationAt: '2026-07-31T12:00:00.000Z' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DonorHome', () => {
  it('shows a loading state, then the status card', async () => {
    renderHome();
    // The skeletons carry the announcement; a full page never spins (DESIGN.md).
    expect(screen.getByRole('status', { name: /loading your donor profile/i })).toBeInTheDocument();

    expect(await screen.findByText('donor-one')).toBeInTheDocument();
    expect(screen.getByText('O-')).toBeInTheDocument();
    expect(screen.getByText('dr5ru')).toBeInTheDocument();
    expect(screen.getByText('Push verified')).toBeInTheDocument();
    expect(screen.getByText('None recorded')).toBeInTheDocument();
  });

  it('leads with the active pledge and a way back to the alert', async () => {
    apiMock.getMe.mockResolvedValue(
      donorOk({
        activePledge: { pledgeId: 'p-1', alertId: 'a-9', requestState: 'partially_pledged' },
      }),
    );
    renderHome();

    // The way back to the address at 2am, when the push is long dismissed.
    const open = await screen.findByRole('link', { name: 'Open alert' });
    expect(open).toHaveAttribute('href', '/alerts/a-9');
    expect(screen.getByText('You pledged')).toBeInTheDocument();
    // First card on the page: settings do not outrank being expected somewhere.
    const cards = screen.getAllByText(/active pledge|donor-one/i);
    expect(cards[0]).toHaveTextContent(/active pledge/i);
  });

  it('shows no pledge card when the donor is holding none', async () => {
    renderHome();
    await screen.findByText('donor-one');

    expect(screen.queryByRole('link', { name: 'Open alert' })).not.toBeInTheDocument();
  });

  it('shows onboarding when the account has no donor record', async () => {
    apiMock.getMe.mockResolvedValue({ ok: false, status: 404, error: { error: 'not_found' } });
    renderHome();

    expect(
      await screen.findByRole('heading', { name: 'Set up your donor profile' }),
    ).toBeInTheDocument();
  });

  it('surfaces a load failure with a retry', async () => {
    apiMock.getMe.mockResolvedValueOnce({ ok: false, status: 500, error: { error: 'internal' } });
    renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load your donor profile/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('donor-one')).toBeInTheDocument();
  });

  it('computes the eligible-again date 56 days after the last donation', async () => {
    apiMock.getMe.mockResolvedValue(donorOk({ lastDonationAt: '2026-07-01T10:00:00.000Z' }));
    renderHome();

    // 2026-07-01 + 56 days = 2026-08-26.
    expect(await screen.findByText(/56 days after your last donation/)).toBeInTheDocument();
    expect(screen.getByText(/Aug 26, 2026|26 Aug 2026/)).toBeInTheDocument();
  });

  it('PATCHes availability when the toggle is switched off', async () => {
    apiMock.updateMe.mockResolvedValue(donorOk({ available: false }));
    renderHome();
    const toggle = await screen.findByLabelText(/available to donate/i);

    await userEvent.setup().click(toggle);

    await waitFor(() => {
      expect(apiMock.updateMe).toHaveBeenCalledWith({ available: false });
    });
    expect(await screen.findByLabelText(/available to donate/i)).not.toBeChecked();
  });

  it('PATCHes a 24-hour snooze as an ISO instant', async () => {
    renderHome();
    await screen.findByText('donor-one');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Snooze 24 hours' }));

    await waitFor(() => {
      expect(apiMock.updateMe).toHaveBeenCalledTimes(1);
    });
    const [patch] = apiMock.updateMe.mock.calls[0] ?? [];
    const until = new Date(String((patch as { snoozeUntil: string }).snoozeUntil)).getTime();
    const expected = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(until - expected)).toBeLessThan(60_000);
  });

  it('PATCHes an explicit null to clear a snooze', async () => {
    apiMock.getMe.mockResolvedValue(donorOk({ snoozeUntil: '2099-01-01T00:00:00.000Z' }));
    renderHome();
    await screen.findByText('donor-one');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear snooze' }));

    await waitFor(() => {
      expect(apiMock.updateMe).toHaveBeenCalledWith({ snoozeUntil: null });
    });
  });

  it('PATCHes phone sharing and says what it reveals', async () => {
    apiMock.updateMe.mockResolvedValue(donorOk({ sharePhoneOnAccept: true }));
    renderHome();
    const toggle = await screen.findByLabelText(/share my phone number/i);
    // The switch is named by its label and described by the consequence, so the
    // reveal is still announced with the control that causes it.
    expect(toggle).toHaveAccessibleDescription(/after you accept/i);

    await userEvent.setup().click(toggle);

    await waitFor(() => {
      expect(apiMock.updateMe).toHaveBeenCalledWith({ sharePhoneOnAccept: true });
    });
  });

  it('reports a save failure without flipping the toggle', async () => {
    apiMock.updateMe.mockResolvedValue({ ok: false, status: 500, error: { error: 'internal' } });
    renderHome();
    const toggle = await screen.findByLabelText(/available to donate/i);

    await userEvent.setup().click(toggle);

    expect(await screen.findByText(/could not save that change/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/available to donate/i)).toBeChecked();
  });

  it('requires a confirmation before self-reporting a donation', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByText('donor-one');

    await user.click(screen.getByRole('button', { name: 'I donated today' }));
    expect(apiMock.reportDonation).not.toHaveBeenCalled();
    expect(screen.getByText(/starts your 56-day cooldown/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yes, I donated today' }));

    await waitFor(() => {
      expect(apiMock.reportDonation).toHaveBeenCalledWith({});
    });
  });

  it('cancels the donation confirmation without calling the API', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByText('donor-one');

    await user.click(screen.getByRole('button', { name: 'I donated today' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(apiMock.reportDonation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'I donated today' })).toBeInTheDocument();
  });

  it('requires a confirmation before revoking alerts consent, then PATCHes optedIn false', async () => {
    apiMock.updateMe.mockResolvedValue(donorOk({ optedIn: false }));
    const user = userEvent.setup();
    renderHome();
    const consent = await screen.findByLabelText(/alert me when a nearby hospital needs/i);
    expect(consent).toBeChecked();

    await user.click(consent);
    expect(apiMock.updateMe).not.toHaveBeenCalled();
    expect(screen.getByText(/you will not be alerted again until you turn this back on/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yes, stop alerting me' }));

    await waitFor(() => {
      expect(apiMock.updateMe).toHaveBeenCalledWith({ optedIn: false });
    });
    expect(await screen.findByLabelText(/alert me when a nearby hospital needs/i)).not.toBeChecked();
  });

  it('keeps consent on when the opt-out confirmation is dismissed', async () => {
    const user = userEvent.setup();
    renderHome();
    const consent = await screen.findByLabelText(/alert me when a nearby hospital needs/i);

    await user.click(consent);
    await user.click(screen.getByRole('button', { name: 'Keep alerts on' }));

    expect(apiMock.updateMe).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/alert me when a nearby hospital needs/i)).toBeChecked();
  });

  it('turns consent back on directly, with no confirmation', async () => {
    apiMock.getMe.mockResolvedValue(donorOk({ optedIn: false }));
    apiMock.updateMe.mockResolvedValue(donorOk({ optedIn: true }));
    const user = userEvent.setup();
    renderHome();
    const consent = await screen.findByLabelText(/alert me when a nearby hospital needs/i);

    await user.click(consent);

    await waitFor(() => {
      expect(apiMock.updateMe).toHaveBeenCalledWith({ optedIn: true });
    });
  });

  it('offers push enrolment when the donor is not push-verified', async () => {
    apiMock.getMe.mockResolvedValue(donorOk({ pushVerified: false }));
    renderHome();

    expect(await screen.findByText('Push not verified')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Turn on alert notifications' }),
    ).toBeInTheDocument();
  });

  it('confirms verification automatically when opened from the probe notification', async () => {
    apiMock.getMe
      .mockResolvedValueOnce(donorOk({ pushVerified: false }))
      .mockResolvedValue(donorOk({ pushVerified: true }));
    apiMock.confirmPushVerified.mockResolvedValue({
      ok: true,
      status: 200,
      data: { pushVerified: true },
    });

    renderHome('/donor?push=verified');

    await waitFor(() => {
      expect(apiMock.confirmPushVerified).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('Push verified')).toBeInTheDocument();
  });
});
