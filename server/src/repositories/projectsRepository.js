// Projects directory — GET /api/v1/projects read model.
//
// Replaces the `{ items: [], placeholder: true }` stub with real rows from
// the `projects` table. No migration was required: every selected column
// exists in 001-schema.sql, and the app role already holds SELECT on
// `projects` (server/scripts/app-role.js). `projects` has no RLS policy by
// design — tenant isolation stays in the SQL predicates, the same posture
// as the staff directory (server/src/repositories/staffRepository.js).
//
// Visibility is driven by the caller's `projects:view` scope (the route gate
// is projects:view, so the same grant shapes the rows):
//   all     → every project in the tenant
//   team    → projects with at least one member from the caller's team
//             (via team_members or users.team_id), plus the caller's own
//             projects (via user_project_ids)
//   project → the caller's own projects only (via user_project_ids)
//   own     → the caller's own projects only
//   none    → no rows (fail-closed; the route gate 403s before this)
//
// `projects` has no status column, so the filters are `q` (ILIKE over
// name/code/city), `city` (exact, case-insensitive) and `stage` (exact,
// case-insensitive). Unknown stage/city values are not enum-checked — the
// schema has no CHECK on either column, so inventing an allow-list would be
// invented policy. The DTO carries the manager's name via JOIN plus
// available_units; amenities, rera_number and possession_date are not
// exposed — picker screens have no use for them and they are internal
// detail, not secrets (nothing on this table is a credential).
//
// The `/* scope:… */` and `/* filter:… */` markers in the SQL are stable
// seams for the no-DB unit tests (projectsRepository.test.js), whose fake
// client interprets them instead of parsing SQL.

import { tenantQuery } from '../db/client.js';
import { scopeOf } from '../rbac/permissions.js';
import { sanitiseStaffPagination as sanitisePagination } from './staffRepository.js';

function pickString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/**
 * Normalise the projects directory filters out of a query object. Unknown
 * keys are ignored — each route owns its allow-list.
 *
 * @param {Record<string, unknown>=} query
 * @returns {{ q: string, city?: string, stage?: string }}
 */
export function validateProjectFilters(query = {}) {
  if (!query || typeof query !== 'object') return { q: '' };
  const out = { q: pickString(query.q) ?? '' };
  const city = pickString(query.city);
  if (city !== undefined) out.city = city;
  const stage = pickString(query.stage);
  if (stage !== undefined) out.stage = stage;
  return out;
}

function toProjectDTO(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    city: row.city,
    stage: row.stage,
    type: row.type,
    managerId: row.manager_id,
    managerName: row.manager_name,
    availableUnits: row.available_units,
    totalUnits: row.total_units,
  };
}

/**
 * Visibility predicate for the caller's `projects:view` scope. Appends
 * bound values to `params` and returns the SQL fragment.
 *
 * @param {object} user — req.user (id, tenantId, teamId, projectIds, matrix)
 * @param {unknown[]} params — bound values so far (params[0] is the tenant)
 * @returns {string} SQL fragment for the WHERE clause
 */
function projectsScopeClause(user, params) {
  const scope = scopeOf(user, 'projects', 'view');
  const teamId = user.teamId ?? null;
  const projectIds = Array.isArray(user.projectIds)
    ? user.projectIds.filter(Boolean)
    : [];

  if (scope === 'all') return '/* scope:all */ 1 = 1';

  if (scope === 'project' || scope === 'own') {
    if (projectIds.length === 0) return `/* scope:${scope}-empty */ 1 = 0`;
    params.push(projectIds);
    return `/* scope:${scope} */ p.id = ANY($${params.length}::text[])`;
  }

  if (scope === 'team') {
    const parts = [];
    if (teamId) {
      params.push(teamId);
      const teamIdx = params.length;
      parts.push(`/* scope:team */ EXISTS (
        SELECT 1 FROM users u2
        WHERE u2.tenant_id = p.tenant_id
          AND u2.team_id = $${teamIdx}
          AND u2.deleted_at IS NULL
          AND (EXISTS (
            SELECT 1 FROM user_project_ids up
            WHERE up.user_id = u2.id AND up.project_id = p.id
          ) OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.user_id = u2.id AND pm.project_id = p.id
          ))
      )`);
    }
    if (projectIds.length > 0) {
      params.push(projectIds);
      parts.push(`p.id = ANY($${params.length}::text[])`);
    }
    if (parts.length === 0) return '/* scope:team-empty */ 1 = 0';
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
 * List the projects visible to `user`, tenant-scoped and scope-filtered.
 *
 * @param {object} user — req.user (id, tenantId, teamId, projectIds, matrix)
 * @param {{ q?: string, city?: string, stage?: string, limit?: unknown, offset?: unknown }=} filters
 * @param {{ client?: { query: Function } }=} deps — injectable query client
 *   for no-DB unit tests; defaults to tenantQuery
 * @returns {Promise<{ items: object[], pagination: { limit: number, offset: number, total: number } }>}
 */
export async function listProjects(user, filters = {}, deps = {}) {
  const page = sanitisePagination(filters);

  const params = [user.tenantId];
  const clauses = ['p.tenant_id = $1', 'p.deleted_at IS NULL', projectsScopeClause(user, params)];

  const q = pickString(filters.q);
  if (q) {
    const needle = `%${q}%`;
    params.push(needle, needle, needle);
    clauses.push(
      `/* filter:q */ (p.name ILIKE $${params.length - 2} ` +
      `OR COALESCE(p.code, '') ILIKE $${params.length - 1} ` +
      `OR COALESCE(p.city, '') ILIKE $${params.length})`,
    );
  }
  const city = pickString(filters.city);
  if (city !== undefined) {
    params.push(city);
    clauses.push(`/* filter:city */ p.city ILIKE $${params.length}`);
  }
  const stage = pickString(filters.stage);
  if (stage !== undefined) {
    params.push(stage);
    clauses.push(`/* filter:stage */ p.stage ILIKE $${params.length}`);
  }

  const where = clauses.join(' AND ');
  const from = 'FROM projects p';

  const countSql = `SELECT COUNT(*)::int AS total ${from} WHERE ${where}`;
  const dataSql = `SELECT p.id, p.name, p.code, p.city, p.stage, p.type,
      p.manager_id, mgr.name AS manager_name,
      p.available_units, p.total_units
    ${from}
    LEFT JOIN users mgr
      ON mgr.tenant_id = p.tenant_id AND mgr.id = p.manager_id AND mgr.deleted_at IS NULL
    WHERE ${where}
    ORDER BY p.name, p.id
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  const run = runnerFor(user, deps);
  const [counted, rows] = await Promise.all([
    run(countSql, params),
    run(dataSql, [...params, page.limit, page.offset]),
  ]);

  return {
    items: rows.rows.map(toProjectDTO),
    pagination: {
      limit: page.limit,
      offset: page.offset,
      total: counted.rows[0]?.total ?? 0,
    },
  };
}
