// App shell (GB-28, docs/DESIGN.md § App shell): sticky blurred header with the
// brand mark, the two role tabs, and one sign-out control. The screens inside
// own everything below it.
import { useState, type ReactElement, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useAuth } from '../auth/authContext';
import { DEMO_MODE } from '../demo/demoMode';
import { DemoPersonaBar } from '../demo/PersonaBar';
import { signOutUser } from '../lib/firebase';
import { Button, CloseIcon, DropMark } from '../ui';

export function Layout({ children }: { children: ReactNode }): ReactElement {
  const { status } = useAuth();
  const { pathname } = useLocation();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = status === 'signed-in';

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    setError(null);
    try {
      await signOutUser();
    } catch {
      setError('Sign-out failed. Check your connection and try again.');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="brand">
            <span className="brand-mark">
              <DropMark size={18} />
            </span>
            <span>Give Blood</span>
          </h1>
          {signedIn ? (
            <>
              <nav className="app-nav" aria-label="Role">
                <NavLink to="/donor">Donor</NavLink>
                <NavLink to="/requester">Requester</NavLink>
              </nav>
              {/* Switching persona IS the sign-out in demo mode: one control, not two. */}
              {DEMO_MODE ? null : (
                <span className="header-actions">
                  <Button
                    variant="ghost"
                    aria-label="Sign out"
                    loading={signingOut}
                    onClick={() => void handleSignOut()}
                  >
                    <CloseIcon />
                  </Button>
                </span>
              )}
            </>
          ) : null}
        </div>
      </header>
      {DEMO_MODE && signedIn ? <DemoPersonaBar /> : null}
      {error === null ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <main className="app-main">
        {/* Keyed on the path so a route change replays the mount animation. */}
        <div className="route" key={pathname}>
          {children}
        </div>
      </main>
    </>
  );
}
