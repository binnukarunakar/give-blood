# Data Model

Entities, sensitivity classes, the compatibility matrix, the eligibility
predicate, geo-indexing, and the two state machines. This document is
canonical for state names and fields; `PROTOCOL.md` operates on these shapes.

## Sensitivity model

| Class | Definition | Rule of thumb |
|---|---|---|
| **public** | Anything shown in an alert detail view | Fetched by N donor phones = assume it leaks. Hospital location is public — a hospital is a public place. |
| **requester-visible** | Shown to the request's owner | Donor data enters this class **only** via Pledge creation (explicit accept). Never before. |
| **private** | Server + record owner only | All donor fields pre-accept. Requester sees aggregates only ("38 donors alerted"), never who was alerted. |

Two structural invariants:

1. Donor identity crosses `private → requester-visible` only by the donor's
   accept, and only via the snapshot fields on Pledge — never the live Donor row.
2. Donor exact location never exists server-side: the client truncates a
   map-tap to geohash-5 **on device**; only the cell is transmitted or stored.

## Entities (six tables)

### Donor

| Field | Type | Sensitivity | Mutability | Notes |
|---|---|---|---|---|
| donor_id | uuid | private | write-once | never in any payload |
| firebase_uid | text UNIQUE | private | write-once | auth linkage: the Firebase `sub` claim; every donor-authenticated endpoint resolves the row by it |
| handle | text | private → requester-visible on accept | mutable | display name; pseudonym allowed |
| blood_group | enum(8) | private → requester-visible on accept | mutable, locked while a pledge is active | self-reported; hospital cross-matches at the bench regardless |
| geohash5 | char(5) | private | mutable | the ONLY location field |
| travel_radius_km | smallint | private | mutable | how far the donor will travel: 5 / 10 / 25 (`CHECK`), default **25** |
| tz | text | private | derived from geohash5 at write | makes donor-local quiet hours computable |
| phone (`DONOR_PHONE`) | text | private | mutable | OTP identity; revealed post-accept iff `share_phone_on_accept` |
| push_token | text? | private | mutable | delivery address, never displayed; **null until the browser grants push permission** (donor row exists first: register → permission → token → verification push) |
| push_verified_at | timestamp? | private | system-set | **null = not in the matching pool.** Set when the verification push is acknowledged; cleared on token rotation until re-verified |
| share_phone_on_accept | bool | private | mutable | default **false** |
| opted_in | bool | private | mutable | consent gate; false = invisible to matching |
| available | bool | private | mutable | intent gate; donor-controlled toggle |
| snooze_until | timestamp? | private | mutable | donor-set temporary mute |
| last_donation_at | timestamp? | private | mutable — set by requester confirm OR donor self-report, whichever first | physiology gate; null = never donated |
| last_alerted_at | timestamp? | private | system-set | rolling scalar: survives Dispatch retention, feeds least-recently-alerted ranking |
| created_at | timestamp | private | write-once | |

The three gates — `opted_in` (consent), `available` (intent), cooldown
(physiology) — stay independent booleans with one owner each, never a
collapsed status enum. Donating sets `last_donation_at`; it does not touch
`available`.

### Requester (v0: hospital-verified only — attendant tier deferred, `DECISIONS.md` #9)

| Field | Type | Sensitivity | Mutability |
|---|---|---|---|
| requester_id | uuid | private | write-once |
| firebase_uid | text UNIQUE | private | operator-bound at onboarding callback |
| verified | bool | public (badge on alert detail) | operator-set |
| hospital_id | fk | public | mutable |
| phone | text | private — **not revealed to donors in v0**; donors coordinate via `HOSPITAL_BLOODBANK_PHONE` | mutable |

### Hospital (operator-curated registry)

| Field | Type | Sensitivity | Mutability |
|---|---|---|---|
| hospital_id | uuid | public | write-once |
| name, address | text | public | mutable |
| lat, lng | decimal | public | mutable |
| bloodbank_phone (`HOSPITAL_BLOODBANK_PHONE`) | text | public — shown on every alert detail as the verification + coordination anchor | operator-set, sourced from the hospital's own public listings |

Exact coordinates are fine here — the map pin donors see IS the feature.

### Request

| Field | Type | Sensitivity | Mutability |
|---|---|---|---|
| request_id | uuid | public (opaque ref) | write-once |
| requester_id | fk | private | write-once |
| hospital_id | fk | public | write-once |
| blood_group | enum(8) | public | write-once |
| units_needed | int | public | write-once |
| urgency | enum(critical, standard) | public | write-once |
| state | enum (below) | requester-visible | mutable |
| radius_tier | int | private | mutable, monotonic ↑ |
| units_confirmed | int | requester-visible | system-incremented on donated |
| expires_at | timestamp | public | mutable (requester may extend, bounded) |
| created_at | timestamp | public | write-once |

Clinical fields are write-once: dispatched alerts already state them and
cannot be recalled — a correction is a **new request**.

### Dispatch (alert record; append-only)

| Field | Type | Sensitivity | Mutability |
|---|---|---|---|
| dispatch_id | uuid | private | write-once |
| request_id, donor_id | fk | private | write-once |
| radius_tier_at_send | int | private | write-once |
| sent_at | timestamp | private | write-once |
| response | enum(none, accepted, declined) | private | single transition from `none` |
| responded_at | timestamp? | private | write-once on response |

**Unique (request_id, donor_id)** — a donor is alerted once per request;
escalation must never re-page. The whole table is private: the requester sees
`count(*)`, never a roster — a declined alert must never expose that a
specific person was asked.

### Pledge (created iff Dispatch.response = accepted; this row IS the reveal)

| Field | Type | Sensitivity | Mutability |
|---|---|---|---|
| pledge_id | uuid | requester-visible | write-once |
| request_id, donor_id | fk | donor_id private | write-once |
| donor_handle, donor_blood_group | snapshots at accept | requester-visible | write-once |
| donor_phone | text? | requester-visible iff donor's `share_phone_on_accept` | write-once snapshot |
| eta_bucket | enum(≤30m, ≤1h, ≤2h) | requester-visible | donor-set at accept |
| state | enum (below) | requester-visible | mutable, one-way |
| created_at | timestamp | requester-visible | write-once |

Requester-visible fields are snapshots, never joins — the requester's view
never becomes a live window into the Donor table. **At most one active pledge
per donor** (partial unique index): one body holds one unit; an active pledge
also excludes the donor from all further matching.

## Blood compatibility — red-cell matrix (recipient × donor)

Whole-blood recruitment follows red-cell compatibility. ✓ = donor acceptable.

| Recipient \ Donor | O− | O+ | A− | A+ | B− | B+ | AB− | AB+ |
|---|---|---|---|---|---|---|---|---|
| **O−** | ✓ | – | – | – | – | – | – | – |
| **O+** | ✓ | ✓ | – | – | – | – | – | – |
| **A−** | ✓ | – | ✓ | – | – | – | – | – |
| **A+** | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| **B−** | ✓ | – | – | – | ✓ | – | – | – |
| **B+** | ✓ | ✓ | – | – | ✓ | ✓ | – | – |
| **AB−** | ✓ | – | ✓ | – | ✓ | – | ✓ | – |
| **AB+** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Sanity anchors (unit-test assertions): O− column all-✓ (universal donor);
AB+ row all-✓ (universal recipient); row sizes 1/2/2/4/2/4/4/8.

Representation: **a static in-code constant** — immutable medical fact; a DB
table invites an admin edit that kills someone. Changing it requires a deploy,
which is a feature. If the matcher wants a SQL join, the table is generated
from the constant at migration time with UPDATE/DELETE revoked.
(Reconciled — `DECISIONS.md` #6.)

**Warning to future editors:** plasma compatibility is the INVERSE of this
matrix (AB is the universal plasma donor). Do not "correct" the table.
Components other than whole blood are out of scope.

## Donor eligibility predicate

Donor D is eligible for request R at tier T iff ALL of:

```
eligible(D, R, T) :=
      D.opted_in
  AND D.available
  AND D.push_verified_at IS NOT NULL
  AND (D.snooze_until IS NULL OR D.snooze_until < now)
  AND (D.last_donation_at IS NULL
       OR now - D.last_donation_at >= 56 days)        -- whole-blood cooldown
  AND D.blood_group IN COMPAT[R.blood_group]
  AND D.geohash5 IN cover(R.hospital, radius[T])
  AND D.travel_radius_km >= dist(R.hospital, nearest_point(D.geohash5))  -- donor's own limit
  AND quiet_hours_pass(D, R)     -- 22:00–07:00 donor-local; critical pierces
  AND NOT EXISTS active pledge for D                   -- one body, one unit
  AND NOT EXISTS dispatch(R, D)                        -- never re-page per request
```

Resolves against one composite partial index —
`(blood_group, geohash5) WHERE opted_in AND available AND push_verified_at IS NOT NULL`
— plus two anti-joins. No PostGIS, no search engine.

**Travel radius (GB-35).** `cover(...)` and the per-cell distance are produced
together by `coverCellsWithDistance`, passed as two parallel array parameters,
and paired by `unnest` in the one statement — so the donor's own "how far will
you travel?" is compared against how far away they actually are.

The two clauses do different jobs and both are needed:

| Clause | Owner | Question it answers |
|---|---|---|
| `geohash5 IN cover(hospital, radius[T])` | the request | Has escalation reached this donor yet? |
| `travel_radius_km >= dist(...)` | the donor | Could this donor be inside the distance they agreed to? |

The consequence is the behaviour the feature exists for: a donor 18 km out who
is willing to travel 25 km is invisible at tiers 0 and 1 and only becomes
alertable at tier 2, which the sweep only reaches when the nearer tiers failed
to fill the request. Nobody is paged for a hospital they already said is too
far, and nobody far away is paged while a closer donor could still answer.

**Which distance.** The comparison uses the distance to the cell's NEAREST
POINT, not its centroid — the smallest distance any donor in that cell can
possibly be from the hospital. A precision-5 cell is ~4.9 km across, so a donor
sits up to ~3.46 km either side of its centroid, and gating on the centroid
excluded donors who were inside the range they had agreed to: a cell centred
5.04 km out can hold a donor 2.59 km from the hospital, and a "5 km" donor there
was never alerted. Gating on the nearest point asks the only question the data
can answer — *could* this donor be within the distance they agreed to? — so it
excludes only donors who certainly are not.

The bias is deliberate and matches the one `cover(...)` itself is built around:
over-include and let the donor decline, never silently drop someone who would
have come. A false inclusion costs one tap; a false exclusion means a willing
donor minutes away never learns that someone needed blood.

The residual ~±3.46 km spread is also why the choice is a 5/10/25 ladder
matching `RADIUS_TIERS_KM` (DB `CHECK`), not a free-form slider: a finer control
would imply a precision the stored location does not have.

## Geo-indexing

| Precision | Cell size | Verdict |
|---|---|---|
| 4 | ~39 × 19.5 km | too coarse — matching degenerates to "same city" |
| **5** | **~4.9 × 4.9 km** | **chosen** — neighborhood-scale k-anonymity, modest cover sets |
| 6 | ~1.2 × 0.6 km | too fine — effectively stores the donor's block |

`cover(hospital, radius)` enumerates precision-5 cells intersecting the circle
around the hospital's exact point; donors match by `geohash5 IN (...)`.
Radius ladder (canonical, all dimensions): **T0 = 5 km, T1 = 10 km,
T2 = 25 km cap** → ≤ ~90 cells at cap. Distance error up to ~3.5 km is
accepted: pre-accept we only decide *whether to alert*; post-accept routing
runs on the donor's device from their true position, which the server never
sees. In sparse regions the cap may cover zero donors — the fix is a bigger
pool, not finer geo.

## Request state machine (canonical — `DECISIONS.md` #2)

```
open → alerting → partially_pledged → covered → fulfilled
  \________\____________\_______________\______→ cancelled
             \____________\_______________\____→ expired
```

| State | Meaning | Entry trigger |
|---|---|---|
| open | validated, matching not yet run | requester submits |
| alerting | dispatches in flight, zero active pledges | first dispatch |
| partially_pledged | 1 ≤ active pledges < overbook target | first accept |
| covered | active pledges ≥ ceil(units_needed × 1.5); dispatching paused | overbook target hit |
| fulfilled *(terminal)* | units_confirmed ≥ units_needed, requester-confirmed | requester action only |
| expired *(terminal)* | expires_at passed, tiers exhausted | sweep |
| cancelled *(terminal)* | requester withdraws | requester action, any non-terminal state |

- **fulfilled is requester-triggered, never automatic** — pledges are
  promises, not blood. The system's only auto-action at pledge sufficiency is
  pausing dispatch (`covered`).
- 1 donor = 1 unit. A withdrawal/no_show during `covered` drops the count →
  back to `partially_pledged`, dispatch resumes to not-yet-alerted donors.
- Radius escalation is the monotonic `radius_tier` field, **not a state**.
- On any terminal state: all still-active pledges → `released`, pledged donors
  get a closure notification.

## Pledge state machine

```
active → donated                  (terminal; sets Donor.last_donation_at)
active → withdrawn                (terminal; donor cancels, no penalty)
active → no_show                  (terminal; requester marks)
active → released                 (terminal; request closed around the donor)
```

| State | Set by | Effect |
|---|---|---|
| active | system, on accept | donor excluded from all matching; requester sees pledge card |
| donated | requester confirm | increments Request.units_confirmed; stamps last_donation_at if not already self-reported |
| withdrawn | donor | recount → possible covered → partially_pledged regression |
| no_show | requester | recount as above; **no punitive scoring in v1** |
| released | system | request closed first. **Also the mapping for hospital-bench deferral** (donor showed, failed screening): released, NOT donated — a deferred donor must not incur a 56-day cooldown |

All transitions one-way; a Pledge never returns to active (dispatch uniqueness
makes re-accept impossible — linear, auditable history). Cooldown stamping is
dual-path: requester confirm OR donor self-report ("I donated today" in the
app), whichever first — a forgetful requester must not leave a donor alertable
the day after donating. (`DECISIONS.md` #8. ARRIVED state and arrival codes:
deferred, #12.)

## What this deliberately is not

- **No components other than whole blood** — platelets (7-day cooldown) and
  plasma (inverted compatibility) double the state space; cut.
- **No medical screening data** — the hospital screens at the bench; storing
  hemoglobin/meds/travel makes the DB a health-record honeypot for zero value.
- **No rare-phenotype matching** (Kell, Bombay) — specialist registries exist.
- **No donation-history ledger** — `last_donation_at` + terminal pledges are
  the history.
- **No live donor tracking** — `eta_bucket` is the entire ETA surface.
- **No reputation/no-show scoring in v1** — punishing volunteers shrinks the
  pool, which is the product.
