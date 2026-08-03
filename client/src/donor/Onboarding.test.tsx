import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from './Onboarding';

const apiMock = vi.hoisted(() => ({
  registerDonor: vi.fn(),
  setPushToken: vi.fn(),
  confirmPushVerified: vi.fn(),
}));

const firebaseMock = vi.hoisted(() => ({
  getFcmToken: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock, TRANSPORT_STATUS: 0 }));
vi.mock('../lib/firebase', () => firebaseMock);

/** The push step's own heading — the onboarding form is gone once it shows. */
const PUSH_TITLE = 'Prove this phone can hear alerts';

const TIMES_SQUARE = { lat: '40.758', lng: '-73.9855' };
const TIMES_SQUARE_CELL = 'dr5ru';

/** Every body this flow can send, as one string, for the no-coordinates assertion. */
function everySentBody(): string {
  return JSON.stringify([
    apiMock.registerDonor.mock.calls,
    apiMock.setPushToken.mock.calls,
    apiMock.confirmPushVerified.mock.calls,
  ]);
}

async function fillForm(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/display name/i), 'donor-one');
  await user.click(screen.getByRole('button', { name: 'O-' }));
  // No VITE_MAPS_BROWSER_KEY in tests, so the picker degrades to typed entry.
  await user.type(await screen.findByLabelText('Latitude'), TIMES_SQUARE.lat);
  await user.type(screen.getByLabelText('Longitude'), TIMES_SQUARE.lng);
  await user.click(screen.getByRole('button', { name: 'Set my area' }));
}

beforeEach(() => {
  apiMock.registerDonor.mockResolvedValue({
    ok: true,
    status: 201,
    data: {
      donorId: 'd-1',
      handle: 'donor-one',
      bloodGroup: 'O-',
      geohash5: TIMES_SQUARE_CELL,
      tz: 'America/New_York',
    },
  });
  apiMock.setPushToken.mockResolvedValue({ ok: true, status: 202, data: { verificationSent: true } });
  apiMock.confirmPushVerified.mockResolvedValue({ ok: true, status: 200, data: { pushVerified: true } });
  firebaseMock.getFcmToken.mockResolvedValue('fcm-token-1');
  vi.stubEnv('VITE_FCM_VAPID_PUBLIC_KEY', 'vapid-public-test');
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: () => Promise.resolve('granted'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Onboarding', () => {
  it('registers with a geohash-5 cell and reaches the push step', async () => {
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} />);

    await fillForm();
    expect(await screen.findByText(`Your area cell: ${TIMES_SQUARE_CELL}`)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/send me alerts/i));
    await user.click(screen.getByRole('button', { name: 'Create donor profile' }));

    await waitFor(() => {
      expect(apiMock.registerDonor).toHaveBeenCalledWith({
        handle: 'donor-one',
        bloodGroup: 'O-',
        geohash5: TIMES_SQUARE_CELL,
        consent: true,
      });
    });
    expect(await screen.findByRole('heading', { name: PUSH_TITLE })).toBeInTheDocument();
  });

  it('never puts raw coordinates in a request body', async () => {
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} />);

    await fillForm();
    await user.click(screen.getByLabelText(/send me alerts/i));
    await user.click(screen.getByRole('button', { name: 'Create donor profile' }));
    await screen.findByRole('heading', { name: PUSH_TITLE });
    await user.click(screen.getByRole('button', { name: 'Turn on alert notifications' }));
    await screen.findByText(/check your notifications/i);

    const bodies = everySentBody();
    expect(bodies).not.toMatch(/"lat"|"lng"|"latitude"|"longitude"/i);
    expect(bodies).not.toContain(TIMES_SQUARE.lat);
    expect(bodies).not.toContain(TIMES_SQUARE.lng);
    expect(bodies).toContain(TIMES_SQUARE_CELL);
  });

  it('blocks submit until consent is ticked', async () => {
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} />);

    await fillForm();

    const submit = screen.getByRole('button', { name: 'Create donor profile' });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/still needed/i)).toHaveTextContent('your consent');

    await user.click(submit);
    expect(apiMock.registerDonor).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/send me alerts/i));
    expect(screen.getByRole('button', { name: 'Create donor profile' })).toBeEnabled();
  });

  it('completes push setup: token saved, then verification confirmed', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);

    await fillForm();
    await user.click(screen.getByLabelText(/send me alerts/i));
    await user.click(screen.getByRole('button', { name: 'Create donor profile' }));
    await screen.findByRole('heading', { name: PUSH_TITLE });

    await user.click(screen.getByRole('button', { name: 'Turn on alert notifications' }));
    await waitFor(() => {
      expect(apiMock.setPushToken).toHaveBeenCalledWith('fcm-token-1');
    });

    await user.click(await screen.findByRole('button', { name: 'I got it' }));
    await waitFor(() => {
      expect(apiMock.confirmPushVerified).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/push verified/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open your donor profile' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('states the failure when the browser refuses notification permission', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () => Promise.resolve('denied'),
    });
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} />);

    await fillForm();
    await user.click(screen.getByLabelText(/send me alerts/i));
    await user.click(screen.getByRole('button', { name: 'Create donor profile' }));
    await screen.findByRole('heading', { name: PUSH_TITLE });
    await user.click(screen.getByRole('button', { name: 'Turn on alert notifications' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked for this site/i);
    expect(apiMock.setPushToken).not.toHaveBeenCalled();
  });

  it('reports a failed registration and keeps the form', async () => {
    apiMock.registerDonor.mockResolvedValue({
      ok: false,
      status: 500,
      error: { error: 'internal_error' },
    });
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} />);

    await fillForm();
    await user.click(screen.getByLabelText(/send me alerts/i));
    await user.click(screen.getByRole('button', { name: 'Create donor profile' }));

    // The map-unavailable notice is also role=alert here, so match on the text.
    expect(await screen.findByText(/could not create your donor profile/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create donor profile' })).toBeInTheDocument();
  });
});
