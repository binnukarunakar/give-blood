// Demo personas + fixture geometry for the local click-through demo (GB-24).
//
// DEMO ONLY — ONE-DIRECTIONAL. This module imports production code; NOTHING in
// src/demo/ is imported by src/index.ts, src/app.ts or any production module.
// The demo composes its own app by CALLING buildApp with fake adapters, so no
// env flag can switch production into demo auth (guarded by demoSeed.test.ts).
//
// Every phone here is a placeholder in the 555-01xx range — never a real
// number (SECURITY: no PII in generated files). The four tokens are the fake
// Firebase ID tokens the demo's FakeTokenVerifier accepts.
import ngeohash from 'ngeohash';
import type { AuthUser } from '../auth/verifier.js';
import type { BloodGroup } from '../matching/compatibility.js';
import {
  coverCells,
  GEOHASH_PRECISION,
  haversineKm,
  RADIUS_TIERS_KM,
  tzForGeohash,
} from '../matching/geo.js';

/**
 * The single curated hospital (PROTOCOL.md §1 — hospitals are operator-curated,
 * no self-service route creates one). The id is FIXED, not gen_random_uuid():
 * there is no hospital-listing endpoint, so the demo UI needs a stable id to
 * put in the POST /requests body. It is also served by GET /demo/state.
 */
export const DEMO_HOSPITAL = {
  hospitalId: '11111111-1111-4111-8111-111111111111',
  name: 'Bellevue-style Demo Hospital',
  address: '1 Demo Plaza, New York, NY',
  lat: 40.758,
  lng: -73.9855,
  bloodbankPhone: '+15550100100',
} as const;

// True donor positions. A donor's stored location is a precision-5 geohash CELL
// (~4.9 km across) and nothing else (DATA_MODEL "Geo-indexing"), so both of
// these points land in the hospital's own cell and the app shows both donors
// the same coarse cell-centroid distance. That coarseness is the privacy
// feature (TRUST_PRIVACY.md), not a fixture bug.
const ASHA_POINT = { lat: 40.767, lng: -73.9855 } as const; // ~1.0 km N of the hospital
const MEERA_POINT = { lat: 40.776, lng: -73.9855 } as const; // ~2.0 km N of the hospital

function encodeCell(point: { lat: number; lng: number }): string {
  return ngeohash.encode(point.lat, point.lng, GEOHASH_PRECISION);
}

/** Cell-centroid distance to the hospital, rounded exactly like the alerts route. */
export function cellDistanceKm(cell: string): number {
  const { latitude, longitude } = ngeohash.decode(cell);
  return (
    Math.round(haversineKm(latitude, longitude, DEMO_HOSPITAL.lat, DEMO_HOSPITAL.lng) * 10) / 10
  );
}

/**
 * The NEAREST cell covered at tier 1 (10 km) but not at tier 0 (5 km), derived
 * from the cover sets themselves — same method as src/e2e/support.ts — so the
 * fixture cannot drift out of sync with the geo tolerance. Its centroid sits
 * ~8.5 km out: cover keeps every cell whose centroid is within radius + half a
 * cell diagonal, so no cell nearer than that can be tier-1-only.
 */
function nearestRingCell(): string {
  const tier0 = new Set(coverCells(DEMO_HOSPITAL.lat, DEMO_HOSPITAL.lng, RADIUS_TIERS_KM[0]));
  const ring = coverCells(DEMO_HOSPITAL.lat, DEMO_HOSPITAL.lng, RADIUS_TIERS_KM[1])
    .filter((cell) => !tier0.has(cell))
    .sort((a, b) => cellDistanceKm(a) - cellDistanceKm(b))[0];
  if (ring === undefined) throw new Error('no tier-1-only cell around the demo hospital');
  return ring;
}

export interface DemoDonor {
  /** Fake Firebase ID token the client sends as `Authorization: Bearer <token>`. */
  token: string;
  /** Firebase uid (the `sub` claim) this token resolves to. */
  uid: string;
  handle: string;
  bloodGroup: BloodGroup;
  /** Placeholder E.164 phone — the donor's OTP identity (DATA_MODEL § Donor). */
  phone: string;
  /** Fake FCM registration token; never displayed (DATA_MODEL: delivery address only). */
  pushToken: string;
  geohash5: string;
  /** Derived from geohash5 at write, exactly as POST /donors does. */
  tz: string;
  /** Lowest radius tier whose cover contains this donor — asserted at boot. */
  tier: 0 | 1;
}

function donor(
  handle: string,
  bloodGroup: BloodGroup,
  phone: string,
  geohash5: string,
  tier: 0 | 1,
): DemoDonor {
  const slug = handle.toLowerCase();
  return {
    token: `demo-${slug}`,
    uid: `uid-demo-${slug}`,
    handle,
    bloodGroup,
    phone,
    pushToken: `demo-push-${slug}`,
    geohash5,
    tz: tzForGeohash(geohash5),
    tier,
  };
}

/**
 * Three donors that make the matcher visible:
 *   Asha  B+ tier 0 — matches a B+ request immediately
 *   Ravi  O- tier 1 — compatible, but only reached after one escalation
 *   Meera A+ tier 0 — Asha's cell, same 0.3 km, NEVER matched for B+ (group gate)
 */
export const DEMO_DONORS: readonly DemoDonor[] = [
  donor('Asha', 'B+', '+15550100001', encodeCell(ASHA_POINT), 0),
  donor('Ravi', 'O-', '+15550100002', nearestRingCell(), 1),
  donor('Meera', 'A+', '+15550100003', encodeCell(MEERA_POINT), 0),
];

/** The operator-verified hospital requester (PROTOCOL.md §1 — never self-service). */
export const DEMO_REQUESTER = {
  token: 'demo-city',
  uid: 'uid-demo-city',
  phone: '+15550100009',
} as const;

/** The token → principal map the demo's FakeTokenVerifier is built from. */
export function demoPrincipals(): Map<string, AuthUser> {
  const entries: [string, AuthUser][] = DEMO_DONORS.map((d) => [
    d.token,
    { uid: d.uid, phone: d.phone },
  ]);
  entries.push([DEMO_REQUESTER.token, { uid: DEMO_REQUESTER.uid, phone: DEMO_REQUESTER.phone }]);
  return new Map(entries);
}

const HANDLE_BY_PUSH_TOKEN = new Map(DEMO_DONORS.map((d) => [d.pushToken, d.handle]));

/**
 * Push token → donor handle, for the demo's push inbox. An unrecognised token
 * resolves to a constant, never to the token itself: a push token is a delivery
 * address and is never displayed (DATA_MODEL § Donor).
 */
export function handleForPushToken(pushToken: string): string {
  return HANDLE_BY_PUSH_TOKEN.get(pushToken) ?? 'unknown device';
}

/**
 * Boot-time geometry check. Returns one line per problem (empty = fixture
 * intact). The caller warns and continues — a drifted fixture makes for a
 * confusing demo, not an unsafe one.
 */
export function verifyDemoGeometry(): string[] {
  const tier0 = new Set(coverCells(DEMO_HOSPITAL.lat, DEMO_HOSPITAL.lng, RADIUS_TIERS_KM[0]));
  const tier1 = new Set(coverCells(DEMO_HOSPITAL.lat, DEMO_HOSPITAL.lng, RADIUS_TIERS_KM[1]));
  const problems: string[] = [];
  for (const d of DEMO_DONORS) {
    const inTier0 = tier0.has(d.geohash5);
    if (d.tier === 0 && !inTier0) {
      problems.push(`${d.handle} (${d.geohash5}) should be inside the tier-0 cover but is not`);
    }
    if (d.tier === 1 && inTier0) {
      problems.push(`${d.handle} (${d.geohash5}) is inside the tier-0 cover — no escalation to show`);
    }
    if (!tier1.has(d.geohash5)) {
      problems.push(`${d.handle} (${d.geohash5}) is outside the tier-1 cover`);
    }
  }
  return problems;
}
