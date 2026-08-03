// Demo mode ON. `demoMode` is mocked rather than stubbing the env, because
// DEMO_MODE is a build-time constant: a normal build folds it away entirely
// (the OFF case is covered by demoOff.test.tsx).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  setAppTokenSource: vi.fn<(source: () => Promise<string | null>) => void>(),
  api: {},
  TRANSPORT_STATUS: 0,
}));

vi.mock('../lib/api', () => apiMock);
vi.mock('./demoMode', () => ({ DEMO_MODE: true }));

import { useAuth } from '../auth/authContext';
import { Layout } from '../components/Layout';
import { DemoAuthProvider } from './DemoAuthProvider';
import { installDemoTokenSource, setActiveDemoPersona } from './demoSession';

const STORAGE_KEY = 'give-blood.demo.persona';

/** Proves the pages' auth channel, not just the persona bar, follows the switch. */
function AuthProbe(): ReactElement {
  const { status, uid } = useAuth();
  return <p>{`${status}:${uid ?? 'none'}`}</p>;
}

function renderShell(): void {
  render(
    <DemoAuthProvider>
      <MemoryRouter>
        <Layout>
          <AuthProbe />
        </Layout>
      </MemoryRouter>
    </DemoAuthProvider>,
  );
}

/** The function the api layer will call for a bearer token. */
function installedTokenSource(): () => Promise<string | null> {
  installDemoTokenSource();
  const source = apiMock.setAppTokenSource.mock.calls[0]?.[0];
  if (source === undefined) throw new Error('the demo token source was never installed');
  return source;
}

beforeEach(() => {
  window.localStorage.clear();
  setActiveDemoPersona('asha');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('demo persona bar', () => {
  it('renders the four personas in the app header', () => {
    renderShell();

    expect(screen.getByRole('button', { name: 'Asha (B+ donor)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ravi (O- donor)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Meera (A+ donor)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'City Hospital (requester)' })).toBeInTheDocument();
  });

  it('marks the active persona and says who the browser is acting as', () => {
    renderShell();

    expect(screen.getByRole('button', { name: 'Asha (B+ donor)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Ravi (O- donor)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(/Acting as Asha/)).toBeInTheDocument();
  });

  it('replaces sign-out: switching persona is how you change user in a demo', () => {
    renderShell();

    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('changes the token the api layer receives when the persona is switched', async () => {
    const tokenSource = installedTokenSource();
    renderShell();
    await expect(tokenSource()).resolves.toBe('demo-asha');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Ravi (O- donor)' }));

    await expect(tokenSource()).resolves.toBe('demo-ravi');
    expect(screen.getByText(/Acting as Ravi/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ravi (O- donor)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('switches the uid every page reads, exactly as a real sign-in would', async () => {
    renderShell();
    expect(screen.getByText('signed-in:uid-demo-asha')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'City Hospital (requester)' }));

    expect(screen.getByText('signed-in:uid-demo-city')).toBeInTheDocument();
  });

  it('keeps the selected persona across a reload', async () => {
    renderShell();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Meera (A+ donor)' }));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('meera');
  });

  it('carries the two demo levers on the right of the strip', () => {
    renderShell();

    expect(screen.getByRole('button', { name: 'Sweep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });

  it('spends its one status line on the last thing that happened', async () => {
    // A fresh Response per call: a body can only be read once, and the strip
    // now polls /demo/state for the Expire lever alongside the sweep.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ opened: 1, dispatched: 2, tiersAdvanced: 0, expired: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Sweep' }));

    expect(await screen.findByText(/2 donors alerted/)).toBeInTheDocument();
    expect(screen.queryByText(/Acting as Asha/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ravi (O- donor)' }));

    expect(screen.getByText(/Acting as Ravi/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
