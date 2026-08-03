// Persona selection as plain context, kept separate from AuthContext so the
// demo adds a channel rather than changing the one every page already reads.
import { createContext, useContext } from 'react';
import type { DemoPersona, DemoPersonaId } from './personas';

export interface DemoPersonaSelection {
  persona: DemoPersona;
  select: (id: DemoPersonaId) => void;
}

/** null outside the demo provider: the persona bar then renders nothing. */
export const DemoPersonaContext = createContext<DemoPersonaSelection | null>(null);

export function useDemoPersonaSelection(): DemoPersonaSelection | null {
  return useContext(DemoPersonaContext);
}
