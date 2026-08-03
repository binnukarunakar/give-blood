# check=skip=SecretsUsedInArgOrEnv
# ^ Parser directive, must stay on line 1. BuildKit flags any ARG whose NAME
# contains KEY/AUTH/SECRET. The eight VITE_* args below trip it on name alone
# and the names are not ours to change — Vite matches the literal identifiers.
# Every one of them is baked into the public JS bundle by construction
# (client/src/env.ts reads them through import.meta.env), so none can be
# secret. The skip is scoped to that: a permanently-failing check is a check
# nobody runs. NEVER add a server-side secret (DATABASE_URL,
# SWEEP_SHARED_SECRET, a service-account key) as an ARG or ENV here — this
# directive would silence the warning that catches it.

# give-blood — one repo, one Dockerfile, one Cloud Run service
# (docs/ARCHITECTURE.md "Deployment story"). The Vite output is baked into the
# image and Fastify serves it from STATIC_ROOT; there is no second deployable,
# no CDN.
#
# Build context is THIS directory (apps/give-blood) — it holds both packages:
#   docker build -t give-blood .
# Runbook, including the build args below: docs/DEPLOY.md.
#
# Base image: node:22-slim (Debian), not alpine. Nothing in the dependency tree
# compiles today (fastify, pg, jose, ngeohash, tz-lookup, zod, google-auth-library
# are pure JS), so alpine would build — but it swaps glibc for musl, a different
# libc from the machine the 301 server tests run on, to save ~40 MB on an image
# that is already dominated by node_modules. Not a trade worth making for a
# service whose failure mode is a missed blood alert.

# ── Stage 1: client bundle (Vite) ─────────────────────────────────────────────
FROM node:22-slim AS client-build
WORKDIR /build/client

# Every VITE_* value is baked into the public bundle at build time
# (docs/ARCHITECTURE.md § "Env-var surface" — client, build-time). All of them
# are public-by-design: the Firebase web config, the VAPID PUBLIC key and a
# referrer-restricted Maps key all ship to the browser regardless, so a build
# arg discloses nothing the bundle would not.
#
# DATABASE_URL and SWEEP_SHARED_SECRET are NOT build args and must never become
# ones — build args persist in `docker history`. Those two arrive at runtime
# from Secret Manager (docs/DEPLOY.md § 3).
#
# VITE_API_BASE_URL stays empty: this container serves the bundle, so the client
# uses a relative API base (client/src/env.ts § apiBaseUrl).
#
# VITE_DEMO_MODE is absent DELIBERATELY. Docker ignores a --build-arg with no
# matching ARG, so this image cannot be built in demo mode even by someone
# passing the flag: the value never enters the RUN environment, and Vite folds
# the demo branch away. Do not add it here to "make testing easier".
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FCM_VAPID_PUBLIC_KEY
ARG VITE_MAPS_BROWSER_KEY
ARG VITE_API_BASE_URL=""

# Manifest first so a source-only change reuses the install layer.
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
# Docker exports build args into the RUN environment, and Vite exposes every
# VITE_-prefixed process.env key to the bundle — no .env file is written, so
# none can be committed by accident.
RUN npm run build

# ── Stage 2: server build (tsc) ───────────────────────────────────────────────
FROM node:22-slim AS server-build
WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src

# `npm run build` is `tsc -p tsconfig.build.json` (outDir dist, rootDir src),
# which also excludes *.test.ts and src/demo — src/demo is already dropped by
# .dockerignore, so this is belt and braces. It emits no .sql, so the
# migrations under src/db/migrations/ do not reach the image — deliberate: they
# run against Neon BEFORE the revision goes live, never at boot
# (docs/ARCHITECTURE.md "Deployment story"; the command is in docs/DEPLOY.md § 2).
# The prune drops devDependencies from the tree the final stage copies.
RUN npm run build && npm prune --omit=dev

# ── Final: runtime ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

ENV NODE_ENV=production
# Cloud Run injects PORT; 8080 is also the default in server/src/config.ts, so
# `docker run -p 8080:8080` works with no env at all beyond the required ones.
ENV PORT=8080
# Absolute path — server/src/index.ts resolves STATIC_ROOT against the server
# package root, and an absolute value wins over that base.
ENV STATIC_ROOT=/app/client/dist

WORKDIR /app/server

# package.json is required at runtime, not decoration: it carries
# "type": "module", without which Node refuses the ESM in dist/.
COPY --from=server-build /build/server/package.json ./package.json
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=client-build /build/client/dist /app/client/dist

# node:22-slim ships an unprivileged `node` user (uid 1000). Everything above is
# owned by root and stays read-only to it: the service writes no files, holds no
# state on disk, and needs no privileged port (8080, not 80).
USER node

EXPOSE 8080

# Cloud Run ignores HEALTHCHECK — it probes the container port itself — so this
# is for `docker run`, compose, or any plain-Docker host. `fetch` is global in
# Node 22, so no curl or wget is installed for it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
