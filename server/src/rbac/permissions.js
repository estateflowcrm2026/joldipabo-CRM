// Server-side permission vocabulary.
//
// Mirrors src/data/permissions.js EXACTLY:
//   * 11 resources (10 + `listings`, added 2026-09-23 for cross-vertical support)
//   * 7 actions
//   * 5 scopes
//   * 8 system roles with the same default matrices
//
// The frontend's can() / scopeOf() are advisory. This module is the
// authoritative check on the server. Both sides must stay in sync —
// update them together.

export const RESOURCES = Object.freeze({
  DASHBOARD:    'dashboard',
  LEADS:        'leads',
  LISTINGS:     'listings',
  STAFF:        'staff',
  ROLES:        'roles',
  ATTENDANCE:   'attendance',
  VISITS:       'visits',
  PHOTOS:       'photos',
  COMMS:        'communications',
  REPORTS:      'reports',
  PROJECTS:     'projects',
});

export const ACTIONS = Object.freeze([
  'view',
  'create',
  'edit',
  'assign',
  'approve',
  'export',
  'delete',
]);

export const SCOPES = Object.freeze({
  NONE:    'none',
  OWN:     'own',
  TEAM:    'team',
  PROJECT: 'project',
  ALL:     'all',
});

const SCOPE_WEIGHT = Object.freeze({
  none: 0, own: 1, team: 2, project: 3, all: 4,
});

// ---------------------------------------------------------------------------
// Role catalogue
// ---------------------------------------------------------------------------
export const ROLE_DEFINITIONS = Object.freeze({
  'super-admin': {
    id: 'super-admin', name: 'Super Admin',
    description: 'Org owner. Unrestricted access. Manages roles, billing, security audits.',
    color: '#0F1A1F', accent: '#C49B4A', isSystem: true,
  },
  admin: {
    id: 'admin', name: 'Admin',
    description: 'Configures teams, projects, and staff. Cannot redefine super-admin role.',
    color: '#1F3A36', accent: '#3F7B6F', isSystem: true,
  },
  'sales-manager': {
    id: 'sales-manager', name: 'Sales Manager',
    description: 'Owns a sales team. Manages pipeline, approves bookings, reviews reports.',
    color: '#3D2E1F', accent: '#C49B4A',
  },
  'site-manager': {
    id: 'site-manager', name: 'Site Manager',
    description: 'Owns site operations. Approves photos, attendance, and site visits.',
    color: '#2A3D2F', accent: '#5E8C5A',
  },
  'field-executive': {
    id: 'field-executive', name: 'Field Executive',
    description: 'Field sales. Self check-in, logs visits, uploads site photos, follows up.',
    color: '#2E3447', accent: '#6F7BB3',
  },
  telecaller: {
    id: 'telecaller', name: 'Telecaller',
    description: 'Phone-based lead qualification. Manages own call queue and follow-ups.',
    color: '#3F2D45', accent: '#9D6FA3',
  },
  'channel-partner-manager': {
    id: 'channel-partner-manager', name: 'Channel Partner Manager',
    description: 'Manages external broker network and partner-attributed leads.',
    color: '#1F3D3A', accent: '#3F8C84',
  },
  accounts: {
    id: 'accounts', name: 'Accounts',
    description: 'Read-only on pipeline, full access to bookings and payment reconciliation.',
    color: '#3D3A1F', accent: '#B0A14A',
  },
});

// ---------------------------------------------------------------------------
// Default matrices (must mirror src/data/permissions.js DEFAULT_PERMISSION_MATRIX)
// ---------------------------------------------------------------------------
function buildMatrix(entries) {
  const matrix = {};
  for (const [resource, actions] of Object.entries(entries)) {
    matrix[resource] = { ...actions };
  }
  return matrix;
}

export const DEFAULT_PERMISSION_MATRIX = Object.freeze({
  'super-admin': buildMatrix({
    dashboard:       { view: 'all' },
    leads:           { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    listings:        { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    staff:           { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    roles:           { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    attendance:      { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    visits:          { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    photos:          { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    communications:  { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    reports:         { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    projects:        { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
  }),
  admin: buildMatrix({
    dashboard:       { view: 'all' },
    leads:           { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    listings:        { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    staff:           { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    roles:           { view: 'all', create: 'none', edit: 'all', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    attendance:      { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    visits:          { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    photos:          { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    communications:  { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    reports:         { view: 'all', create: 'all', edit: 'all', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    projects:        { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'none', export: 'all', delete: 'none' },
  }),
  'sales-manager': buildMatrix({
    dashboard:       { view: 'team' },
    leads:           { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
    listings:        { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
    staff:           { view: 'team', create: 'none', edit: 'team', assign: 'team', approve: 'none', export: 'team', delete: 'none' },
    roles:           { view: 'team', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance:      { view: 'team', create: 'own', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'none' },
    visits:          { view: 'team', create: 'team', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'none' },
    photos:          { view: 'team', create: 'team', edit: 'team', assign: 'none', approve: 'team', export: 'team', delete: 'none' },
    communications:  { view: 'team', create: 'all', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    reports:         { view: 'team', create: 'team', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    projects:        { view: 'project', create: 'none', edit: 'project', assign: 'project', approve: 'none', export: 'project', delete: 'none' },
  }),
  'site-manager': buildMatrix({
    dashboard:       { view: 'project' },
    leads:           { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    listings:        { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    staff:           { view: 'project', create: 'none', edit: 'project', assign: 'project', approve: 'none', export: 'project', delete: 'none' },
    roles:           { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance:      { view: 'project', create: 'own', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    visits:          { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    photos:          { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    communications:  { view: 'project', create: 'project', edit: 'project', assign: 'none', approve: 'none', export: 'project', delete: 'none' },
    reports:         { view: 'project', create: 'project', edit: 'project', assign: 'none', approve: 'none', export: 'project', delete: 'none' },
    projects:        { view: 'project', create: 'none', edit: 'project', assign: 'project', approve: 'none', export: 'project', delete: 'none' },
  }),
  'field-executive': buildMatrix({
    dashboard:       { view: 'own' },
    leads:           { view: 'own', create: 'all', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    listings:        { view: 'own', create: 'all', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    staff:           { view: 'own', create: 'none', edit: 'own', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    roles:           { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance:      { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    visits:          { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    photos:          { view: 'all', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'own' },
    communications:  { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    reports:         { view: 'own', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    projects:        { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
  }),
  telecaller: buildMatrix({
    dashboard:       { view: 'own' },
    leads:           { view: 'own', create: 'all', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    listings:        { view: 'own', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    staff:           { view: 'own', create: 'none', edit: 'own', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    roles:           { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance:      { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    visits:          { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    photos:          { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    communications:  { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    reports:         { view: 'own', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    projects:        { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
  }),
  'channel-partner-manager': buildMatrix({
    dashboard:       { view: 'team' },
    leads:           { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
    listings:        { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'none', export: 'team', delete: 'none' },
    staff:           { view: 'team', create: 'none', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    roles:           { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance:      { view: 'team', create: 'own', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    visits:          { view: 'team', create: 'team', edit: 'team', assign: 'team', approve: 'none', export: 'team', delete: 'none' },
    photos:          { view: 'team', create: 'team', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    communications:  { view: 'team', create: 'all', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    reports:         { view: 'team', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    projects:        { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
  }),
  accounts: buildMatrix({
    dashboard:       { view: 'all' },
    leads:           { view: 'all', create: 'none', edit: 'project', assign: 'none', approve: 'project', export: 'all', delete: 'none' },
    listings:        { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    staff:           { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    roles:           { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance:      { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    visits:          { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'all', export: 'all', delete: 'none' },
    photos:          { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    communications:  { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    reports:         { view: 'all', create: 'all', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    projects:        { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the configured scope for a user on (resource, action).
 * If the user has no entry, returns SCOPES.NONE.
 *
 * @param {{ permissionMatrix?: object }} user
 * @param {string} resource
 * @param {string} action
 * @returns {'none'|'own'|'team'|'project'|'all'}
 */
export function scopeOf(user, resource, action) {
  const matrix = user?.permissionMatrix;
  if (!matrix) return SCOPES.NONE;
  const actions = matrix[resource];
  if (!actions) return SCOPES.NONE;
  return actions[action] || SCOPES.NONE;
}

// Mirror of scopeFilters.js — which record field the `own` predicate reads
// for each resource. Most resources use `ownerId`, but `listings` uses the
// field executive's `assignedTo`. Keep in sync with the SQL helper so a
// matrix row's `own` scope and the in-memory `can()` agree.
const RECORD_OWN_FIELD = Object.freeze({
  listings: 'assignedTo',
});

function recordOwnField(resource) {
  return RECORD_OWN_FIELD[resource] || 'ownerId';
}

/**
 * True when `user` may perform `action` on `resource`.
 *
 * If `record` is omitted, returns true when any scope > 'none' is granted.
 * If `record` is provided, returns true only when the record passes the scope.
 *
 * @param {{ id: string, teamId?: string|null, projectId?: string|null, ownerId?: string|null, assignedTo?: string|null, permissionMatrix?: object }} user
 * @param {string} resource
 * @param {string} action
 * @param {{ ownerId?: string|null, assignedTo?: string|null, teamId?: string|null, projectId?: string|null }=} record
 * @returns {boolean}
 */
export function can(user, resource, action, record = null) {
  const scope = scopeOf(user, resource, action);
  if (scope === SCOPES.NONE) return false;
  if (!record) return true;

  switch (scope) {
    case SCOPES.ALL:
      return true;
    case SCOPES.OWN: {
      const field = recordOwnField(resource);
      const candidate = record?.[field];
      return Boolean(user && candidate != null && candidate === user.id);
    }
    case SCOPES.TEAM:
      return Boolean(
        user && record.teamId != null && user.teamId != null
          && record.teamId === user.teamId
      );
    case SCOPES.PROJECT:
      return Boolean(
        user && record.projectId != null && Array.isArray(user.projectIds)
          && user.projectIds.includes(record.projectId)
      );
    default:
      return false;
  }
}

/**
 * Trims a record collection to what `user` can `action` on `resource`.
 * Returns [] for scope NONE or missing user.
 *
 * @template T extends { ownerId?: string|null, teamId?: string|null, projectId?: string|null }
 * @param {{ id: string, teamId?: string|null, projectIds?: string[], permissionMatrix?: object }} user
 * @param {string} resource
 * @param {string} action
 * @param {T[]} records
 * @returns {T[]}
 */
export function filterByScope(user, resource, action, records) {
  const scope = scopeOf(user, resource, action);
  if (scope === SCOPES.NONE) return [];
  if (scope === SCOPES.ALL) return records;
  if (!user) return [];
  return records.filter((r) => can(user, resource, action, r));
}

/**
 * True when the role id is a system role (cannot be deleted or fully overwritten).
 * @param {string} roleId
 * @returns {boolean}
 */
export function isSystemRole(roleId) {
  return Boolean(ROLE_DEFINITIONS[roleId]?.isSystem);
}

/**
 * Merges a base matrix with customisations (per-user override).
 * @param {object} base
 * @param {object} overrides
 * @returns {object}
 */
export function mergeMatrix(base, overrides) {
  const next = {};
  for (const [resource, actions] of Object.entries(base || {})) {
    next[resource] = { ...actions, ...(overrides?.[resource] || {}) };
  }
  return next;
}
