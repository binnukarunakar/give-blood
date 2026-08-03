# Architecture

Emergency blood-donor alert network: a verified hospital requester raises a
blood request; registered, opted-in donors near the hospital with a compatible
blood group get a push alert with the hospital pinned on a map; they accept,
pledge, and show up. One deployable unit, one database, no accounts beyond
phone OTP.

**The one product truth everything follows from:** there is no API to alert
arbitrary strangers near a hospital. Alerts reach only donors who registered,
opted in, and proved push-reachable. The registered donor pool IS the product;
every design choice is scored against "does this lose me an alertable donor?"

Operating assumptions: one developer, portfolio-grade, near-zero idle cost,
city-scale donor pools (10³–10⁴), request lifecycle measured in minutes-to-hours.

## Client: installable PWA. No native app at v1.

The deciding constraint is push — a donor alert must land on a phone with the
app closed:

| Platform | Push with app closed | Cost to one dev |
|---|---|---|
| Android (Chrome, PWA or tab) | Yes — FCM web push | zero extra |
| iOS ≥ 16.4, PWA installed to home screen | Yes — Web Push via APNs relay | onboarding friction |
| iOS Safari tab (not installed) | **No** | — |
| Native app | Yes, most reliable | 2 store pipelines, $99/yr, review latency on every fix |

**Decision: PWA (React + Vite + TypeScript, service worker), single codebase
serving donor and requester roles via routing.** One artifact, no store review
between fix and user.

Trade-offs accepted, with load-bearing mitigations:

1. **Alertable = push-verified.** A donor enters the matching pool only after a
   test push is delivered and acknowledged (`push_verified_at` on Donor, part
   of the eligibility predicate — see `DATA_MODEL.md`). A pool padded with
   unreachable registrations silently breaks the core loop.
2. **Escape hatch pre-planned:** Capacitor wrap of the same web code gives real
   APNs with no rewrite. Taken on evidence: measured iOS delivery/ack rate
   below a threshold defined up front (open question).

## Backend: single Node server + Postgres. Not full-Firebase.

The decision is where domain logic and data live — FCM, Firebase Auth, and
Maps stay managed-Google either way (no credible alternative for web push or
maps here).

| Concern | Firebase (Firestore + Functions) | Node + Postgres |
|---|---|---|
| Matching predicate (compatible ∧ eligible ∧ in-radius ∧ not-yet-alerted) | split across query limits + function code | one SQL statement, one index, unit-testable |
| Request state machine | transactions + trigger-smeared logic | ordinary DB transactions in one process |
| Escalation timers | Cloud Tasks / scheduled functions | one cron-hit idempotent sweep |
| Idle cost | ~$0 | ~$0 (Neon free tier + Cloud Run scale-to-zero) |
| Lock-in | total | commodity SQL |

**Decision: TypeScript + Node 22 + Fastify, one container; Postgres 16 on Neon
(serverless, pooled); plain forward-only SQL migrations with raw parameterized
SQL as the query layer.** (Drizzle was originally in as a thin typed layer;
removed as unused — GB-19, 2026-07-29.) The product core — a
correctness-sensitive matching query and a stateful request lifecycle — is
native to SQL and awkward in Firestore.

**Geo matching is geohash-5 IN-list, no PostGIS.** Donors store one geohash-5
cell; the matcher enumerates cells covering the current radius circle around
the hospital and filters by membership (≤ ~90 cells at the 25 km cap). One
composite partial index serves the whole predicate. PostGIS was considered and
dropped: with coarse cells as the only stored location, true-distance queries
add an extension for no gained precision. (Reconciled — see `DECISIONS.md` #5.)

Trade-off accepted: I own a server and a DB. Cold starts stack (Cloud Run 0→1
+ Neon resume, 2–4 s after idle) — though in practice the 60 s scheduler ping
keeps the service warm, so the real cost is "never actually idle" rather than
cold starts.

## Components

| Component | Tech | Responsibility |
|---|---|---|
| Web client (PWA) | React + Vite + TS, service worker | donor onboarding + availability toggle, requester flow, alert accept/decline, hospital map pin, receives web push |
| API + domain core | Node 22 + Fastify + TS, one container | REST API, request state machine, matching query, escalation/expiry sweep, FCM dispatch, serves the PWA bundle |
| Database | Postgres 16 (Neon, pooled) | donors (coarse geo only), hospitals, requests, dispatches, pledges |
| Identity | Firebase Auth (phone OTP) | login for donors AND hospital requesters; server verifies ID tokens via cached JWKS. Requester trust comes from operator verification, not a separate auth system |
| Push transport | FCM HTTP v1 | opaque alert pointers to closed apps |
| Scheduler | Cloud Scheduler, 1/min | hits idempotent `/internal/sweep` (escalate, expire, close) |
| Maps | Maps JS SDK + deep-links | hospital pin render; directions via `google.com/maps` deep-link (destination only — donor origin resolved on-device, never server-side) |
| Runtime host | Cloud Run, single service, scale-to-zero | the one deployable unit |
| CI/CD | GitHub Actions | test → build → migrate → deploy; rollback = previous Cloud Run revision |

## Topology

```
        ┌─────────────────────────────────────────────┐
        │            Donor / Requester phone          │
        │        React PWA (installed, has SW)        │
        └────┬───────────────▲─────────────────┬──────┘
             │ HTTPS REST    │ web push        │ OTP / ID token
             │ (+ polling)   │ {alert_id} only │
             │               │                 ▼
             │          ┌────┴────┐     ┌──────────────┐
             │          │   FCM   │     │ Firebase Auth│
             │          └────▲────┘     └──────┬───────┘
             ▼               │ FCM HTTP v1     │ JWKS verify (cached)
        ┌────────────────────┴────────┐        │
Cloud   │  Cloud Run — ONE service    │◄───────┘
Sched. ─►  Node/Fastify container     │
(60s     │   • serves PWA bundle      │
 sweep)  │   • REST API + auth guard  │
         │   • matcher + request FSM  │
         │   • sweep: escalate/expire │
         └──────────────┬─────────────┘
                        │ SQL (pooled)
                        ▼
         ┌───────────────────────────┐
         │   Neon Postgres 16        │
         └───────────────────────────┘

Client-side only: Maps JS SDK (pin render);
directions via google.com/maps deep-link — no server involvement.
```

## Deployment story

- One repo, one Dockerfile, one Cloud Run service. Vite output baked into the
  image; Fastify serves it. No CDN, no second deployable.
- Migrations run in CI against Neon before the new revision goes live —
  forward-only, additive; a bad deploy rolls code back, never schema.
- Escalation without a resident process: Cloud Scheduler fires
  `/internal/sweep` every 60 s (authenticated via `SWEEP_SHARED_SECRET`
  header). The sweep is one idempotent transaction: advance radius tiers past
  their window, expire stale requests, dispatch resulting alerts, release
  pledges of closed requests. **No in-process timers** — they die with
  scale-to-zero instances. (Reconciled — `DECISIONS.md` #7.)
- Secrets: Cloud Run ambient service account (ADC) for Google APIs — no key
  file in the image. `DATABASE_URL` + `SWEEP_SHARED_SECRET` via Secret
  Manager → env. Local dev: docker-compose Postgres + a
  `GOOGLE_APPLICATION_CREDENTIALS` file path.
- Requester's live pledge view: **short polling (10–15 s)**. No
  WebSockets/SSE — the lifecycle is minutes-long and sockets fight
  scale-to-zero.
- Hospitals are a curated, operator-seeded registry table (name, address,
  lat/lng, `HOSPITAL_BLOODBANK_PHONE`). No Places Autocomplete — no billing,
  no garbage input, and the registry doubles as the anti-abuse anchor
  (`TRUST_PRIVACY.md`).

## Env-var surface (names only, never values)

| Name | Side | Note |
|---|---|---|
| `DATABASE_URL` | server | Neon pooled connection string |
| `FIREBASE_PROJECT_ID` | server | token verification + FCM target |
| `GOOGLE_APPLICATION_CREDENTIALS` | server, local dev only | prod uses ADC |
| `SWEEP_SHARED_SECRET` | server | authenticates Cloud Scheduler |
| `APP_BASE_URL` | server | absolute links in fetch-on-tap responses (never request detail in pushes) |
| `PORT`, `LOG_LEVEL` | server | |
| `STATIC_ROOT` | server, optional | path to the built client bundle; absent = API-only boot (GB-23) |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID` | client, build-time | public-by-design Firebase web config |
| `VITE_FCM_VAPID_PUBLIC_KEY` | client, build-time | web-push key |
| `VITE_MAPS_BROWSER_KEY` | client, build-time | HTTP-referrer-restricted |

## What this deliberately is not

- **Not microservices.** One container; splitting matcher/notifier/API at this
  scale is résumé-driven architecture.
- **Not native mobile at v1.** Capacitor is the documented exit, on evidence.
- **Not realtime.** Polling; no sockets, no live listeners.
- **Not a queue system.** Postgres rows + a 60 s sweep are the queue.
- **Not multi-region / HA.** Single region, managed backups.
- **Not an SMS platform.** Push-verified donors only at v1 (SMS fallback is a
  flagged open question — cost + consent law + second PII channel).
- **Not a hospital-data integration.** No EHR, no hospital APIs; hospitals are
  seed rows.
- **Not an admin product.** Admin = SQL console + a protected verify-requester
  endpoint + one operator purge endpoint, until proven otherwise.
