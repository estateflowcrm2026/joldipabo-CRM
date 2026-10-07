// Route-level tests for GET /api/v1/teams (teams directory).
//
// Layered coverage:
//
//   1. Auth + RBAC — pure HTTP, no DB needed.
//      * no auth                       → 401
//      * placeholder bearer, no DB     → 403 (RBAC fires before DB)
//
//   2. DB-integration scoping — runs only when DATABASE_URL is set.
//      Read-only over the seeded teams; no writes, no cleanup needed.
//      * dev-super (staff:view all)    → both seed teams with counts
//      * dev-sales (team t_north)      → t_north only
//      * dev-site (project, no team)   → member-project teams only
//      * dev-field (own, t_north)      → t_north only
//      * q filter narrows within scope
//      * cross-team RBAC denial: a role with staff:view none → 403
//        (dev token with `none` scope does not exist in the seed, so this
//        is covered by the placeholder 403 above plus the none-scope
//        unit tests in teamsRepository.test.js)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { issueAccessToken } from '../auth/tokenService.js';
import { validateTeamFilters } from '../repositories/teamsRepository.js';
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

test('validateTeamFilters defaults to an empty search', () => {
  assert.deepEqual(validateTeamFilters({}), { q: '' });
  assert.deepEqual(validateTeamFilters(), { q: '' });
});

test('validateTeamFilters trims q and ignores unknown keys', () => {
  assert.deepEqual(validateTeamFilters({ q: '  north ' }), { q: 'north' });
  assert.deepEqual(validateTeamFilters({ status: 'Active' }), { q: '' });
});

// ---------------------------------------------------------------------------
// 1. Auth + RBAC (no DB required)
// ---------------------------------------------------------------------------

test('GET /api/v1/teams without auth returns 401', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/teams' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /api/v1/teams with placeholder auth reaches RBAC gate', async () => {
  // Placeholder bearer resolves u-asha but the placeholder matrix is
  // empty → RBAC fires 403 before the data layer is touched.
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/teams',
    headers: { authorization: bearer() },
  });
  if (dbConfigured) {
    // With DB, the placeholder token resolves u-asha (field-executive,
    // staff.view='own', team t_north) → 200 with exactly her team.
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((t) => t.id), ['t_north']);
  } else {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'forbidden');
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// 2. DB-integration scoping (read-only over seeded teams)
// ---------------------------------------------------------------------------

function assertNoSecrets(items) {
  for (const item of items) {
    assert.ok(item.id && item.name, 'team DTO carries id and name');
    for (const key of Object.keys(item)) {
      assert.ok(
        ['id', 'name', 'region', 'leadId', 'leadName', 'memberCount', 'activeMemberCount'].includes(key),
        `team DTO must not carry ${key}`,
      );
    }
  }
}

test('GET /api/v1/teams (dev-super, DB set) lists both seed teams', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/teams?limit=100',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.items.map((tm) => tm.id), ['t_north', 't_south']);
    assert.equal(body.pagination.total, 2);
    assertNoSecrets(body.items);
    const north = body.items[0];
    assert.equal(north.leadName, 'Raj Mehta');
    assert.ok(north.memberCount >= 3, 'seed t_north has manager + executive + telecaller');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/teams (dev-sales, DB set) stays team-scoped', async (t) => {
  // u-raj (sales-manager, t_north, staff.view='team') sees t_north only.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/teams?limit=100',
      headers: { authorization: 'Bearer dev-sales' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((tm) => tm.id), ['t_north']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/teams (dev-site, DB set) stays project-scoped', async (t) => {
  // u-priya (site-manager, no team, staff.view='project') sees teams with
  // members on her projects (p_skyline, p_heights): both seed teams, since
  // t_south's u-vijay holds no project but t_north does — assert t_north is
  // present and the list is a subset of the tenant.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/teams?limit=100',
      headers: { authorization: 'Bearer dev-site' },
    });
    assert.equal(res.statusCode, 200);
    const ids = res.json().items.map((tm) => tm.id);
    assert.ok(ids.includes('t_north'), 'site manager sees the project team');
    assert.ok(!ids.includes('t_other') && ids.length <= 2, 'never outside the tenant');
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/teams (dev-field, DB set) stays own-scoped', async (t) => {
  // u-asha (field-executive, t_north, staff.view='own') sees t_north only.
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/teams',
      headers: { authorization: 'Bearer dev-field' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((tm) => tm.id), ['t_north']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test('GET /api/v1/teams (dev-super, DB set) honours the q filter', async (t) => {
  if (skipIfNoDb(t)) return;
  process.env.DEV_AUTH_ENABLED = 'true';
  try {
    const app = await newApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/teams?q=south',
      headers: { authorization: 'Bearer dev-super' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((tm) => tm.id), ['t_south']);
    await app.close();
  } finally {
    delete process.env.DEV_AUTH_ENABLED;
  }
});

test.after(async () => {
  await closeDb();
});
