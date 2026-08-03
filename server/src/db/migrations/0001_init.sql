-- Migration 0001 — initial schema for give-blood.
-- Forward-only (no down migration). Creates 6 enums, 6 tables, 4 load-bearing indexes.
-- UUID PKs default to gen_random_uuid(), which is core in PostgreSQL >= 13 — no extension.
-- All timestamps are timestamptz; snake_case throughout. Canonical: docs/DATA_MODEL.md.
-- Write-once columns are marked "-- write-once" and are enforced at the application layer.

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE blood_group AS ENUM ('O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+');
CREATE TYPE request_urgency AS ENUM ('critical', 'standard');
CREATE TYPE request_state AS ENUM (
  'open', 'alerting', 'partially_pledged', 'covered', 'fulfilled', 'expired', 'cancelled'
);
CREATE TYPE dispatch_response AS ENUM ('none', 'accepted', 'declined');
CREATE TYPE pledge_state AS ENUM ('active', 'donated', 'withdrawn', 'no_show', 'released');
CREATE TYPE eta_bucket AS ENUM ('le_30m', 'le_1h', 'le_2h');

-- ── Hospital (operator-curated registry; every field public) ───────────────
CREATE TABLE hospital (
  hospital_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- write-once
  name            text NOT NULL,
  address         text NOT NULL,
  lat             numeric(9, 6) NOT NULL,
  lng             numeric(9, 6) NOT NULL,
  bloodbank_phone text NOT NULL                               -- HOSPITAL_BLOODBANK_PHONE; operator-set
);

-- ── Donor (every field private pre-accept) ─────────────────────────────────
CREATE TABLE donor (
  donor_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- write-once
  handle                text NOT NULL,                             -- display name; pseudonym allowed
  blood_group           blood_group NOT NULL,                      -- locked while a pledge is active (app-enforced)
  geohash5              char(5) NOT NULL,                          -- the ONLY location field
  tz                    text NOT NULL,                             -- derived from geohash5 at write
  phone                 text NOT NULL,                             -- DONOR_PHONE; OTP identity
  push_token            text,                                      -- delivery address, never displayed; null until browser grants push permission
  push_verified_at      timestamptz,                               -- null = not in the matching pool
  share_phone_on_accept boolean NOT NULL DEFAULT false,
  opted_in              boolean NOT NULL,                          -- consent gate
  available             boolean NOT NULL,                          -- intent gate
  snooze_until          timestamptz,                               -- donor-set temporary mute
  last_donation_at      timestamptz,                               -- null = never donated
  last_alerted_at       timestamptz,                               -- system-set; least-recently-alerted ranking
  created_at            timestamptz NOT NULL DEFAULT now()         -- write-once
);

-- ── Requester (v0: hospital-verified only) ─────────────────────────────────
CREATE TABLE requester (
  requester_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),        -- write-once
  verified     boolean NOT NULL,                                  -- operator-set; public badge
  hospital_id  uuid NOT NULL REFERENCES hospital (hospital_id),
  phone        text NOT NULL                                      -- not revealed to donors in v0
);

-- ── Request (clinical fields are write-once — a correction is a new request) ─
CREATE TABLE request (
  request_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),                 -- write-once
  requester_id    uuid NOT NULL REFERENCES requester (requester_id),          -- write-once
  hospital_id     uuid NOT NULL REFERENCES hospital (hospital_id),            -- write-once
  blood_group     blood_group NOT NULL,                                       -- write-once
  units_needed    integer NOT NULL,                                           -- write-once
  urgency         request_urgency NOT NULL,                                   -- write-once
  state           request_state NOT NULL DEFAULT 'open',
  radius_tier     integer NOT NULL DEFAULT 0,                                 -- mutable, monotonic increasing
  units_confirmed integer NOT NULL DEFAULT 0,                                 -- system-incremented on donated
  expires_at      timestamptz NOT NULL,                                       -- mutable (bounded extend)
  created_at      timestamptz NOT NULL DEFAULT now()                          -- write-once
);

-- ── Dispatch (alert record; append-only) ───────────────────────────────────
CREATE TABLE dispatch (
  dispatch_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- write-once
  request_id          uuid NOT NULL REFERENCES request (request_id), -- write-once
  donor_id            uuid NOT NULL REFERENCES donor (donor_id),     -- write-once
  radius_tier_at_send integer NOT NULL,                             -- write-once
  sent_at             timestamptz NOT NULL DEFAULT now(),           -- write-once
  response            dispatch_response NOT NULL DEFAULT 'none',    -- single transition from 'none'
  responded_at        timestamptz                                  -- write-once on response
);

-- ── Pledge (created iff Dispatch.response = accepted; this row IS the reveal) ─
CREATE TABLE pledge (
  pledge_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),    -- write-once
  request_id        uuid NOT NULL REFERENCES request (request_id), -- write-once
  donor_id          uuid NOT NULL REFERENCES donor (donor_id),     -- write-once
  donor_handle      text NOT NULL,                                 -- snapshot at accept; write-once
  donor_blood_group blood_group NOT NULL,                          -- snapshot at accept; write-once
  donor_phone       text,                                          -- snapshot; null unless share_phone_on_accept; write-once
  eta_bucket        eta_bucket NOT NULL,                           -- donor-set at accept
  state             pledge_state NOT NULL DEFAULT 'active',        -- mutable, one-way
  created_at        timestamptz NOT NULL DEFAULT now()             -- write-once
);

-- ── Load-bearing indexes ───────────────────────────────────────────────────
-- (a) a donor is alerted at most once per request; escalation must never re-page.
CREATE UNIQUE INDEX dispatch_request_donor_uq ON dispatch (request_id, donor_id);

-- (b) at most one active pledge per donor — one body holds one unit.
CREATE UNIQUE INDEX pledge_one_active_per_donor ON pledge (donor_id) WHERE state = 'active';

-- (c) the eligibility predicate resolves against this composite partial index.
CREATE INDEX donor_pool ON donor (blood_group, geohash5)
  WHERE opted_in AND available AND push_verified_at IS NOT NULL;

-- (d) the expiry sweep scans requests by state.
CREATE INDEX request_state_idx ON request (state);
