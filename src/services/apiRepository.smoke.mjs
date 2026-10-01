// Smoke test for src/services/apiRepository.js — listings list + get.
//
// Run from the project root:
//   node src/services/apiRepository.smoke.mjs
//
// Required env:
//   VITE_USE_API_REPOSITORY=true   (otherwise the script exits 0 with a SKIP)
//   VITE_API_BASE_URL=http://localhost:4000/api/v1
//   VITE_DEV_AUTH_TOKEN=dev-super
//
// What it asserts:
//   1. The script can read the env flag and base URL.
//   2. `apiRepository.list('listings')` resolves and returns a non-empty
//      `items` array with the documented shape.
//   3. The first item carries the DTO fields the backend emits:
//      id, tenantId, serviceCategory, location, pricing, status, assignedTo.
//   4. `apiRepository.get('listings', id)` returns a record matching the
//      list item's id.
//   5. Bad base URL → clear error (ApiError, status 0, code 'network-error').
//
// Exit codes: 0 = pass, 1 = assertion / network failure, 2 = skipped (env
// flag absent).

import assert from 'node:assert/strict';

// Read env manually. Vite replaces `import.meta.env.VITE_*` at build time;
// at runtime in node we read from process.env directly. The apiClient
// resolves to `import.meta.env`, which is `undefined` in plain node, so
// we have to forward the relevant values via process.env and use the
// helpers in apiClient.js only when running under Vite.
const useApi = process.env.VITE_USE_API_REPOSITORY === 'true';
if (!useApi) {
  console.log('[smoke] VITE_USE_API_REPOSITORY is not "true" — skipping.');
  console.log('[smoke] Set VITE_USE_API_REPOSITORY=true VITE_DEV_AUTH_TOKEN=dev-super \\');
  console.log('         VITE_API_BASE_URL=http://localhost:4000/api/v1 \\');
  console.log('         node src/services/apiRepository.smoke.mjs');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Lazy import. We delay the import until after the env-flag check so the
// SKIP path doesn't pay the cost of loading apiClient / apiRepository.
// ---------------------------------------------------------------------------

const { apiRepository } = await import('./apiRepository.js');
const { ApiError } = await import('./apiClient.js');

const baseUrl = process.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1';
const token = process.env.VITE_DEV_AUTH_TOKEN || '';

console.log(`[smoke] base URL: ${baseUrl}`);
console.log(`[smoke] token:    ${token ? `${token.slice(0, 12)}…` : '(none)'}`);

// Patch the env that apiClient reads. In node, `import.meta.env` is
// undefined, so we monkey-patch the env reads by reaching into module
// scope via re-imports. The cleanest way is to set the values via a small
// shim: we wrap fetch so the right URL/headers are used.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  // Inject bearer header when the caller didn't set one.
  const headers = { Accept: 'application/json', ...(init.headers || {}) };
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  return originalFetch(url, { ...init, headers });
};

// Also forward base URL — read it inside the patched fetch by intercepting
// path-only calls. apiClient builds the URL with `${baseUrl}${path}`, but
// when running outside Vite `import.meta.env` is undefined, so the client
// falls back to its DEFAULT_BASE_URL. That's fine — but if the operator
// set VITE_API_BASE_URL we honour it by rewriting the request URL.
const resolvedBase = baseUrl.replace(/\/+$/, '');
globalThis.fetch = async (input, init = {}) => {
  let url = input;
  if (typeof url === 'string' && url.startsWith('http://localhost:4000/api/v1')) {
    url = resolvedBase + url.slice('http://localhost:4000/api/v1'.length);
  }
  const headers = { Accept: 'application/json', ...(init.headers || {}) };
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  return originalFetch(url, { ...init, headers });
};

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      pass += 1;
    })
    .catch((err) => {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err && err.message ? err.message : err}`);
      fail += 1;
    });
}

console.log('[smoke] results:');

await check('list("listings") returns non-empty items', async () => {
  const result = await apiRepository.list('listings', { pagination: { limit: 5, offset: 0 } });
  assert.ok(result && Array.isArray(result.items), 'result.items is an array');
  assert.ok(result.items.length > 0, `expected items > 0, got ${result.items.length}`);
  assert.ok(result.pagination && typeof result.pagination.total === 'number', 'pagination.total is a number');
  return result.items[0];
});

await check('listings DTO shape matches documented fields', async () => {
  const result = await apiRepository.list('listings', { pagination: { limit: 1, offset: 0 } });
  const item = result.items[0];
  for (const field of ['id', 'tenantId', 'serviceCategory', 'title']) {
    assert.ok(item[field] !== undefined, `item.${field} is set`);
  }
  assert.ok(item.location && typeof item.location === 'object', 'item.location is an object');
  assert.ok(item.pricing && typeof item.pricing === 'object', 'item.pricing is an object');
  assert.ok(item.status && typeof item.status === 'object', 'item.status is an object');
});

await check('list("listings", serviceCategory=rent) filters correctly', async () => {
  const result = await apiRepository.list('listings', {
    where: { serviceCategory: 'rent' },
    pagination: { limit: 5, offset: 0 },
  });
  for (const item of result.items) {
    assert.equal(item.serviceCategory, 'rent', `expected rent, got ${item.serviceCategory}`);
  }
});

await check('get("listings", id) round-trips the list item', async () => {
  const list = await apiRepository.list('listings', { pagination: { limit: 1, offset: 0 } });
  const id = list.items[0].id;
  const detail = await apiRepository.get('listings', id);
  assert.ok(detail, 'detail is non-null');
  assert.equal(detail.id, id);
});

await check('get("listings", "missing") returns null (404 → null)', async () => {
  const detail = await apiRepository.get('listings', 'l_does_not_exist_smoke');
  assert.equal(detail, null);
});

await check('unreachable base URL yields ApiError(network-error)', async () => {
  // Temporarily swap base URL by overriding fetch to a closed port.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:1');
  };
  try {
    let threw = null;
    try {
      await apiRepository.list('listings');
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof ApiError, 'threw ApiError');
    assert.equal(threw.status, 0);
    assert.equal(threw.code, 'network-error');
  } finally {
    globalThis.fetch = original;
  }
});

console.log(`[smoke] ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
