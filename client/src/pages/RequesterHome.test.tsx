import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestSummary } from '../lib/apiTypes';
import { RequesterHome } from './RequesterHome';

const apiMock = vi.hoisted(() => ({
  listMyRequests: vi.fn(),
  createRequest: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock, TRANSPORT_STATUS: 0 }));

const HOSPITAL_ID = '11111111-2222-4333-8444-555555555555';
const EXISTING_ID = '99999999-8888-4777-8666-555555555555';

/** The whole request card is the link; its aria-label names the request. */
const NEWEST_CARD = 'Open request: B+, 2 units';

const OLDER: RequestSummary = {
  requestId: 'req-old',
  bloodGroup: 'A+',
  unitsNeeded: 1,
  unitsConfirmed: 1,
  urgency: 'standard',
  state: 'fulfilled',
  radiusTier: 2,
  hospitalId: HOSPITAL_ID,
  createdAt: '2026-07-30T09:00:00.000Z',
  expiresAt: '2026-07-30T21:00:00.000Z',
  donorsAlerted: 8,
  activePledges: 0,
};

const NEWER: RequestSummary = {
  requestId: 'req-new',
  bloodGroup: 'B+',
  unitsNeeded: 2,
  unitsConfirmed: 0,
  urgency: 'critical',
  state: 'alerting',
  radiusTier: 0,
  hospitalId: HOSPITAL_ID,
  createdAt: '2026-07-31T10:00:00.000Z',
  expiresAt: '2026-07-31T16:00:00.000Z',
  donorsAlerted: 12,
  activePledges: 1,
};

function listOk(requests: RequestSummary[]) {
  return { ok: true as const, status: 200, data: requests };
}

/** Stands in for the real detail route: proves where a raised request lands. */
function DetailProbe(): ReactElement {
  const { requestId } = useParams<{ requestId: string }>();
  const state = useLocation().state as { created?: boolean; warning?: string } | null;
  return (
    <p>{`detail ${requestId ?? ''} created=${String(state?.created)} warning=${state?.warning ?? 'none'}`}</p>
  );
}

function renderHome(): void {
  render(
    <MemoryRouter initialEntries={['/requester']}>
      <Routes>
        <Route path="/requester" element={<RequesterHome />} />
        <Route path="/requester/requests/:requestId" element={<DetailProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fill the form the way a requester would, then submit. */
async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'New request' }));
  await user.type(screen.getByLabelText(/hospital id/i), HOSPITAL_ID);
  await user.click(screen.getByRole('button', { name: 'B+' }));
  await user.click(screen.getByRole('button', { name: 'More units' }));
  await user.click(screen.getByRole('button', { name: 'Send alert to donors' }));
}

beforeEach(() => {
  apiMock.listMyRequests.mockResolvedValue(listOk([OLDER, NEWER]));
  apiMock.createRequest.mockResolvedValue({
    ok: true,
    status: 201,
    data: { requestId: 'req-created', state: 'open', expiresAt: '2026-07-31T16:00:00.000Z' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RequesterHome', () => {
  it('loads on mount and lists the account requests newest first with their aggregates', async () => {
    renderHome();
    expect(screen.getByRole('status', { name: 'Loading your requests' })).toBeInTheDocument();

    expect(await screen.findByRole('link', { name: NEWEST_CARD })).toBeInTheDocument();
    const cards = screen.getAllByRole('link').map((node) => node.getAttribute('aria-label'));
    expect(cards).toEqual([NEWEST_CARD, 'Open request: A+, 1 unit']);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('0 of 2')).toBeInTheDocument();
    expect(screen.getByText('Alerting donors')).toBeInTheDocument();
    expect(screen.getByText('Fulfilled')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('shows an empty state instead of a bare list', async () => {
    apiMock.listMyRequests.mockResolvedValue(listOk([]));
    renderHome();

    expect(await screen.findByText(/no requests yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New request' })).toBeInTheDocument();
  });

  it('explains a 403 as "not a requester", not as an error', async () => {
    apiMock.listMyRequests.mockResolvedValue({
      ok: false,
      status: 403,
      error: { error: 'not_a_requester' },
    });
    renderHome();

    expect(await screen.findByText(/not a hospital requester/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New request' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a load failure with a retry', async () => {
    apiMock.listMyRequests.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: { error: 'internal' },
    });
    renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load your requests/i);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: NEWEST_CARD })).toBeInTheDocument();
  });

  it('submits the form the requester filled in and opens the request it raised', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await fillAndSubmit(user);

    await waitFor(() => {
      expect(apiMock.createRequest).toHaveBeenCalledWith({
        bloodGroup: 'B+',
        unitsNeeded: 2,
        urgency: 'critical',
        hospitalId: HOSPITAL_ID,
      });
    });
    // Straight to the request, not back to a list with a link pointing at it.
    expect(await screen.findByText(/^detail req-created created=true/)).toBeInTheDocument();
  });

  it('hands the similar-request warning to the request it opens', async () => {
    apiMock.createRequest.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        requestId: 'req-created',
        state: 'open',
        expiresAt: '2026-07-31T16:00:00.000Z',
        warning: 'similar_open_request_exists',
      },
    });
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await fillAndSubmit(user);

    expect(
      await screen.findByText(/warning=similar_open_request_exists/),
    ).toBeInTheDocument();
  });

  it('says how soon donors hear about it, in time and not in sweeps', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await user.click(screen.getByRole('button', { name: 'New request' }));

    expect(screen.getByText(/alerted within a minute/i)).toBeInTheDocument();
    expect(screen.queryByText(/next sweep/i)).not.toBeInTheDocument();
  });

  it('offers a different-patient re-submit on a 409 duplicate and sends the flag', async () => {
    apiMock.createRequest.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: { error: 'duplicate_request', existingRequestId: EXISTING_ID },
    });
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(EXISTING_ID);
    expect(apiMock.createRequest).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Yes, different patient' }));

    await waitFor(() => {
      expect(apiMock.createRequest).toHaveBeenLastCalledWith({
        bloodGroup: 'B+',
        unitsNeeded: 2,
        urgency: 'critical',
        hospitalId: HOSPITAL_ID,
        differentPatient: true,
      });
    });
  });

  it('keeps the existing request when the duplicate confirmation is dismissed', async () => {
    apiMock.createRequest.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: { error: 'duplicate_request', existingRequestId: EXISTING_ID },
    });
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await fillAndSubmit(user);
    await user.click(await screen.findByRole('button', { name: 'Keep the existing request' }));

    expect(apiMock.createRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Yes, different patient' })).not.toBeInTheDocument();
  });

  it('reports the open-request cap (429) without losing the form', async () => {
    apiMock.createRequest.mockResolvedValue({
      ok: false,
      status: 429,
      error: { error: 'too_many_open_requests' },
    });
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/limit of open requests/i);
    expect(screen.getByRole('button', { name: 'Send alert to donors' })).toBeInTheDocument();
  });

  it('attaches an unknown hospital id to the field that holds it', async () => {
    apiMock.createRequest.mockResolvedValue({
      ok: false,
      status: 404,
      error: { error: 'unknown_hospital' },
    });
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await fillAndSubmit(user);

    // On the input, not in a banner four controls below it.
    const field = await screen.findByLabelText(/hospital id/i);
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(/not in the registry/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the hospital id as operator-provided, since there is no directory to pick from', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('link', { name: NEWEST_CARD });

    await user.click(screen.getByRole('button', { name: 'New request' }));

    expect(screen.getByText(/provided by the operator during onboarding/i)).toBeInTheDocument();
    expect(screen.getByText(/no hospital directory/i)).toBeInTheDocument();
  });
});
