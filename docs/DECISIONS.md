# Decision & Reconciliation Log

The architecture was produced 2026-07-20 by four parallel design passes
(system/stack, data model, alert protocol, trust & privacy) followed by an
adversarial critique pass (18 gap findings, 15 scope findings). The four raw
dimension docs conflicted in places; this log records how each conflict was
resolved. **This file is the tiebreaker — if any doc contradicts it, this
file wins.**

## Reconciled conflicts

1. **Push payload** — system dimension put "B+ needed — City Hospital, ~3 km"
   in the FCM payload; protocol dimension mandated an opaque `alert_id` with
   fetch-on-tap. *Resolved: opaque payload wins.* It keeps health-adjacent
   data off lock screens and FCM infrastructure, and makes stale pushes
   self-correcting. (Gap finding #1.)

2. **Request state machine** — data model defined
   open → alerting → partially_pledged → covered → …; protocol defined only
   OPEN → terminal, and its accept guard ("state = OPEN") would have rejected
   every accept after first dispatch. *Resolved: data-model FSM is canonical;
   accept guard rewritten to `state IN (open, alerting, partially_pledged)`;
   dispatch pauses at `covered` = ceil(units × 1.5) — the single overbook
   threshold; `units_confirmed` added to Request.* (Gap #2.)

3. **Escalation engine** — data model had simple monotonic radius tiers;
   protocol had a full wave engine (annulus waves, WAVE_SIZE_MAX overflow,
   deferred re-entry pools, 5-step ladder to 50 km). *Resolved: tiers win,
   waves cut.* v0 = radius_tier 5 → 10 → 25 km; each tier alerts all newly
   eligible donors; Dispatch uniqueness prevents re-paging; quiet-hours
   donors get picked up by later sweeps. Radius ladder canonicalized at
   5/10/25 everywhere. Ranked partial waves: phase 2 if pilot tiers prove too
   large. (Scope blocker #1, gap minor #16.)

4. **Coordination channel** — trust-privacy specified in-app relay chat and
   "never reveal DONOR_PHONE"; data model had a `share_phone_on_accept`
   toggle; protocol said "not a chat product". *Resolved: chat cut; toggle
   stays (default off); requester phone NOT revealed; the hospital blood-bank
   registry phone is the universal coordination + verification anchor.*
   (Gap #4, scope blocker #2.)

5. **Geo query mechanism** — system chose PostGIS `ST_DWithin` on a derived
   centroid; data model chose geohash-5 IN-list with a composite partial
   index and "no PostGIS". *Resolved: geohash IN-list wins; PostGIS dropped
   from the stack.* With coarse cells as the only stored location, PostGIS
   adds an extension for no gained precision. Postgres itself stays — the
   FSM + transactional matching justified it independently of PostGIS.
   (Gap #5.)

6. **Compatibility matrix authority** — system wanted a seeded DB table; data
   model wanted an in-code constant ("a table invites an admin edit that
   kills someone"). *Resolved: in-code constant, unit-tested against sanity
   anchors; if a SQL join is wanted, generate the table from the constant at
   migration time with UPDATE/DELETE revoked.* (Gap #6.)

7. **Timers** — protocol described an in-process one-minute sweeper; system
   mandated Cloud Scheduler → `/internal/sweep` because in-process timers die
   at scale-to-zero. *Resolved: Cloud Scheduler wins.* Honest side effect
   recorded: a 60 s external ping means the service never truly idles.
   (Gap #13, scope minor #15.)

8. **Cooldown stamping** — protocol wanted donor self-report OR requester
   confirm (whichever first); data model only had requester confirm.
   *Resolved: dual-path added to the model* — a forgetful requester must not
   leave a donor alertable the day after donating. Bench deferral stays
   `released` (no cooldown). (Gap #7.)

9. **Requester tiers** — trust-privacy designed a two-tier model with a
   self-serve attendant tier plus its whole containment apparatus (device
   fingerprints, trust scores, 2-report auto-close, permanent blocklists,
   global kill switch, capped fan-outs, TOTP). *Resolved: v0 is
   hospital-verified (Tier A) only — the scope critic's single largest safe
   cut.* The attendant tier and its containment layer are preserved as the
   phase-2 design. Hospital auth v0 = Firebase phone OTP bound at operator
   callback; TOTP/Identity Platform is a phase-2 question. (Scope major #3,
   gap #9, gap minor #18.)

10. **push_verified_at** — system called the push-verification gate
    load-bearing but no other dimension modeled it. *Resolved: added to Donor
    and to the eligibility predicate; token rotation clears it.* (Gap #10.)

11. **Alert lifecycle** — protocol had SENT → SEEN → … → LAPSED; data model
    had none/accepted/declined. *Resolved: three-value Dispatch wins; SEEN
    and LAPSED cut with the fatigue-budget machinery they fed.* `Donor.
    last_alerted_at` (rolling scalar) keeps least-recently-alerted ranking
    computable and survives Dispatch retention. (Gap #11, #12; scope #6, #8.)

12. **No-show machinery** — protocol had ETA deadlines, nudge pushes, standby
    promotion, arrival codes; data model had none of it (and standby was
    structurally impossible under dispatch uniqueness). *Resolved for v0:
    requester-marked no_show + donor withdraw only; `eta_bucket` enum
    replaces free-text eta_note; standby, nudges, deadlines, arrival codes,
    and the ARRIVED state all deferred to phase 2.* (Gap #3, #14, #15;
    scope #4, #9, #10.)

13. **Retention vs fatigue data** — trust-privacy's aggressive deletion
    schedule destroyed the alert history the protocol's budgets needed, and
    contradicted append-only Dispatch. *Resolved: Dispatch append-only until
    close + 90 d, then reduced to per-donor rolling scalars that survive
    deletion; v0 ships the written policy + one operator purge endpoint;
    automation lands pre-public-launch with the jurisdiction decision.*
    (Gap #12; scope minor #11.)

14. **Duplicates** — trust-privacy auto-merged same-hospital+group requests;
    protocol refused cross-requester merging. *Resolved: soft-warn only,
    never merge (false-merging two real patients is the worse failure);
    same-requester hard dedupe stays, overridable by hospital staff with an
    explicit "different patient" confirmation.* (Gap #8; scope minor #14.)

15. **Reliability scoring** — protocol ranked by historical response rate and
    decremented scores on no-show; data model banned reputation in v1.
    *Resolved: ban wins; ranking is four static keys.* (Gap #13/#41-adjacent;
    scope #5.)

16. **Quiet hours** — 21:00 vs 22:00 defaults, and donor-local time was
    uncomputable without a timezone. *Resolved: 22:00–07:00; `Donor.tz`
    derived from geohash5 at write (coarse, no new PII). v0: critical pierces
    (all requesters hospital-verified), standard defers; per-donor night-alert
    opt-in comes back with the fatigue suite.* (Gap minor #17.)

17. **SCHEDULED urgency** — cut from v0 (two levels: critical, standard). A
    donation-scheduling feature was creeping into an emergency-alert product.
    (Scope #7.)

18. **Custom OTP anti-pumping** — cut; Firebase Auth's built-in abuse
    controls (region policy, reCAPTCHA/App Check, quotas) cover v0.
    (Scope minor #12.)

## Deferred ledger (design exists, build later)

| Item | To phase | Trigger to build |
|---|---|---|
| Attendant (Tier B) requesters + full containment apparatus | 2 | pilot hospitals ask for family-raised requests |
| Standby queue + auto-promotion | 2 | pilot no-show data shows overbook buffer insufficient |
| Alert-fatigue suite (7-day budget, inter-alert cooldown, decline-reason snoozes, night opt-in) | 2 | alert volume grows beyond what quiet hours + uniqueness absorb |
| ETA deadlines, nudge pushes, ARRIVED state, arrival codes | 2 | pilot shows manual no_show marking too slow |
| Ranked partial waves (WAVE_SIZE_MAX) | 2 | tier-blast sizes exceed ~30 donors in pilot city |
| Hospital-account MFA (TOTP / Identity Platform) | 2 | before onboarding beyond pilot hospitals |
| Retention automation + field-level crypto | pre-public launch | jurisdiction determination |
| SMS fallback | 3 | measured token-staleness rate + cost + consent-law answer |
| Capacitor native wrap | on evidence | iOS push delivery/ack below threshold (define the number first) |
| Masked calling (proxy numbers) | 3 | evidence that phone-toggle coordination fails |
| Relay chat | 3 | evidence pledges fail to coordinate without it |

## Standing open questions (cross-doc)

- **Launch jurisdiction — RESOLVED 2026-07-20: United States.** Binnu's
  instruction. Downstream effects: HIPAA (`TRUST_PRIVACY.md` §Regulatory #1)
  is now the primary open regulatory question, not GDPR/India DPDP (#2 stays
  recorded for a possible future market, not deleted). 56-day cooldown is
  federally uniform in the US (FDA/AABB whole-blood standard) — the
  "per-region config" open question in #8 is **closed**: no config needed for
  v0, 56 days is a plain constant. Donor age minimum (#7) narrows to
  US-state variation (most states: 17 unassisted / 16 with parental consent)
  instead of a global range. See the market research notes §7 for the US-specific product
  implication this surfaced.
- ~~**Product name** — the original "google-blood" carried Google's
  trademark.~~ **RESOLVED 2026-07-31: renamed to Give Blood** (display name
  "Give Blood", slug/package `give-blood`). The old name appears only in the
  origin note about the empty 2019 repo.
- **Cooldown interval per jurisdiction** — 56 d is US-standard; may need
  per-region config and possibly donor sex (not currently modeled).
- **Geohash-5 in sparse rural areas** — one donor per cell can be
  identifying; per-region precision config?
- **Donor self-reported blood group** — add a `verified_group` flag after
  first confirmed donation?
- **Neon free tier under alert burst** — when do min-instances=1 and a paid
  DB tier stop being optional?
- **Firebase OTP SMS spend** at target registration volume.
- **iOS PWA push threshold** that triggers the Capacitor wrap — pick the
  number before the pilot, not after.
