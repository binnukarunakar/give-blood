import { render, screen } from '@testing-library/react';
import { useEffect, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/** Stands in for firebaseConfig() throwing on a missing VITE_FIREBASE_* var. */
function ThrowsOnRender(): ReactElement {
  throw new Error('Missing required environment variable: VITE_FIREBASE_API_KEY');
}

/** The real failure shape: env is read in an effect, not during render. */
function ThrowsInEffect(): ReactElement {
  useEffect(() => {
    throw new Error('Missing required environment variable: VITE_FIREBASE_API_KEY');
  }, []);
  return <p>never seen</p>;
}

beforeEach(() => {
  // React logs the caught error itself; the boundary logs its own line. Neither
  // is the thing under test, and both would make the run look broken.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the app</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('replaces a render throw with a card that says what to do', () => {
    render(
      <ErrorBoundary>
        <ThrowsOnRender />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/give blood hit an error\. reload\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('catches the missing-env throw that used to leave a blank black page', () => {
    render(
      <ErrorBoundary>
        <ThrowsInEffect />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/give blood hit an error\. reload\./i)).toBeInTheDocument();
    expect(screen.queryByText('never seen')).not.toBeInTheDocument();
  });

  it('never puts the thrown message on screen', () => {
    render(
      <ErrorBoundary>
        <ThrowsOnRender />
      </ErrorBoundary>,
    );

    expect(screen.queryByText(/VITE_FIREBASE_API_KEY/)).not.toBeInTheDocument();
  });
});
