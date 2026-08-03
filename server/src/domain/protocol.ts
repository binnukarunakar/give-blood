// Named protocol constants — the single home for give-blood's tunable
// request numbers (docs/PROTOCOL.md §8 "Named defaults"). Call sites import
// from here so no magic numbers live in route/domain code. Later tickets extend
// this file. (Cooldown days, quiet hours, and radius tiers already live with
// their owning modules — matching/eligibility.ts, matching/geo.ts — where they
// were first needed; this file owns the request-creation numbers.)

/** Max units one request may ask for (PROTOCOL.md §8). Above this, hospitals use blood banks, not the app. */
export const MAX_UNITS_PER_REQUEST = 6;

/** Max simultaneously-open requests a single requester may hold (PROTOCOL.md §8). */
export const MAX_OPEN_REQUESTS_PER_REQUESTER = 3;

/** Same-requester dedupe window, in hours (PROTOCOL.md §8). */
export const DUP_WINDOW_H = 24;

/** Request time-to-live by urgency, in hours (PROTOCOL.md §8: 12 h critical / 24 h standard). */
export const REQUEST_TTL_HOURS = { critical: 12, standard: 24 } as const;

/** Max requester-initiated TTL extensions (PROTOCOL.md §8). Enforced by a later ticket. */
export const MAX_TTL_EXTENSIONS = 2;

/**
 * Tier-advance window per urgency, in minutes (PROTOCOL.md §5 table / §8:
 * TIER_WINDOW_CRITICAL 10 min, TIER_WINDOW_STANDARD 30 min). Drives the
 * sweep's deterministic created_at-based tier schedule (GB-12 — no schema
 * column; the target tier is recomputed from created_at every cycle).
 */
export const TIER_WINDOW_MIN = { critical: 10, standard: 30 } as const;

/**
 * The radius tier a request STARTS at, by urgency (PROTOCOL.md §5 table):
 * critical opens at T1 (10 km), standard at T0 (5 km). The sweep raises
 * radius_tier from here on the created_at schedule, capped at T2 (25 km).
 */
export const BASE_TIER = { critical: 1, standard: 0 } as const;

/**
 * The non-terminal request states — the set dedupe and the rate cap count
 * against (an "open" request in the protocol's sense). The terminal states
 * (fulfilled / expired / cancelled) are deliberately excluded, so a closed
 * request never blocks or de-dupes a new one. Canonical state list:
 * docs/DATA_MODEL.md § "Request state machine".
 */
export const OPEN_REQUEST_STATES = [
  'open',
  'alerting',
  'partially_pledged',
  'covered',
] as const;
