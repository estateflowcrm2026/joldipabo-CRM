// Route-level tests for GET /api/v1/users (staff directory).
//
// Layered coverage:
//
//   1. Auth + RBAC + validation — pure HTTP, no DB needed.
//      * no auth                       → 401
//      * placeholder bearer, no DB     → 403 (RBAC fires before DB)
//      * unknown role value            → 400 invalid-enum (validator fires
//                                        before the data layer, via dev auth
//                                        + offline fallback)
//      * unknown status value          → 400 invalid-enum
//
//   2. DB-integration scoping — runs only when DATABASE_URL is set.
//      Read-only over the seeded users; no writes, no cleanup needed.
//      * dev-super (staff:view all)    → every Active seed user, no secrets
//      * dev-sales (team t_north)      → t_north members + self, never t_south
//      * dev-field (own)               → exactly self
//      * role filter narrows within scope
//      * q filter matches name/email
//      * status filter is honoured (Invited → empty on the seed)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { issueAccessToken } from '../auth/tokenService.js';
import { validateStaffFilters, sanitiseStaffPagination } from '../repositories/staffRepository.js';
import { dbConfigured, skipIfNoDb } from '../test-support/requireDb.js';

function bearer(sub = 'u-asha', tid = 'org_acme') {
  const { token } = issueAccessToken({ sub, tid });
  return `Bearer ${token}`;
}

async function newApp() {
  return buildApp({ logLevel: 'silent' });
}

function withDevAuth() {
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.DEV_AUTH_OFFLINE_FALLBACK = 'true';
}

function withoutDevAuth() {
  delete process.env.DEV_AUTH_ENABLED;
  delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
}

// ---------------------------------------------------------------------------
// 0. Pure validator unit tests (no HTTP, no DB)
// ---------------------------------------------------------------------------

test('validateStaffFilters defaults to Active with an empty search', () => {
  assert.deepEqual(validateStaffFilters({}), { status: 'Active', q: '' });
  assert.deepEqual(validateStaffFilters(), { status: 'Active', q: '' });
});

test('validateStaffFilters passes through known filters and trims', () => {
  assert.deepEqual(
    validateStaffFilters({ role: 'field-executive', teamId: ' t_north ', q: ' ash ' }),
    { status: 'Active', q: 'ash', role: 'field-executive', teamId: 't_north' },
  );
});

test('validateStaffFilters rejects an unknown role with invalid-enum', () => {
  assert.throws(() => validateStaffFilters({ role: 'janitor' }), (err) => err.code === 'invalid-enum');
});

test('validateStaffFilters rejects an unknown status with invalid-enum', () => {
  assert.throws(() => validateStaffFilters({ status: 'On Vacation' }), (err) => err.code === 'invalid-enum');
});

test('sanitiseStaffPagination clamps to the 1..100 window', () => {
  assert.deepEqual(sanitiseStaffPagination({}), { limit: 25, offset: 0 });
  assert.deepEqual(sanitiseStaffPagination({ limit: '500', offset: '-3' }), { limit: 100, offset: 0 });
  assert.deepEqual(sanitiseStaffPagination({ limit: '10', offset: '40' }), { limit: 10, offset: 40 });
});

// ---------------------------------------------------------------------------
// 1. Auth + RBAC + validation (no DB required)
// ---------------------------------------------------------------------------

test('GET /api/v1/users without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/users' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/users with placeholder auth reaches RBAC gate', async () => {
  // Placeholder bearer resolves u-asha but the placeholder matrix is
  // empty → RBAC fires 403 before the data layer is touched.
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/users',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // With DB, the placeholder token resolves u-asha (field-executive,
    // staff.view='own') → 200 with exactly herself.
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((u) => u.id), ['u-asha']);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

test('GET /api/v1/users rejects an unknown role with 400', async () => {
  withDevAuth();
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users?role=janitor',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid-enum');
    await app.close();
  } finally {
    withoutDevAuth();
  }
});

test('GET /api/v1/users rejects an unknown status with 400', async () => {
  withDevAuth();
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users?status=On+Vacation',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid-enum');
    await app.close();
  } finally {
    withoutDevAuth();
  }
});

// ---------------------------------------------------------------------------
// 2. DB-integration scoping (read-only over seeded users)
// ---------------------------------------------------------------------------

const SECRET_KEYS = ['password_hash', 'passwordHash', 'mfa_secret', 'mfaSecret', 'invite_token', 'inviteToken', 'permission_matrix', 'permissionMatrix'];

function assertNoSecrets(items) {
  for (const item of items) {
    for (const key of SECRET_KEYS) {
      assert.ok(!(key in item), `staff DTO must not carry ${key}`);
    }
    assert.ok(item.id && item.name && item.email && item.role && item.status);
  }
}

test('GET /api/v1/users (dev-super, DB set) lists every Active seed user', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users?limit=100',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 9, 'expected the full seed roster');
    assert.ok(body.pagination.total >= 9);
    assertNoSecrets(body.items);
    // Ordered by name: the two demo accounts sort before the named staff.
    const names = body.items.map((u) => u.name);
    assert.deepEqual(names, [...names].sort());
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/users (dev-sales, DB set) stays team-scoped', async (t) => {
  // u-raj (sales-manager, t_north, staff.view='team') sees t_north members
  // plus himself — never the t_south executive.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users?limit=100',
      headers: { authorization: 'Bearer dev-sales' },
    });
    assert.equal(res.statusCode, 200);
    const ids = res.json().items.map((u) => u.id);
    assert.ok(ids.includes('u-raj'), 'manager sees self');
    assert.ok(ids.includes('u-asha'), 'manager sees same-team executive');
    assert.ok(ids.includes('u-tele'), 'manager sees same-team telecaller');
    assert.ok(!ids.includes('u-vijay'), 'manager never sees the other team');
    assertNoSecrets(res.json().items);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/users (dev-field, DB set) stays own-scoped', async (t) => {
  // u-asha (field-executive, staff.view='own') sees exactly herself, even
  // with a role filter that would match others.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const plain = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(plain.statusCode, 200);
    assert.deepEqual(plain.json().items.map((u) => u.id), ['u-asha']);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/users?role=field-executive',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(filtered.json().items.map((u) => u.id), ['u-asha']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/users (dev-super, DB set) honours role/q/status filters', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();

    const execs = await app.inject({
      method: 'GET',
      url: '/api/v1/users?role=field-executive&limit=100',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(execs.statusCode, 200);
    const execIds = execs.json().items.map((u) => u.id).sort();
    assert.deepEqual(execIds, ['u-asha', 'u-vijay']);

    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/users?q=vijay',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(search.json().items.map((u) => u.id), ['u-vijay']);

    const invited = await app.inject({
      method: 'GET',
      url: '/api/v1/users?status=Invited',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(invited.statusCode, 200);
    assert.deepEqual(invited.json().items, []);
    assert.equal(invited.json().pagination.total, 0);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// 3. Manual staff creation + admin reset (no DB required for gate checks)
// ---------------------------------------------------------------------------

test('POST /api/v1/users without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    payload: { name: 'X', email: 'x@acme.example', roleId: 'field-executive', initialPassword: 'a-strong-password-1' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /api/v1/users with placeholder auth reaches RBAC gate', async () => {
  // Placeholder bearer resolves u-asha (field-executive, staff.create='none')
  // → 403 before the data layer is touched.
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { authorization: bearer() },
    payload: { name: 'X', email: 'x@acme.example', roleId: 'field-executive', initialPassword: 'a-strong-password-1' },
  });
  if (dbConfigured) {
    // With DB, the placeholder token resolves u-asha → 403 (no create grant).
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

test('POST /api/v1/users/:id/reset-password with placeholder auth reaches RBAC gate', async () => {
  const app = await newApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/users/u-asha/reset-password',
    headers: { authorization: bearer() },
    payload: { newPassword: 'a-brand-new-password-2' },
  });
  // u-asha holds staff.edit='own' — the coarse gate passes, then the real
  // DB work would run. Without a DB that is a 503, never a 200.
  if (dbConfigured) {
    assert.ok([200, 403, 404].includes(res.statusCode), `unexpected ${res.statusCode}`);
  } else {
    assert.ok([403, 503].includes(res.statusCode), `unexpected ${res.statusCode}`);
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// 4. DB-integration: manual create + admin reset round-trip
// ---------------------------------------------------------------------------

test('POST /api/v1/users (dev-admin, DB set) creates and resets a synthetic user', async (t) => {
  // Full round-trip over HTTP with exact-row cleanup: create → duplicate
  // 409 → weak-password 400 → reset → reset-unknown 404 → delete rows.
  // The password travels only in request bodies, never in responses.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const suffix = `manual_${Date.now().toString(36)}`;
    const email = `${suffix}@acme.example`;
    const createdIds = [];
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { authorization: 'Bearer dev-admin' },
        payload: {
          name: 'Manual Hire', email, roleId: 'field-executive',
          teamId: 't_north', designation: 'Field Executive',
          initialPassword: 'a-strong-manual-password-1',
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const body = created.json();
      assert.ok(body.id, 'create returns the id');
      assert.equal(body.email, email);
      assert.equal(body.status, 'Active');
      assert.ok(!created.body.includes('a-strong-manual-password-1'), 'the response never carries the password');
      createdIds.push(body.id);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { authorization: 'Bearer dev-admin' },
        payload: {
          name: 'Manual Hire', email, roleId: 'field-executive',
          initialPassword: 'another-strong-password-2',
        },
      });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(duplicate.json().error.code, 'duplicate-email');

      const weak = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { authorization: 'Bearer dev-admin' },
        payload: {
          name: 'Weak Hire', email: `weak-${email}`, roleId: 'field-executive',
          initialPassword: 'short',
        },
      });
      assert.equal(weak.statusCode, 400);
      assert.equal(weak.json().error.code, 'weak-password');

      const reset = await app.inject({
        method: 'POST',
        url: `/api/v1/users/${body.id}/reset-password`,
        headers: { authorization: 'Bearer dev-admin' },
        payload: { newPassword: 'a-brand-new-manual-password-3' },
      });
      assert.equal(reset.statusCode, 200, reset.body);
      assert.deepEqual(reset.json(), { ok: true, userId: body.id, sessionsRevoked: 0 });
      assert.ok(!reset.body.includes('a-brand-new-manual-password-3'), 'the reset response never carries the password');

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/v1/users/u_missing/reset-password',
        headers: { authorization: 'Bearer dev-admin' },
        payload: { newPassword: 'a-brand-new-manual-password-3' },
      });
      assert.equal(unknown.statusCode, 404);
    } finally {
      const { query } = await import('../db/client.js');
      for (const id of createdIds) {
        await query('DELETE FROM users WHERE tenant_id = $1 AND id = $2', ['org_acme', id]);
      }
      await app.close();
    }
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('POST /api/v1/users (dev-field, DB set) is denied by staff:create', async (t) => {
  // u-asha (field-executive) holds staff.create='none' → coarse 403.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: 'Bearer dev-field' },
      payload: {
        name: 'Denied', email: 'denied@acme.example', roleId: 'field-executive',
        initialPassword: 'a-strong-manual-password-1',
      },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
