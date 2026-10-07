// Teams directory — GET /api/v1/teams read model.
//
// Replaces the `{ items: [], placeholder: true }` stub with real rows from
// the `teams` table. No migration was required: id, tenant_id, name, region
// and lead_id all exist in 001-schema.sql, and the app role already holds
// SELECT on `teams` (server/scripts/app-role.js). `teams` has no RLS policy
// by design — tenant isolation stays in the SQL predicates, the same posture
// as the staff directory (server/src/repositories/staffRepository.js).
//
// Visibility is driven by the caller's `staff:view` scope (the route gate is
// staff:view, so the same grant shapes the rows):
//   all     → every team in the tenant
//   team    → the caller's own team only
//   project → teams with at least one member in any of the caller's projects
//             (via user_project_ids), plus the caller's own team
//   own     → the caller's own team only (no team → no rows)
//   none    → no rows (fail-closed; the route gate 403s before this)
//
// `teams` has no status column, so the only filter is `q` (ILIKE over
// name/region). The DTO carries member counts (total + Active) and the team
// lead's name via JOINs — no secrets exist on this table.
//
// The `/* scope:… */` and `/* filter:… */` markers in the SQL are stable
// seams for the no-DB unit tests (teamsRepository.test.js), whose fake client
// interprets them instead of parsing SQL.

import { tenantQuery } from '../db/client.js';
import { scopeOf } from '../rbac/permissions.js';
import { sanitiseStaffPagination as sanitisePagination } from './staffRepository.js';

function pickString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/**
 * Normalise the teams directory filters out of a query object. `teams` has
 * no status column, so `q` is the only filter; unknown keys are ignored —
 * each route owns its allow-list.
 *
 * @param {Record<string, unknown>=} query
 * @returns {{ q: string }}
 */
export function validateTeamFilters(query = {}) {
  if (!query || typeof query !== 'object') return { q: '' };
  return { q: pickString(query.q) ?? '' };
}

function toTeamDTO(row) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    leadId: row.lead_id,
    leadName: row.lead_name,
    memberCount: row.member_count,
    activeMemberCount: row.active_member_count,
  };
}

/**
 * Visibility predicate for the caller's `staff:view` scope. Appends bound
 * values to `params` and returns the SQL fragment.
 *
 * @param {object} user — req.user (id, tenantId, teamId, projectIds, matrix)
 * @param {unknown[]} params — bound values so far (params[0] is the tenant)
 * @returns {string} SQL fragment for the WHERE clause
 */
function teamsScopeClause(user, params) {
  const scope = scopeOf(user, 'staff', 'view');
  const teamId = user.teamId ?? null;
  const projectIds = Array.isArray(user.projectIds)
    ? user.projectIds.filter(Boolean)
    : [];

  if (scope === 'all') return '/* scope:all */ 1 = 1';

  if (scope === 'team' || scope === 'own') {
    if (!teamId) return `/* scope:${scope}-empty */ 1 = 0`;
    params.push(teamId);
    return `/* scope:${scope} */ t.id = $${params.length}`;
  }

  if (scope === 'project') {
    const parts = [];
    if (teamId) {
      params.push(teamId);
      parts.push(`t.id = $${params.length}`);
    }
    if (projectIds.length > 0) {
      params.push(projectIds);
      parts.push(`/* scope:project */ EXISTS (
        SELECT 1 FROM users u2
        JOIN user_project_ids up ON up.user_id = u2.id
        WHERE u2.tenant_id = t.tenant_id
          AND u2.team_id = t.id
          AND u2.deleted_at IS NULL
          AND up.project_id = ANY($${params.length}::text[])
      )`);
    }
    if (parts.length === 0) return '/* scope:project-empty */ 1 = 0';
    return `(${parts.join(' OR ')})`;
  }

  // 'none' or anything unexpected — fail closed.
  return '/* scope:none */ 1 = 0';
}

function runnerFor(user, deps) {
  if (deps && deps.client) return (text, params) => deps.client.query(text, params);
  return (text, params) => tenantQuery(user, text, params);
}

/**
 * List the teams visible to `user`, tenant-scoped and scope-filtered.
 *
 * @param {object} user — req.user (id, tenantId, teamId, projectIds, matrix)
 * @param {{ q?: string, limit?: unknown, offset?: unknown }=} filters
 * @param {{ client?: { query: Function } }=} deps — injectable query client
 *   for no-DB unit tests; defaults to tenantQuery
 * @returns {Promise<{ items: object[], pagination: { limit: number, offset: number, total: number } }>}
 */
export async function listTeams(user, filters = {}, deps = {}) {
  const page = sanitisePagination(filters);

  const params = [user.tenantId];
  const clauses = ['t.tenant_id = $1', 't.deleted_at IS NULL', teamsScopeClause(user, params)];

  const q = pickString(filters.q);
  if (q) {
    const needle = `%${q}%`;
    params.push(needle, needle);
    clauses.push(
      `/* filter:q */ (t.name ILIKE $${params.length - 1} ` +
      `OR COALESCE(t.region, '') ILIKE $${params.length})`,
    );
  }

  const where = clauses.join(' AND ');
  const from = 'FROM teams t';

  const countSql = `SELECT COUNT(DISTINCT t.id)::int AS total ${from} WHERE ${where}`;
  const dataSql = `SELECT t.id, t.name, t.region, t.lead_id,
      lead.name AS lead_name,
      COUNT(u.id) FILTER (WHERE u.deleted_at IS NULL)::int AS member_count,
      COUNT(u.id) FILTER (WHERE u.deleted_at IS NULL AND u.status = 'Active')::int AS active_member_count
    ${from}
    LEFT JOIN users lead
      ON lead.tenant_id = t.tenant_id AND lead.id = t.lead_id AND lead.deleted_at IS NULL
    LEFT JOIN users u
      ON u.tenant_id = t.tenant_id AND u.team_id = t.id
    WHERE ${where}
    GROUP BY t.id, t.name, t.region, t.lead_id, lead.name
    ORDER BY t.name, t.id
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  const run = runnerFor(user, deps);
  const [counted, rows] = await Promise.all([
    run(countSql, params),
    run(dataSql, [...params, page.limit, page.offset]),
  ]);

  return {
    items: rows.rows.map(toTeamDTO),
    pagination: {
      limit: page.limit,
      offset: page.offset,
      total: counted.rows[0]?.total ?? 0,
    },
  };
}
