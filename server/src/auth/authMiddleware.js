// Auth middleware.
//
// Three paths coexist. Exactly one is reachable in production, and the
// other two refuse to run there.
//
//   1. **Dev shortcut** — `Authorization: Bearer dev-<role>` when
//      `DEV_AUTH_ENABLED=true`. Resolves to a seeded user, in the dev
//      tenant only. This is curl-friendly development auth. The server
//      refuses to boot in production with the flag on
//      (`assertProductionSafety`), and this path independently refuses to
//      run if it somehow gets there anyway.
//
//   2. **Signed access tokens** — `Authorization: Bearer <jwt>`, HS256,
//      verified for signature, issuer, audience and expiry. On success
//      the user is loaded from Postgres keyed by BOTH `sub` and `tid`,
//      so a token claiming a user from one tenant while naming another
//      tenant matches no row. The permission matrix always comes from
//      the database, never from the token.
//
//   3. **Fail-closed placeholder** — when the database is unreachable,
//      the request continues with an empty matrix so `requirePermission`
//      refuses every route. The client is told 503 upstream.
//
// The permission matrix is deliberately NOT carried in the token. A
// token survives 15 minutes; a role change must take effect within that
// window, so the matrix is re-read on every request. `rid` and `sid` are
// in the token so a stale role or a revoked session can be detected
// without a second round trip.
//
// See docs/AUTH_TENANT_SECURITY_PLAN.md §8 and §23.

import { config, isDevAuthEnabled } from '../config/index.js';
import { isDbConfigured } from '../db/client.js';
import { Unauthorized } from '../utils/errors.js';
import { verifyAccessToken, isDevFallbackAllowed } from './tokenService.js';
import {
  KNOWN_DEV_KEYS,
  buildOfflineDevContext,
  getDevUserAuthContext,
  resolveAuthContext,
} from '../repositories/authRepository.js';

/**
 * @typedef {Object} ReqUser
 * @property {string} id
 * @property {string} tenantId
 * @property {string|null} branchId
 * @property {string|null} teamId
 * @property {string[]} projectIds
 * @property {string} role
 * @property {object} permissionMatrix
 * @property {string} status
 * @property {string|null} [email]
 * @property {string|null} [name]
 * @property {string|null} [sessionId] — refresh-session this token descends from
 */

/**
 * Failure reason → HTTP error. Each reason gets a specific code so an
 * operator can tell "your account was suspended" from "that token was
 * signed with a key we do not accept", while the message stays generic
 * enough not to confirm whether a given user id exists.
 *
 * @param {import('../repositories/authRepository.js').AuthLookupFailure} reason
 * @returns {Unauthorized}
 */
function lookupFailureError(reason) {
  switch (reason) {
    case 'user-suspended':
    case 'user-inactive':
      return new Unauthorized('user-suspended', 'This account is not active.');
    case 'tenant-suspended':
    case 'tenant-inactive':
      return new Unauthorized('tenant-suspended', 'This organisation is not active.');
    case 'tenant-deleted':
      return new Unauthorized('tenant-not-found', 'This organisation is not available.');
    // 'not-found' and 'tenant-mismatch' are deliberately indistinguishable.
    // Telling a caller "that user exists but in another tenant" confirms
    // the user id is real, which is a user-enumeration oracle.
    default:
      return new Unauthorized('unauthorized', 'Invalid or expired credentials.');
  }
}

/**
 * Fastify preHandler. Reads the Bearer token and attaches `req.user`.
 * Routes that need authentication register this as a preHandler.
 *
 * @param {import('fastify').FastifyRequest} req
 * @param {import('fastify').FastifyReply} reply
 */
export async function authMiddleware(req, reply) {
  void reply;
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') {
    throw new Unauthorized('unauthorized', 'Missing Authorization header.');
  }
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    throw new Unauthorized('unauthorized', 'Authorization header must use Bearer.');
  }
  const token = m[1].trim();
  if (!token) {
    throw new Unauthorized('unauthorized', 'Bearer token is empty.');
  }

  const isProduction = process.env.NODE_ENV === 'production';

  // ---- Dev shortcut -------------------------------------------------------
  if (isDevAuthEnabled() && KNOWN_DEV_KEYS.includes(token)) {
    // Belt and braces. The boot guard already refuses this combination;
    // this catches the case where the flag was flipped at runtime.
    if (isProduction) {
      throw new Unauthorized(
        'unauthorized',
        'Development authentication is not permitted on this server.',
      );
    }
    req.user = await resolveDevUser(token);
    req.auth = { source: 'dev', jti: null, sessionId: null };
    return;
  }

  // A dev-shaped token must never authenticate, even outside production.
  // Outside production we allow the dev FLOW, not dev-shaped JWTs: an
  // unsigned token is still refused by verifyAccessToken.
  if (KNOWN_DEV_KEYS.includes(token) && !isDevFallbackAllowed()) {
    throw new Unauthorized('unauthorized', 'Development authentication is disabled.');
  }

  // ---- Signed access token ------------------------------------------------
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    throw new Unauthorized('unauthorized', err?.message || 'Token is invalid.');
  }

  if (isDbConfigured()) {
    const result = await resolveAuthContext(claims.sub, claims.tid);
    if (!result.ok) {
      throw lookupFailureError(result.reason);
    }
    req.user = result.context;
    req.auth = {
      source: 'jwt',
      jti: claims.jti || null,
      sessionId: claims.sid || null,
    };
    return;
  }

  // No database. We cannot confirm the user exists, is active, or what
  // permissions they hold, so we will not claim otherwise. The empty
  // matrix makes requirePermission refuse every route — fail closed.
  req.user = placeholderUser(claims);
  req.auth = { source: 'unverified', jti: claims.jti || null, sessionId: null };
}

/**
 * Resolve a `dev-<role>` token to an AuthContext, scoped to the
 * configured dev tenant.
 *
 * @param {string} devKey
 * @returns {Promise<ReqUser>}
 */
async function resolveDevUser(devKey) {
  const tenantId = config.devAuth.tenantId;

  if (isDbConfigured()) {
    const ctx = await getDevUserAuthContext(devKey, { tenantId });
    if (ctx) return ctx;
    throw new Unauthorized(
      'unauthorized',
      `Dev token ${devKey} does not resolve to a seeded user. Did you run db:seed?`,
    );
  }

  if (!config.devAuth.offlineFallback) {
    throw new Unauthorized(
      'database-not-configured',
      'DATABASE_URL is not set and DEV_AUTH_OFFLINE_FALLBACK is off.',
    );
  }
  const ctx = buildOfflineDevContext(devKey, { tenantId });
  if (!ctx) {
    throw new Unauthorized('unauthorized', `Unknown dev token: ${devKey}.`);
  }
  return ctx;
}

/**
 * Build a fail-closed placeholder user. Used only when the DB is not
 * configured — `permissionMatrix = {}` so `requirePermission` returns
 * 403 for every (resource, action).
 *
 * @param {{ sub: string, tid: string, rid?: string }} claims
 * @returns {ReqUser}
 */
function placeholderUser(claims) {
  return {
    id: claims.sub,
    tenantId: claims.tid,
    branchId: null,
    teamId: null,
    projectIds: [],
    role: claims.rid || 'unknown',
    permissionMatrix: {},
    status: 'Active',
    email: null,
    name: null,
    sessionId: claims.sid || null,
  };
}

export { lookupFailureError, placeholderUser };
