// Staff directory — GET /api/v1/users read model.
//
// Replaces the `{ items: [], placeholder: true }` stub with real rows from
// the `users` table. No migration is needed: id, name, email, phone,
// role_id, team_id, designation and status all exist in schema.sql, the app
// role already holds SELECT on `users` (scripts/app-role.js), and `users`
// deliberately has no RLS policy (it is read during auth before a tenant
// context could be established) — tenant isolation stays in the SQL
// predicates, the same posture as the other list endpoints.
//
// Visibility is driven by the caller's `staff:view` scope, mirroring the
// permission matrix (server/src/rbac/permissions.js):
//   all     → everyone in the tenant
//   team    → same team_id, plus self (a manager with no team still sees self)
//   project → users sharing any of the caller's projects, plus self
//   own     → self only (field-executive / telecaller default)
//   none    → no rows (fail-closed; the route gate 403s before this)
//
// The DTO never carries secrets: no password_hash, mfa_secret,
// invite/reset tokens, or permission_matrix. Phone is included for every
// viewer that passes the `staff:view` gate — there is no field-level grant
// in the matrix to key off, so a phone-hiding rule would be invented
// policy; documented as a gap in docs/STAFF_DIRECTORY.md.

import { BadRequest } from '../utils/errors.js';
import { ROLE_DEFINITIONS, scopeOf } from '../rbac/permissions.js';
import { tenantQuery } from '../db/client.js';

const KNOWN_ROLES = Object.freeze(Object.keys(ROLE_DEFINITIONS));
const KNOWN_STATUSES = Object.freeze(['Active', 'Inactive', 'On Leave', 'Invited', 'Suspended']);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function pickString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/**
 * Normalise the staff directory filters out of a query object. Returns the
 * effective filters with defaults applied (status defaults to 'Active' so
 * the directory lists working staff unless the caller asks otherwise).
 * Unknown keys are ignored — each route owns its allow-list.
 *
 * @param {Record<string, unknown>=} query
 * @returns {{ role?: string, teamId?: string, status: string, q: string }}
 * @throws {BadRequest} on unknown role/status enum values
 */
export function validateStaffFilters(query = {}) {
  if (!query || typeof query !== 'object') return { status: 'Active', q: '' };
  const out = { status: 'Active', q: '' };

  const rawRole = pickString(query.role);
  if (rawRole !== undefined) {
    if (!KNOWN_ROLES.includes(rawRole)) {
      throw new BadRequest(
        'invalid-enum',
        `role must be one of: ${KNOWN_ROLES.join(', ')}.`,
      );
    }
    out.role = rawRole;
  }

  const rawTeam = pickString(query.teamId);
  if (rawTeam !== undefined) out.teamId = rawTeam;

  const rawStatus = pickString(query.status);
  if (rawStatus !== undefined) {
    if (!KNOWN_STATUSES.includes(rawStatus)) {
      throw new BadRequest(
        'invalid-enum',
        `status must be one of: ${KNOWN_STATUSES.join(', ')}.`,
      );
    }
    out.status = rawStatus;
  }

  const rawQ = pickString(query.q);
  if (rawQ !== undefined) out.q = rawQ;

  return out;
}

/**
 * Sanitise pagination input (default 25, max 100 — the leads-list convention).
 *
 * @param {{limit?: unknown, offset?: unknown}=} input
 * @returns {{ limit: number, offset: number }}
 */
export function sanitiseStaffPagination(input = {}) {
  const limitRaw = Number.parseInt(input.limit, 10);
  const offsetRaw = Number.parseInt(input.offset, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  return { limit, offset };
}

function toStaffDTO(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role_id,
    roleName: row.role_name,
    teamId: row.team_id,
    teamName: row.team_name,
    status: row.status,
    designation: row.designation,
  };
}

/**
 * List the staff visible to `user`, tenant-scoped and scope-filtered.
 *
 * @param {object} user — req.user (id, tenantId, teamId, projectIds, matrix)
 * @param {{ role?: string, teamId?: string, status?: string, q?: string, limit?: unknown, offset?: unknown }=} filters
 * @returns {Promise<{ items: object[], pagination: { limit: number, offset: number, total: number } }>}
 */
export async function listStaff(user, filters = {}) {
  const page = sanitiseStaffPagination(filters);
  const scope = scopeOf(user, 'staff', 'view');

  const params = [user.tenantId];
  const clauses = ['u.tenant_id = $1', 'u.deleted_at IS NULL'];

  // Visibility from the caller's staff:view scope.
  if (scope === 'all') {
    // Nothing beyond the tenant predicate.
  } else if (scope === 'team') {
    if (user.teamId) {
      params.push(user.teamId, user.id);
      clauses.push(`(u.team_id = $${params.length - 1} OR u.id = $${params.length})`);
    } else {
      params.push(user.id);
      clauses.push(`u.id = $${params.length}`);
    }
  } else if (scope === 'project') {
    const ids = Array.isArray(user.projectIds) ? user.projectIds : [];
    params.push(user.id);
    const selfIdx = params.length;
    if (ids.length === 0) {
      clauses.push(`u.id = $${selfIdx}`);
    } else {
      params.push(ids);
      const anyIdx = params.length;
      clauses.push(
        `(u.id = $${selfIdx} OR EXISTS (SELECT 1 FROM user_project_ids up ` +
        `JOIN user_project_ids me ON me.project_id = up.project_id ` +
        `WHERE up.user_id = u.id AND me.user_id = $${selfIdx} ` +
        `AND up.project_id = ANY($${anyIdx}::text[])))`,
      );
    }
  } else if (scope === 'own') {
    params.push(user.id);
    clauses.push(`u.id = $${params.length}`);
  } else {
    // 'none' or anything unexpected — fail closed.
    clauses.push('1 = 0');
  }

  if (filters.role) {
    params.push(filters.role);
    clauses.push(`u.role_id = $${params.length}`);
  }
  if (filters.teamId) {
    params.push(filters.teamId);
    clauses.push(`u.team_id = $${params.length}`);
  }
  const status = pickString(filters.status) ?? 'Active';
  params.push(status);
  clauses.push(`u.status = $${params.length}`);
  if (filters.q && typeof filters.q === 'string' && filters.q.trim()) {
    const needle = `%${filters.q.trim()}%`;
    params.push(needle, needle, needle);
    clauses.push(
      `(u.name ILIKE $${params.length - 2} OR u.email ILIKE $${params.length - 1} ` +
      `OR COALESCE(u.phone, '') ILIKE $${params.length})`,
    );
  }

  const where = clauses.join(' AND ');
  const from = `FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN teams t ON t.tenant_id = u.tenant_id AND t.id = u.team_id`;

  const countSql = `SELECT COUNT(*)::int AS total ${from} WHERE ${where}`;
  const dataSql = `SELECT u.id, u.name, u.email, u.phone, u.role_id, r.name AS role_name,
      u.team_id, t.name AS team_name, u.status, u.designation
    ${from} WHERE ${where}
    ORDER BY u.name, u.id
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  const [counted, rows] = await Promise.all([
    tenantQuery(user, countSql, params),
    tenantQuery(user, dataSql, [...params, page.limit, page.offset]),
  ]);

  return {
    items: rows.rows.map(toStaffDTO),
    pagination: {
      limit: page.limit,
      offset: page.offset,
      total: counted.rows[0]?.total ?? 0,
    },
  };
}
