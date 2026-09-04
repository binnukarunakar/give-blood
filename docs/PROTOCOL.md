# Alert & Matching Protocol

The core loop: request → match → alert → pledge → fulfill → close.
State names and table shapes are defined in `DATA_MODEL.md` (canonical);
reconciliation history in `DECISIONS.md`.

## At a glance

```
Request:  open → alerting → partially_pledged → covered → fulfilled
                                   (any non-terminal) → expired | cancelled
Dispatch: none → accepted | declined          (per donor, per request)
Pledge:   active → donated | withdrawn | no_show | released
```

All timing (tier advance, request TTL) is driven by the **Cloud Scheduler →
`/internal/sweep`** endpoint, every 60 s, one idempotent transaction. No
in-process timers — they die with scale-to-zero instances. A minute of jitter
is irrelevant at blood-request timescales.

## 1. Request creation & validation

Requester submits: `blood_group`, `units_needed`, `urgency`
(critical | standard), `hospital_id` (from the curated registry — free-text
hospitals rejected by construction), optional length-capped note. **No patient
name field exists — by construction, not policy.**

| Gate | Rule | On failure |
|---|---|---|
| Requester verified | operator-verified hospital account (v0 has no other tier) | reject |
| Units sane | 1 ≤ units ≤ MAX_UNITS_PER_REQUEST | reject |
| Hospital known | hospital_id in registry (gives trusted lat/lng + `HOSPITAL_BLOODBANK_PHONE`) | reject |
| Same-requester duplicate | open request, same (hospital_id, blood_group, requester_id) within DUP_WINDOW_H | block; prompt "add units to existing request", overridable with an explicit "different patient" confirmation (hospital staff legitimately raise two same-group requests in one shift) |
| Cross-requester duplicate | any open request, same hospital + group | **soft warn only, never auto-merge** — two attendants of one patient are indistinguishable from two patients, and false-merging two real patients starves one of them |
| Requester rate cap | ≤ MAX_OPEN_REQUESTS_PER_REQUESTER | reject |

On pass: Request row in `open`, tier-0 dispatch runs immediately.

## 2. Matching & dispatch — tier blast, not waves

Each escalation tier alerts **all** eligible donors in the tier's cover set
(eligibility predicate in `DATA_MODEL.md`; Dispatch uniqueness guarantees
nobody is ever re-paged for the same request). The wave-composition engine
(ranked partial waves, overflow rollover, deferred re-entry pools) was cut
from v0 as the scope critic's top finding — at pilot scale a tier contains
tens of donors, not hundreds. Revisit only if pilot data shows tier-blasts
too large (`DECISIONS.md` #3).

Dispatch ORDER (for send sequencing and any future wave cap) is a
deterministic four-key sort, explainable in one sentence, debuggable in SQL:

| Key | Rationale |
|---|---|
| 1. Exact group match before merely-compatible | blood banks prefer type-specific; a B+ request drains B+ donors before touching O− |
| 2. O− donors last for non-O− recipients | conserve universal donors for the requests only they can serve |
| 3. Distance (cell-centroid, ascending) | closer = faster arrival |
| 4. Least-recently-alerted first (`Donor.last_alerted_at`) | spread burden across the pool |

No ML, no reliability scoring (deferred with the rest of reputation — v1
policy: never punish volunteers).

## 3. Push delivery — no PHI on the wire

The FCM message carries an opaque pointer, nothing else:

```
notification:
  title: "Blood needed near you"
  body:  "Tap to view — this request expires soon"
data:
  type: BLOOD_ALERT
  alert_id: <opaque id>
```

No blood group, no hospital name, no distance, no patient anything — lock
screens, notification logs, and FCM infrastructure never see request content.
On tap, the app calls `GET /alerts/{alert_id}` (donor-authenticated) and
renders: blood group needed, units, urgency, hospital pin on the map,
`HOSPITAL_BLOODBANK_PHONE` (call to verify before traveling), distance from
the donor's alert-area, Accept / Decline.

Fetch-on-tap buys stale-push self-correction for free: if the request filled
or was cancelled after send, the fetch returns the closed state — "This
request has been fulfilled — thank you" — so cancellation needs no delivery
guarantees on stand-down pushes.

Dead token: FCM rejection marks the token stale → `push_verified_at` cleared →
donor silently exits candidate pools until the app re-verifies. No SMS
fallback in v1.

## 4. Accept / decline / pledge

**Decline:** one tap. Dispatch → declined. No effect on request state, never
itemized to the requester, no penalty ever.

**Accept:** one atomic transaction, DB as the arbiter:

```
guard:  Request.state IN (open, alerting, partially_pledged)   -- not covered/terminal
        AND active_pledge_count < ceil(units_needed × 1.5)     -- overbook headroom
effect: Dispatch none → accepted; Pledge created (snapshots + eta_bucket);
        recount → state transition per DATA_MODEL.md
```

Two donors tapping in the same second cannot both take the last slot; the
loser's fetch renders the honest closed-state screen ("enough donors pledged")
— no phantom pledges, no standby queue in v0 (deferred, `DECISIONS.md` #4).

On success the donor gets: Google Maps directions deep-link (destination
only), the blood-bank phone, and their pledge card. The requester's poll now
shows: donor handle, blood group, ETA bucket — plus `DONOR_PHONE` iff the
donor flipped `share_phone_on_accept` (default off). Donor-side coordination
anchor is the blood-bank phone; requester phone is not revealed in v0.

## 5. Escalation & expiry (the sweep)

Every 60 s, one idempotent transaction over all non-terminal requests:

1. **Tier advance:** state in (alerting, partially_pledged) AND tier window
   elapsed AND active pledges < units_needed → radius_tier++ (5 → 10 → 25 km
   cap), dispatch newly eligible donors. "Newly eligible" is filtered by each
   donor's own `travel_radius_km` (GB-35), so widening the circle only reaches
   people who already said they would come that far — and only after the nearer
   tiers failed to fill the request. That filter compares against the nearest
   point of the donor's cell, not its centroid, so a coarse location can never
   exclude a donor who is genuinely inside the range they agreed to
   (DATA_MODEL.md, "Which distance").
2. **Quiet-hours pickup:** donors whose quiet window ended since the last
   sweep and are still eligible at the current tier get dispatched (they were
   skipped, not excluded — the eligibility predicate re-evaluates each sweep).
3. **Expiry:** expires_at passed → `expired`; requester notified with the
   honest number ("41 donors alerted, 1 pledge") — the product must not
   pretend a thin pool is deep.
4. **Close fan-out:** terminal requests with still-active pledges → pledges
   `released` + closure notifications.

Urgency changes tempo, not mechanics:

| Urgency | Tier window | First tier | Quiet hours (22:00–07:00 donor-local) |
|---|---|---|---|
| critical | TIER_WINDOW_CRITICAL (10 min) | starts at T1 (10 km) | pierced (all v0 requesters are hospital-verified) |
| standard | TIER_WINDOW_STANDARD (30 min) | T0 (5 km) | respected — deferred donors picked up next sweep after 07:00 |

## 6. Fulfillment & close

Two facts, deliberately separated, each controlled by the party it protects:

| Fact | Confirmed by | Effect |
|---|---|---|
| Slot fulfilled | requester marks pledge `donated` | units_confirmed++; request → fulfilled at units_confirmed ≥ units_needed |
| Donor entered cooldown | requester confirm OR donor self-report, whichever first | stamps `last_donation_at`; 56-day cooldown starts |

A forgetful requester must not leave a donor alertable the day after donating;
a donor's self-report alone must not close a hospital's request. Bench
deferral (donor showed, failed screening) = pledge `released`, never
`donated` — no cooldown for blood not given.

Close paths: fulfilled, expired, cancelled — all terminal. A closed request
never reopens; raise a new one (re-runs validation and dedupe cleanly).

## 7. Race conditions

| Race | Policy |
|---|---|
| More acceptors than units | Overbook to ceil(units × 1.5); past that, accepts fail the guard and see the honest closed screen. Slot release (withdraw/no_show) regresses covered → partially_pledged and dispatch resumes to never-alerted donors. No standby queue in v0. |
| Accept then no-show | v0 is manual: requester marks `no_show` any time; recount resumes dispatch. ETA-deadline sweeping + nudge pushes deferred. |
| Cancel mid-flight | Request → cancelled; sweep checks state before every dispatch, queued sends die silently; stand-down pushes are best-effort because fetch-on-tap self-corrects. |
| Duplicate requests | Same-requester hard dedupe (overridable with "different patient" confirm); cross-requester soft-warn only, never merge. |
| Accept races close/cancel | Accept guard checks request state inside the same transaction as the slot claim; a losing tap gets the closed-state screen, never a phantom pledge. |

## 8. Named defaults (config, not code — no magic numbers elsewhere)

| Constant | Default | Notes |
|---|---|---|
| RADIUS_TIERS_KM | 5 / 10 / 25 | canonical ladder, cap 25 km |
| TIER_WINDOW_CRITICAL | 10 min | |
| TIER_WINDOW_STANDARD | 30 min | |
| OVERBOOK_FACTOR | 1.5 | ceil(units × 1.5) pledge ceiling |
| REQUEST_TTL | 12 h critical / 24 h standard | requester may extend, max 2 extensions |
| QUIET_HOURS | 22:00–07:00 donor-local | tz derived from geohash5 |
| DONATION_COOLDOWN_DAYS | 56 | US whole-blood standard; jurisdiction-dependent (open question) |
| DUP_WINDOW_H | 24 | same-requester dedupe |
| MAX_UNITS_PER_REQUEST | 6 | above this, hospitals use blood banks, not apps |
| MAX_OPEN_REQUESTS_PER_REQUESTER | 3 | |

Deferred to phase 2+ (with the fatigue suite): ALERTS_PER_DONOR_7D,
DONOR_ALERT_COOLDOWN_H, WAVE_SIZE_MAX, NO_SHOW_GRACE_MIN, night-alert opt-in.
v0's cheap 80% of fatigue protection: Dispatch uniqueness (never re-page per
request), one-active-pledge exclusion, donor toggles (`available`,
`snooze_until`), quiet hours, and the 25 km hard cap — a donor 60 km away is
not "nearby", and alerting them teaches the pool that alerts are ignorable.

## What this deliberately is not

- **Not a stranger-alerting system.** Only registered, opted-in, push-verified
  donors are reachable. The pool is the product; this protocol spends it
  frugally.
- **Not a blood-bank inventory system.** Human-to-hospital pledges only.
- **Not plasma/platelet-aware.** Red-cell matrix only.
- **Not live-tracking donors.** ETA bucket is the entire coordination surface.
- **Not a chat product.** No requester↔donor messaging (relay chat cut —
  `DECISIONS.md` #4).
- **Not ML-ranked.** Four sort keys, one sentence, one SQL query.
- **Not a donation-drive scheduler.** SCHEDULED urgency was cut from v0.
