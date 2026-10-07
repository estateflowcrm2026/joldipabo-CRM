// Fastify app factory.
//
// Builds the Fastify instance, registers routes, and returns it. The
// server entry point (server.js) calls buildApp() and then .listen().

import Fastify from 'fastify';
import { config } from './config/index.js';
import { HttpError } from './utils/errors.js';
import { DB_NOT_CONFIGURED } from './db/client.js';

import authRoutes      from './routes/auth.js';
import userRoutes      from './routes/users.js';
import roleRoutes      from './routes/roles.js';
import teamRoutes      from './routes/teams.js';
import projectRoutes   from './routes/projects.js';
import leadRoutes      from './routes/leads.js';
import contactRoutes   from './routes/contacts.js';
import listingRoutes   from './routes/listings.js';
import visitRoutes     from './routes/visits.js';
import attendanceRoutes from './routes/attendance.js';
import photoRoutes     from './routes/photos.js';
import commRoutes      from './routes/communications.js';
import reportRoutes    from './routes/reports.js';
import syncRoutes      from './routes/sync.js';

/**
 * Build (but do not start) the Fastify app.
 *
 * @param {object} [overrides]
 * @returns {import('fastify').FastifyInstance}
 */
export async function buildApp(overrides = {}) {
  const app = Fastify({
    logger: { level: overrides.logLevel ?? config.logLevel },
    disableRequestLogging: false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
  });

  // CORS — restricted to the configured origins. Implemented inline to
  // avoid pulling in @fastify/cors for a scaffold. Replace with the
  // official plugin when preflight handling grows.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key,X-Tenant-Slug,X-CSRF-Token');
      reply.code(204).send();
    }
  });

  // A POST with `content-type: application/json` and NO body is rejected
  // by Fastify's content-type parser before any handler runs, with
  // FST_ERR_CTP_EMPTY_JSON_BODY. That is correct for an endpoint that
  // expects a payload, and wrong for the cookie-authenticated ones:
  // /auth/refresh and /auth/logout take everything they need from
  // headers and the cookie jar, so a browser sending an empty body is
  // doing the right thing.
  //
  // Treat an empty body as `{}` on those routes rather than loosening the
  // parser globally, which would hide genuinely malformed requests
  // everywhere else.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      if (!body || (typeof body === 'string' && body.trim() === '')) {
        const wantsNoBody =
          req.method === 'POST' &&
          ['/auth/refresh', '/auth/logout'].includes(req.url.split('?')[0]);
        if (wantsNoBody) {
          done(null, {});
          return;
        }
      }
      try {
        done(null, body === '' ? {} : JSON.parse(body));
      } catch (err) {
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Standard error handler — renders HttpError subclasses via the
  // documented envelope (docs/AUTH_API_SPEC.md §1).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      // A lockout or rate-limit response carries `Retry-After` in
      // seconds, per the spec §1. Clients use it to back off without
      // parsing the message.
      if (err.statusCode === 429) {
        const ms = err.detail?.retryAfterMs;
        reply.header('Retry-After', String(Math.max(1, Math.ceil((ms || 60_000) / 1000))));
      }
      reply.code(err.statusCode).send(err.toBody());
      return;
    }
    // DB-not-configured is a 503, not a 500. Routes that touch the
    // database throw this code from `query()` when DATABASE_URL is
    // absent; map it to the documented envelope.
    if (err && err.code === DB_NOT_CONFIGURED) {
      reply.code(503).send({
        error: {
          code: 'database-not-configured',
          message: 'DATABASE_URL is not configured. See server/README.md "Local Postgres".',
        },
      });
      return;
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      // Preserve the thrown code rather than flattening it. The auth
      // endpoints document distinct codes (`invalid-credentials`,
      // `invalid-refresh-token`, `reason-required`, …) and clients
      // branch on them; collapsing everything to `bad-request` made
      // those contracts unimplementable.
      reply.code(err.statusCode).send({
        error: { code: err.code || 'bad-request', message: err.message || 'Bad request.' },
      });
      return;
    }
    req.log.error({ err }, 'unhandled-error');
    reply.code(500).send({
      error: { code: 'internal-error', message: 'Internal server error.' },
    });
  });

  // Health endpoints.
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => {
    // Real probe: not-configured -> 200, connected -> 200,
    // configured-but-down -> 503 (thrown by checkReadiness).
    const { checkReadiness } = await import('./db/health.js');
    return checkReadiness();
  });

  // Mount routes under /api/v1.
  await app.register(async (scope) => {
    await authRoutes(scope);
    await userRoutes(scope);
    await roleRoutes(scope);
    await teamRoutes(scope);
    await projectRoutes(scope);
    await leadRoutes(scope);
    await contactRoutes(scope);
    await listingRoutes(scope);
    await visitRoutes(scope);
    await attendanceRoutes(scope);
    await photoRoutes(scope);
    await commRoutes(scope);
    await reportRoutes(scope);
    await syncRoutes(scope);
  }, { prefix: '/api/v1' });

  return app;
}
