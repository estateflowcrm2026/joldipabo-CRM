// Scope-filter SQL helper tests.
//
// Today the only DB-backed call sites are placeholders, so these tests
// lock the SQL contract: which `own` column is referenced for which
// resource, the tenant binding, and the fail-closed behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { andFilters, scopeFilterFor } from './scopeFilters.js';

const user = (overrides = {}) => ({
  id: 'u-asha',
  tenantId: 'org_acme',
  teamId: 't-north',
  projectIds: ['p-skyline', 'p-heights'],
  permissionMatrix: {},
  ...overrides,
});

test('scopeFilterFor returns a deny-all when no user is supplied', () => {
  assert.deepEqual(scopeFilterFor(null, 'leads', 'view'), { sql: '1 = 0', params: [] });
});

test('scopeFilterFor scope=ALL binds only the tenant', () => {
  const f = scopeFilterFor(user({ permissionMatrix: { leads: { view: 'all' } } }), 'leads', 'view');
  assert.equal(f.sql, 'tenant_id = $1');
  assert.deepEqual(f.params, ['org_acme']);
});

test('scopeFilterFor scope=OWN on leads uses owner_id', () => {
  const f = scopeFilterFor(user({ permissionMatrix: { leads: { view: 'own' } } }), 'leads', 'view');
  assert.equal(f.sql, 'tenant_id = $1 AND owner_id = $2');
  assert.deepEqual(f.params, ['org_acme', 'u-asha']);
});

test('scopeFilterFor scope=OWN on listings uses assigned_to (not owner_id)', () => {
  const f = scopeFilterFor(user({ permissionMatrix: { listings: { view: 'own' } } }), 'listings', 'view');
  assert.equal(f.sql, 'tenant_id = $1 AND assigned_to = $2');
  assert.deepEqual(f.params, ['org_acme', 'u-asha']);
});

test('scopeFilterFor scope=TEAM binds the team_id', () => {
  const f = scopeFilterFor(user({ permissionMatrix: { listings: { view: 'team' } } }), 'listings', 'view');
  assert.equal(f.sql, 'tenant_id = $1 AND team_id = $2');
  assert.deepEqual(f.params, ['org_acme', 't-north']);
});

test('scopeFilterFor scope=PROJECT uses ANY($2::text[]) and returns deny-all when projectIds is empty', () => {
  const withProjects = scopeFilterFor(
    user({ permissionMatrix: { listings: { view: 'project' } } }),
    'listings',
    'view',
  );
  assert.equal(withProjects.sql, 'tenant_id = $1 AND project_id = ANY($2::text[])');
  assert.deepEqual(withProjects.params, ['org_acme', ['p-skyline', 'p-heights']]);

  const noProjects = scopeFilterFor(
    user({ projectIds: [], permissionMatrix: { listings: { view: 'project' } } }),
    'listings',
    'view',
  );
  assert.equal(noProjects.sql, '1 = 0');
});

test('scopeFilterFor scope=NONE returns deny-all regardless of inputs', () => {
  const f = scopeFilterFor(user({ permissionMatrix: { listings: { view: 'none' } } }), 'listings', 'view');
  assert.deepEqual(f, { sql: '1 = 0', params: [] });
});

test('andFilters re-binds placeholders and ANDs the parts', () => {
  const a = scopeFilterFor(user({ permissionMatrix: { listings: { view: 'own' } } }), 'listings', 'view');
  const b = scopeFilterFor(user({ permissionMatrix: { leads: { view: 'team' } } }), 'leads', 'view');
  const joined = andFilters([a, b]);
  // Each input used $1 — output must rebind to $1, $2 with a fresh sequence.
  assert.match(joined.sql, /tenant_id = \$1 AND assigned_to = \$2/);
  assert.match(joined.sql, /tenant_id = \$3 AND team_id = \$4/);
  assert.match(joined.sql, /\)\s+AND\s+\(/);
  assert.deepEqual(joined.params, ['org_acme', 'u-asha', 'org_acme', 't-north']);
});

test('andFilters with no filters returns the trivial 1 = 1', () => {
  const joined = andFilters([]);
  assert.equal(joined.sql, '1 = 1');
  assert.deepEqual(joined.params, []);
});
