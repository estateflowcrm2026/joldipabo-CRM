// Route-level tests for GET /api/v1/projects (projects directory).
//
// Layered coverage:
//
//   1. Auth + RBAC — pure HTTP, no DB needed.
//      * no auth                       → 401
//      * placeholder bearer, no DB     → 403 (RBAC fires before DB)
//
//   2. DB-integration scoping — runs only when DATABASE_URL is set.
//      Read-only over the seeded projects; no writes, no cleanup needed.
//      * dev-super (projects:view all) → both seed projects
//      * dev-sales (projects:view project, on both) → both seed projects
//      * dev-site (projects:view project, on both) → both seed projects
//      * dev-field (projects:view all) → both seed projects
//      * dev-field2 (projects:view all, no project links) → both (all scope
//        ignores membership — a field executive sees the catalogue)
//      * q / city / stage filters narrow within scope
//      * cross-tenant hiding is structural (tenant predicate); the seed has
//        a single tenant, so this is covered by the tenant-scoped unit
//        tests in projectsRepository.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { issueAccessToken } from '../auth/tokenService.js';
import { validateProjectFilters } from '../repositories/projectsRepository.js';
import { dbConfigured, skipIfNoDb } from '../test-support/requireDb.js';

function bearer(sub = 'u-asha', tid = 'org_acme') {
  const { token } = issueAccessToken({ sub, tid });
  return `Bearer ${token}`;
}

async function newApp() {
  return buildApp({ logLevel: 'silent' });
}

// ---------------------------------------------------------------------------
// 0. Pure validator unit tests (no HTTP, no DB)
// ---------------------------------------------------------------------------

test('validateProjectFilters defaults to an empty search', () => {
  assert.deepEqual(validateProjectFilters({}), { q: '' });
  assert.deepEqual(validateProjectFilters(), { q: '' });
});

test('validateProjectFilters passes through known filters and trims', () => {
  assert.deepEqual(
    validateProjectFilters({ q: ' sky ', city: ' Bangalore ', stage: ' Booking open ' }),
    { q: 'sky', city: 'Bangalore', stage: 'Booking open' },
  );
});

// ---------------------------------------------------------------------------
// 1. Auth + RBAC (no DB required)
// ---------------------------------------------------------------------------

test('GET /api/v1/projects without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/projects with placeholder auth reaches RBAC gate', async () => {
  // Placeholder bearer resolves u-asha but the placeholder matrix is
  // empty → RBAC fires 403 before the data layer is touched.
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // With DB, the placeholder token resolves u-asha (field-executive,
    // projects.view='all') → 200 with both seed projects.
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((p) => p.id).sort(), ['p_heights', 'p_skyline']);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// 2. DB-integration scoping (read-only over seeded projects)
// ---------------------------------------------------------------------------

function assertNoSecrets(items) {
  for (const item of items) {
    assert.ok(item.id && item.name, 'project DTO carries id and name');
    for (const key of Object.keys(item)) {
      assert.ok(
        ['id', 'name', 'code', 'city', 'stage', 'type', 'managerId', 'managerName', 'availableUnits', 'totalUnits'].includes(key),
        `project DTO must not carry ${key}`,
      );
    }
  }
}

test('GET /api/v1/projects (dev-super, DB set) lists both seed projects', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=100',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.items.map((p) => p.id), ['p_heights', 'p_skyline']);
    assert.equal(body.pagination.total, 2);
    assertNoSecrets(body.items);
    const skyline = body.items.find((p) => p.id === 'p_skyline');
    assert.equal(skyline.managerName, 'Priya Sharma');
    assert.equal(skyline.availableUnits, 42);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/projects (dev-sales, DB set) stays project-scoped', async (t) => {
  // u-raj (sales-manager, projects.view='project') is on both seed
  // projects → both rows.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=100',
      headers: { authorization: 'Bearer dev-sales' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((p) => p.id), ['p_heights', 'p_skyline']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/projects (dev-site, DB set) stays project-scoped', async (t) => {
  // u-priya (site-manager, projects.view='project') owns both seed
  // projects → both rows.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=100',
      headers: { authorization: 'Bearer dev-site' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((p) => p.id), ['p_heights', 'p_skyline']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/projects (dev-field, DB set) sees the catalogue', async (t) => {
  // u-asha (field-executive, projects.view='all') → both rows even though
  // she is only on p_skyline: `all` ignores membership.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=100',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((p) => p.id), ['p_heights', 'p_skyline']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/projects (dev-super, DB set) honours q/city/stage filters', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();

    const byCode = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?q=sky',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(byCode.statusCode, 200);
    assert.deepEqual(byCode.json().items.map((p) => p.id), ['p_skyline']);

    const byCity = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?city=Bangalore',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(byCity.statusCode, 200);
    assert.deepEqual(byCity.json().items.map((p) => p.id), ['p_heights', 'p_skyline']);

    const byStage = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?stage=Pre-launch',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(byStage.statusCode, 200);
    assert.deepEqual(byStage.json().items.map((p) => p.id), ['p_heights']);

    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/projects?city=Chennai',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().items, []);
    assert.equal(empty.json().pagination.total, 0);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
