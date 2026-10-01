// Route-level tests for /api/v1/listings/*.
//
// Truth table (today's placeholder authMiddleware):
//   * no auth                       → 401
//   * placeholder bearer, no DB     → 403 (RBAC fires before DB)
//   * placeholder bearer, DB set    → 403 (placeholder matrix is empty)
//   * dev-* token, DEV_AUTH on      → loads user (DB or offline matrix)
//   * dev-* token, DEV_AUTH off     → 401 (treated as unknown token)
//
// The dev-* path is exercised in src/auth/authMiddleware.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { dbConfigured, skipIfNoDb } from '../test-support/requireDb.js';
import { issueAccessToken } from '../auth/tokenService.js';


function bearer(sub = 'u-asha', tid = 'org_acme') {
  const { token } = issueAccessToken({ sub, tid });
  return `Bearer ${token}`;
}

async function newApp() {
  return buildApp({ logLevel: 'silent' });
}

test('GET /api/v1/listings without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/listings' });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), {
    error: { code: 'unauthorized', message: 'Missing Authorization header.' },
  });
  await app.close();
});

test('GET /api/v1/listings/:id without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/listings/l_test' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/listings with placeholder auth reaches RBAC gate', async (t) => {
  // With DATABASE_URL set, the placeholder bearer resolves u-asha and
  // her matrix → 200 (own scope, listing rows exist). Without
  // DATABASE_URL the placeholder user has an empty matrix → 403.
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    assert.equal(res.statusCode, 200);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

test('GET /api/v1/listings/:id with placeholder auth reaches RBAC gate', async (t) => {
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings/l_rent_indiranagar_3bhk',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    assert.ok([200, 404].includes(res.statusCode),
      `expected 200 or 404, got ${res.statusCode}`);
  } else {
    assert.equal(res.statusCode, 403);
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// Dev shortcut integration — DEV_AUTH on, no DB, offline fallback on.
// Without DATABASE_URL, the data layer throws database-not-configured
// at query() time. The offline fallback only affects req.user — it does
// NOT conjure rows. The route still hits 503, but importantly it is
// gated by RBAC at the dev token (matrix non-empty) instead of 403.
// ---------------------------------------------------------------------------

test('GET /api/v1/listings with dev-super (no DB, fallback on) → 503 database-not-configured', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set');
    return;
  }
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'database-not-configured');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test('GET /api/v1/listings?serviceCategory=rent with dev-super (no DB) → 503', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set');
    return;
  }
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings?serviceCategory=rent&limit=5',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test('GET /api/v1/listings/:id with dev-super (no DB) → 503', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set');
    return;
  }
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test('GET /api/v1/listings with dev-field (no DB) → 503 (own scope, not 403)', async (t) => {
  // This is the test that proves dev-token RBAC reaches the data layer:
  // with placeholder auth, dev-field would 403 (matrix empty). With
  // dev-token + fallback, dev-field has listings:view=own, so RBAC
  // passes; the data layer then throws DB_NOT_CONFIGURED → 503.
  if (dbConfigured) {
    t.skip('DATABASE_URL is set');
    return;
  }
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test.after(async () => {
  await closeDb();
});
