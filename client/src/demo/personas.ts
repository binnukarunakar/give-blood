// The four demo identities.
//
// These bearer tokens are fake and are recognised ONLY by the server's demo
// entrypoint, which maps each one to a seeded uid. The production server
// verifies real Firebase ID tokens and would reject every one of them.
//
// The set is chosen to make the matcher visible in a browser: one donor inside
// tier 0, one only reachable after the radius escalates, one who is close but
// blood-incompatible, and the hospital account that raises the request.
//
// The distances below are the ones the app reports, and they are cell
// distances, not point distances. A donor is stored as a precision-5 geohash
// cell (~4.9 km across) and nothing finer (TRUST_PRIVACY.md "Location
// privacy"), so Asha and Meera — a kilometre apart on the ground — share the
// hospital's own cell and both read 0.3 km. That collapse is the privacy
// design working, not a fixture error.

export type DemoPersonaId = 'asha' | 'ravi' | 'meera' | 'city';

export interface DemoPersona {
  id: DemoPersonaId;
  /** Sent verbatim as `Authorization: Bearer <token>`. */
  token: string;
  /** The uid the demo server maps that token to. */
  uid: string;
  name: string;
  /** Button label in the persona bar. */
  label: string;
  /** What this persona proves when you switch to it. */
  detail: string;
  role: 'donor' | 'requester';
}

const ASHA: DemoPersona = {
  id: 'asha',
  token: 'demo-asha',
  uid: 'uid-demo-asha',
  name: 'Asha',
  label: 'Asha (B+ donor)',
  detail: 'Shares the hospital cell, so reads 0.3 km and tier 0 reaches her.',
  role: 'donor',
};

const RAVI: DemoPersona = {
  id: 'ravi',
  token: 'demo-ravi',
  uid: 'uid-demo-ravi',
  name: 'Ravi',
  label: 'Ravi (O- donor)',
  detail: 'Reads 8.5 km: outside tier 0, alerted once the radius escalates.',
  role: 'donor',
};

const MEERA: DemoPersona = {
  id: 'meera',
  token: 'demo-meera',
  uid: 'uid-demo-meera',
  name: 'Meera',
  label: 'Meera (A+ donor)',
  detail: 'Tied with Asha at 0.3 km, same cell, and never alerted: A+ cannot give to B+.',
  role: 'donor',
};

const CITY: DemoPersona = {
  id: 'city',
  token: 'demo-city',
  uid: 'uid-demo-city',
  name: 'City Hospital',
  label: 'City Hospital (requester)',
  detail: 'Verified requester at the seeded hospital. Raises the request.',
  role: 'requester',
};

export const DEMO_PERSONAS: readonly DemoPersona[] = [ASHA, RAVI, MEERA, CITY];

export const DEFAULT_DEMO_PERSONA: DemoPersona = ASHA;

/** Unknown ids fall back to the default rather than leaving the demo unusable. */
export function demoPersonaById(id: string): DemoPersona {
  return DEMO_PERSONAS.find((persona) => persona.id === id) ?? DEFAULT_DEMO_PERSONA;
}
