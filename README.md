# Give Blood

Emergency blood-donor alert network.

A verified hospital requester raises a blood request (group, units, urgency).
Registered, opted-in donors near that hospital whose blood group is compatible
get a push alert with the hospital pinned on a map. They accept, pledge, and
show up. The search radius escalates (5 → 10 → 25 km) until the request is
covered or expires.

## The one product truth

**It alerts registered, opted-in donors only.** There is no directory of
donors, no scraped contact list, no way to look someone up. A donor exists to
this system only after they register and opt in, and they can opt out at any
time. Three invariants make that structural rather than a policy promise:

- A donor's exact GPS never reaches the server. The device derives a geohash-5
  cell (~5 km) and sends that; matching runs on cells, not coordinates.
- Donor identity crosses to a requester only through a pledge, created by the
  donor's explicit accept. Nothing else exposes it.
- No endpoint lists, searches, or browses donors — by design, not by
  permission check.

Push payloads carry an opaque alert id and nothing else. Every clinical detail
is fetched on tap, behind donor auth.

## Stack

| Layer | Choice |
|---|---|
| Client | React + Vite + TypeScript, installable PWA, service-worker push |
| Server | Node 22 + Fastify + TypeScript — serves the API and the built bundle |
| Database | Postgres 16, geohash-5 IN-list matching (no PostGIS) |
| Auth | Firebase Auth phone OTP; server verifies the ID token |
| Push | FCM web push, opaque payload |
| Scheduling | A 60 s idempotent sweep drives radius escalation and expiry |
| Packaging | One container, one service — `Dockerfile` at the repo root |

Blood-group compatibility is a server-side constant, unit-tested against the
standard anchors (O− universal donor, AB+ universal recipient). Clients never
compute eligibility.

## Run the local demo

The whole request → alert → pledge → fulfil loop, in a browser, on one
machine — no cloud project, no Firebase, no Postgres, no network calls. The
server is the real one: same routes, same matching SQL, same state machines,
same sweep. Only the infrastructure under them is faked.

```bash
npm --prefix client ci
npm --prefix server ci

VITE_DEMO_MODE=1 npm --prefix client run build
npm --prefix server run demo
# open http://localhost:8787
```

`VITE_DEMO_MODE` is a **build-time** switch. Without it the bundle contains no
personas, no push inbox, and no fake tokens — Vite folds the branch away and
the demo sources are dropped from the output entirely. A production build
cannot be talked into demo mode by a query string, a header, or a localStorage
key. `npm --prefix client run verify:no-demo` builds without the flag and greps
every emitted asset to prove it.

The demo server binds `127.0.0.1` and keeps its database in memory. Restarting
wipes everything.

Full walkthrough, personas, and the exact list of what is faked:
[docs/DEMO.md](docs/DEMO.md).

## Tests

```bash
npm --prefix server test    # 23 files, 319 tests
npm --prefix client test    # 16 files, 156 tests
```

Server tests run against an in-process Postgres (PGlite), so the SQL under
test is the SQL that ships. The end-to-end core-loop test drives request →
match → alert → pledge → fulfil through the real routes.

## Docs

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | stack, components, topology, env-var surface, deployment |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | entities, sensitivity classes, compatibility matrix, state machines |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | the core loop: request → match → alert → pledge → fulfil |
| [docs/TRUST_PRIVACY.md](docs/TRUST_PRIVACY.md) | requester verification, threat model, retention, regulatory flags |
| [docs/DESIGN.md](docs/DESIGN.md) | UI system — tokens, surfaces, the two flows |
| [docs/DECISIONS.md](docs/DECISIONS.md) | reconciliation log and deferred ledger — the tiebreaker doc |
| [docs/DEMO.md](docs/DEMO.md) | running the local demo |

If any doc contradicts another, `docs/DECISIONS.md` wins.

## Status

**v0 — not deployed; demo only.** The name and product are not affiliated with
Google (historical repo name only).
