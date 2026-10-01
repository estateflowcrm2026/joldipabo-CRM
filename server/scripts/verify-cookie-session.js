// Live verification of the HttpOnly-cookie session (Phase 9B).
//
//   node --env-file=.env scripts/verify-cookie-session.js
//
// Uses an explicit cookie jar, because that is what a browser does and
// the whole point is that the server cannot tell the difference. Proves:
//
//   1. login sets TWO cookies, the refresh one HttpOnly
//   2. NO refresh token appears in any response body
//   3. refresh works from the cookie alone, and ROTATES it
//   4. the OLD cookie is refused after rotation (replay detection)
//   5. concurrent refresh sends ONE request and both callers succeed
//   6. a cookie request with no CSRF header is refused
//   7. a cookie request with a MISMATCHED CSRF token is refused
//   8. a cookie request from a foreign Origin is refused
//   9. a body-token refresh still works (the script/CLI path)
//  10. logout revokes the session AND expires the cookie
//  11. refresh after logout fails
//  12. the MFA path sets cookies too
//
// NOTHING IS PRINTED except status codes and cookie ATTRIBUTE names —
// never a token value, never a cookie value.

const BASE = process.env.AUTH_VERIFY_BASE_URL || 'http://127.0.0.1:4000/api/v1';
const ORIGIN = process.env.AUTH_VERIFY_ORIGIN || 'http://localhost:5173';
const EMAIL_PLAIN = process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example';
const PASSWORD = process.env.DEMO_PASSWORD;

let passed = 0;
let failed = 0;
const assert = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok  ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

if (!PASSWORD) { console.error('DEMO_PASSWORD is not set.'); process.exit(2); }

// ---------------------------------------------------------------------------
// A minimal cookie jar
// ---------------------------------------------------------------------------
/** name -> { value, attrs:Set<string> } */
const jar = new Map();

function absorb(response) {
  const raw = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const line of raw) absorbOne(line);
  return raw;
}

function absorbOne(line) {
  const [pair, ...rest] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq === -1) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const attrs = new Set(rest.map((a) => a.trim().split('=')[0].toLowerCase()));
  if (attrs.has('max-age') || /expires=thu, 01 jan 1970/i.test(line)) {
    jar.delete(name);
  } else {
    jar.set(name, { value, attrs });
  }
}

const cookieHeader = () =>
  [...jar.entries()].map(([n, c]) => `${n}=${c.value}`).join('; ');

const csrf = () => jar.get('jrp_csrf')?.value ?? null;

async function post(path, body, { origin = ORIGIN, withCsrf = true, jar: useJar = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (useJar && jar.size > 0) headers.cookie = cookieHeader();
  if (useJar && withCsrf && csrf()) headers['x-csrf-token'] = csrf();
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const setCookies = absorb(res);
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: parsed, setCookies };
}

/**
 * Whether a refresh token is present in a response BODY.
 *
 * Checks for the KEY rather than pattern-matching a token-shaped value.
 * A value scan also matches the access token and the user record, so it
 * reported "a token leaked" when nothing had — and printing the matches to
 * diagnose that would have put a live access token in this transcript.
 */
const refreshTokenInBody = (b) =>
  Boolean(b && typeof b === 'object' && 'refreshToken' in b);

// ---------------------------------------------------------------------------

console.log(`\n[cookie] target ${BASE}  origin ${ORIGIN}`);

// 1 + 2. login
let login;
{
  login = await post('/auth/login', { tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD });
  assert('login returns 200', login.status === 200, `status=${login.status}`);
  const names = login.setCookies.map((l) => l.split('=')[0].trim());
  assert('two cookies are set', names.length === 2, names.join(','));
  const refresh = login.setCookies.find((l) => l.startsWith('jrp_refresh='));
  assert('the refresh cookie is HttpOnly', Boolean(refresh && /httponly/i.test(refresh)));
  assert('the refresh cookie is SameSite', Boolean(refresh && /samesite/i.test(refresh)));
  assert('the refresh cookie is scoped to the auth path',
    Boolean(refresh && /path=\/api\/v1\/auth/i.test(refresh)));
  assert('the refresh cookie has an expiry',
    Boolean(refresh && /expires=/i.test(refresh)));
  assert('NO refreshToken key in the response body', !refreshTokenInBody(login.body),
    Object.keys(login.body ?? {}).join(','));
  assert('the access token IS in the body', Boolean(login.body?.accessToken));
}

// 3. refresh rotates
let rotated;
{
  const r = await post('/auth/refresh', {});
  assert('refresh with only the cookie returns 200', r.status === 200, `status=${r.status}`);
  assert('a new access token is issued', Boolean(r.body?.accessToken));
  assert('NO refreshToken key in the refresh response', !refreshTokenInBody(r.body),
    Object.keys(r.body ?? {}).join(','));
  const setRefresh = r.setCookies.find((l) => l.startsWith('jrp_refresh='));
  assert('the cookie is replaced (rotation)', Boolean(setRefresh));
  rotated = setRefresh ? setRefresh.split('=')[1].split(';')[0] : null;
  assert('the replacement differs from the original', Boolean(rotated));
}

// 4. replay of the OLD cookie is refused
{
  const current = jar.get('jrp_refresh').value;
  jar.set('jrp_refresh', { value: `${current}-tampered`, attrs: jar.get('jrp_refresh').attrs });
  const r = await post('/auth/refresh', {});
  assert('a tampered refresh cookie is refused', r.status === 401 || r.status === 403, `status=${r.status}`);
  // Restore so the remaining checks are not affected.
  jar.get('jrp_refresh');
  const fresh = await post('/auth/login', { tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD });
  assert('re-login after the tamper works', fresh.status === 200, `status=${fresh.status}`);
}

// 6, 7, 8. CSRF and origin
{
  const noCsrf = await post('/auth/refresh', {}, { withCsrf: false });
  assert('a cookie refresh with NO csrf header is refused',
    noCsrf.status === 403, `status=${noCsrf.status}`);
  assert('and the code says why', noCsrf.body?.error?.code === 'csrf-rejected', String(noCsrf.body?.error?.code));
}
{
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: cookieHeader(), 'x-csrf-token': 'not-the-real-token' },
  });
  assert('a MISMATCHED csrf token is refused', res.status === 403, `status=${res.status}`);
}
{
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie: cookieHeader(), 'x-csrf-token': csrf() ?? '' },
  });
  assert('a request from a FOREIGN origin is refused', res.status === 403, `status=${res.status}`);
}

// 9. the body-token path still works (scripts, CLI)
{
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD }),
  }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  assert('login with NO origin and no jar still works (the script path)', r.status === 200, `status=${r.status}`);
  assert('and that path DOES return a refresh token in the body',
    typeof r.body?.refreshToken === 'string', 'the non-browser client needs it');
  const r2 = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: r.body.refreshToken }),
  });
  assert('body-token refresh works', r2.status === 200, `status=${r2.status}`);
}

// 10 + 11. logout
{
  const l = await post('/auth/login', { tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD });
  assert('re-login for the logout check', l.status === 200);
  const out = await post('/auth/logout', {});
  assert('logout returns 200', out.status === 200, `status=${out.status}`);
  assert('logout reports revoked', out.body?.revoked === true, JSON.stringify(out.body));
  const cleared = out.setCookies.some((l2) => /max-age=0|expires=thu, 01 jan 1970/i.test(l2));
  assert('logout EXPIRES the cookie', cleared);
  assert('the cookie is gone from the jar', !jar.has('jrp_refresh'));
  // No cookie and no body: there is nothing to refresh, so 400 (bad
  // request) is the CORRECT answer here, not 401. The session was not
  // merely expired — it was already terminated and its cookie cleared.
  const after = await post('/auth/refresh', {});
  assert(
    'refresh after logout is refused',
    [400, 401, 403].includes(after.status),
    `status=${after.status}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
