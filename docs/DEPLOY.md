# Deploy Runbook

The steps to put give-blood in front of real donors. Nothing here has been
run — this repo has never been deployed and holds no credentials. Follow it in
order; each step produces an input the next one needs.

Read § 8 first. Two high-severity advisories sit in the production dependency
tree today, so § 1–7 are the path, not a clearance.

Target from `ARCHITECTURE.md` § "Deployment story": one Cloud Run service
serving both the API and the PWA bundle, one Neon Postgres, Firebase Auth for
identity, FCM for push, Cloud Scheduler driving the 60 s sweep.

**No value in this file is real.** Every `<placeholder>` is something you fill
in from a console. Never paste a secret into this file, a commit message, or a
`gcloud` flag that is not `--set-secrets`.

---

## 0. Preconditions

| Need | Note |
|---|---|
| Google Cloud project, billing on | Cloud Run, Artifact Registry, Secret Manager, Cloud Scheduler |
| Firebase project | can be the same GCP project — simpler, and FCM then shares the service identity |
| Neon account | free tier is sufficient at pilot scale |
| `gcloud` CLI, authenticated | `gcloud auth login && gcloud config set project <PROJECT_ID>` |
| Docker | to build the image (or let Cloud Build do it) |
| `psql` | steps 2, 5, 6 have no UI |

Enable the APIs once:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  fcm.googleapis.com
```

---

## 1. Firebase — identity and push

Both roles authenticate the same way (`ARCHITECTURE.md` § Components:
"Firebase Auth (phone OTP) — login for donors AND hospital requesters").
Requester trust is not a second auth system; it comes from step 6.

1. Create the Firebase project (or add Firebase to the existing GCP project).
2. **Authentication → Sign-in method → Phone → Enable.** Nothing else needs
   enabling; there is no email/password path in the client.
3. **Authentication → Settings → Authorized domains:** add the Cloud Run
   hostname from step 3 of this runbook. Phone sign-in silently fails on an
   unlisted domain, and it fails at the reCAPTCHA step with a message that
   does not say so. Expect to return here after the first deploy.
4. **Project settings → General → Your apps → Web app.** Register one. The
   config object it prints supplies five of the build args:

| Console field | Build arg |
|---|---|
| `apiKey` | `VITE_FIREBASE_API_KEY` |
| `authDomain` | `VITE_FIREBASE_AUTH_DOMAIN` |
| `projectId` | `VITE_FIREBASE_PROJECT_ID` |
| `appId` | `VITE_FIREBASE_APP_ID` |
| `messagingSenderId` | `VITE_FIREBASE_MESSAGING_SENDER_ID` |

   These are public by design — they ship inside the JS bundle either way.
   The control that matters is not hiding them: it is the authorized-domain
   list above plus an HTTP-referrer restriction on the API key
   (`APIs & Services → Credentials`).

5. **VAPID key for web push.** Firebase console → **Project settings → Cloud
   Messaging → Web configuration → Web Push certificates → Generate key
   pair.** Copy the **public** key (the "Key pair" string) into
   `VITE_FCM_VAPID_PUBLIC_KEY`. There is no private half to handle — the
   server sends through the FCM HTTP v1 API using its service identity, not
   through raw VAPID.
6. **Maps browser key.** `APIs & Services → Credentials → Create credentials →
   API key`, restrict it to HTTP referrers matching the Cloud Run hostname,
   and restrict it to the Maps JavaScript API. That value is
   `VITE_MAPS_BROWSER_KEY`. A key without both restrictions is a billing
   incident waiting to be scraped out of the bundle.
7. Leave `VITE_API_BASE_URL` empty. The container serves the bundle, so the
   client resolves a relative base (`client/src/env.ts` § `apiBaseUrl`).
8. Server side gets one Firebase value only: `FIREBASE_PROJECT_ID`. It is not
   a secret and goes in `--set-env-vars`. Credentials come from the Cloud Run
   service account (ADC) — `GOOGLE_APPLICATION_CREDENTIALS` is local-dev only
   and no key file ever enters the image.

---

## 2. Neon — database and migrations

1. Create a Neon project, Postgres 16, one region, near the Cloud Run region.
2. Copy the **pooled** connection string from the Neon dashboard. That is
   `DATABASE_URL`. It contains a password: it goes to Secret Manager in step
   3 and nowhere else.
3. Apply both migrations, in filename order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/src/db/migrations/0001_init.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/src/db/migrations/0002_auth_uid.sql
```

   Forward-only, no down migrations (`ARCHITECTURE.md`: "a bad deploy rolls
   code back, never schema"). 0001 creates 6 enums, 6 tables and the 4
   load-bearing indexes; 0002 adds the `firebase_uid` linkage columns. Both
   are idempotence-free — run them once, on an empty database.

4. Verify before going further:

```bash
psql "$DATABASE_URL" -c "\dt"          # 6 tables
psql "$DATABASE_URL" -c "\di"          # incl. dispatch_request_donor_uq,
                                       # pledge_one_active_per_donor, donor_pool
```

   `donor_pool` and `pledge_one_active_per_donor` are not optional
   performance tuning — the eligibility predicate and the one-active-pledge
   rule are enforced through them (`DATA_MODEL.md`).

**Gap, stated plainly:** `server/src/db/migrate.ts` applies these files, but
its `SqlExecutor` contract wants `exec(sql)`, which PGlite has and `pg.Client`
does not. It is a test-harness runner; there is no `npm run migrate` and no
CI step that applies migrations to a real Postgres. Until one exists, the
`psql` commands above **are** the migration procedure, run by hand before the
new revision goes live.

---

## 3. Build, push, deploy

Artifact Registry repo, once:

```bash
gcloud artifacts repositories create give-blood \
  --repository-format=docker --location=<REGION>
gcloud auth configure-docker <REGION>-docker.pkg.dev
```

Build. The eight `VITE_*` values from step 1 are compiled into the bundle here
and cannot be changed later without a rebuild — the bundle is the artifact:

```bash
IMAGE=<REGION>-docker.pkg.dev/<PROJECT_ID>/give-blood/server:$(git rev-parse --short HEAD)

docker build -t "$IMAGE" \
  --build-arg VITE_FIREBASE_API_KEY=<value> \
  --build-arg VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com \
  --build-arg VITE_FIREBASE_PROJECT_ID=<PROJECT_ID> \
  --build-arg VITE_FIREBASE_APP_ID=<value> \
  --build-arg VITE_FIREBASE_MESSAGING_SENDER_ID=<value> \
  --build-arg VITE_FCM_VAPID_PUBLIC_KEY=<value> \
  --build-arg VITE_MAPS_BROWSER_KEY=<value> \
  .

docker push "$IMAGE"
```

`.dockerignore` keeps `server/src/demo/` and `server/src/auth/fakeVerifier.ts`
out of the build context, so the pushed image contains no code that accepts a
demo persona token — not merely no code path that reaches it. Verify after any
change to that file:

```bash
docker run --rm --entrypoint sh "$IMAGE" -c 'ls dist/demo; grep -rl demo-asha /app'
```

Both should find nothing. Run the demo from source instead (`DEMO.md`).

Secrets — names only, created from a file so the value never reaches shell
history:

```bash
printf '%s' "$(cat neon-url.txt)"  | gcloud secrets create give-blood-database-url --data-file=-
openssl rand -base64 32            | gcloud secrets create give-blood-sweep-secret --data-file=-
rm neon-url.txt
```

`SWEEP_SHARED_SECRET` must be ≥ 16 characters (`server/src/config.ts`); 32
random bytes clears that with room. Read it back once in step 4, then never
again.

Service account, least privilege:

```bash
gcloud iam service-accounts create give-blood-run
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member=serviceAccount:give-blood-run@<PROJECT_ID>.iam.gserviceaccount.com \
  --role=roles/firebasemessaging.admin
gcloud secrets add-iam-policy-binding give-blood-database-url \
  --member=serviceAccount:give-blood-run@<PROJECT_ID>.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding give-blood-sweep-secret \
  --member=serviceAccount:give-blood-run@<PROJECT_ID>.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

Deploy:

```bash
gcloud run deploy give-blood \
  --image "$IMAGE" \
  --region <REGION> \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 10 \
  --timeout 30s \
  --service-account give-blood-run@<PROJECT_ID>.iam.gserviceaccount.com \
  --set-env-vars FIREBASE_PROJECT_ID=<PROJECT_ID>,APP_BASE_URL=https://<service-host>,LOG_LEVEL=info \
  --set-secrets DATABASE_URL=give-blood-database-url:latest,SWEEP_SHARED_SECRET=give-blood-sweep-secret:latest
```

**`--concurrency 1` is load-bearing, not tuning.** The service holds one
`pg.Client`, one session, by standing ruling (`server/src/index.ts`; the
reasoning: BEGIN/COMMIT via a pool spreads statements across connections and silently breaks the transaction). Four production
paths open transactions on it — `routes/requests.ts`,
`routes/pledgesShared.ts`, `routes/fulfillmentShared.ts`, `sweep/sweep.ts`.
Two requests interleaving on one session means the second `BEGIN` is a no-op
and one `COMMIT` commits both units of work. Cloud Run's default concurrency
is 80. At 1, an instance handles one request at a time and the interleave
cannot occur; throughput scales by instance count instead. See § 8.

`APP_BASE_URL` is the deployed origin and must be a valid absolute URL
(`config.ts` rejects anything else at boot, before serving a request).
Chicken-and-egg on the first deploy: deploy once with a placeholder to learn
the hostname, then redeploy with the real one and add it to the Firebase
authorized domains from step 1.

Rollback is `gcloud run services update-traffic give-blood
--to-revisions=<previous>=100`. Never a schema rollback.

---

## 4. Cloud Scheduler — the 60 s sweep

No in-process timers exist anywhere in this codebase; they would die with
scale-to-zero (`PROTOCOL.md` § 5, `DECISIONS.md` #7). Escalation, expiry and
close fan-out happen only when something POSTs `/internal/sweep`.

```bash
gcloud scheduler jobs create http give-blood-sweep \
  --location <REGION> \
  --schedule "* * * * *" \
  --time-zone UTC \
  --uri "https://<service-host>/internal/sweep" \
  --http-method POST \
  --headers "x-sweep-secret=<the SWEEP_SHARED_SECRET value>" \
  --attempt-deadline 30s \
  --max-retry-attempts 1
```

- `* * * * *` is once per minute, Scheduler's finest granularity, which is
  exactly the 60 s the protocol specifies. A minute of jitter is irrelevant
  at blood-request timescales.
- The header name is `x-sweep-secret`, compared in constant time over SHA-256
  digests so a wrong-length secret 401s like any other miss
  (`server/src/routes/internal.ts`). The `Authorization` header is ignored on
  this route — the caller is a machine, not a Firebase principal.
- **The secret value lands in the job's stored config**, readable by anyone
  with `cloudscheduler.jobs.get`, and in your shell history. That is the cost
  of the shared-secret design. Restrict the role, and rotate by writing a new
  Secret Manager version, redeploying, then `gcloud scheduler jobs update
  http` — in that order, or the sweep 401s in the gap.
- The service is `--allow-unauthenticated` because the PWA is public, so
  `/internal/sweep` is publicly reachable and the shared secret is its only
  defence. An unauthenticated caller can burn a 401 per request; see § 8 on
  rate limiting.
- One retry, not the default five: the sweep is idempotent, and the next tick
  is 60 seconds away regardless.

Verify it fires: `gcloud scheduler jobs run give-blood-sweep --location
<REGION>` and read the response body — a sweep report, not an error.

---

## 5. Seed the hospital registry

There is no admin UI and there is not meant to be
(`ARCHITECTURE.md`: "Not an admin product"). Hospitals are an
operator-curated table, and that curation is the anti-abuse anchor of the
whole product.

**Before inserting anything, honor the verification rule** from
`TRUST_PRIVACY.md` § "Requester verification":

> operator calls the hospital's **published switchboard number, sourced
> independently** (never a number supplied in the application)

`bloodbank_phone` must come from the hospital's own public listing, resolved
by you, not from the application form. Every alert detail view renders that
number so a donor can verify a request with one call before driving
(`PROTOCOL.md` § 3). An attacker can fake an account application; they cannot
fake the hospital's published number. Seeding an attacker-supplied number
removes the only defence a donor has.

Parameterized shape — the values are operator-sourced, never user input, and
never string-concatenated in:

```sql
PREPARE seed_hospital (text, text, numeric, numeric, text) AS
  INSERT INTO hospital (name, address, lat, lng, bloodbank_phone)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING hospital_id;

EXECUTE seed_hospital(
  '<hospital name>',
  '<street address as published>',
  <lat>, <lng>,
  '<E.164 blood-bank phone, from the hospital''s own public listing>'
);
```

- `lat`/`lng` are `numeric(9,6)` and must be the blood-bank entrance, not the
  campus centroid — they are the origin of every radius tier and the map pin
  the donor drives to.
- Phone in E.164 (`+1...`). The client renders it as a tap-to-call link.
- Keep the returned `hospital_id`. Step 6 needs it.

---

## 6. Create the first verified requester

Also SQL. `verified` is operator-set and is the badge donors see; nothing in
the API can set it.

1. The blood-bank staffer signs in to the deployed PWA with their phone
   number and completes OTP. This creates their Firebase Auth user and
   nothing else — the app has no requester self-registration route.
2. **Firebase console → Authentication → Users**, find that phone number,
   copy the **User UID**. That string is the token's `sub` claim, which
   `routes/requests.ts` resolves via `SELECT requester_id, verified FROM
   requester WHERE firebase_uid = $1`.
3. Complete the operator callback from § 5 — the independently sourced
   switchboard number, confirming this person works there — **before**
   running the insert. The insert is the moment trust is granted.

```sql
PREPARE seed_requester (text, uuid, text) AS
  INSERT INTO requester (firebase_uid, hospital_id, phone, verified)
  VALUES ($1, $2, $3, true)
  RETURNING requester_id;

EXECUTE seed_requester(
  '<Firebase User UID>',
  '<hospital_id from step 5>',
  '<staffer phone, E.164>'
);
```

`requester.phone` is stored but never revealed to donors in v0
(`TRUST_PRIVACY.md` § "Donor anonymity & contact"). The donor-side
coordination channel is the hospital's blood-bank number, deliberately.

Suspension, when needed: `UPDATE requester SET verified = false WHERE
requester_id = $1`, then cancel their open requests through
`POST /requests/:requestId/cancel` so alerted donors get the closure notice
rather than silence.

---

## 7. Post-deploy smoke checklist

Run top to bottom. Each line names the endpoint it exercises.

| # | Check | Expected |
|---|---|---|
| 1 | `curl -i https://<host>/healthz` | `200 {"ok":true}` |
| 2 | `curl -i https://<host>/` | `200`, HTML shell — the bundle is in the image |
| 3 | `curl -i -H 'Accept: text/html' https://<host>/donor` | `200` HTML, not 404 — SPA deep-link fallback |
| 4 | `curl -i -H 'Accept: application/json' https://<host>/nope` | `404 {"error":"not_found"}` — API 404s survive the static mount |
| 5 | `curl -i https://<host>/donors/me` | `401 {"error":"unauthorized"}` — no bearer token |
| 6 | `curl -i -X POST https://<host>/internal/sweep` | `401` — no secret header |
| 7 | `curl -i -X POST -H 'x-sweep-secret: <value>' https://<host>/internal/sweep` | `200` + sweep report |
| 8 | Browser: phone OTP sign-in | completes — if reCAPTCHA fails, the host is missing from Firebase authorized domains (§ 1.3) |
| 9 | Donor registers, grants push permission | `POST /donors`, `PUT /donors/me/push-token`, verification push arrives, `POST /donors/me/push-verified` → `push_verified_at` set. **Until this lands the donor is not in any matching pool** (`ARCHITECTURE.md`: "Alertable = push-verified") |
| 10 | Verified requester raises a request | `POST /requests` → `201` with `requestId`, state `open` |
| 11 | Wait ≤ 60 s | Scheduler fires; donor's phone shows a notification |
| 12 | **Read the notification without opening it** | Title/body only, no blood group, no hospital, no distance (`PROTOCOL.md` § 3 — no PHI on the wire). If any request detail is on the lock screen, stop and fix before onboarding anyone |
| 13 | Tap it | `GET /alerts/:dispatchId` → group, units, urgency, hospital pin, blood-bank phone, distance |
| 14 | `curl` that alert id with a *different* donor's token | `404`, identical to a nonexistent id — no probe surface |
| 15 | Accept with an ETA bucket | `POST /alerts/:dispatchId/accept` → `201`, pledge card, directions deep-link |
| 16 | Requester's view | `GET /requests/mine` and `GET /requests/:requestId` → handle, group, ETA bucket. Phone present only if the donor opted in; **no donor id, no location, ever** |
| 17 | Requester marks donated | `POST /pledges/:pledgeId/donated` → `units_confirmed` increments; at `≥ units_needed` the request reads `fulfilled` |
| 18 | Cancel path on a second request | `POST /requests/:requestId/cancel` → terminal; alerted donors get the withdrawal notice |
| 19 | Cloud Run logs | structured JSON, no push tokens, no phone numbers, no `DATABASE_URL` |
| 20 | Neon dashboard | one active session, not a climbing count — confirms `--concurrency 1` and the single-client design agree |

---

## 8. What is NOT production-ready

Blunt list. Every item is a live gap, not a style preference.

**1. Two high-severity advisories in the production dependency tree (GB-20).**
`npm audit --omit=dev` in `server/` reports:

| Package | Advisory | Why it matters here |
|---|---|---|
| `brace-expansion` ≤ 5.0.7 | GHSA-mh99-v99m-4gvg — DoS via unbounded expansion, OOM crash | transitive |
| `find-my-way` ≤ 9.6.0 | GHSA-c96f-x56v-gq3h — DDoS with HTTP/2 | **this is Fastify's router**, on the path of every request |

The client already pins `brace-expansion` through an `overrides` block; the
server does not. GB-20 is open on the board and is the one item that should
block the first real deploy — an emergency alert service that can be knocked
over by an unauthenticated request has no useful availability.

**2. No rate limiting beyond the per-requester caps.** What exists:
`MAX_OPEN_REQUESTS_PER_REQUESTER` = 3, same-requester dedupe inside
`DUP_WINDOW_H` = 24 h, `MAX_UNITS_PER_REQUEST` = 6 (`PROTOCOL.md` § 8). What
does not exist: any per-IP or global limit, any `@fastify/rate-limit`
registration, any protection on the unauthenticated `/internal/sweep` and
`/healthz` surfaces. OTP abuse leans entirely on Firebase's built-in region
policy and quotas (`TRUST_PRIVACY.md` § "Fake-request defense"), which is a
deliberate v0 call, not coverage.

**3. Single `pg.Client`, and it constrains the whole deploy.** The standing
ruling is correct for correctness — `BEGIN/COMMIT` through a `pg.Pool` spans
connections and silently breaks the transaction — but the consequences are:

- **`--concurrency 1` is mandatory** (§ 3). At Cloud Run's default of 80,
  concurrent transactions interleave on one session and commit each other's
  work. This is a correctness bug at any concurrency > 1, not a slowdown.
- Throughput is instances, not requests-per-instance. Each instance is one
  connection and one in-flight request. `--max-instances 10` means ten
  concurrent requests, service-wide.
- Every instance holds a Neon connection open for its lifetime. Watch the
  connection ceiling as `max-instances` rises.
- **No reconnect.** `index.ts` is crash-only by design: a session error logs
  and `process.exit(1)`. Neon's idle disconnect will kill instances routinely
  and Cloud Run will replace them. Acceptable, but it means restart counts are
  normal noise and cannot be used as a health signal.

The real fix is a checked-out `PoolClient` per transaction. It is a known
follow-up, not written.

**4. No retention automation, and no purge endpoint either.**
`TRUST_PRIVACY.md` § "Data minimization & retention" specifies close + 90 d
for request and dispatch rows, close + 30 d for pledge snapshots, deletion of
declines at close, hard delete of a deleted account within 30 d. None of it
runs. Worse than the docs imply: `ARCHITECTURE.md` describes "one operator
purge endpoint", and there is no such route in `server/src/routes/` — grep
for it and you get nothing. Retention is currently a document and a
`psql` session you have not written yet. Data accumulates from the first
request onward, which makes this compound with item 5.

**5. Jurisdiction and regulatory questions are open, and are flagged as
questions in `TRUST_PRIVACY.md` § Regulatory — not as answers.** Launch
jurisdiction is decided (US), which makes these the live ones:

- **HIPAA (#1):** do hospital-raised requests carrying blood group +
  hospital + timestamp constitute PHI handling, and do verified-hospital
  accounts require a BAA? Needs counsel. Unanswered, this is the item that
  can retroactively invalidate the retention design.
- **Donation-facilitation law (#6):** legality of intermediating
  donor-hospital contact. The no-payments stance likely helps; verify.
- **Donor age minimum (#7):** 18+ self-attestation is planned; sufficiency
  varies.
- **Pilot call-load (#9):** does "call the blood bank to verify" create
  unacceptable call volume for the hospital? Test with the first pilot
  hospital before onboarding a second.

Item #8 (56-day cooldown) is closed for US-only launch; do not reopen it
without a non-US market.

**6. No CI/CD.** `ARCHITECTURE.md` describes GitHub Actions running
test → build → migrate → deploy, and rollback as a previous Cloud Run
revision. There is no `.github/workflows/` in this repo and the monorepo has
no remote. Every step in this runbook is manual today, including the
migration step that has no runner (§ 2).

**7. No requester-verification endpoint.** `ARCHITECTURE.md` lists a
"protected verify-requester endpoint" as part of the admin surface. It does
not exist; § 6 is raw SQL. Fine for tens of hospitals, which is v1 scope by
design — but there is no audit trail of who verified whom or when.

**8. Nothing has been load-tested, and no monitoring is configured.** No
alerting on sweep failures, no dashboard, no error budget. If Cloud Scheduler
stops firing, escalation and expiry stop silently and the only symptom is
requests that never widen their radius.
