// Scope filter helpers.
//
// Each helper returns a plain object that the data layer can AND into a
// WHERE clause. No SQL string concatenation happens here — the data layer
// is expected to bind the parameters.
//
// Example (raw SQL):
//   const f = scopeFilterFor(user, 'leads', 'view');
//   // -> { sql: "tenant_id = $1 AND owner_id = $2", params: ['org_acme', 'u-asha'] }
//
// Example (Drizzle):
//   const f = scopeFilterFor(user, 'leads', 'view');
//   // AND table.tenantId.eq(f.params[0]).and(table.ownerId.eq(f.params[1]))
//
// Fail-closed: if the user has no scope or the scope is 'none', the helper
// returns a predicate that matches no rows. The route must refuse the
// request before reaching this point (see requirePermission.js), so this
// is the second line of defence.

import { RESOURCES, SCOPES, scopeOf } from './permissions.js';

/**
 * @typedef {Object} ScopeFilter
 * @property {string} sql      — placeholder expression with $1, $2, ... keys
 * @property {unknown[]} params — values to bind
 */

// Per-resource column for the `own` scope. Most resources use `owner_id`,
// but `listings` uses `assigned_to` (the field executive collecting /
// managing the listing). Keep this map tiny — extending it is the right
// move for any new resource whose ownership semantics differ.
const OWN_COLUMN = Object.freeze({
  [RESOURCES.LISTINGS]: 'assigned_to',
  // Default: every other resource uses `owner_id`.
});

function ownColumnFor(resource) {
  return OWN_COLUMN[resource] || 'owner_id';
}

/**
 * Builds a ScopeFilter for a (user, resource, action) triple.
 *
 * The returned SQL references `tenant_id` (or its first alias), the
 * resource's own-field, `team_id`, `project_id` — by column name. The
 * data layer may rewrite the column names if a JOIN is involved.
 *
 * When the data layer joins the resource table to others that also have
 * a `tenant_id` column (e.g. `listings l LEFT JOIN users u LEFT JOIN projects p`),
 * the unqualified `tenant_id` is ambiguous. Pass `{ table: 'l' }` so the
 * helper emits `l.tenant_id = $1` and the per-resource own/team/project
 * columns are rewritten with the same alias. Other repos that don't join
 * can omit the option.
 *
 * @param {{ id: string, tenantId: string, teamId?: string|null, projectIds?: string[] }} user
 * @param {string} resource
 * @param {string} action
 * @param {{ table?: string }} [opts] — table alias for the filtered table
 * @returns {ScopeFilter}
 */
export function scopeFilterFor(user, resource, action, opts = {}) {
  if (!user || !user.tenantId) {
    // No user, no tenant — deny everything.
    return { sql: '1 = 0', params: [] };
  }

  const scope = scopeOf(user, resource, action);
  const tenant = user.tenantId;
  const prefix = opts.table ? `${opts.table}.` : '';
  const tenantCol = `${prefix}tenant_id`;
  const teamCol    = `${prefix}team_id`;
  const projectCol = `${prefix}project_id`;
  const ownCol     = `${prefix}${ownColumnFor(resource)}`;

  switch (scope) {
    case SCOPES.NONE:
      return { sql: '1 = 0', params: [] };

    case SCOPES.ALL:
      return { sql: `${tenantCol} = $1`, params: [tenant] };

    case SCOPES.OWN:
      return {
        sql: `${tenantCol} = $1 AND ${ownCol} = $2`,
        params: [tenant, user.id],
      };

    case SCOPES.TEAM:
      return {
        sql: `${tenantCol} = $1 AND ${teamCol} = $2`,
        params: [tenant, user.teamId ?? null],
      };

    case SCOPES.PROJECT: {
      const ids = Array.isArray(user.projectIds) ? user.projectIds : [];
      if (ids.length === 0) return { sql: '1 = 0', params: [] };
      // ANY($2::text[]) — Postgres array binding.
      return {
        sql: `${tenantCol} = $1 AND ${projectCol} = ANY($2::text[])`,
        params: [tenant, ids],
      };
    }

    default:
      return { sql: '1 = 0', params: [] };
  }
}

/**
 * Convenience for routes that need to AND multiple scope filters
 * (e.g. leads joined to visits).
 *
 * @param {ScopeFilter[]} filters
 * @returns {ScopeFilter}
 */
export function andFilters(filters) {
  const parts = [];
  const params = [];
  let i = 1;
  for (const f of filters) {
    // Re-bind parameters with fresh placeholders.
    parts.push(`(${f.sql.replace(/\$\d+/g, () => `$${i++}`)})`);
    for (const p of f.params) params.push(p);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params };
}
