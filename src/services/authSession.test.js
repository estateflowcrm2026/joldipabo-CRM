// Sign-in state machine tests.
//
// Run with: `npm test` (root) or `node src/services/authSession.test.js`
//
// The behaviour worth pinning is the BRANCHING, not the network: a
// correct password that returns a challenge instead of tokens, a refresh
// token spent exactly once, a sign-out that clears locally even when the
// server call fails. All of that is decided by what a response looks
// like, so a stubbed `fetch` tests the real decision code without a
// server, a database, or a timing dependency.
//
// The live half is `server/scripts/verify-auth-flow.js`, which exercises
// the same paths against a running backend and a real Postgres. Both
// matter: this file runs on every `npm test`, that one needs a database.

import {
  signIn,
  completeMfa,
  refreshSession,
  ensureFreshToken,
  isAboutToExpire,
  signOut,
  isSignedIn,
  getSession,
  getCurrentUser,
  subscribeToSession,
  resetSessionForTests,
} from './authSession.js';

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const USER = {
  id: 'u-1', tenantId: 'org_acme', name: 'Test Plain',
  email: 'mfa-off@acme.example', role: 'field-executive',
  permissionMatrix: { listings: { view: 'own' } },
};
const MFA_USER = { ...USER, id: 'u-2', email: 'mfa-on@acme.example' };

// ---------------------------------------------------------------------------
// A stubbed fetch, replaying recorded responses
// ---------------------------------------------------------------------------
let stubs = new Map();
let calls = [];

function stubFetch(map) {
  stubs = new Map(Object.entries(map));
  calls = [];
}

function jsonResponse(status, body) {
  const text = body === null ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText: 'stub', text: async () => text };
}

// A minimal in-process Storage, so the "no token in storage" scan below
// is a REAL check rather than one skipped because node has no
// localStorage — which would make the most important assertion here
// vacuous.
class FakeStorage {
  constructor() { this._m = new Map(); }
  get length() { return this._m.size; }
  key(i) { return [...this._m.keys()][i] ?? null; }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
}

// Pre-seeded with unrelated app data, so the scan has something to walk
// past and cannot pass by finding an empty store.
globalThis.localStorage = new FakeStorage();
globalThis.sessionStorage = new FakeStorage();
globalThis.localStorage.setItem('joldipabo:viewMode', 'desktop');
globalThis.sessionStorage.setItem('joldipabo:draft', 'an-unsaved-note');

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = (init.method || 'GET').toUpperCase();
  const key = `${method} ${path.split('?')[0]}`;
  calls.push({
    key,
    body: init.body ? JSON.parse(init.body) : undefined,
    credentials: init.credentials,
    headers: init.headers || {},
  });

  const entry = stubs.get(key);
  if (!entry) return jsonResponse(404, { error: { code: 'not-stubbed', message: `no stub for ${key}` } });
  if (entry.networkError) throw new TypeError('Failed to fetch');
  return jsonResponse(entry.status, entry.body);
};

/** Serialise a web store, for asserting nothing sensitive reached it. */
const storageDump = (name) => {
  const store = globalThis[name];
  if (!store) return [];
  const out = [];
  for (let i = 0; i < store.length; i += 1) out.push([store.key(i), store.getItem(store.key(i))]);
  return out;
};

const countCalls = (key) => calls.filter((c) => c.key === key).length;
const lastCall = (key) => calls.filter((c) => c.key === key).at(-1);

// A stubbed `document.cookie` carrying the CSRF pair, so the CSRF-echo
// assertions below exercise the real `readCsrfToken()` path instead of
// the no-document early return.
function stubCsrfCookie(token = 'csrf-abc-123') {
  globalThis.document = { cookie: `jrp_csrf=${encodeURIComponent(token)}` };
}
function clearDocumentStub() {
  delete globalThis.document;
}

function reset() {
  resetSessionForTests();
  calls = [];
}

const LOGIN_OK = {
  status: 200,
  body: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 900, sessionId: 'rs-1', user: USER },
};

// ---------------------------------------------------------------------------
// 1. Sign-in
// ---------------------------------------------------------------------------

console.log('\nsign-in: the plain path');
{
  reset();
  stubFetch({ 'POST /api/v1/auth/login': LOGIN_OK });

  const result = await signIn({ email: USER.email, password: 'x' });
  assert('a plain sign-in reports authenticated', result.status === 'authenticated');
  assert('the session is adopted', isSignedIn() === true);
  assert('the user comes from the RESPONSE', getCurrentUser()?.email === USER.email);
  assert('the role comes from the response too', getCurrentUser()?.role === 'field-executive');
  assert('the caller supplies only credentials', calls[0].body.email === USER.email);
  assert('and cannot supply an identity', calls[0].body.user === undefined);
}

console.log('\nsign-in: the MFA path issues nothing on the first factor');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': {
      status: 200,
      body: { mfaRequired: true, mfaReason: 'enabled', challengeToken: 'challenge-1', expiresIn: 300 },
    },
  });

  const result = await signIn({ email: MFA_USER.email, password: 'x' });
  assert('a challenge is returned', result.status === 'mfa-required');
  assert('the challenge token is passed through', result.challengeToken === 'challenge-1');
  assert('the reason is "enabled"', result.reason === 'enabled');
  assert('NO session exists', isSignedIn() === false, 'a correct password alone must not sign anyone in');
  assert('there is no user', getCurrentUser() === null);
}

console.log('\nsign-in: failures are distinguishable');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': {
      status: 401,
      body: { error: { code: 'invalid-credentials', message: 'Invalid email or password.' } },
    },
  });
  const rejected = await signIn({ email: USER.email, password: 'wrong' });
  assert('a wrong password is an error', rejected.status === 'error');
  assert('the backend code is surfaced', rejected.code === 'invalid-credentials');
  assert('and no session is created', isSignedIn() === false);
}
{
  reset();
  stubFetch({ 'POST /api/v1/auth/login': { networkError: true } });
  const offline = await signIn({ email: USER.email, password: 'x' });
  assert('a network failure has its own code', offline.code === 'network-error', offline.code);
  assert('so the UI can say "offline", not "wrong password"', offline.status === 'error');
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': {
      status: 200,
      body: { mfaRequired: true, mfaReason: 'required', challengeToken: 'c-2' },
    },
  });
  const unenrolled = await signIn({ email: 'admin@acme.example', password: 'x' });
  assert('an unenrolled admin reports "required"', unenrolled.reason === 'required');
  assert('and still gets no session', isSignedIn() === false);
}

// ---------------------------------------------------------------------------
// 2. MFA completion
// ---------------------------------------------------------------------------

console.log('\nMFA: completion and failure');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/mfa/challenge': {
      status: 200,
      body: { accessToken: 'a2', expiresIn: 900, user: MFA_USER },
    },
  });
  const done = await completeMfa({ challengeToken: 'c', code: '123456' });
  assert('a correct code issues the session', done.status === 'authenticated');
  assert('with the right identity', getCurrentUser()?.email === MFA_USER.email);
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/mfa/challenge': {
      status: 401,
      body: { error: { code: 'mfa-invalid-code', message: 'That code is not valid.' } },
    },
  });
  const bad = await completeMfa({ challengeToken: 'c', code: '000000' });
  assert('a wrong code is an error', bad.status === 'error');
  assert('with mfa-invalid-code', bad.code === 'mfa-invalid-code');
  assert('and no session', isSignedIn() === false);
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/mfa/challenge': {
      status: 429,
      body: { error: { code: 'mfa-attempts-exhausted', message: 'Too many incorrect codes. Sign in again.' } },
    },
  });
  const spent = await completeMfa({ challengeToken: 'c', code: '000000' });
  assert(
    'an exhausted challenge is distinguishable, so the UI can send them back',
    spent.code === 'mfa-attempts-exhausted',
    spent.code,
  );
}

// ---------------------------------------------------------------------------
// 3. Refresh
// ---------------------------------------------------------------------------

console.log('\nrefresh: rotation, single use, and giving up');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/refresh': {
      status: 200,
      body: { accessToken: 'a2', expiresIn: 900, user: USER },
    },
  });
  await signIn({ email: USER.email, password: 'x' });
  assert('refresh succeeds', (await refreshSession()) === true);
  assert('the access token rotated', getSession().accessToken === 'a2');
  assert(
    'the rotated refresh token stays in the cookie, not in memory',
    !('refreshToken' in (getSession() ?? {})),
  );
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/refresh': {
      status: 200,
      body: { accessToken: 'a2', expiresIn: 900, user: USER },
    },
  });
  await signIn({ email: USER.email, password: 'x' });
  await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
  assert(
    'three concurrent refreshes send ONE request',
    countCalls('POST /api/v1/auth/refresh') === 1,
    `${countCalls('POST /api/v1/auth/refresh')} sent`,
  );
  assert(
    'and concurrent refreshes did not race the single-use token',
    getSession()?.accessToken === 'a2',
  );
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/refresh': {
      status: 401,
      body: { error: { code: 'invalid-refresh-token', message: 'Session is no longer valid.' } },
    },
  });
  await signIn({ email: USER.email, password: 'x' });
  assert('a dead refresh reports failure', (await refreshSession()) === false);
  assert('and signs the user out rather than looping', isSignedIn() === false);
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/refresh': {
      status: 200,
      body: { accessToken: 'a2', expiresIn: 900, user: USER },
    },
  });
  await signIn({ email: USER.email, password: 'x' });
  assert('a fresh token is outside the refresh margin', isAboutToExpire() === false);
  assert('ensureFreshToken is a no-op then', (await ensureFreshToken()) === true);
  assert('and sends no refresh', countCalls('POST /api/v1/auth/refresh') === 0);
}

// ---------------------------------------------------------------------------
// 4. Sign-out
// ---------------------------------------------------------------------------

console.log('\nsign-out: revoke, and clear locally regardless');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/logout': { status: 200, body: { revoked: true } },
  });
  await signIn({ email: USER.email, password: 'x' });
  const out = await signOut();
  assert('the server is told to revoke', out.revoked === true);
  assert('the local session is gone', isSignedIn() === false);
  assert('and the user with it', getCurrentUser() === null);
}
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/logout': { networkError: true },
  });
  await signIn({ email: USER.email, password: 'x' });
  const out = await signOut();
  assert('an unreachable server is reported honestly', out.revoked === false);
  assert(
    'but the local session is cleared anyway',
    isSignedIn() === false,
    'being offline must not strand someone in a signed-in UI',
  );
}
{
  reset();
  const out = await signOut();
  assert('signing out with no session is a no-op', out.revoked === false && isSignedIn() === false);
}

// ---------------------------------------------------------------------------
// 4b. Cookie mode on the wire: credentials + CSRF header
// ---------------------------------------------------------------------------

console.log('\ncookie mode: session endpoints send the cookie cross-site');
{
  reset();
  stubCsrfCookie('csrf-abc-123');
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/mfa/challenge': {
      status: 200,
      body: { accessToken: 'a2', expiresIn: 900, user: MFA_USER },
    },
    'POST /api/v1/auth/refresh': {
      status: 200,
      body: { accessToken: 'a3', expiresIn: 900, user: USER },
    },
    'POST /api/v1/auth/logout': { status: 200, body: { revoked: true } },
  });

  await signIn({ email: USER.email, password: 'x' });
  assert(
    'login sends credentials: include so Set-Cookie is accepted',
    lastCall('POST /api/v1/auth/login')?.credentials === 'include',
    String(lastCall('POST /api/v1/auth/login')?.credentials),
  );

  const mfa = await completeMfa({ challengeToken: 'c', code: '123456' });
  assert('mfa challenge authenticates', mfa.status === 'authenticated');
  assert(
    'mfa challenge sends credentials: include',
    lastCall('POST /api/v1/auth/mfa/challenge')?.credentials === 'include',
    String(lastCall('POST /api/v1/auth/mfa/challenge')?.credentials),
  );

  assert('refresh succeeds', (await refreshSession()) === true);
  const refreshCall = lastCall('POST /api/v1/auth/refresh');
  assert(
    'refresh sends credentials: include so the cookie is attached',
    refreshCall?.credentials === 'include',
    String(refreshCall?.credentials),
  );
  assert(
    'refresh echoes the CSRF cookie as a header',
    refreshCall?.headers?.['x-csrf-token'] === 'csrf-abc-123',
    JSON.stringify(refreshCall?.headers),
  );

  const out = await signOut();
  assert('logout revokes', out.revoked === true);
  const logoutCall = lastCall('POST /api/v1/auth/logout');
  assert(
    'logout sends credentials: include so the server can clear the pair',
    logoutCall?.credentials === 'include',
    String(logoutCall?.credentials),
  );

  clearDocumentStub();
}

// ---------------------------------------------------------------------------
// 5. The guarantee the design rests on
// ---------------------------------------------------------------------------

console.log('\ntokens: in memory, never in storage');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': {
      status: 200,
      body: {
        accessToken: 'SECRET-ACCESS',
        expiresIn: 900, user: USER,
      },
    },
  });
  await signIn({ email: USER.email, password: 'x' });

  assert('the access token really is held in memory', getSession()?.accessToken === 'SECRET-ACCESS');
  // The whole point of 9B: there is no refresh token for this module to
  // lose on a reload, because the HttpOnly cookie carries it.
  assert(
    'no refreshToken is held in the session',
    !('refreshToken' in (getSession() ?? {})),
    Object.keys(getSession() ?? {}).join(','),
  );
  assert('NO refresh token reached localStorage', !/SECRET-REFRESH/.test(JSON.stringify(storageDump('localStorage'))));

  for (const [name, store] of [
    ['localStorage', globalThis.localStorage],
    ['sessionStorage', globalThis.sessionStorage],
  ]) {
    assert(`${name} is available so the scan is real`, Boolean(store));
    let leaked = false;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      const value = store.getItem(key) ?? '';
      if (value.includes('SECRET-ACCESS') || value.includes('SECRET-REFRESH')) leaked = true;
      if (/token/i.test(key)) leaked = true;
    }
    assert(`no token reached ${name}`, !leaked);
    assert(`${name} still holds its unrelated data`, store.length === 1, `${store.length} keys`);
  }
}
{
  reset();
  assert('a reload starts signed out', getSession() === null && isSignedIn() === false);
}

console.log('\nsubscribers see every transition');
{
  reset();
  stubFetch({
    'POST /api/v1/auth/login': LOGIN_OK,
    'POST /api/v1/auth/logout': { status: 200, body: { revoked: true } },
  });
  const seen = [];
  const off = subscribeToSession((s) => seen.push(s ? 'in' : 'out'));
  await signIn({ email: USER.email, password: 'x' });
  await signOut();
  off();
  assert('sign-in and sign-out are both announced', seen.join(',') === 'in,out', seen.join(','));
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
