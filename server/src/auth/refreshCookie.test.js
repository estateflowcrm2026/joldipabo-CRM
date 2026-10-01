// Cookie attribute and CSRF tests.
//
// Run with: `npm test` (src/auth/*.test.js is in the glob)
//
// These are pure. The behavioural proof — that a browser keeps the
// session across a reload, and that a foreign origin cannot use it — is
// `scripts/verify-cookie-session.js` and `scripts/browser-smoke-auth.mjs`,
// because those need a server and a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCookies,
  buildRefreshCookie,
  buildCsrfCookie,
  buildClearCookie,
  csrfMatches,
  checkOrigin,
  REFRESH_COOKIE,
  CSRF_COOKIE,
} from './refreshCookie.js';

const EXPIRES = new Date('2030-01-01T00:00:00Z');
const SECRET = 'super-secret-refresh-token-value';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseCookies reads a simple jar', () => {
  const out = parseCookies('a=1; b=2');
  assert.equal(out.a, '1');
  assert.equal(out.b, '2');
});

test('parseCookies percent-decodes values', () => {
  // The tokens are base64url and are encoded into the cookie, so a
  // round trip is not guaranteed without this.
  const token = 'ab_cd-ef123';
  const out = parseCookies(`x=${encodeURIComponent(token)}`);
  assert.equal(out.x, token);
});

test('parseCookies survives rubbish', () => {
  assert.deepEqual({ ...parseCookies(undefined) }, {});
  assert.deepEqual({ ...parseCookies('') }, {});
  assert.deepEqual({ ...parseCookies('novalue; =empty; k=v') }, { k: 'v' });
});

// ---------------------------------------------------------------------------
// The refresh cookie
// ---------------------------------------------------------------------------

test('the refresh cookie is HttpOnly, scoped and expiring', () => {
  const c = buildRefreshCookie({ token: SECRET, expiresAt: EXPIRES, secure: false, sameSite: 'Lax' });
  assert.ok(c.startsWith(`${REFRESH_COOKIE}=`), 'named correctly');
  assert.match(c, /HttpOnly/i, 'unreadable by JavaScript — the entire point');
  assert.match(c, /SameSite=Lax/i);
  assert.match(c, /Path=\/api\/v1\/auth/i, 'not attached to every API call');
  assert.match(c, /Expires=/i);
  assert.ok(!c.includes('Secure'), 'no Secure on plain-HTTP dev');
});

test('the refresh cookie is Secure when configured so', () => {
  const c = buildRefreshCookie({ token: SECRET, expiresAt: EXPIRES, secure: true, sameSite: 'None' });
  assert.match(c, /Secure/i);
  assert.match(c, /SameSite=None/i, 'a cross-site deployment needs both');
});

test('the refresh token is percent-encoded into the header', () => {
  // A token containing a separator would otherwise truncate the cookie
  // and silently produce an unusable session.
  const odd = 'has;equals=and,comma';
  const c = buildRefreshCookie({ token: odd, expiresAt: EXPIRES, secure: false, sameSite: 'Lax' });
  const value = c.split(';')[0].split('=')[1];
  assert.equal(decodeURIComponent(value), odd);
});

// ---------------------------------------------------------------------------
// The CSRF cookie
// ---------------------------------------------------------------------------

test('the CSRF cookie is readable by JS and scoped to /', () => {
  // Path must be /, not the API path: `document.cookie` only exposes a
  // cookie whose path is a prefix of the current page, and the client
  // has to read this one to echo it in the header. Scoping it to the
  // API made every cookie refresh fail as `csrf-rejected`.
  const c = buildCsrfCookie({ token: 'tok', expiresAt: EXPIRES, secure: false, sameSite: 'Lax' });
  // Matched with a trailing delimiter rather than `$`: the attribute is
  // emitted as `Path=/ ` with a space before the next `;`, so `Path=/$`
  // does not match even though the value is correct.
  assert.match(c, /Path=\/\s*;/i, 'must be visible to the frontend origin');
  assert.ok(!/HttpOnly/i.test(c), 'deliberately readable — it is not the credential');
  assert.match(c, /SameSite=Lax/i);
});

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

test('clearing expires the cookie with a matching path', () => {
  // A different path means the browser treats it as a different cookie
  // and keeps the original, so the session would survive a logout.
  const c = buildClearCookie(REFRESH_COOKIE, { secure: false, sameSite: 'Lax', path: '/api/v1/auth' });
  assert.match(c, /Max-Age=0/i);
  assert.match(c, /Expires=Thu, 01 Jan 1970/i);
  assert.match(c, /Path=\/api\/v1\/auth/i);
  assert.match(c, /HttpOnly/i, 'must match the original attributes too');
});

test('the CSRF cookie can be cleared at /', () => {
  const c = buildClearCookie(CSRF_COOKIE, { secure: false, sameSite: 'Lax', path: '/' });
  assert.match(c, /Path=\/\s*;/i);
  assert.match(c, /Max-Age=0/i);
});

// ---------------------------------------------------------------------------
// CSRF comparison
// ---------------------------------------------------------------------------

test('a matching CSRF token is accepted', () => {
  assert.equal(csrfMatches('abc123', 'abc123'), true);
});

test('a mismatched or absent CSRF token is refused', () => {
  assert.equal(csrfMatches('abc123', 'xyz789'), false);
  assert.equal(csrfMatches('', 'abc123'), false);
  assert.equal(csrfMatches('abc123', ''), false);
  assert.equal(csrfMatches(undefined, undefined), false);
});

test('a different length is refused rather than throwing', () => {
  // timingSafeEqual throws on a length mismatch; a CSRF check that
  // throws is a 500 on every malformed request.
  assert.equal(csrfMatches('short', 'much-longer-value'), false);
});

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

test('an allowed origin passes', () => {
  assert.deepEqual(checkOrigin('http://localhost:5173', ['http://localhost:5173']), { ok: true });
});

test('a foreign origin is refused', () => {
  const r = checkOrigin('http://evil.example', ['http://localhost:5173']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'origin-not-allowed');
});

test('a MISSING origin is refused on a cookie route', () => {
  // A cross-site form post from a browser always carries an Origin, so
  // its absence means a non-browser client — which has no business
  // using a cookie, and has no Origin to forge.
  const r = checkOrigin(undefined, ['http://localhost:5173']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing-origin');
});
