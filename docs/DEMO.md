# Local Demo

Click through the whole request → alert → pledge → fulfil loop in a browser,
on one machine, with no Google Cloud account, no Firebase project, no
Postgres, and no network calls to anything.

It exists because "can I see this work?" deserves a better answer than a test
report. Everything you click below is the real server: the same routes, the
same matching SQL, the same state machines, the same sweep. What is faked is
the infrastructure underneath them, and § 4 lists exactly what.

---

## 1. Run it

Three commands, from `apps/give-blood`:

```bash
VITE_DEMO_MODE=1 npm --prefix client run build
npm --prefix server run demo
open http://localhost:8787
```

First run only, add installs: `npm --prefix client ci && npm --prefix server ci`.

`VITE_DEMO_MODE=1` is required and is a **build-time** switch. Without it the
bundle has no persona bar, no push inbox, no demo CSS, and no fake tokens —
Vite folds the branch away and rollup drops `client/src/demo/` entirely
(`client/src/demo/demoMode.ts`). A production build of the client cannot be
talked into demo mode by a query string, a header, or a localStorage key,
because there is nothing left in it to talk to.

That is checked, not trusted:

```bash
npm --prefix client run verify:no-demo
```

It runs a production build with `VITE_DEMO_MODE` explicitly unset, greps every
emitted asset for `demo-asha` (a persona token) and `demo-bar` (a demo-only CSS
class), and exits non-zero on a hit
(`client/scripts/verify-no-demo.mjs`). Run it before any deploy: it is the
check that keeps demo mode out of production.

The server prints a banner with the personas, the hospital id, and the
demo-only endpoints. It binds `127.0.0.1`, not `0.0.0.0` — a server that
accepts `demo-asha` as an identity has no business being reachable from the
network (`server/src/demo/demoServer.ts`).

Restarting wipes everything. The database is in-memory.

---

## 2. The four personas

Switch between them with the persona bar at the top of the page. That bar
replaces sign-out: switching persona *is* signing in as someone else, and the
app subtree is keyed on the persona uid so a switch remounts every screen and
refetches under the new identity (`client/src/demo/mountDemo.tsx`).

What a switch does **not** do is navigate. The URL is unchanged, so you land on
the same route as the new person — often the wrong route for them. Switching is
half the move; the nav link is the other half.

| Persona | Role | Group | Distance shown | What it proves |
|---|---|---|---|---|
| **Asha** | donor | B+ | 0.3 km | inside tier 0 — alerted on the first sweep |
| **Ravi** | donor | O− | 8.5 km | outside tier 0, inside tier 1 — alerted only after the radius escalates |
| **Meera** | donor | A+ | 0.3 km | tied with Asha, not closer, and **never** alerted for a B+ request. A+ is not a compatible donor group for a B+ recipient (`DATA_MODEL.md` compatibility matrix). This is the matcher working, not a bug |
| **City** | requester | — | at the hospital | operator-verified staff account at the seeded hospital |

**Why Asha and Meera both read 0.3 km when they are a kilometre apart.** They
are not being rounded to the same number by accident. A donor's stored location
is a precision-5 geohash cell — about 4.9 km across — and nothing finer
(`TRUST_PRIVACY.md` § "Location privacy"). Asha's point is 1 km north of the
hospital and Meera's is 2 km north, and both land inside the hospital's own cell
`dr5ru`, so the app can only report the distance to that cell's centroid: 0.3 km
for each. Two donors a kilometre apart legitimately share a cell and legitimately
report the same coarse distance. **That coarseness is the privacy design.** A
breached database localizes a donor to ~24 km² — a district, not a doorstep —
and this screen is where you can see the app paying that price.

The same property explains Ravi. He is not placed at a hand-picked "7 km": his
cell is derived at boot as the nearest cell covered at tier 1 (10 km) but not at
tier 0 (5 km), and its centroid is 8.5 km out. Nothing nearer can qualify — the
cover set keeps every cell whose centroid falls within the radius plus half a
cell diagonal, so no cell at 7 km can sit outside tier 0
(`server/src/demo/demoPersonas.ts`).

Seeded hospital: **Bellevue-style Demo Hospital**, 1 Demo Plaza, New York, NY.
All phone numbers are `+1555010xxxx` placeholders — no real number appears
anywhere in this repo.

All three donors are seeded past the push-verification handshake
(`opted_in`, `available`, push token, `push_verified_at`), so the pool is
alertable the moment the page loads. In production a donor who has not
completed that handshake is in no matching pool at all
(`ARCHITECTURE.md`: "Alertable = push-verified").

---

## 3. The click path

Follow it in order. It takes about two minutes.

1. **Start as Asha.** The donor screen shows a registered, opted-in,
   available donor with no alerts. There is no sign-up step: the three donors
   are seeded, because the interesting part of this app is not a form.
2. **Switch to City (requester), then click the "Requester" nav link.**
   Switching persona does not change the page — you stay on `/donor`, now as
   City, and City has no donor record, so you get the onboarding screen. The nav
   link is the second half of the step. Then: empty request list.
3. **Raise a B+ request.** Press the new-request button, then:
   - **Hospital id** — paste `11111111-1111-4111-8111-111111111111`. The
     server prints it in the startup banner and serves it at `/demo/state`.
     The field is a paste box on purpose: there is no hospital directory
     endpoint and never will be, so a requester uses the id the operator gave
     them (`ARCHITECTURE.md`: hospitals are an operator-seeded registry).
   - **Blood group** `B+`, **units** `1`, **urgency** `critical`.
   - **Raise request.**

   It lands in state `open` — `POST /requests` writes the row and stops. No
   alert has gone out yet, deliberately.
4. **Press "Run sweep"** in the demo panel at the bottom of the page. This is
   the whole trick: production has Cloud Scheduler POSTing `/internal/sweep`
   every 60 s and there are no in-process timers anywhere in the codebase
   (`PROTOCOL.md` § 5), so in a demo *nothing moves until you call it*. The
   sweep report appears inline.
5. **Read the push inbox.** Two pushes — Asha and Ravi. Each payload is
   `{ type: 'BLOOD_ALERT', alertId: <uuid> }` and nothing more: no blood
   group, no hospital, no units, no distance. That is `PROTOCOL.md` § 3
   enforced rather than described — a lock screen, a notification log and
   FCM's infrastructure never see request content.
   - **Nothing to Meera.** She sits in the same cell as Asha at the same 0.3
     km, and A+ is not a compatible donor group for a B+ recipient. The matcher
     excluded her on the blood-compatibility gate, not on distance.
   - Ravi is reached at 8.5 km because `critical` opens at tier 1 (10 km).
     Urgency changes tempo, not mechanics.

   **The inbox is a god-view, on purpose.** It lists every push the server
   sent, to every persona — no real device could see that. So only the card
   addressed to your *current* persona will open. Tap Ravi's card while you are
   Asha and you get "This alert is not available for your account." That is the
   uniform-404 property (`TRUST_PRIVACY.md` § "Threat model") doing its job: a
   wrong alert id and a nonexistent one are indistinguishable, so alert ids
   cannot be probed. It is the demo instrument leaking, never the app.
6. **Switch to Asha and open the alert.** The detail arrives only now, over
   `GET /alerts/:alertId` behind donor auth — fetch-on-tap. You get blood
   group, units, urgency, the hospital pin, the blood-bank phone (the number
   a donor calls to verify before driving), and a distance computed from her
   coarse cell, never from GPS.
7. **Accept**, pick an ETA bucket, set the phone-sharing checkbox as you
   like. `POST /alerts/:alertId/accept` runs one transaction: guard the
   request state, claim a slot, write the pledge. The pledge card and a
   directions deep-link appear. The request moves to `partially_pledged` —
   one active pledge is below the overbook ceiling of `ceil(1 × 1.5) = 2`.
8. **Switch back to City, click "Requester", open the request.** (Switching
   alone would leave you on Asha's alert URL, which City may not read.) The
   pledge is now visible:
   handle, blood group, ETA bucket, and the phone only if Asha shared it. No
   donor id. No location. Ever. Before she accepted, the requester saw a
   count and nothing else (`TRUST_PRIVACY.md` § "Donor anonymity & contact").
9. **Press "Arrived and donated"**, then confirm. `units_confirmed` becomes
   1, which meets `units_needed`, and the request reads **`fulfilled`**.
   Terminal — a closed request never reopens; a correction is a new request.
   Ravi's alert still resolves: tapping it now renders the closed state, which
   is why a stand-down push is never needed.

**Worth trying next**

- **Raise the same request as `standard` instead.** It opens at tier 0
  (5 km), so the first sweep reaches Asha alone; sweep again after the tier
  window and the radius widens to Ravi. That is the escalation ladder.
  Caveat: `standard` respects quiet hours, 22:00–07:00 in the donor's own
  timezone (`America/New_York` for these three), so run it late at night and
  the sweep correctly dispatches nothing. `critical` pierces quiet hours,
  which is why the path above uses it.
- Accept as Asha, then try to accept the same alert again. The transaction
  guard rejects it.
- Raise a fourth open request as City. `MAX_OPEN_REQUESTS_PER_REQUESTER` is 3.
- Raise two B+ requests for the same hospital in a row: the same-requester
  dedupe blocks the second until you confirm it is a different patient.
- **Reset demo data** puts everything back to the opening position.

Behind the panel buttons, and callable with `curl`:

| Endpoint | Purpose | Production equivalent |
|---|---|---|
| `GET /demo/pushes` | the device inbox, payloads verbatim | FCM |
| `POST /demo/sweep` | one sweep pass, by hand | Cloud Scheduler, every 60 s |
| `GET /demo/state` | every request with state and radius tier | a SQL console |
| `POST /demo/reset` | reseed the database, empty the inbox | — |

These four are registered by `server/src/demo/demoServer.ts` and by nothing
else. `buildApp` does not know they exist, so no deploy and no env flag can
expose them.

---

## 4. What is faked, and what is not

The honest version, because a demo that blurs this line is a sales pitch.

**Faked — four adapters, swapped at the composition root:**

| Real | Demo | Consequence |
|---|---|---|
| Firebase Auth phone OTP | `FakeTokenVerifier` mapping four fixed strings to four uids | there is no login screen; you switch persona instead |
| FCM HTTP v1 | an in-memory list you read at `/demo/pushes` | no notification reaches a phone; nothing leaves the process |
| Neon Postgres | PGlite, in memory | restarting wipes every request, pledge and dispatch |
| Cloud Scheduler | the "Run sweep" button | escalation and expiry advance only when you press it |

**Not faked — this is the production code path, unmodified:**

- **Every route.** `POST /requests`, `GET /alerts/:id`, the accept and decline
  paths, `GET /requests/mine`, `GET /requests/:id`, the fulfilment endpoints —
  the demo composes them by calling the same `buildApp` that
  `server/src/index.ts` calls.
- **The matcher.** One parameterized SQL statement carrying every gate:
  compatibility, geohash-5 cover set for the current tier, opted-in,
  available, push-verified, the 56-day cooldown, quiet hours in the donor's
  own timezone, and anti-joins against prior dispatches and active pledges.
  Meera's absence from the inbox is that statement's output.
- **Both state machines.** Request (`open → alerting → partially_pledged →
  covered → fulfilled`, with `expired`/`cancelled` terminals) and pledge
  (`active → donated | withdrawn | no_show | released`).
- **The sweep.** `runSweep` is imported directly from `src/sweep/sweep.ts`.
  Same function, same single-session client, same idempotent transaction —
  only the trigger differs.
- **Every privacy rule.** Opaque push payloads, fetch-on-tap detail, the
  count-only pre-accept requester view, pledge snapshots as the only channel
  donor data crosses on, geohash-5 as the only stored location, uniform 404s
  that make a wrong alert id indistinguishable from a nonexistent one.
- **PGlite is real Postgres.** WASM-compiled, running the same two migration
  files (`server/src/db/migrations/`) that step 2 of `DEPLOY.md` applies to
  Neon. Same schema, same enums, same four load-bearing indexes, same
  constraints. It is where the 306 server tests (22 files) already run; the
  client adds 109 tests across 13 files.

**The safety property, stated once:** nothing under `server/src/demo/` is
imported by `src/index.ts`, `src/app.ts`, or any production module. The
dependency arrow points one way. The demo builds its own app by *calling*
`buildApp` with fake adapters; there is no env flag, no feature toggle, and no
code path that puts a fake verifier into a production process.

To go from this to something real, follow `DEPLOY.md` — and read its § 8
first.
