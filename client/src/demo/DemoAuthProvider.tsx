// Demo replacement for FirebaseAuthProvider.
//
// It publishes the SAME AuthState shape ({ status, uid }), so RequireAuth and
// every page work unchanged and none of them can tell the difference. Firebase
// is never touched: no app is initialised, no env var is read, so a demo build
// runs with no Firebase project at all.
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { AuthContext, type AuthState } from '../auth/authContext';
import { activeDemoPersona, setActiveDemoPersona } from './demoSession';
import { DemoPersonaContext, type DemoPersonaSelection } from './personaContext';
import type { DemoPersona, DemoPersonaId } from './personas';

export function DemoAuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [persona, setPersona] = useState<DemoPersona>(() => activeDemoPersona());

  const select = useCallback((id: DemoPersonaId): void => {
    setPersona(setActiveDemoPersona(id));
  }, []);

  // A persona switch is a user switch: the uid changes. Publishing the new uid
  // does NOT by itself refetch anything — pages load in effects that never
  // depend on it. mountDemo keys the app subtree on this uid; that is what
  // makes a switch remount.
  const auth: AuthState = useMemo(() => ({ status: 'signed-in', uid: persona.uid }), [persona]);
  const selection: DemoPersonaSelection = useMemo(() => ({ persona, select }), [persona, select]);

  return (
    <DemoPersonaContext.Provider value={selection}>
      <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
    </DemoPersonaContext.Provider>
  );
}
