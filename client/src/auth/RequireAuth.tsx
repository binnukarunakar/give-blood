// Route guard. Signed-out users are sent to /login; the pre-resolution frame
// renders a status line rather than flashing the login form.
import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from './authContext';

export function RequireAuth({ children }: { children: ReactNode }): ReactElement {
  const { status } = useAuth();
  if (status === 'loading') {
    return <p className="status">Checking your sign-in…</p>;
  }
  if (status === 'signed-out') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
