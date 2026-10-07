// apiClient credentials-mode tests.
//
// Run with: `npm test` (root) or `node src/services/apiClient.test.mjs`
//
// What this pins: the cross-site default. When the configured API origin
// differs from the page origin (Vercel frontend + Render backend), plain
// `apiRequest` calls default to `credentials: 'include'` so the HttpOnly
// session cookie is attached and `Set-Cookie` on login is accepted. When
// same-origin, the default stays `'same-origin'`. An explicit
// `options.credentials` always wins, and Bearer handling is untouched.

import assert from 'node:assert/strict';

import {
  apiRequest,
  ApiError,
  getAuthToken,
  setAuthToken,
  clearAuthToken,
  defaultCredentials,
} from './apiClient.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;

const seen = [];
function stubFetch() {
  seen.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ ok: true }),
    };
  };
}

function setPageOrigin(origin) {
  globalThis.window = { location: new URL(origin) };
}

function restore() {
  globalThis.fetch = realFetch;
  if (realWindow === undefined) delete globalThis.window;
  else globalThis.window = realWindow;
  clearAuthToken();
}

// ---------------------------------------------------------------------------
// 1. defaultCredentials unit behavior (no network)
// ---------------------------------------------------------------------------

console.log('\ndefaultCredentials follows the page/API origin split');
{
  delete globalThis.window;
  check('no window (node) stays same-origin', defaultCredentials('http://localhost:4000/api/v1') === 'same-origin');

  setPageOrigin('https://crm-live-pilot.vercel.app/');
  check(
    'cross-origin API defaults to include',
    defaultCredentials('https://crm-api.onrender.com/api/v1') === 'include',
  );
  check(
    'localhost API from a Vercel page is cross-origin',
    defaultCredentials('http://localhost:4000/api/v1') === 'include',
  );
  check(
    'garbage base URL fails closed to same-origin',
    defaultCredentials('http://exa mple.com:bad-port/api') === 'same-origin',
    defaultCredentials('http://exa mple.com:bad-port/api'),
  );

  setPageOrigin('http://localhost:4000/app');
  check(
    'same-origin API stays same-origin',
    defaultCredentials('http://localhost:4000/api/v1') === 'same-origin',
  );
}

// ---------------------------------------------------------------------------
// 2. apiRequest default credentials on the wire
// ---------------------------------------------------------------------------

console.log('\napiRequest sends the right credentials mode by default');
{
  stubFetch();
  setPageOrigin('https://crm-live-pilot.vercel.app/');

  await apiRequest('/listings');
  check(
    'cross-origin data request defaults to include',
    seen.at(-1).init.credentials === 'include',
    String(seen.at(-1).init.credentials),
  );
  check(
    'no token means no Authorization header',
    !('Authorization' in (seen.at(-1).init.headers || {})),
  );

  setAuthToken('access-123');
  await apiRequest('/listings');
  check(
    'Bearer header still sent cross-origin',
    seen.at(-1).init.headers?.Authorization === 'Bearer access-123',
  );
  check(
    'cookie mode and Bearer coexist',
    seen.at(-1).init.credentials === 'include',
  );
  clearAuthToken();

  await apiRequest('/listings', { credentials: 'omit' });
  check('explicit credentials wins over the default', seen.at(-1).init.credentials === 'omit');
}

console.log('\napiRequest same-origin behavior is unchanged');
{
  stubFetch();
  setPageOrigin('http://localhost:4000/app');

  await apiRequest('/listings');
  check('same-origin defaults to same-origin', seen.at(-1).init.credentials === 'same-origin');

  delete globalThis.window;
  await apiRequest('/listings');
  check('no window defaults to same-origin', seen.at(-1).init.credentials === 'same-origin');
}

// ---------------------------------------------------------------------------
// 3. Token state and error shape are untouched
// ---------------------------------------------------------------------------

console.log('\nuntouched behavior still holds');
{
  stubFetch();
  check('token starts null without env fallback', getAuthToken() === null);
  setAuthToken('  t-1  ');
  check('setAuthToken trims', getAuthToken() === 't-1');
  setAuthToken('');
  check('empty string clears', getAuthToken() === null);

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { code: 'unauthorized', message: 'Missing.' } }),
  });
  try {
    await apiRequest('/listings');
    check('non-2xx throws', false);
  } catch (err) {
    check('non-2xx throws ApiError', err instanceof ApiError && err.code === 'unauthorized');
  }
}

restore();

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
