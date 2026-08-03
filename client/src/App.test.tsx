import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { AuthContext, type AuthState } from './auth/authContext';

// Routing test only: the donor screens fetch on mount, so the API is stubbed
// with calls that never settle. Every guarded route then renders its loading
// state and nothing here depends on donor-flow behaviour (covered by
// pages/DonorHome.test.tsx and pages/AlertDetail.test.tsx).
const pending = vi.hoisted(() => ({
  getMe: vi.fn(() => new Promise(() => undefined)),
  getAlert: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('./lib/api', () => ({ api: pending, TRANSPORT_STATUS: 0 }));

const SIGNED_OUT: AuthState = { status: 'signed-out', uid: null };
const SIGNED_IN: AuthState = { status: 'signed-in', uid: 'uid-abc' };
const LOADING: AuthState = { status: 'loading', uid: null };

function renderAt(path: string, auth: AuthState): void {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('App routes', () => {
  it('renders the phone sign-in form on /login', () => {
    renderAt('/login', SIGNED_OUT);

    expect(screen.getByRole('heading', { name: 'Sign in to Give Blood' })).toBeInTheDocument();
    expect(screen.getByLabelText(/phone number/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument();
  });

  it('redirects a signed-out visitor from /donor to /login', () => {
    renderAt('/donor', SIGNED_OUT);

    expect(screen.getByRole('heading', { name: 'Sign in to Give Blood' })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: /loading your donor profile/i }),
    ).not.toBeInTheDocument();
  });

  it('holds the guarded route while auth is still resolving', () => {
    renderAt('/alerts/abc', LOADING);

    expect(screen.getByText(/checking your sign-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to Give Blood' })).not.toBeInTheDocument();
  });

  it('renders the guarded alert route and the role nav when signed in', () => {
    renderAt('/alerts/abc-123', SIGNED_IN);

    // The alert screen leads with the blood group, not a page heading (GB-29),
    // so the skeleton's announcement is what proves the route mounted.
    expect(screen.getByRole('status', { name: /loading this alert/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Donor' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Requester' })).toBeInTheDocument();
  });
});
