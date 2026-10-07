// Route-level tests for /api/v1/visits.
//
// Mirrors leads.test.js. Layered coverage:
//
//   1. Auth + RBAC + validation — pure HTTP, no DB needed.
//      * no auth                       → 401
//      * placeholder bearer, no DB     → 403 (RBAC fires before DB)
//      * unknown list filter key       → 400 (validator fires before DB)
//      * invalid order value           → 400
//
//   2. DB-integration tracking filters — runs only when DATABASE_URL is
//      set. Uses seeded visits (visit_… rows), read-only: no writes,
//      no cleanup needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { issueAccessToken } from '../auth/tokenService.js';
import { dbConfigured, skipIfNoDb } from '../test-support/requireDb.js';

function bearer(sub = 'u-asha', tid = 'org_acme') {
  const { token } = issueAccessToken({ sub, tid });
  return `Bearer ${token}`;
}

async function newApp() {
  return buildApp({ logLevel: 'silent' });
}

// ---------------------------------------------------------------------------
// 1. Auth + RBAC + validation (no DB required)
// ---------------------------------------------------------------------------

test('GET /api/v1/visits without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/visits' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/visits with placeholder auth reaches RBAC gate', async () => {
  // Placeholder bearer resolves u-asha but the placeholder matrix is
  // empty → RBAC fires 403 before the data layer is touched.
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/visits',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // With DB, the placeholder token resolves u-asha (field-executive,
    // visits.view='own') → 200 with her assigned visits.
    assert.equal(res.statusCode, 200);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

test('GET /api/v1/visits rejects an unknown filter key with 400', async () => {
  // Validation fires after auth+RBAC but before the DB, so dev auth with
  // the offline fallback is enough to prove the 400 — no DB required.
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/visits?bogus=1',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'forbidden-field');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test('GET /api/v1/visits rejects an invalid order with 400', async () => {
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/visits?order=random',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid-payload');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

// ---------------------------------------------------------------------------
// 2. DB-integration tracking filters (read-only over seeded visits)
// ---------------------------------------------------------------------------

test('GET /api/v1/visits (dev-super, DB set) supports tracking filters → 200', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const base = await app.inject({
      method: 'GET',
      url: '/api/v1/visits?limit=5',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(base.statusCode, 200);
    assert.ok(Array.isArray(base.json().items));

    // Narrow window around "now" — must be a subset, still 200-shaped.
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 86400000).toISOString();
    const to = new Date(now.getTime() + 30 * 86400000).toISOString();
    const windowed = await app.inject({
      method: 'GET',
      url: `/api/v1/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&order=asc&limit=5`,
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(windowed.statusCode, 200);
    const body = windowed.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(body.pagination.total <= base.json().pagination.total);
    for (let i = 1; i < body.items.length; i += 1) {
      assert.ok(
        body.items[i].scheduledAt >= body.items[i - 1].scheduledAt,
        'order=asc must return oldest-first',
      );
    }
    // Every list item carries the manager-board columns.
    for (const item of body.items) {
      assert.ok(item.id && item.status && item.scheduledAt);
      assert.ok(typeof item.viewingCount === 'number');
      assert.ok('updatedAt' in item);
    }
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/visits (dev-field, DB set) stays own-scoped with filters → 200', async (t) => {
  // u-asha (field-executive, visits.view='own') sees only her assigned
  // visits even when passing another executive's id as assignedTo.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/visits?assignedTo=u-vijay',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items.length, 0);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
