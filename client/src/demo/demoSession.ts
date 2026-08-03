// Which persona this browser is acting as.
//
// The active persona lives outside React on purpose: the api layer's token
// source is a plain function called per request (lib/api.ts), so it has to read
// the CURRENT persona at call time, not the one selected when a provider
// mounted. The React provider mirrors this module, it does not own it.
import { setAppTokenSource } from '../lib/api';
import {
  DEFAULT_DEMO_PERSONA,
  demoPersonaById,
  type DemoPersona,
  type DemoPersonaId,
} from './personas';

/** Survives a reload so a demo keeps its persona across a refresh. */
const STORAGE_KEY = 'give-blood.demo.persona';

function restore(): DemoPersona {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_DEMO_PERSONA : demoPersonaById(stored);
  } catch {
    // localStorage throws in some privacy modes. The demo still runs, it just
    // starts from the default persona every time.
    return DEFAULT_DEMO_PERSONA;
  }
}

let active: DemoPersona = restore();

export function activeDemoPersona(): DemoPersona {
  return active;
}

export function setActiveDemoPersona(id: DemoPersonaId): DemoPersona {
  active = demoPersonaById(id);
  try {
    window.localStorage.setItem(STORAGE_KEY, active.id);
  } catch {
    // Not persisted. The in-memory switch above already took effect.
  }
  return active;
}

/**
 * Point the app-wide api client at the selected persona's fake token. Call this
 * before the first render so the opening GET already carries a bearer header;
 * every later request re-reads `active`, so switching persona takes effect on
 * the next call with no re-install.
 */
export function installDemoTokenSource(): void {
  setAppTokenSource(() => Promise.resolve(active.token));
}
