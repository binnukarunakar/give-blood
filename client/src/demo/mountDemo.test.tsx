// The one integration test: mount the demo entry exactly as main.tsx does and
// check the whole composition — real App, demo auth, persona token on the wire,
// panel underneath.
//
// fetch is stubbed at module scope and mountDemo is imported inside the test
// on purpose: lib/api binds globalThis.fetch when the module is first imported,
// so a stub installed later would never be seen.
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DonorView } from '../lib/apiTypes';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);
vi.mock('./demoMode', () => ({ DEMO_MODE: true }));

const DONOR: DonorView = {
  donorId: 'd-1',
  handle: 'nightbird',
  bloodGroup: 'B+',
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

fetchMock.mockImplementation((input) => {
  const url = String(input);
  if (url.endsWith('/donors/me')) return Promise.resolve(jsonResponse(DONOR));
  if (url.endsWith('/demo/pushes')) return Promise.resolve(jsonResponse({ pushes: [] }));
  return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
});

const containers: HTMLElement[] = [];

function newContainer(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  vi.clearAllMocks();
});

describe('mountDemo', () => {
  it('renders the real app, the persona bar and the demo panel together', async () => {
    const { mountDemo } = await import('./mountDemo');
    const container = newContainer();

    const root = await act(async () => mountDemo(container));

    expect(screen.getByRole('heading', { name: 'Give Blood' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Donor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Asha (B+ donor)' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Demo persona' })).toBeInTheDocument();
    // The inbox mounts collapsed (DESIGN.md): a pill, not a panel.
    expect(screen.getByRole('button', { name: /^push inbox/i })).toBeInTheDocument();
    // The real donor screen, reached through the real RequireAuth guard: the
    // identity card renders the handle the stubbed /donors/me returned.
    expect(screen.getByRole('heading', { name: DONOR.handle })).toBeInTheDocument();

    await act(async () => root.unmount());
  });

  it('sends the persona token on the app request the donor screen makes', async () => {
    const { mountDemo } = await import('./mountDemo');
    const container = newContainer();

    const root = await act(async () => mountDemo(container));

    const donorCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/donors/me'));
    const headers = (donorCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer demo-asha');

    await act(async () => root.unmount());
  });
});
