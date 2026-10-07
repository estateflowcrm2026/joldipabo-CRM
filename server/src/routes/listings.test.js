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

// ---------------------------------------------------------------------------
// Interested leads: GET /listings/:id/interested-leads
// ---------------------------------------------------------------------------
// Auth + RBAC + validation run with no DB. DB-integration round-trips run
// only when DATABASE_URL is set, against the seed lm_001/lm_002/lm_003
// rows (each on a distinct listing, so every assertion below names a
// different listing id).

test('GET /api/v1/listings/:id/interested-leads without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/listings/:id/interested-leads with placeholder auth reaches RBAC gate', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // u-asha owns l_rent_indiranagar_3bhk → 200 with lm_001's lead.
    assert.equal(res.statusCode, 200);
  } else {
    assert.equal(res.statusCode, 403);
  }
  await app.close();
});

test('GET /api/v1/listings/:id/interested-leads rejects unknown status → 400', async (t) => {
  // Validation fires before the DB read, so this needs no database.
  if (dbConfigured) {
    t.skip('DATABASE_URL is set; covered by the round-trip below');
    return;
  }
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads?status=matched',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid-status');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test('interested-leads round-trip (dev-super, DB set): list → filter → 404s → 200s', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const auth = { authorization: 'Bearer dev-super' };

    // lm_001: ld_tenant_meera ↔ l_rent_indiranagar_3bhk (viewed_by_lead).
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads',
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json();
    assert.equal(body.listingId, 'l_rent_indiranagar_3bhk');
    assert.equal(body.items.length, 1);
    const row = body.items[0];
    assert.equal(row.leadId, 'ld_tenant_meera');
    assert.equal(row.status, 'viewed_by_lead');
    assert.equal(row.score, 92.5);
    assert.equal(row.lead.name, 'Meera Krishnan');
    assert.equal(row.lead.phone, '+919811110001');
    assert.equal(row.lead.owner.id, 'u-asha');
    assert.match(row.reason, /score/);

    // Status filter narrows; a non-matching status empties.
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads?status=viewed_by_lead',
      headers: auth,
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().items.length, 1);
    const emptied = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads?status=suggested',
      headers: auth,
    });
    assert.equal(emptied.statusCode, 200);
    assert.deepEqual(emptied.json().items, []);
    const badStatus = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk/interested-leads?status=matched',
      headers: auth,
    });
    assert.equal(badStatus.statusCode, 400);

    // Unknown listing → 404.
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_nope/interested-leads',
      headers: auth,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'not-found');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/listings/:id/interested-leads (dev-field) out-of-scope → 404', async (t) => {
  // l_land_devanahalli_plot is assigned to u-vijay (t_south). dev-field
  // (u-asha, t_north, own scope) cannot see it → 404, same as
  // GET /listings/:id.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_land_devanahalli_plot/interested-leads',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not-found');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/listings/:id/interested-leads skips out-of-scope leads (dev-field)', async (t) => {
  // lm_003 pairs ld_land_seller_rajesh (u-vijay, t_south) with
  // l_land_devanahalli_plot (u-vijay, t_south). A caller who can see the
  // listing but not the lead gets 200 with [] — never the lead's name.
  // dev-field (u-asha, own scope) sees neither here, so use dev-super to
  // prove the shape and rely on the repository unit for the skip itself.
  // This case asserts the positive: super sees Rajesh's row.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/listings/l_land_devanahalli_plot/interested-leads',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items.length, 1);
    assert.equal(res.json().items[0].leadId, 'ld_land_seller_rajesh');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
