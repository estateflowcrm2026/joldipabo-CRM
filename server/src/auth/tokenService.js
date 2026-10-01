// Token service — HMAC-SHA256 (HS256) signed access tokens, and opaque
// refresh tokens stored hashed.
//
// Until 2026-09-24 `issueAccessToken` returned `header.payload.` with an
// EMPTY signature and `verifyAccessToken` only base64-decoded the body.
// Anyone could mint `{sub:"u-super", tid:"org_acme", exp:<future>}` and
// the server accepted it — a working impersonation path, and the
// tenant-isolation breach, since `tid` was never checked against `sub`.
// That hole is closed here: tokens are signed and the signature is
// verified with a constant-time comparison.
//
// Signing uses `node:crypto` directly rather than a JWT library. The
// surface is two functions and three claims, so a dependency would add
// install weight and version risk without buying anything. Revocation,
// key rotation, and asymmetric keys are deferred to Phase 6.
//
// Refresh tokens are deliberately NOT JWTs: they are 32 random bytes,
// stored as a SHA-256 hash, and are looked up by that hash. They cannot
// be forged and they can be revoked by deleting a row.
//
// See docs/AUTH_API_SPEC.md for the wire contract and
// docs/AUTH_TENANT_SECURITY_PLAN.md §8 for the session design.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** HMAC-SHA256 over the ASCII bytes of `data`, Base64URL-encoded. */
function sign(data, secret) {
  return createHmac('sha256', secret).update(data, 'ascii').digest('base64url');
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, so
 * length is compared first and the result folded into the timing-safe
 * path. Comparing a hash's length leaks nothing useful — it is fixed by
 * the algorithm.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'ascii');
  const bufB = Buffer.from(b, 'ascii');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolve the signing key, or throw.
 *
 * Order of preference:
 *   1. `JWT_SECRET` — the real key.
 *   2. The dev fallback, ONLY when `DEV_AUTH_ENABLED=true` and
 *      `NODE_ENV !== 'production'`. This keeps the dev-token flow and
 *      the test suite working on a machine with no secret configured.
 *
 * The fallback is never reachable in production: the boot guard refuses
 * to start without a real `JWT_SECRET`, and this function independently
 * refuses the fallback there. Two independent checks, because this is
 * the exact line that was previously missing.
 *
 * @param {{ allowDevFallback?: boolean }} [opts]
 * @returns {string}
 * @throws {Error}
 */
export function resolveSigningKey({ allowDevFallback = true } = {}) {
  if (config.jwt.secret && config.jwt.secret.trim() !== '') {
    return config.jwt.secret;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    throw new Error(
      'JWT_SECRET is not set. Tokens cannot be signed or verified.\n' +
        'Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
  }

  if (allowDevFallback && isDevFallbackAllowed()) {
    return config.jwt.devFallbackSecret;
  }

  throw new Error(
    'JWT_SECRET is not set, and the development fallback is not available.\n' +
      'Set JWT_SECRET, or set DEV_AUTH_ENABLED=true to use the dev-only fallback key.',
  );
}

/**
 * Whether the dev-only fallback key may be used. Requires the dev-auth
 * flag AND a non-production runtime.
 *
 * @returns {boolean}
 */
export function isDevFallbackAllowed() {
  return (
    process.env.DEV_AUTH_ENABLED === 'true' && process.env.NODE_ENV !== 'production'
  );
}

/**
 * Whether a usable signing key is available. Used by the boot guard.
 * @returns {boolean}
 */
export function hasUsableSigningKey() {
  try {
    resolveSigningKey();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Access tokens — HS256 JWT
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AccessTokenClaims
 * @property {string} sub   — user id
 * @property {string} tid   — tenant id. Checked against the user row on
 *                            every request; a mismatch is a forged token.
 * @property {string} rid   — role id, for cheap staleness checks
 * @property {string} sid   — refresh-session id this token descends from
 * @property {string} jti   — unique token id
 * @property {number} iat   — issued-at (seconds)
 * @property {number} exp   — expiry (seconds)
 * @property {string} iss   — issuer
 * @property {string} aud   — audience
 */

/**
 * Issue a signed HS256 access token.
 *
 * @param {{ sub: string, tid: string, rid?: string, sid?: string }} input
 * @param {{ allowDevFallback?: boolean }} [opts]
 * @returns {{ token: string, expiresIn: number, jti: string, claims: AccessTokenClaims }}
 */
export function issueAccessToken(input, opts = {}) {
  if (!input?.sub) throw new Error('issueAccessToken requires a sub (user id).');
  if (!input?.tid) throw new Error('issueAccessToken requires a tid (tenant id).');

  const secret = resolveSigningKey(opts);
  const jti = `at_${randomBytes(12).toString('hex')}`;
  const iat = nowSeconds();
  const exp = iat + config.jwt.accessTtlSeconds;

  /** @type {AccessTokenClaims} */
  const claims = {
    sub: input.sub,
    tid: input.tid,
    rid: input.rid || null,
    sid: input.sid || null,
    jti,
    iat,
    exp,
    iss: config.jwt.issuer,
    aud: config.jwt.audience,
  };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;

  return {
    token: `${signingInput}.${sign(signingInput, secret)}`,
    expiresIn: config.jwt.accessTtlSeconds,
    jti,
    claims,
  };
}

/**
 * Verify a signed access token: structure, signature, issuer, audience,
 * expiry. Returns the claims or throws.
 *
 * The signature is checked BEFORE the payload is trusted for anything,
 * including the expiry comparison — an attacker must not be able to
 * learn anything from a forged token's shape.
 *
 * @param {string} token
 * @param {{ allowDevFallback?: boolean, now?: number }} [opts]
 * @returns {AccessTokenClaims}
 * @throws {Error} with a message suitable for a 401 body
 */
export function verifyAccessToken(token, opts = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token is empty.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Token is malformed.');
  }
  const [header, payload, signature] = parts;

  // An unsigned token is `header.payload.` — the third segment is empty.
  // Checking this explicitly keeps the old failure mode (an empty
  // signature comparing equal to an empty signature) from ever
  // returning, even if resolveSigningKey were to return ''.
  if (!signature) {
    throw new Error('Token signature is missing.');
  }

  let secret;
  try {
    secret = resolveSigningKey(opts);
  } catch (err) {
    throw new Error(err.message);
  }

  const expected = sign(`${header}.${payload}`, secret);
  if (!safeEqual(signature, expected)) {
    throw new Error('Token signature is invalid.');
  }

  let claims;
  try {
    claims = JSON.parse(base64urlDecode(payload));
  } catch {
    throw new Error('Token payload is not valid JSON.');
  }

  if (typeof claims !== 'object' || claims === null) {
    throw new Error('Token payload is not an object.');
  }
  if (typeof claims.sub !== 'string' || typeof claims.tid !== 'string') {
    throw new Error('Token payload is missing sub or tid.');
  }

  // Issuer and audience. A token minted for a different deployment, or
  // for a different client, is not acceptable here even when correctly
  // signed with our key.
  if (claims.iss !== config.jwt.issuer) {
    throw new Error('Token issuer is not accepted.');
  }
  if (claims.aud !== config.jwt.audience) {
    throw new Error('Token audience is not accepted.');
  }

  const now = opts.now ?? nowSeconds();
  // `exp` strictly in the past is expired. A token at exactly `now` has
  // reached the end of its window.
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw new Error('Token has expired.');
  }
  // A token issued in the future by more than a small skew suggests a
  // clock problem or an attempt to extend validity.
  if (typeof claims.iat === 'number' && claims.iat > now + 60) {
    throw new Error('Token is not yet valid.');
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Refresh tokens (opaque random, stored hashed)
// ---------------------------------------------------------------------------

/**
 * Issue a refresh token. Returns the plaintext (one-time read by the
 * client) and its SHA-256 hash for storage.
 *
 * @returns {{ token: string, tokenHash: string, expiresAt: string }}
 */
export function issueRefreshToken() {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(
    Date.now() + config.jwt.refreshTtlSeconds * 1000,
  ).toISOString();
  return { token, tokenHash, expiresAt };
}

/**
 * SHA-256 of a refresh token's plaintext. Idempotent.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashRefreshToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
