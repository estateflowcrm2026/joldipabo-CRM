// The refresh token, moved out of JavaScript's reach.
//
// WHY
// ---
// Phase 9A kept tokens in module scope, which meant a page reload
// re-authenticated. The conventional fix is an `httpOnly` cookie: the
// browser attaches it to every request, `document.cookie` cannot read it,
// and a reload restores the session without a stored credential.
//
// WHAT THIS DOES NOT CHANGE
// -------------------------
// The ACCESS token stays in memory on the frontend. Only the refresh
// token moves. An access token in a cookie would be attached
// automatically to every request including cross-site form posts, and
// being short-lived and read by JS is what lets the client refresh it
// before expiry.
//
// THE CSRF PROBLEM THIS CREATES
// -----------------------------
// A cookie is attached by the browser, not by JavaScript, so a page on
// another origin can make the browser POST /auth/refresh and receive an
// access token it can then read. That is the classic CSRF-to-token-theft
// path, and SameSite does not close it on its own: `Lax` allows
// top-level GET navigations, and a refresh endpoint that is GET-able is
// enough.
//
// Three defences, all required here:
//
//   1. `SameSite=Lax` — blocks the cross-site POST, which is the case
//      that matters. `Strict` is not used because it also blocks the
//      cookie on a normal navigation back into the app, which signs
//      users out every time they click a link from their email.
//   2. A double-submit CSRF token, compared with `timingSafeEqual`. A
//      cross-site attacker cannot read the CSRF cookie, so cannot
//      reproduce the header.
//   3. An explicit `Origin` check on cookie-authenticated routes. A
//      forged request carries the attacker's origin, which is not ours.
//
// WHY DEV AND PRODUCTION DIFFER HERE
// ---------------------------------
// The frontend (5173) and the API (4000) are different ORIGINS but the
// same SITE in development — `localhost:5173` and `localhost:4000` share
// a registrable domain — so `SameSite=Lax` is sufficient there. In
// production they may not be, and a cross-site deployment needs
// `SameSite=None; Secure`, which browsers refuse without HTTPS. The
// cookie attributes are therefore derived from configuration rather than
// hard-coded, so a cross-site deployment does not silently stop
// refreshing and fail as "logged out, for no visible reason".

import { timingSafeEqual } from 'node:crypto';

/** Cookie carrying the refresh token. */
export const REFRESH_COOKIE = 'jrp_refresh';

/** Cookie carrying the CSRF token. Readable by JS, useless without the refresh cookie. */
export const CSRF_COOKIE = 'jrp_csrf';

/** Header the client echoes the CSRF cookie back in. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Parse a `Cookie` header into a plain object.
 *
 * Hand-rolled rather than adding a cookie plugin: the header is a
 * documented, stable format and this is the only place it is read.
 * Values are percent-decoded because the CSRF token is base64url, which
 * can contain characters that must be encoded in a cookie value.
 *
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // A malformed value is not worth failing the request over; the
      // caller sees a missing cookie and refuses, which is correct.
      out[name] = value;
    }
  }
  return out;
}

/**
 * Build the `Set-Cookie` header for the refresh token.
 *
 * @param {object} input
 * @param {string} input.token
 * @param {Date}   input.expiresAt absolute expiry, from the session row
 * @param {boolean} input.secure whether to mark the cookie Secure
 * @param {string}  [input.sameSite]
 * @returns {string}
 */
export function buildRefreshCookie({ token, expiresAt, secure, sameSite = 'Lax' }) {
  const attrs = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api/v1/auth',
    // Unreadable by JavaScript. The whole point.
    'HttpOnly',
    // `SameSite=<value>`, not a bare value. A bare `lax` is a cookie with
    // an unknown attribute named "lax": browsers fall back to their
    // default (Lax in Chrome, and historically None elsewhere), so the
    // setting silently did not apply where it mattered most.
    `SameSite=${sameSite}`,
    // Scoped to the auth routes so it is not attached to every API
    // call — least privilege for a credential that outlives an access
    // token by days.
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Build the `Set-Cookie` header for the CSRF token.
 *
 * NOT HttpOnly, deliberately: the client has to read it to echo it in the
 * header. That is safe because it is only half the credential — without
 * the HttpOnly refresh cookie, a cross-origin script that reads this
 * still cannot authenticate.
 *
 * @param {object} input
 * @param {string} input.token
 * @param {Date}   input.expiresAt
 * @param {boolean} input.secure
 * @param {string}  [input.sameSite]
 * @returns {string}
 */
export function buildCsrfCookie({ token, expiresAt, secure, sameSite = 'Lax' }) {
  const attrs = [
    `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
    // NOT `/api/v1/auth`. `document.cookie` only exposes cookies whose
    // path is a prefix of the CURRENT page URL, so a cookie scoped to
    // the API is invisible to the frontend origin — and the client then
    // cannot echo the CSRF header, so every cookie refresh is refused as
    // `csrf-rejected` and the session cannot survive a reload. The CSRF
    // token is not the credential: the HttpOnly refresh cookie is, and
    // this one carries no privilege on its own.
    'Path=/',
    'SameSite=' + sameSite,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Build a `Set-Cookie` that clears a cookie. Must match the original's
 * path and attributes or the browser keeps it.
 *
 * @param {string} name
 * @param {object} [opts]
 * @returns {string}
 */
export function buildClearCookie(name, { secure = true, sameSite = 'Lax', path = '/api/v1/auth' } = {}) {
  // The path must MATCH the one the cookie was set with, or the browser
  // treats this as a different cookie and keeps the original.
  const attrs = [
    `${name}=`,
    'Path=' + path,
    'HttpOnly',
    'SameSite=' + sameSite,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Compare a presented CSRF token with the cookie, in constant time.
 *
 * @param {string|undefined} presented from the header
 * @param {string|undefined} fromCookie
 * @returns {boolean}
 */
export function csrfMatches(presented, fromCookie) {
  if (!presented || !fromCookie) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(fromCookie));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}


/**
 * Whether a request's Origin is one we serve.
 *
 * Checked on cookie-authenticated routes. A forged request carries the
 * attacker's origin, so this refuses it even if the browser attached the
 * cookie — which is the case SameSite already blocks, and the case a
 * `None` deployment (needed for a cross-site split) would NOT.
 *
 * A request with NO Origin header is refused on cookie routes. A
 * cross-site form post from a browser always carries one, so its absence
 * means a non-browser client, which has no business using a cookie.
 *
 * @param {string|undefined} origin
 * @param {string[]} allowedOrigins
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkOrigin(origin, allowedOrigins) {
  if (!origin) {
    return { ok: false, reason: 'missing-origin' };
  }
  if (!allowedOrigins.includes(origin)) {
    return { ok: false, reason: 'origin-not-allowed' };
  }
  return { ok: true };
}
