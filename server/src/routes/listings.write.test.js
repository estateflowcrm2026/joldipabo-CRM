// Write-route tests for /api/v1/listings/*.
//
// Layered coverage:
//
//   1. Auth + RBAC + validation — pure HTTP, no DB needed.
//      Unauthenticated → 401; placeholder bearer → 403 (RBAC fires
//      before any data call); invalid payload → 400.
//
//   2. DB-integration happy path + scope checks — runs only when
//      DATABASE_URL is set AND the seeded fixture rows are present.
//      Each test asserts 200 with a body shape and audit/404 semantics
//      consistent with the documented contracts.
//
// The test reuses the dev-* bearer tokens defined in
// src/repositories/authRepository.js. Common scopes:
//
//   dev-super  → super-admin, all scope
//   dev-admin  → admin, all scope
//   dev-sales  → sales-manager, team scope (t_north)
//   dev-field  → field-executive, own scope (cannot delete)
//
// Cross-team existence hiding (404) is exercised by having dev-sales
// attempt to mutate a listing assigned to t_south.

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

test('POST /api/v1/listings without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/listings',
    payload: {},
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /api/v1/listings with placeholder auth reaches RBAC gate', async () => {
  // With DATABASE_URL set, the placeholder bearer resolves u-asha (a
  // field-executive with `listings.create = 'all'` in the seed matrix)
  // → 201 succeeds. Without DATABASE_URL the placeholder user has an
  // empty matrix → 403.
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/listings',
    headers: { authorization: bearer() },
    payload: {
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
      title: 'placeholder-create',
    },
  });
  if (dbConfigured) {
    assert.equal(res.statusCode, 201);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

test('POST /api/v1/listings (dev-super) with invalid serviceCategory returns 400', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/listings',
      headers: { authorization: 'Bearer dev-super' },
      payload: {
        serviceCategory: 'garage',
        propertyType: 'apartment',
        listingIntent: 'available_for_rent',
        title: 'Test',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid-enum');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('PATCH /api/v1/listings/:id without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/listings/l_anything',
    payload: { title: 'x' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PATCH /api/v1/listings/:id (dev-field) out-of-scope → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    // l_land_devanahalli_plot is assigned to u-vijay (field-executive t_south).
    // dev-field (u-asha, t_north) has own scope, so it's out of scope.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/listings/l_land_devanahalli_plot',
      headers: { authorization: 'Bearer dev-field' },
      payload: { title: 'hijacked' },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('DELETE /api/v1/listings/:id without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/listings/l_anything',
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE /api/v1/listings/:id (dev-field) without listings.delete → 403', async (t) => {
  // field-executive.listings.delete is `none` so the coarse RBAC fires
  // before any row-level check. This is the documented behaviour: a
  // field executive can never delete a listing, full stop.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('DELETE /api/v1/listings/:id (dev-sales) out-of-team → 404 (existence hidden)', async (t) => {
  // dev-sales (u-raj, sales-manager, t_north) has listings.delete='team'.
  // l_land_devanahalli_plot is assigned to u-vijay in t_south → out of
  // scope at the row level. The handler fails-closed with a 404 so the
  // existence of rows in other teams is not leaked.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/listings/l_land_devanahalli_plot',
      headers: { authorization: 'Bearer dev-sales' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not-found');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/listings/:id/verify with placeholder bearer → 403', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/listings/l_anything/verify',
    headers: { authorization: bearer() },
    payload: { status: 'verified' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// ---------------------------------------------------------------------------
// 2. DB-integration happy path
// ---------------------------------------------------------------------------

test('POST /api/v1/listings (dev-super) creates a rent listing → 201', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/listings',
      headers: { authorization: 'Bearer dev-super' },
      payload: {
        serviceCategory: 'rent',
        propertyType: 'apartment',
        listingIntent: 'available_for_rent',
        title: 'Smoke-create 2BHK',
        rentMonthly: 42000,
        city: 'Bangalore',
        locality: 'HSR Layout',
        bedrooms: 2,
        bathrooms: 2,
        furnished: 'semi',
        amenities: ['Parking', 'Gym'],
      },
    });
    const body = res.json();
    assert.equal(res.statusCode, 201);
    assert.ok(body.id, 'created listing has an id');
    assert.equal(body.serviceCategory, 'rent');
    assert.equal(body.title, 'Smoke-create 2BHK');
    assert.equal(body.pricing.rentMonthly, 42000);
    // Default assigned to caller (dev-super → u-super)
    assert.equal(body.assignedTo?.id, 'u-super');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('PATCH /api/v1/listings/:id (dev-super) updates title → 200', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk',
      headers: { authorization: 'Bearer dev-super' },
      payload: { title: 'Renamed by test', notes: 'unit test patch' },
    });
    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.title, 'Renamed by test');
    assert.equal(body.notes, 'unit test patch');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('PATCH /api/v1/listings/:id rejects tenant_id attempts with 400', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk',
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

test('POST /api/v1/listings/:id/assign to cross-tenant user → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/listings/l_rent_indiranagar_3bhk/assign',
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

test('POST /api/v1/listings/:id/verify (dev-super) sets verified → 200', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/listings/l_pg_koramangala_bed/verify',
      headers: { authorization: 'Bearer dev-super' },
      payload: { status: 'verified' },
    });
    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.status.verification, 'verified');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/listings/:id/verify rejected without reason → 400', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/listings/l_pg_koramangala_bed/verify',
      headers: { authorization: 'Bearer dev-super' },
      payload: { status: 'rejected' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'reason-required');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/listings/:id/photos adds a metadata row → 201', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/listings/l_pg_koramangala_bed/photos',
      headers: { authorization: 'Bearer dev-super' },
      payload: {
        objectKey: 'listings/l_pg_koramangala_bed/hall-1.jpg',
        caption: 'Common hall',
        category: 'Interior',
      },
    });
    const body = res.json();
    assert.equal(res.statusCode, 201);
    assert.ok(body.id);
    assert.equal(body.listingId, 'l_pg_koramangala_bed');
    assert.equal(body.category, 'Interior');
    assert.equal(body.approved, false);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('DELETE /api/v1/listings/:id (dev-super) soft-deletes → 200, then GET → 404', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  let createdId = null;
  try {
    const app = await newApp();
    // Create a sacrificial listing
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/listings',
      headers: { authorization: 'Bearer dev-super' },
      payload: {
        serviceCategory: 'rent',
        propertyType: 'apartment',
        listingIntent: 'available_for_rent',
        title: 'Will be deleted',
        rentMonthly: 30000,
      },
    });
    assert.equal(create.statusCode, 201);
    createdId = create.json().id;

    // Delete it
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/listings/${createdId}`,
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().ok, true);

    // GET now returns 404
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/listings/${createdId}`,
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(detail.statusCode, 404);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
