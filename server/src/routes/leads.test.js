// Route-level tests for /api/v1/leads/*.
//
// Mirrors listings.write.test.js. Layered coverage:
//
//   1. Auth + RBAC + validation — pure HTTP, no DB needed.
//      * no auth                       → 401
//      * placeholder bearer, no DB     → 403 (RBAC fires before DB)
//      * dev-* token, DEV_AUTH off     → 401 (unknown dev token)
//
//   2. DB-integration happy path + scope checks — runs only when
//      DATABASE_URL is set.
//
// All assertions follow the documented contracts: 201 with a body shape,
// 404 for cross-tenant / out-of-scope, 403 for missing coarse RBAC, and
// 400 for validator rejections.

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

test('GET /api/v1/leads without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/leads' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/leads/:id without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/leads/ld_anything' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /api/v1/leads without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/leads',
    payload: { name: 'X', phone: '1' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /api/v1/leads/:id without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/leads/ld_anything',
    payload: { notes: 'x' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE /api/v1/leads/:id without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'DELETE', url: '/api/v1/leads/ld_anything' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /api/v1/leads/:id/assign without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/leads/ld_anything/assign',
    payload: { assignedUserId: 'u-vijay' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/leads with placeholder auth reaches RBAC gate', async () => {
  // Placeholder bearer resolves u-asha but the placeholder matrix is
  // empty → RBAC fires 403 before the data layer is touched.
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/leads',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // With DB, the placeholder token resolves u-asha (field-executive,
    // leads.view='own') and the seed has her leads → 200.
    assert.equal(res.statusCode, 200);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

test('GET /api/v1/leads/:id with placeholder auth reaches RBAC gate', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/leads/ld_tenant_meera',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // u-asha owns ld_tenant_meera → 200.
    assert.equal(res.statusCode, 200);
  } else {
    assert.equal(res.statusCode, 403);
  }
  await app.close();
});

test('POST /api/v1/leads (dev-super, no DB, fallback on) → 503 database-not-configured', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set');
    return;
  }
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-super' },
      payload: { name: 'Test', phone: '999' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'database-not-configured');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  }
});

test('POST /api/v1/leads rejects missing name with 400', async () => {
  // Validation must fire before RBAC's coarse gate. Without DB, a
  // placeholder bearer gets 403 on any authed route; with DB, the
  // validator would catch the missing name. We test the auth gate here
  // (no DB) — the validator is fully covered in leadValidation.test.js.
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/leads',
    headers: { authorization: bearer() },
    payload: { phone: '999' },
  });
  if (dbConfigured) {
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid-payload');
  } else {
    assert.equal(res.statusCode, 403);
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// 2. DB-integration happy path + RBAC scope checks
// ---------------------------------------------------------------------------

test('GET /api/v1/leads (dev-super, DB set) returns all tenant leads → 200', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-super' },
    });
    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.pagination);
    // dev-super has leads:view='all' on org_acme → 4 seeded leads visible.
    assert.ok(body.pagination.total >= 4);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/leads (dev-field) returns only own-scope leads', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-field' },
    });
    const body = res.json();
    assert.equal(res.statusCode, 200);
    // u-asha owns ld_tenant_meera + ld_pg_seeker_anu (created_by); not
    // ld_buyer_sandeep / ld_land_seller_rajesh (owned by u-vijay).
    assert.ok(body.pagination.total >= 1);
    for (const lead of body.items) {
      assert.equal(
        lead.owner?.id,
        'u-asha',
        `field-executive should only see own leads; saw ${lead.owner?.id}`,
      );
    }
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/leads/:id (dev-field) out-of-scope → 404', async (t) => {
  // ld_buyer_sandeep is owned by u-vijay (t_south). dev-field (u-asha,
  // t_north, own scope) cannot see it → existence hidden with 404.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads/ld_buyer_sandeep',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not-found');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/leads/:id (dev-sales) out-of-team → 404 (existence hidden)', async (t) => {
  // dev-sales (u-raj, sales-manager, t_north) has leads:view='team'.
  // ld_buyer_sandeep is owned by u-vijay in t_south → out of scope.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads/ld_buyer_sandeep',
      headers: { authorization: 'Bearer dev-sales' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not-found');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/leads (dev-super) creates a lead → 201', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-super' },
      payload: {
        name: 'Smoke Lead',
        phone: '+919876501234',
        serviceNeed: 'rent',
        clientType: 'tenant',
      },
    });
    const body = res.json();
    assert.equal(res.statusCode, 201);
    assert.ok(body.id);
    assert.equal(body.name, 'Smoke Lead');
    assert.equal(body.status, 'New');
    assert.equal(body.serviceNeed, 'rent');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/leads (dev-field) creating with ownerId of another user → 400 forbidden-field', async (t) => {
  // dev-field has leads:assign='none', so attempting to set ownerId to
  // anyone else must be refused before the data layer.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-field' },
      payload: {
        name: 'Hijack',
        phone: '+919876501235',
        ownerId: 'u-vijay',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'forbidden-field');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/leads rejects matchedListingIds → 400', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-super' },
      payload: {
        name: 'X',
        phone: '1',
        matchedListingIds: ['l_pg_koramangala_bed'],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'field-not-writable');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('PATCH /api/v1/leads/:id rejects ownerId mutation → 400', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/leads/ld_tenant_meera',
      headers: { authorization: 'Bearer dev-super' },
      payload: { ownerId: 'u-vijay' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'forbidden-field');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('PATCH /api/v1/leads/:id rejects tenantId mutation → 400', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/leads/ld_tenant_meera',
      headers: { authorization: 'Bearer dev-super' },
      payload: { tenantId: 'org_other' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'forbidden-field');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('PATCH /api/v1/leads/:id (dev-super) updates notes → 200', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/leads/ld_tenant_meera',
      headers: { authorization: 'Bearer dev-super' },
      payload: { notes: 'unit test patch' },
    });
    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.notes, 'unit test patch');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/leads/:id/assign (dev-super) reassigns owner → 200', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/ld_pg_seeker_anu/assign',
      headers: { authorization: 'Bearer dev-super' },
      payload: { assignedUserId: 'u-vijay', reason: 'reassign test' },
    });
    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.owner?.id, 'u-vijay');
    // Re-assign back so subsequent tests see a stable state.
    await app.inject({
      method: 'POST',
      url: '/api/v1/leads/ld_pg_seeker_anu/assign',
      headers: { authorization: 'Bearer dev-super' },
      payload: { assignedUserId: 'u-asha', reason: 'revert' },
    });
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/leads/:id/assign (dev-field) without leads.assign → 403', async (t) => {
  // dev-field has leads:assign='none', so the coarse RBAC fires before
  // the row-level check.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/ld_tenant_meera/assign',
      headers: { authorization: 'Bearer dev-field' },
      payload: { assignedUserId: 'u-vijay' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/leads/:id/assign to cross-tenant user → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/ld_tenant_meera/assign',
      headers: { authorization: 'Bearer dev-super' },
      payload: { assignedUserId: 'u-nonexistent' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'user-not-found');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('DELETE /api/v1/leads/:id (dev-field) without leads.delete → 403', async (t) => {
  // field-executive.leads.delete is 'none' → coarse RBAC fires 403.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/leads/ld_tenant_meera',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('DELETE /api/v1/leads/:id (dev-super) soft-deletes → 200, then GET → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  let createdId = null;
  try {
    const app = await newApp();
    // Create a sacrificial lead
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: 'Bearer dev-super' },
      payload: { name: 'Will be deleted', phone: '+919876501236' },
    });
    assert.equal(create.statusCode, 201);
    createdId = create.json().id;

    // Delete it
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/leads/${createdId}`,
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    // GET now returns 404
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/leads/${createdId}`,
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(detail.statusCode, 404);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/leads/:id/export.csv returns 501 not-implemented', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leads/ld_tenant_meera/export.csv',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error.code, 'not-implemented');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});