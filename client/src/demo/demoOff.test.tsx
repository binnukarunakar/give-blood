// Demo mode OFF — the default for every build and for `npm test`. Nothing here
// is mocked: this is the real Layout with the real DEMO_MODE constant, and it
// must show no trace of the demo.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AuthContext, type AuthState } from '../auth/authContext';
import { Layout } from '../components/Layout';
import { DEMO_MODE } from './demoMode';

const SIGNED_IN: AuthState = { status: 'signed-in', uid: 'uid-abc' };

function renderShell(): void {
  render(
    <AuthContext.Provider value={SIGNED_IN}>
      <MemoryRouter>
        <Layout>
          <p>page</p>
        </Layout>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('normal mode', () => {
  it('leaves demo mode off when VITE_DEMO_MODE is unset', () => {
    expect(DEMO_MODE).toBe(false);
  });

  it('renders sign-out and no persona bar', () => {
    renderShell();

    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Demo persona' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asha (B+ donor)' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Acting as/)).not.toBeInTheDocument();
  });
});
