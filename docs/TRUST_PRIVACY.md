# Trust, Abuse Prevention & Privacy

## Stance

The donor pool is the only asset. One fake alert, one 2 a.m. spam ping, or one
leaked donor address converts a donor into an uninstall, permanently. Three
biases govern everything:

1. **Verify requesters asymmetrically hard.** Donor signup stays
   near-frictionless; requester trust is earned.
2. **Reveal donor data late and minimally.** Nothing about a donor crosses to
   a requester until the donor acts.
3. **Store so little that a breach is boring.** The best privacy control is
   data that does not exist.

## Requester verification — v0 is hospital-verified only

The two-tier design (hospital accounts + self-serve patient attendants)
collapsed to **Tier A only for v0** — the attendant tier dragged in device
fingerprinting, per-phone trust scores, report pipelines, and blocklists,
none of which a pilot with tens of manually onboarded hospitals needs
(`DECISIONS.md` #9; the full Tier B containment design is preserved there for
phase 2).

| | v0 requester |
|---|---|
| Who | Blood-bank / ward staff of a registry hospital |
| Onboarding | Operator-manual: application → operator calls the hospital's **published switchboard number, sourced independently** (never a number supplied in the application) → account bound to the staffer's phone |
| Auth | Firebase phone OTP (same system as donors); TOTP/MFA upgrade is a phase-2 question |
| Fan-out | Full escalation schedule |
| Abuse response | Operator suspends via protected endpoint / SQL console — closes open requests, notifies alerted donors "request withdrawn" |

**The verification anchor an attacker cannot control:** every request targets
a hospital from the operator-curated registry, and every alert detail view
displays the registry's `HOSPITAL_BLOODBANK_PHONE`, sourced by the operator
from the hospital's own public listings. An attacker can fake an account
application; they cannot fake the hospital's published phone number. A donor
can always verify with one call before driving. This is also the donor-side
coordination channel — which is why v0 needs no chat and no requester-phone
reveal.

Manual onboarding does not scale past tens of hospitals — accepted; tens of
hospitals IS v1.

## Fake-request defense (v0 layers)

| Layer | Mechanism |
|---|---|
| Structural | requests only target registry hospitals; blood-bank phone always shown; no free-text hospital field, ever; no patient name field exists |
| Identity | requester accounts exist only via operator callback verification |
| Rate | MAX_OPEN_REQUESTS_PER_REQUESTER; same-requester dedupe; operator anomaly eyeball at pilot scale |
| Correctness | the compatibility matrix is server-authoritative; the client never computes eligibility — a medically wrong alert burns trust exactly like a fake one |
| Attention | quiet hours; Dispatch uniqueness; one-active-pledge exclusion; 25 km hard cap |
| OTP abuse | Firebase Auth's built-in controls (SMS region policy, reCAPTCHA/App Check, quotas) — no custom anti-pumping layer in v0 |

Deferred with Tier B: in-alert "report as fake" auto-close, trust scores,
device fingerprints, permanent blocklists, global fan-out kill switch.

## Donor anonymity & contact

Disclosure is a one-way ratchet controlled entirely by the donor:

| State | Requester sees | Donor sees |
|---|---|---|
| Alerted | count only ("12 donors notified") | hospital, group needed, units, urgency, map pin, blood-bank phone, verified badge |
| Declined | nothing — declines are never itemized | — |
| Accepted | handle (pseudonym allowed) + blood group + ETA bucket + phone iff donor's toggle | pledge card, directions deep-link, blood-bank phone |
| Withdrawn | count decrements | no penalty, no record shown |

- **No donor directory exists.** No endpoint lists, searches, or browses
  donors; requester-facing APIs return aggregates. You cannot scrape what has
  no read path.
- Declines are free and invisible — punishing or exposing declines trains
  donors to ignore alerts.
- Contact surface: donor calls the blood bank (anchor number), or opts into
  sharing `DONOR_PHONE` on the accept screen (default off). In-app relay chat
  was cut from v0; masked calling stays deferred.

## Location privacy

| Rule | Detail |
|---|---|
| At rest | donor location = geohash-5 cell (~4.9 × 4.9 km), a self-declared "area I can donate from" |
| Capture | map tap truncated to geohash-5 **on device**; exact coordinates never leave the phone |
| Why precision 5 | a breached DB localizes a donor to ~24 km² — a district, not a doorstep — while 5/10/25 km matching still works |
| Directions | post-accept deep-link carries **destination only** (hospital); origin resolved by the Maps app on-device; the server never receives donor GPS in any flow |
| ETA | donor-chosen bucket, never computed — computing it would require the location we refuse to collect |
| Escalation | widening the radius widens the queried cell set; it reads nothing new from donors |

## Data minimization & retention

v0 ships the **policy** and one operator-invoked purge endpoint; scheduled
automation lands in the pre-public-launch phase, gated on the jurisdiction
determination (`DECISIONS.md` #13).

| Item | At-rest form | Retention policy |
|---|---|---|
| `DONOR_PHONE` | E.164 | life of account; account deletion = hard delete ≤ 30 d, push token immediately |
| blood group, last_donation_at | plaintext (query keys); health-adjacent — flagged below | life of account |
| location | geohash-5 only, donor-editable | life of account |
| Request record | hospital id, group, units, urgency, timestamps, outcome | tombstone (no requester identity) close + 90 d → aggregate counters |
| Dispatch log | append-only while request open (dedupe needs it) | close + 90 d → reduced to per-donor rolling scalars (`last_alerted_at` etc.), which survive row deletion so future fatigue budgets stay computable |
| Pledge snapshots | as written | close + 30 d → counters |
| Declines | — | deleted at request close; only aggregate counts survive |

Provider-level encryption at rest (Neon) is the v0 baseline; field-level
crypto deferred to launch-hardening with the regulatory answer.

## Threat model (v0)

| Threat | Vector | Mitigation |
|---|---|---|
| Fake request | compromised/false hospital application | operator out-of-band callback to independently sourced switchboard; registry-anchored blood-bank phone on every alert |
| Requester account takeover | phished OTP / SIM swap | operator suspend kill-switch; phase-2 MFA upgrade flagged |
| Donor enumeration / scraping | raise requests to harvest identities | pre-accept anonymity (counts only); accept reveals pseudonym + bucket only; no list endpoint exists |
| Alert spam / fatigue | high volume or malicious repeats | request caps, dedupe, quiet hours, Dispatch uniqueness, 25 km cap |
| Donor home inference | correlating accepts over time | geohash-5 at rest; an accept discloses presence at a hospital once, not origin; donors may set their cell anywhere |
| Paid-blood touting | brokers demanding money | no payment rails in-app; "asked for money" → operator suspend; legality flagged below |
| DB breach | server compromise | minimization: no addresses, no exact GPS, pseudonyms OK, short retention. Worst case leaked: phone + blood group + ~24 km² cell |
| OTP pumping | bots triggering SMS | Firebase built-in region policy / CAPTCHA / quotas |

## What this deliberately is not

- **Not an open marketplace.** No donor browsing, search, or public request
  feed. Ever.
- **No continuous location tracking.** "Donors near me now" is a stalking tool
  wearing scrubs.
- **No donor ID verification at v1** — friction kills the pool; the hospital
  verifies blood group at the bench regardless.
- **No payments, tips, or rewards** — money flow invites touting and
  paid-donor brokering.
- **No SMS fallback at v1** — cost, pumping fraud, consent-law questions.
- **No requester-visible donor reputation** ("donated 5 times") — prolific
  donors would become harassment targets.

## Regulatory — flagged open questions, NOT assertions

None of the following is asserted as settled; each needs checking before any
non-demo launch. Launch jurisdiction is now decided — **United States**
(`DECISIONS.md` standing open questions) — so #1 (HIPAA) is the live question;
#2 and #6's India-specific clause are kept for a possible future market, not
deleted, but are not blocking v0.

1. **HIPAA (US):** do hospital-raised requests carrying blood group +
   hospital + timestamp constitute PHI handling; do verified-hospital
   accounts require a BAA? Needs counsel.
2. **GDPR Art. 9 / India DPDP:** blood group and last-donation date are
   plausibly special-category health data — consent basis, possible DPIA.
3. **Deletion rights vs abuse blocklists** (phase 2): legitimate-interest /
   fraud exception defensible?
4. **Data portability:** v1 has no export; GDPR-scope launch may require one.
5. **SMS consent law (TCPA-type):** only if SMS is ever added.
6. **Donation-facilitation law:** legality of intermediating donor-hospital
   contact + local anti-payment / replacement-donor rules (e.g., national
   blood-transfusion regulation in India). No-payments stance likely helps;
   verify.
7. **Donor age minimum:** 18+ self-attestation planned; sufficiency varies by
   jurisdiction.
8. **Cooldown interval — CLOSED for v0:** 56 days is the uniform FDA/AABB
   whole-blood standard across all US states. No per-region config or donor-sex
   field needed while launch is US-only; reopens only if a non-US market is
   added later.
9. **Pilot validation:** does "call the blood bank to verify" create
   unacceptable call load? Test with the first pilot hospital, not in theory.
