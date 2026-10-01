// Cookie-backed session issuance.
//
// The only thing this adds over the existing login/refresh services is
// the delivery mechanism: read the refresh token from a cookie, and set
// the cookie (plus its CSRF pair) on the way out. All the security
// properties — rotation, family revocation on replay, single use — belong
// to `authService.js` and are unchanged.
//
// A TOKEN BODY is still accepted on these routes, and that is deliberate:
// it is what makes the endpoints testable from a script and usable by a
// non-browser client. But the response NEVER returns a refresh token in
// the body when a cookie was used, so a browser that opts into the
// cookie cannot accidentally read it back out of a JSON response.

import { randomBytes } from 'node:crypto';

import { config } from '../config/index.js';
import {
  REFRESH_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  parseCookies,
  buildRefreshCookie,
  buildCsrfCookie,
  buildClearCookie,
  csrfMatches,
  checkOrigin,
} from './refreshCookie.js';

const csrfSecrets = new Map(); // csrf token -> expiry, so a rotated pair can be checked

/** @returns {{secure: boolean, sameSite: string}} */
const cookieOpts = () => ({
  secure: config.authCookie.secure,
  sameSite: config.authCookie.sameSite,
});

/**
 * Mint a CSRF token and remember it until it expires.
 *
 * Kept in process memory rather than derived, so a CSRF token cannot be
 * computed from anything the client already has. A stateless HMAC scheme
 * would also be safe; the in-memory one is here because it makes the
 * "one pair per session" property obvious and has no key to manage.
 *
 * @param {Date} expiresAt
 * @returns {string}
 */
export function issueCsrfToken(expiresAt) {
  const token = randomBytes(24).toString('base64url');
  csrfSecrets.set(token, expiresAt.getTime());
  return token;
}

/** Drop expired CSRF tokens. Cheap; called on issuance. */
function sweepCsrf() {
  const now = Date.now();
  for (const [token, expiresAt] of csrfSecrets) {
    if (expiresAt <= now) csrfSecrets.delete(token);
  }
}

/**
 * The `Set-Cookie` headers that establish a session.
 *
 * @param {object} input
 * @param {string} input.refreshToken
 * @param {Date}   input.expiresAt
 * @returns {string[]}
 */
export function sessionCookies({ refreshToken, expiresAt }) {
  sweepCsrf();
  const csrf = issueCsrfToken(expiresAt);
  const opts = cookieOpts();
  return [
    buildRefreshCookie({ token: refreshToken, expiresAt, ...opts }),
    buildCsrfCookie({ token: csrf, expiresAt, ...opts }),
  ];
}

/** The `Set-Cookie` headers that end a session. */
export function clearSessionCookies() {
  const opts = cookieOpts();
  return [
    buildClearCookie(REFRESH_COOKIE, opts),
    // The CSRF cookie was set with Path=/, so it must be cleared with
    // Path=/ too.
    buildClearCookie(CSRF_COOKIE, { ...opts, path: '/' }),
  ];
}

/**
 * Strip the refresh token from a response body.
 *
 * Applied on every response that would otherwise carry one, so the
 * cookie path cannot leak it into JSON that a client — or a proxy log,
 * or a devtools network panel — might read.
 *
 * @template T
 * @param {T} body
 * @returns {T}
 */
export function withoutRefreshToken(body) {
  if (!body || typeof body !== 'object') return body;
  if (!('refreshToken' in body)) return body;
  const { refreshToken, ...rest } = body;
  return rest;
}

/**
 * Read the refresh token from a request, preferring the cookie.
 *
 * @param {import('fastify').FastifyRequest} req
 * @returns {{token: string, source: 'cookie'|'body'}|null}
 */
export function readRefreshToken(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const fromCookie = cookies[REFRESH_COOKIE];
  if (fromCookie) return { token: fromCookie, source: 'cookie' };
  const fromBody = req.body?.refreshToken;
  if (fromBody) return { token: fromBody, source: 'body' };
  return null;
}

/**
 * Whether a cookie-based request is allowed to proceed.
 *
 * Three checks, in order of what they stop:
 *
 *   1. Origin — a forged cross-site request carries the attacker's
 *      origin. This is the check that still works when SameSite cannot:
 *      a `None` deployment (needed for a cross-site split) is protected
 *      by nothing else.
 *   2. CSRF header present and matching the cookie — a cross-origin
 *      script cannot read the cookie, so it cannot reproduce the header.
 *   3. A known CSRF secret — so a token the attacker invented, with a
 *      cookie value they also invented, is still refused.
 *
 * @param {import('fastify').FastifyRequest} req
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function authorizeCookieRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  if (!cookies[REFRESH_COOKIE]) {
    // No cookie: the caller used a body token, which is not cookie-auth
    // and so not subject to CSRF. That is the script/CLI path.
    return { ok: true };
  }

  const origin = checkOrigin(req.headers?.origin, config.corsOrigins);
  if (!origin.ok) {
    return { ok: false, reason: origin.reason };
  }

  const presented = req.headers?.[CSRF_HEADER];
  const fromCookie = cookies[CSRF_COOKIE];
  if (!csrfMatches(presented, fromCookie)) {
    return { ok: false, reason: 'csrf-mismatch' };
  }
  if (!csrfSecrets.has(String(presented))) {
    return { ok: false, reason: 'csrf-unknown' };
  }
  if (csrfSecrets.get(String(presented)) <= Date.now()) {
    return { ok: false, reason: 'csrf-expired' };
  }
  return { ok: true };
}

export { REFRESH_COOKIE, CSRF_COOKIE, CSRF_HEADER };
