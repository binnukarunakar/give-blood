// Fastify app factory. Built from injected deps (config, a TokenVerifier, a SQL
// client and a PushSender) so tests can drive it with fakes and no listening
// socket. The app OWNS route registration: every module is mounted here, so the
// production entrypoint and the tests exercise one identical route surface.
//
// Canonical: docs/ARCHITECTURE.md "API + domain core".
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type preHandlerHookHandler,
} from 'fastify';
import { AuthError, type AuthUser, type TokenVerifier } from './auth/verifier.js';
import type { Config } from './config.js';
import type { SqlClient } from './matching/eligibility.js';
import type { PushSender } from './push/pushSender.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerDonorRoutes } from './routes/donors.js';
import { registerFulfillmentRoutes } from './routes/fulfillment.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerPledgeRoutes } from './routes/pledges.js';
import { registerRequestViewRoutes } from './routes/requestViews.js';
import { registerRequestRoutes } from './routes/requests.js';
import { INDEX_HTML, wantsHtmlDocument } from './routes/spaShell.js';

// The authenticated principal and the auth decorator, typed onto Fastify so
// route handlers read `request.user` and attach `app.authenticate` with no any.
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    /**
     * True when a client bundle is mounted (deps.staticRoot present), so a route
     * that a browser can navigate to may answer a document load with the SPA
     * shell instead of its JSON (GB-32, /alerts/:dispatchId). False → every
     * route keeps its API-only behaviour.
     */
    hasStatic: boolean;
  }
}

export interface AppDeps {
  config: Config;
  verifier: TokenVerifier;
  /**
   * SQL seam for every route. MUST be a SINGLE-SESSION client — PGlite,
   * `pg.Client`, or a checked-out `PoolClient` (standing ruling):
   * the accept/fulfillment/sweep paths issue BEGIN/COMMIT, and a `pg.Pool`
   * spreads those statements across connections, silently breaking the
   * transaction. Required, not optional: the app cannot serve a route without it.
   */
  db: SqlClient;
  /** Push transport for donor alerts, closure notices and the verify handshake. */
  push: PushSender;
  /**
   * Optional Fastify logger override. Production leaves this unset (a pino
   * logger at config.LOG_LEVEL is built); tests pass `false` to stay silent.
   */
  logger?: FastifyServerOptions['logger'];
  /**
   * Absolute path to the built client bundle (client/dist). Omitted → the app
   * is API-only and an unmatched path keeps Fastify's JSON 404. Present → the
   * bundle is served and an HTML GET falls back to index.html so the SPA can
   * own its own paths. The entrypoint omits it when no build exists on disk.
   */
  staticRoot?: string;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Serve the built PWA, and hand every unmatched HTML GET back to index.html so
 * a deep link (/donor, /requester/requests/:id) survives a reload.
 *
 * The API routes share no common prefix, so the fallback cannot be decided by
 * path. It does not have to be: Fastify only reaches the not-found handler for
 * a path NO route matched, and @fastify/static's wildcard defers to it when the
 * file is absent. The remaining guard is the caller — an API client asks for
 * application/json and gets the JSON 404; a browser navigation asks for
 * text/html and gets the shell. Non-GET keeps the JSON 404 either way.
 */
function registerStatic(app: FastifyInstance, root: string): void {
  app.register(fastifyStatic, { root });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && wantsHtmlDocument(request.headers.accept)) {
      return reply.sendFile(INDEX_HTML);
    }
    return reply.code(404).send({ error: 'not_found' });
  });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? { level: deps.config.LOG_LEVEL },
  });

  app.get('/healthz', () => ({ ok: true }));

  // preHandler: require a valid `Authorization: Bearer <token>`. On success the
  // verified AuthUser is attached to request.user; any missing/malformed header
  // or AuthError becomes a 401. Non-auth errors propagate (→ 500).
  const authenticate: preHandlerHookHandler = async (request, reply) => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const token = header.slice(BEARER_PREFIX.length);
    try {
      request.user = await deps.verifier.verify(token);
    } catch (err) {
      if (err instanceof AuthError) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      throw err;
    }
  };

  app.decorate('authenticate', authenticate);
  // Declared before the routes so a route registrar can read it at registration
  // time; the alert deep link reads it per request.
  app.decorate('hasStatic', deps.staticRoot !== undefined);

  // Route surface. Registered after the decorator, which every authenticated
  // module attaches as a preHandler. The sweep secret comes from config — the
  // only route that authenticates a machine caller rather than a Firebase uid.
  const { db, push } = deps;
  registerDonorRoutes(app, { db, push });
  registerRequestRoutes(app, { db });
  registerRequestViewRoutes(app, { db });
  registerAlertRoutes(app, { db });
  registerPledgeRoutes(app, { db });
  // push: closure notices for donors whose active pledge a cancel/fulfil released.
  registerFulfillmentRoutes(app, { db, push });
  registerInternalRoutes(app, { db, push, sweepSecret: deps.config.SWEEP_SHARED_SECRET });

  // Static last: the API owns its paths, and only what no route matched can
  // reach the bundle or the SPA fallback.
  if (deps.staticRoot !== undefined) {
    registerStatic(app, deps.staticRoot);
  }

  return app;
}
