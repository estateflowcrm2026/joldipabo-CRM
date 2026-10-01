// Auth repository — raw `pg` helpers that load a user with their
// effective permission matrix. Used by `authMiddleware` once a real
// auth path lands, and by the development auth shortcut today.
//
// Matrix resolution (in order, first match wins per resource/action):
//   1. `users.permission_matrix` (JSONB per-user override)
//   2. `permission_matrices.matrix` (role default, JSONB)
//   3. `DEFAULT_PERMISSION_MATRIX[role]` from rbac/permissions.js
//
// The seed currently writes no `permission_matrices` rows, so the
// fallback to the in-code defaults is the common path. This is
// documented at the call sites in authMiddleware.

import { query } from '../db/client.js';
import { DEFAULT_PERMISSION_MATRIX } from '../rbac/permissions.js';
import { mergeMatrix } from '../rbac/permissions.js';

/**
 * @typedef {Object} AuthContext
 * @property {string} id
 * @property {string} tenantId
 * @property {string|null} branchId
 * @property {string|null} teamId
 * @property {string[]} projectIds
 * @property {string} role
 * @property {object} permissionMatrix
 * @property {string} status
 * @property {string} email
 * @property {string} name
 */

const BASE_SELECT = `
  SELECT
    u.id,
    u.tenant_id,
    u.branch_id,
    u.team_id,
    u.role_id,
    u.permission_matrix,
    u.status,
    u.email,
    u.name,
    u.password_hash,
    u.failed_login_count,
    u.locked_until,
    COALESCE(pm.matrix, '{}'::jsonb) AS role_matrix,
    o.status AS tenant_status,
    o.deleted_at AS tenant_deleted_at
  FROM users u
  LEFT JOIN permission_matrices pm ON pm.role_id = u.role_id
  JOIN organisations o ON o.id = u.tenant_id
  WHERE u.deleted_at IS NULL
`;

/**
 * Look up a user for the login flow, including the password hash.
 *
 * Returns null when no active user matches, so the caller cannot tell
 * "no such address" from "wrong password" — the login response is
 * identical either way, which is what stops the endpoint being a user
 * enumeration oracle.
 *
 * @param {string} tenantId
 * @param {string} email
 * @returns {Promise<{ id, tenantId, email, name, role, passwordHash, failedLoginCount, lockedUntil, status } | null>}
 */
export async function getLoginCandidate(tenantId, email) {
  if (!tenantId || !email) return null;
  const { rows } = await query(
    `${BASE_SELECT} AND u.tenant_id = $1 AND lower(u.email) = lower($2)`,
    [tenantId, String(email).trim()],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  // A locked account is still returned: the caller needs the id to
  // count the attempt. Whether the password was right is irrelevant
  // once the account is locked.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role_id,
    passwordHash: row.password_hash,
    failedLoginCount: row.failed_login_count || 0,
    lockedUntil: row.locked_until,
    status: row.status,
  };
}

const PROJECT_SELECT = `
  SELECT project_id
    FROM user_project_ids
   WHERE user_id = $1
   ORDER BY project_id
`;

/**
 * Build an AuthContext from a base row + projectIds list.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {string[]} projectIds
 * @returns {AuthContext | null}
 */
function shape(row, projectIds) {
  if (!row) return null;
  const role = row.role_id;
  const fallback = DEFAULT_PERMISSION_MATRIX[role] || {};
  const merged = mergeMatrix(fallback, row.role_matrix || {});
  const effective = mergeMatrix(merged, row.permission_matrix || {});
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id ?? null,
    teamId: row.team_id ?? null,
    projectIds,
    role,
    permissionMatrix: effective,
    status: row.status,
    email: row.email,
    name: row.name,
  };
}

async function loadProjects(userId) {
  const { rows } = await query(PROJECT_SELECT, [userId]);
  return rows.map((r) => r.project_id);
}

/**
 * Reasons a lookup can fail, so callers can distinguish "no such user"
 * from "user exists but is not allowed to authenticate".
 *
 * `tenant-mismatch` is the cross-tenant forgery case: a token carrying
 * `sub` from tenant A and `tid` from tenant B. Because the lookup keys
 * on BOTH columns, that combination simply matches no row — the two
 * tenants are never conflated.
 *
 * @typedef {'not-found'
 *   | 'user-inactive'
 *   | 'user-suspended'
 *   | 'user-deleted'
 *   | 'tenant-inactive'
 *   | 'tenant-suspended'
 *   | 'tenant-deleted'
 *   | 'tenant-mismatch'} AuthLookupFailure
 */

/**
 * Map a row to a failure reason, or null when the account may
 * authenticate.
 *
 * `shape()` already filters `deleted_at IS NULL` in SQL, so
 * `user-deleted` cannot be produced by the query today; it is kept so
 * the function stays correct if that filter is ever relaxed.
 *
 * @param {Record<string, any>} row
 * @returns {AuthLookupFailure | null}
 */
export function classifyRowFailure(row) {
  if (!row) return 'not-found';
  if (row.deleted_at) return 'user-deleted';
  if (row.tenant_deleted_at) return 'tenant-deleted';

  const userStatus = String(row.status || '').trim().toLowerCase();
  if (userStatus === 'suspended') return 'user-suspended';
  // Only an explicit 'Active' may authenticate. A new enum value added
  // to the schema CHECK must not silently let someone in, and a NULL or
  // empty status must not either — both are refused, and the new value
  // gets handled deliberately rather than by accident.
  if (userStatus !== 'active') return 'user-inactive';

  const tenantStatus = String(row.tenant_status || '').trim().toLowerCase();
  if (tenantStatus === 'suspended') return 'tenant-suspended';
  // 'Active' and 'Trial' are the only states that may serve requests.
  // Anything else — including a value added to the CHECK constraint
  // later, or a NULL — refuses, for the same reason the user status
  // does above.
  if (tenantStatus !== 'active' && tenantStatus !== 'trial') return 'tenant-inactive';

  return null;
}

/**
 * Load an auth context keyed by BOTH user id and tenant id.
 *
 * Keying on `sub` alone was the tenant-isolation breach: a forged token
 * could name any user id, and the effective tenant was then taken from
 * that victim's own row — so `tid` in the token was decorative. This
 * function makes the token's tenant claim authoritative and therefore
 * checkable.
 *
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<AuthContext | null>}
 */
export async function getUserAuthContextById(userId, tenantId) {
  if (!userId || !tenantId) return null;
  const { rows } = await query(
    `${BASE_SELECT} AND u.id = $1 AND u.tenant_id = $2`,
    [userId, tenantId],
  );
  if (rows.length === 0) return null;
  if (classifyRowFailure(rows[0])) return null;
  const projectIds = await loadProjects(rows[0].id);
  return shape(rows[0], projectIds);
}

/**
 * Detailed variant used by the auth middleware, so a refusal can be
 * reported accurately and audited without leaking whether the user
 * exists.
 *
 * @param {string} userId
 * @param {string} tenantId
 * @returns {Promise<{ ok: true, context: AuthContext } | { ok: false, reason: AuthLookupFailure }>}
 */
export async function resolveAuthContext(userId, tenantId) {
  if (!userId || !tenantId) return { ok: false, reason: 'not-found' };
  const { rows } = await query(
    `${BASE_SELECT} AND u.id = $1 AND u.tenant_id = $2`,
    [userId, tenantId],
  );
  if (rows.length === 0) return { ok: false, reason: 'not-found' };

  const failure = classifyRowFailure(rows[0]);
  if (failure) return { ok: false, reason: failure };

  const projectIds = await loadProjects(rows[0].id);
  const context = shape(rows[0], projectIds);
  if (!context) return { ok: false, reason: 'not-found' };
  return { ok: true, context };
}

/**
 * @param {string} email
 * @param {string} tenantId
 * @returns {Promise<AuthContext | null>}
 */
export async function getUserAuthContextByEmail(email, tenantId) {
  if (!email || !tenantId) return null;
  // The schema is UNIQUE (tenant_id, email), not UNIQUE (email) — the
  // same address may legitimately exist in two tenants. Filtering on
  // tenant is therefore required for correctness as well as safety;
  // the previous version took rows[0] with no tenant predicate, which
  // returned an arbitrary tenant when an address was duplicated.
  const { rows } = await query(
    `${BASE_SELECT} AND u.email = $1 AND u.tenant_id = $2`,
    [email, tenantId],
  );
  if (rows.length === 0) return null;
  if (classifyRowFailure(rows[0])) return null;
  const projectIds = await loadProjects(rows[0].id);
  return shape(rows[0], projectIds);
}

/**
 * Load an auth context for a development key. Today this is a static
 * map from `dev-<role>` to a seeded user id; once the role-permission
 * matrix moves entirely to JSONB in the DB we can read role labels
 * straight from the `roles` row.
 *
 * The map is intentionally hard-coded — the dev tokens are a curl-friendly
 * shortcut, not a routing rule. The list of valid dev keys is exposed by
 * `KNOWN_DEV_KEYS` so the middleware can validate them without a DB hit.
 *
 * Dev tokens resolve within the configured dev tenant only
 * (`DEV_AUTH_TENANT_ID`), which is how the seeded users are scoped.
 *
 * @param {string} devKey — e.g. 'dev-admin', 'dev-field', 'dev-super'
 * @param {{ tenantId: string }} opts
 * @returns {Promise<AuthContext | null>}
 */
export async function getDevUserAuthContext(devKey, opts = {}) {
  const userId = DEV_KEY_TO_USER_ID[devKey];
  if (!userId) return null;
  return getUserAuthContextById(userId, opts.tenantId);
}

/**
 * Canonical mapping of dev-token aliases to the seeded user ids the
 * demo backend recognises. Mirrors the seeded users in
 * `server/src/db/seed-demo.sql` and `src/data/seed.js`.
 *
 * @type {Record<string, string>}
 */
export const DEV_KEY_TO_USER_ID = Object.freeze({
  'dev-admin':    'u-admin',
  'dev-super':    'u-super',
  'dev-sales':    'u-raj',
  'dev-site':     'u-priya',
  'dev-field':    'u-asha',
  'dev-field2':   'u-vijay',
  'dev-tele':     'u-tele',
  'dev-cpm':      'u-cpm',
  'dev-accounts': 'u-anil',
});

export const KNOWN_DEV_KEYS = Object.freeze(Object.keys(DEV_KEY_TO_USER_ID));

/**
 * Build an offline-fallback auth context for a dev key when
 * DATABASE_URL is unset. The matrix comes from the in-code defaults;
 * project ids from a small static map (so a test hitting
 * `?serviceCategory=rent` returns rows even without a DB). This is
 * not a production path — the README documents it as "offline demo
 * only".
 *
 * @param {string} devKey
 * @param {{ tenantId: string }} opts
 * @returns {AuthContext | null}
 */
export function buildOfflineDevContext(devKey, opts = { tenantId: 'org_acme' }) {
  const userId = DEV_KEY_TO_USER_ID[devKey];
  if (!userId) return null;
  const role = DEV_KEY_TO_ROLE[userId];
  if (!role) return null;
  const matrix = DEFAULT_PERMISSION_MATRIX[role] || {};
  return {
    id: userId,
    tenantId: opts.tenantId,
    branchId: 'br_bangalore',
    teamId: OFFLINE_TEAM[userId] ?? null,
    projectIds: OFFLINE_PROJECTS[userId] ? [...OFFLINE_PROJECTS[userId]] : [],
    role,
    permissionMatrix: matrix,
    status: 'Active',
    email: OFFLINE_EMAIL[userId] || `${userId}@acme.example`,
    name: OFFLINE_NAME[userId] || userId,
  };
}

/**
 * Static role + team + project snapshot for offline dev mode. Matches
 * the seed exactly so behaviour is identical to the DB-loaded path.
 */
const DEV_KEY_TO_ROLE = Object.freeze({
  'u-admin':    'admin',
  'u-super':    'super-admin',
  'u-raj':      'sales-manager',
  'u-priya':    'site-manager',
  'u-asha':     'field-executive',
  'u-vijay':    'field-executive',
  'u-tele':     'telecaller',
  'u-cpm':      'channel-partner-manager',
  'u-anil':     'accounts',
});

const OFFLINE_TEAM = Object.freeze({
  'u-raj':   't_north',
  'u-asha':  't_north',
  'u-vijay': 't_south',
  'u-tele':  't_north',
});

const OFFLINE_PROJECTS = Object.freeze({
  'u-priya': ['p_skyline', 'p_heights'],
  'u-asha':  ['p_skyline'],
  'u-raj':   ['p_skyline', 'p_heights'],
  'u-anil':  ['p_skyline'],
});

const OFFLINE_EMAIL = Object.freeze({
  'u-admin':    'admin@acme.example',
  'u-super':    'super@acme.example',
  'u-raj':      'raj@acme.example',
  'u-priya':    'priya@acme.example',
  'u-asha':     'asha@acme.example',
  'u-vijay':    'vijay@acme.example',
  'u-tele':     'tara@acme.example',
  'u-cpm':      'cpm@acme.example',
  'u-anil':     'anil@acme.example',
});

const OFFLINE_NAME = Object.freeze({
  'u-admin':    'Demo Admin',
  'u-super':    'Demo Super',
  'u-raj':      'Raj Mehta',
  'u-priya':    'Priya Sharma',
  'u-asha':     'Asha Rao',
  'u-vijay':    'Vijay Kumar',
  'u-tele':     'Tara Iyer',
  'u-cpm':      'Partner Lead',
  'u-anil':     'Anil Verma',
});
