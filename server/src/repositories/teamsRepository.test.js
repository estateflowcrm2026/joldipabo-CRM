// Teams directory tests: listTeams + validateTeamFilters.
//
// Driven by a small in-memory `pg` stand-in that interprets the stable
// `/* scope:… */` and `/* filter:… */` markers in the SQL instead of parsing
// it — the same seam strategy as staffManagement.test.js. The SQL itself is
// exercised by the DB-integration suites in routes/teams.test.js when
// DATABASE_URL is set.
//
// Covered:
//   * all scope lists tenant teams ordered by name, with member counts and
//     the lead's name; other tenants and soft-deleted rows are excluded
//   * team / own scope returns only the caller's team (no team → no rows)
//   * project scope returns member-project teams plus the caller's own team
//   * none scope fails closed
//   * q narrows over name and region
//   * pagination slices items but not the total
//
// Run with `npm test` (src/repositories/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listTeams, validateTeamFilters } from './teamsRepository.js';

const db = {
  teams: [
    { id: 't_north', tenant_id: 'org_acme', name: 'North Sales', region: 'North Bangalore', lead_id: 'u-raj', deleted_at: null },
    { id: 't_south', tenant_id: 'org_acme', name: 'South Sales', region: 'South Bangalore', lead_id: null, deleted_at: null },
    { id: 't_other', tenant_id: 'org_other', name: 'Other Team', region: 'Elsewhere', lead_id: null, deleted_at: null },
    { id: 't_gone', tenant_id: 'org_acme', name: 'Gone Team', region: 'Nowhere', lead_id: null, deleted_at: '2026-01-01' },
  ],
  users: [
    { id: 'u-raj', team_id: 't_north', status: 'Active', name: 'Raj Mehta', projects: ['p_skyline', 'p_heights'] },
    { id: 'u-asha', team_id: 't_north', status: 'Active', name: 'Asha Rao', projects: ['p_skyline'] },
    { id: 'u-tele', team_id: 't_north', status: 'Active', name: 'Tara Iyer', projects: [] },
    { id: 'u-vijay', team_id: 't_south', status: 'Active', name: 'Vijay Kumar', projects: [] },
    { id: 'u-old', team_id: 't_south', status: 'Inactive', name: 'Old Hand', projects: [] },
    { id: 'u-priya', team_id: null, status: 'Active', name: 'Priya Sharma', projects: ['p_skyline', 'p_heights'] },
  ],
};

function makeUser({ id = 'u-test', tenantId = 'org_acme', teamId = null, projectIds = [], staffView = 'all' } = {}) {
  return {
    id,
    tenantId,
    teamId,
    projectIds,
    permissionMatrix: { staff: { view: staffView } },
  };
}

/**
 * A `pg`-shaped client modelling the teams directory statements. Interprets
 * the scope/filter markers rather than parsing SQL; filter VALUES come from
 * the test's `filters` input, so a dropped clause surfaces as an
 * un-narrowed result.
 */
function makeClient(user, filters = {}) {
  return {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const tenantId = params[0];
      let teams = db.teams.filter((t) => t.tenant_id === tenantId && !t.deleted_at);

      if (sql.includes('/* scope:all */')) {
        // Nothing beyond the tenant predicate.
      } else if (sql.includes('/* scope:none */') || sql.includes('-empty */')) {
        teams = [];
      } else if (sql.includes('/* scope:project */')) {
        const own = user.teamId ? [user.teamId] : [];
        const pids = user.projectIds || [];
        teams = teams.filter((t) =>
          own.includes(t.id) ||
          db.users.some((u) =>
            u.team_id === t.id &&
            (u.projects || []).some((p) => pids.includes(p)),
          ),
        );
      } else {
        // team / own scope, or the project-scope own-team leg: `t.id = $N`.
        const teamId = params[1];
        teams = typeof teamId === 'string' ? teams.filter((t) => t.id === teamId) : [];
      }

      if (sql.includes('/* filter:q */')) {
        const term = String(filters.q || '').trim().toLowerCase();
        teams = teams.filter((t) =>
          t.name.toLowerCase().includes(term) ||
          (t.region || '').toLowerCase().includes(term),
        );
      }

      teams.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

      if (sql.startsWith('SELECT COUNT')) {
        return { rows: [{ total: teams.length }], rowCount: 1 };
      }
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const page = teams.slice(offset, offset + limit);
      return {
        rows: page.map((t) => ({
          id: t.id,
          name: t.name,
          region: t.region,
          lead_id: t.lead_id,
          lead_name: t.lead_id ? db.users.find((u) => u.id === t.lead_id)?.name ?? null : null,
          member_count: db.users.filter((u) => u.team_id === t.id).length,
          active_member_count: db.users.filter((u) => u.team_id === t.id && u.status === 'Active').length,
        })),
        rowCount: page.length,
      };
    },
  };
}

const ids = (result) => result.items.map((t) => t.id);

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

test('validateTeamFilters defaults to an empty search', () => {
  assert.deepEqual(validateTeamFilters({}), { q: '' });
  assert.deepEqual(validateTeamFilters(), { q: '' });
  assert.deepEqual(validateTeamFilters('nope'), { q: '' });
});

test('validateTeamFilters trims q and ignores unknown keys', () => {
  assert.deepEqual(validateTeamFilters({ q: '  north ' }), { q: 'north' });
  assert.deepEqual(validateTeamFilters({ status: 'Active', foo: 1 }), { q: '' });
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

test('listTeams (all) lists tenant teams ordered by name with counts', async () => {
  const result = await listTeams(
    makeUser({ staffView: 'all' }),
    {},
    { client: makeClient(makeUser({ staffView: 'all' })) },
  );
  assert.deepEqual(ids(result), ['t_north', 't_south']);
  assert.deepEqual(result.pagination, { limit: 25, offset: 0, total: 2 });
  const north = result.items[0];
  assert.equal(north.leadName, 'Raj Mehta');
  assert.equal(north.memberCount, 3);
  assert.equal(north.activeMemberCount, 3);
  const south = result.items[1];
  assert.equal(south.leadName, null);
  assert.equal(south.memberCount, 2);
  assert.equal(south.activeMemberCount, 1);
});

test('listTeams (all) is tenant-scoped', async () => {
  const user = makeUser({ tenantId: 'org_other', staffView: 'all' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['t_other']);
});

test('listTeams (team) returns only the caller team', async () => {
  const user = makeUser({ teamId: 't_north', staffView: 'team' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['t_north']);
});

test('listTeams (team) with no team returns no rows', async () => {
  const user = makeUser({ teamId: null, staffView: 'team' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
  assert.equal(result.pagination.total, 0);
});

test('listTeams (own) returns only the caller team', async () => {
  const user = makeUser({ teamId: 't_south', staffView: 'own' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['t_south']);
});

test('listTeams (own) with no team returns no rows', async () => {
  const user = makeUser({ teamId: null, staffView: 'own' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
});

test('listTeams (project) returns member-project teams', async () => {
  // u-priya pattern: no team, on p_skyline. t_north has members on
  // p_skyline; t_south has none on any project.
  const user = makeUser({ projectIds: ['p_skyline'], staffView: 'project' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['t_north']);
});

test('listTeams (project) includes the caller own team as well', async () => {
  const user = makeUser({ teamId: 't_south', projectIds: ['p_skyline'], staffView: 'project' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['t_north', 't_south']);
});

test('listTeams (project) with no team and no projects returns no rows', async () => {
  const user = makeUser({ staffView: 'project' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
});

test('listTeams (none) fails closed', async () => {
  const user = makeUser({ teamId: 't_north', staffView: 'none' });
  const result = await listTeams(user, {}, { client: makeClient(user) });
  assert.deepEqual(result.items, []);
  assert.equal(result.pagination.total, 0);
});

// ---------------------------------------------------------------------------
// Filters + pagination
// ---------------------------------------------------------------------------

test('listTeams q narrows over name and region', async () => {
  const user = makeUser({ staffView: 'all' });
  const byName = await listTeams(user, { q: 'south' }, { client: makeClient(user, { q: 'south' }) });
  assert.deepEqual(ids(byName), ['t_south']);
  const byRegion = await listTeams(user, { q: 'bangalore' }, { client: makeClient(user, { q: 'bangalore' }) });
  assert.deepEqual(ids(byRegion), ['t_north', 't_south']);
});

test('listTeams pagination slices items but not the total', async () => {
  const user = makeUser({ staffView: 'all' });
  const result = await listTeams(user, { limit: 1, offset: 1 }, { client: makeClient(user) });
  assert.deepEqual(ids(result), ['t_south']);
  assert.deepEqual(result.pagination, { limit: 1, offset: 1, total: 2 });
});
