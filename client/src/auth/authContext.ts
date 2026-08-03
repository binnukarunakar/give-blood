// Auth state as plain context, decoupled from Firebase so any surface (and any
// test) can supply it. The Firebase subscription lives in FirebaseAuthProvider.
import { createContext, useContext } from 'react';

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out';

export interface AuthState {
  status: AuthStatus;
  /** Firebase uid of the signed-in user, else null. */
  uid: string | null;
}

export const INITIAL_AUTH_STATE: AuthState = { status: 'loading', uid: null };

export const AuthContext = createContext<AuthState>(INITIAL_AUTH_STATE);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
