// Projects directory tests: listProjects + validateProjectFilters.
//
// Driven by a small in-memory `pg` stand-in that interprets the stable
// `/* scope:… */` and `/* filter:… */` markers in the SQL instead of parsing
// it — the same seam strategy as staffManagement.test.js. The SQL itself is
// exercised by the DB-integration suites in routes/projects.test.js when
// DATABASE_URL is set.
//
// Covered:
//   * all scope lists tenant projects ordered by name, with manager names
//     and unit counts; other tenants and soft-deleted rows are excluded
//   * project / own scope returns only the caller's projects (none → no rows)
//   * team scope returns team-member projects plus the caller's own projects
//   * none scope fails closed
//   * q narrows over name/code/city; city and stage narrow case-insensitively
//   * pagination slices items but not the total
//
// Run with `npm test` (src/repositories/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listProjects, validateProjectFilters } from './projectsRepository.js';

const db = {
  projects: [
    { id: 'p_heights', tenant_id: 'org_acme', name: 'Acme Heights', code: 'HTS', city: 'Bangalore', stage: 'Pre-launch', type: 'Luxury Residential', manager_id: 'u-priya', available_units: 80, total_units: 80, deleted_at: null },
    { id: 'p_skyline', tenant_id: 'org_acme', name: 'Skyline Heights', code: 'SKY', city: 'Bangalore', stage: 'Booking open', type: 'Residential', manager_id: 'u-priya', available_units: 42, total_units: 120, deleted_at: null },
    { id: 'p_marina', tenant_id: 'org_acme', name: 'Marina Bay', code: 'MBY', city: 'Chennai', stage: 'Sold out', type: 'Residential', manager_id: null, available_units: 0, total_units: 60, deleted_at: null },
    { id: 'p_other', tenant_id: 'org_other', name: 'Other Project', code: 'OTH', city: 'Mumbai', stage: 'Booking open', type: null, manager_id: null, available_units: 5, total_units: 10, deleted_at: null },
    { id: 'p_gone', tenant_id: 'org_acme', name: 'Gone Project', code: 'GONE', city: 'Bangalore', stage: 'Booking open', type: null, manager_id: null, available_units: 1, total_units: 2, deleted_at: '2026-01-01' },
  ],
  // Membership: u-asha (t_north) on p_skyline; u-vijay (t_south) on nothing;
  // u-priya (no team) owns both Bangalore projects.
  memberships: [
    { user_id: 'u-asha', team_id: 't_north', project_id: 'p_skyline' },
    { user_id: 'u-raj', team_id: 't_north', project_id: 'p_skyline' },
    { user_id: 'u-raj', team_id: 't_north', project_id: 'p_heights' },
    { user_id: 'u-priya', team_id: null, project_id: 'p_skyline' },
    { user_id: 'u-priya', team_id: null, project_id: 'p_heights' },
  ],
  managers: { 'u-priya': 'Priya Sharma' },
};

function makeUser({ id = 'u-test', tenantId = 'org_acme', teamId = null, projectIds = [], projectsView = 'all' } = {}) {
  return {
    id,
    tenantId,
    teamId,
    projectIds,
    permissionMatrix: { projects: { view: projectsView } },
  };
}

/**
 * A `pg`-shaped client modelling the projects directory statements.
 * Interprets the scope/filter markers rather than parsing SQL; filter
 * VALUES come from the test's `filters` input, so a dropped clause
 * surfaces as an un-narrowed result.
 */
function makeClient(user, filters = {}) {
  return {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const tenantId = params[0];
      let projects = db.projects.filter((p) => p.tenant_id === tenantId && !p.deleted_at);

      if (sql.includes('/* scope:all */')) {
        // Nothing beyond the tenant predicate.
      } else if (sql.includes('/* scope:none */') || sql.includes('-empty */')) {
        projects = [];
      } else if (sql.includes('/* scope:team */')) {
        const mine = new Set(user.projectIds || []);
        const teamProjects = new Set(
          db.memberships.filter((m) => m.team_id && m.team_id === user.teamId).map((m) => m.project_id),
        );
        projects = projects.filter((p) => mine.has(p.id) || teamProjects.has(p.id));
      } else {
        // project / own scope: `p.id = ANY($N)`.
        const mine = new Set(user.projectIds || []);
        projects = projects.filter((p) => mine.has(p.id));
      }

      if (sql.includes('/* filter:q */')) {
        const term = String(filters.q || '').trim().toLowerCase();
        projects = projects.filter((p) =>
          p.name.toLowerCase().includes(term) ||
          (p.code || '').toLowerCase().includes(term) ||
          (p.city || '').toLowerCase().includes(term),
        );
      }
      if (sql.includes('/* filter:city */')) {
        const city = String(filters.city || '').trim().toLowerCase();
        projects = projects.filter((p) => (p.city || '').toLowerCase() === city);
      }
      if (sql.includes('/* filter:stage */')) {
        const stage = String(filters.stage || '').trim().toLowerCase();
        projects = projects.filter((p) => (p.stage || '').toLowerCase() === stage);
      }

      projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

      if (sql.startsWith('SELECT COUNT')) {
        return { rows: [{ total: projects.length }], rowCount: 1 };
      }
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const page = projects.slice(offset, offset + limit);
      return {
        rows: page.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          city: p.city,
          stage: p.stage,
          type: p.type,
          manager_id: p.manager_id,
          manager_name: p.manager_id ? db.managers[p.manager_id] ?? null : null,
          available_units: p.available_units,
          total_units: p.total_units,
        })),
        rowCount: page.length,
      };
    },
  };
}

const ids = (result) => result.items.map((p) => p.id);

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

test('validateProjectFilters defaults to an empty search', () => {
  assert.deepEqual(validateProjectFilters({}), { q: '' });
  assert.deepEqual(validateProjectFilters(), { q: '' });
  assert.deepEqual(validateProjectFilters('nope'), { q: '' });
});

test('validateProjectFilters passes through known filters and trims', () => {
  assert.deepEqual(
    validateProjectFilters({ q: ' sky ', city: ' Bangalore ', stage: ' Booking open ', foo: 1 }),
    { q: 'sky', city: 'Bangalore', stage: 'Booking open' },
  );
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

test('listProjects (all) lists tenant projects ordered by name', async () => {
  const user = makeUser({ projectsView: 'all' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_heights', 'p_marina', 'p_skyline']);
  assert.deepEqual(result.pagination, { limit: 25, offset: 0, total: 3 });
  const heights = result.items[0];
  assert.equal(heights.managerName, 'Priya Sharma');
  assert.equal(heights.availableUnits, 80);
  assert.equal(heights.totalUnits, 80);
  assert.equal(heights.code, 'HTS');
  const marina = result.items[1];
  assert.equal(marina.managerName, null);
});

test('listProjects (all) is tenant-scoped', async () => {
  const user = makeUser({ tenantId: 'org_other', projectsView: 'all' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_other']);
});

test('listProjects (project) returns only the caller projects', async () => {
  const user = makeUser({ projectIds: ['p_skyline'], projectsView: 'project' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_skyline']);
});

test('listProjects (project) with no projects returns no rows', async () => {
  const user = makeUser({ projectsView: 'project' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
  assert.equal(result.pagination.total, 0);
});

test('listProjects (own) returns only the caller projects', async () => {
  const user = makeUser({ projectIds: ['p_heights', 'p_skyline'], projectsView: 'own' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_heights', 'p_skyline']);
});

test('listProjects (team) returns team-member projects plus own', async () => {
  // t_north works p_skyline + p_heights; the caller owns only p_marina.
  const user = makeUser({ teamId: 't_north', projectIds: ['p_marina'], projectsView: 'team' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_heights', 'p_marina', 'p_skyline']);
});

test('listProjects (team) with no team falls back to own projects', async () => {
  const user = makeUser({ projectIds: ['p_skyline'], projectsView: 'team' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_skyline']);
});

test('listProjects (team) with no team and no projects returns no rows', async () => {
  const user = makeUser({ projectsView: 'team' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
});

test('listProjects (none) fails closed', async () => {
  const user = makeUser({ projectIds: ['p_skyline'], projectsView: 'none' });
  const result = await listProjects(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
  assert.equal(result.pagination.total, 0);
});

// ---------------------------------------------------------------------------
// Filters + pagination
// ---------------------------------------------------------------------------

test('listProjects q narrows over name, code and city', async () => {
  const user = makeUser({ projectsView: 'all' });
  const byName = await listProjects(user, { q: 'marina' }, { client: makeClient(user, { q: 'marina' }) });
  assert.deepEqual(ids(byName), ['p_marina']);
  const byCode = await listProjects(user, { q: 'sky' }, { client: makeClient(user, { q: 'sky' }) });
  assert.deepEqual(ids(byCode), ['p_skyline']);
  const byCity = await listProjects(user, { q: 'chennai' }, { client: makeClient(user, { q: 'chennai' }) });
  assert.deepEqual(ids(byCity), ['p_marina']);
});

test('listProjects city and stage narrow case-insensitively', async () => {
  const user = makeUser({ projectsView: 'all' });
  const city = await listProjects(user, { city: 'chennai' }, { client: makeClient(user, { city: 'chennai' }) });
  assert.deepEqual(ids(city), ['p_marina']);
  const stage = await listProjects(user, { stage: 'pre-launch' }, { client: makeClient(user, { stage: 'pre-launch' }) });
  assert.deepEqual(ids(stage), ['p_heights']);
});

test('listProjects filters compose within scope', async () => {
  const user = makeUser({ projectIds: ['p_skyline', 'p_heights'], projectsView: 'project' });
  const result = await listProjects(
    user,
    { q: 'acme', city: 'Bangalore' },
    { client: makeClient(user, { q: 'acme', city: 'Bangalore' }) },
  );
  assert.deepEqual(ids(result), ['p_heights']);
});

test('listProjects pagination slices items but not the total', async () => {
  const user = makeUser({ projectsView: 'all' });
  const result = await listProjects(user, { limit: 1, offset: 1 }, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['p_marina']);
  assert.deepEqual(result.pagination, { limit: 1, offset: 1, total: 3 });
});
