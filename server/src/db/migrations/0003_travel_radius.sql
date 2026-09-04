-- Migration 0003 — donor-chosen travel radius (GB-35). Forward-only, additive.
--
-- "How far will you travel?" becomes a donor-owned field instead of an
-- assumption. The matcher compares it against the distance to the donor's own
-- cell, so the request's radius tier still controls WHEN a farther donor
-- becomes reachable: a donor 18 km out who is willing to travel 25 km only
-- enters the cover set at tier 2, which the sweep only reaches when tiers 0
-- and 1 failed to fill the request.
--
-- DEFAULT 25 is deliberate and load-bearing: 25 km is the hard cap and was the
-- effective behaviour before this column existed, so every row that predates
-- the migration keeps exactly the reach it already had. A smaller default would
-- silently shrink the alertable pool, which is the one outcome the whole design
-- is scored against.
--
-- Constrained to the RADIUS_TIERS_KM ladder rather than a free integer: the
-- stored location is a ~4.9 km cell, so a finer slider would imply a precision
-- the data does not have.

ALTER TABLE donor
  ADD COLUMN travel_radius_km smallint NOT NULL DEFAULT 25
    CONSTRAINT donor_travel_radius_km_allowed CHECK (travel_radius_km IN (5, 10, 25));
