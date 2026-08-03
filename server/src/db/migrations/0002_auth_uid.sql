-- Migration 0002 — auth linkage (GB-16). Forward-only.
-- Adds the Firebase auth linkage (the token's `sub` claim) to donor and
-- requester so an authenticated uid resolves to exactly one row.
-- Both tables are empty pre-launch, so ADD COLUMN ... NOT NULL without a
-- default is safe here.

ALTER TABLE donor ADD COLUMN firebase_uid text NOT NULL;     -- write-once auth linkage (Firebase `sub` claim)
CREATE UNIQUE INDEX donor_firebase_uid_uq ON donor (firebase_uid);

ALTER TABLE requester ADD COLUMN firebase_uid text NOT NULL; -- write-once auth linkage (Firebase `sub` claim)
CREATE UNIQUE INDEX requester_firebase_uid_uq ON requester (firebase_uid);
