// Bridges Firebase auth state into AuthContext. The subscription starts on
// mount, so nothing Firebase-related runs at import time.
import { onAuthStateChanged } from 'firebase/auth';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { firebaseAuth } from '../lib/firebase';
import { AuthContext, INITIAL_AUTH_STATE, type AuthState } from './authContext';

export function FirebaseAuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<AuthState>(INITIAL_AUTH_STATE);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth(), (user) => {
      setState(
        user === null
          ? { status: 'signed-out', uid: null }
          : { status: 'signed-in', uid: user.uid },
      );
    });
    return unsubscribe;
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
