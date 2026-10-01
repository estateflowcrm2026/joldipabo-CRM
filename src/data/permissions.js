// Centralized permission system.
// Every UI gate and data filter MUST go through `can()` or `scopeOf()`.
//
// Resources define what can be acted on.
// Actions define what can be done.
// Scopes define the boundary:
//   - none    : cannot perform
//   - own     : only records the user owns (ownerId === user.id)
//   - team    : records owned by anyone on the user's team (teamId === user.teamId)
//   - project : records tied to projects the user is assigned to
//   - all     : no restriction

export const RESOURCES = Object.freeze({
  DASHBOARD: 'dashboard',
  LEADS: 'leads',
  STAFF: 'staff',
  ROLES: 'roles',
  ATTENDANCE: 'attendance',
  VISITS: 'visits',
  PHOTOS: 'photos',
  COMMS: 'communications',
  REPORTS: 'reports',
  PROJECTS: 'projects',
  LISTINGS: 'listings',
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
  NONE: 'none',
  OWN: 'own',
  TEAM: 'team',
  PROJECT: 'project',
  ALL: 'all',
});

// Scope weight — used to pick the most permissive matching scope when checking records.
const SCOPE_WEIGHT = {
  none: 0,
  own: 1,
  team: 2,
  project: 3,
  all: 4,
};

// Role catalogue. Each role has a label, a description, and a default matrix.
// `super-admin` is intentionally distinct from `admin` so we can lock down a true
// org owner vs. delegated admin operations later.
export const ROLE_DEFINITIONS = {
  'super-admin': {
    id: 'super-admin',
    name: 'Super Admin',
    description:
      'Org owner. Unrestricted access. Manages roles, billing, security audits.',
    color: '#0F1A1F',
    accent: '#C49B4A',
    isSystem: true,
  },
  admin: {
    id: 'admin',
    name: 'Admin',
    description:
      'Configures teams, projects, and staff. Cannot redefine super-admin role.',
    color: '#1F3A36',
    accent: '#3F7B6F',
    isSystem: true,
  },
  'sales-manager': {
    id: 'sales-manager',
    name: 'Sales Manager',
    description:
      'Owns a sales team. Manages pipeline, approves bookings, reviews reports.',
    color: '#3D2E1F',
    accent: '#C49B4A',
  },
  'site-manager': {
    id: 'site-manager',
    name: 'Site Manager',
    description:
      'Owns site operations. Approves photos, attendance, and site visits.',
    color: '#2A3D2F',
    accent: '#5E8C5A',
  },
  'field-executive': {
    id: 'field-executive',
    name: 'Field Executive',
    description:
      'Field sales. Self check-in, logs visits, uploads site photos, follows up.',
    color: '#2E3447',
    accent: '#6F7BB3',
  },
  telecaller: {
    id: 'telecaller',
    name: 'Telecaller',
    description:
      'Phone-based lead qualification. Manages own call queue and follow-ups.',
    color: '#3F2D45',
    accent: '#9D6FA3',
  },
  'channel-partner-manager': {
    id: 'channel-partner-manager',
    name: 'Channel Partner Manager',
    description:
      'Manages external broker network and partner-attributed leads.',
    color: '#1F3D3A',
    accent: '#3F8C84',
  },
  accounts: {
    id: 'accounts',
    name: 'Accounts',
    description:
      'Read-only on pipeline, full access to bookings and payment reconciliation.',
    color: '#3D3A1F',
    accent: '#B0A14A',
  },
};

// Default permission matrix per role. Admins can later edit non-system role matrices
// from the Role Management UI.
const buildMatrix = (entries) => {
  const matrix = {};
  for (const [resource, actions] of Object.entries(entries)) {
    matrix[resource] = { ...actions };
  }
  return matrix;
};

export const DEFAULT_PERMISSION_MATRIX = {
  'super-admin': buildMatrix({
    dashboard: { view: 'all' },
    leads: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    staff: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    roles: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    attendance: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    visits: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    photos: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    communications: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    reports: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    projects: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    listings: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
  }),
  admin: buildMatrix({
    dashboard: { view: 'all' },
    leads: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    staff: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'team', export: 'all', delete: 'all' },
    roles: { view: 'all', create: 'none', edit: 'all', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    attendance: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    visits: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    photos: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    communications: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
    reports: { view: 'all', create: 'all', edit: 'all', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    projects: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'none', export: 'all', delete: 'none' },
    listings: { view: 'all', create: 'all', edit: 'all', assign: 'all', approve: 'all', export: 'all', delete: 'all' },
  }),
  'sales-manager': buildMatrix({
    dashboard: { view: 'team' },
    leads: { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
    staff: { view: 'team', create: 'none', edit: 'team', assign: 'team', approve: 'none', export: 'team', delete: 'none' },
    roles: { view: 'team', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance: { view: 'team', create: 'own', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'none' },
    visits: { view: 'team', create: 'team', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'none' },
    photos: { view: 'team', create: 'team', edit: 'team', assign: 'none', approve: 'team', export: 'team', delete: 'none' },
    communications: { view: 'team', create: 'all', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    reports: { view: 'team', create: 'team', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    projects: { view: 'project', create: 'none', edit: 'project', assign: 'project', approve: 'none', export: 'project', delete: 'none' },
    listings: { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
  }),
  'site-manager': buildMatrix({
    dashboard: { view: 'project' },
    leads: { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    staff: { view: 'project', create: 'none', edit: 'project', assign: 'project', approve: 'none', export: 'project', delete: 'none' },
    roles: { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance: { view: 'project', create: 'own', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    visits: { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    photos: { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
    communications: { view: 'project', create: 'project', edit: 'project', assign: 'none', approve: 'none', export: 'project', delete: 'none' },
    reports: { view: 'project', create: 'project', edit: 'project', assign: 'none', approve: 'none', export: 'project', delete: 'none' },
    projects: { view: 'project', create: 'none', edit: 'project', assign: 'project', approve: 'none', export: 'project', delete: 'none' },
    listings: { view: 'project', create: 'project', edit: 'project', assign: 'project', approve: 'project', export: 'project', delete: 'none' },
  }),
  'field-executive': buildMatrix({
    dashboard: { view: 'own' },
    leads: { view: 'own', create: 'all', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    staff: { view: 'own', create: 'none', edit: 'own', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    roles: { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance: { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    visits: { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    photos: { view: 'all', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'own' },
    communications: { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    reports: { view: 'own', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    projects: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    listings: { view: 'own', create: 'all', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
  }),
  telecaller: buildMatrix({
    dashboard: { view: 'own' },
    leads: { view: 'own', create: 'all', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    staff: { view: 'own', create: 'none', edit: 'own', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    roles: { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance: { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    visits: { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    photos: { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    communications: { view: 'own', create: 'own', edit: 'own', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    reports: { view: 'own', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'own', delete: 'none' },
    projects: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    listings: { view: 'own', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
  }),
  'channel-partner-manager': buildMatrix({
    dashboard: { view: 'team' },
    leads: { view: 'team', create: 'all', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
    staff: { view: 'team', create: 'none', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    roles: { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance: { view: 'team', create: 'own', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    visits: { view: 'team', create: 'team', edit: 'team', assign: 'team', approve: 'none', export: 'team', delete: 'none' },
    photos: { view: 'team', create: 'team', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    communications: { view: 'team', create: 'all', edit: 'team', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    reports: { view: 'team', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'team', delete: 'none' },
    projects: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    listings: { view: 'team', create: 'team', edit: 'team', assign: 'team', approve: 'team', export: 'team', delete: 'team' },
  }),
  accounts: buildMatrix({
    dashboard: { view: 'all' },
    leads: { view: 'all', create: 'none', edit: 'project', assign: 'none', approve: 'project', export: 'all', delete: 'none' },
    staff: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    roles: { view: 'none', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'none', delete: 'none' },
    attendance: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    visits: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'all', export: 'all', delete: 'none' },
    photos: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    communications: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    reports: { view: 'all', create: 'all', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    projects: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
    listings: { view: 'all', create: 'none', edit: 'none', assign: 'none', approve: 'none', export: 'all', delete: 'none' },
  }),
};

// Resources that surface in the navigation. Kept here so the same list drives
// role management UI and sidebar/menu visibility.
export const NAV_RESOURCES = [
  { resource: RESOURCES.DASHBOARD, label: 'Dashboard', iconKey: 'dashboard' },
  { resource: RESOURCES.LEADS, label: 'Leads', iconKey: 'leads' },
  { resource: RESOURCES.STAFF, label: 'Staff', iconKey: 'staff' },
  { resource: RESOURCES.ROLES, label: 'Roles & Permissions', iconKey: 'roles' },
  { resource: RESOURCES.ATTENDANCE, label: 'Attendance', iconKey: 'attendance' },
  { resource: RESOURCES.VISITS, label: 'Site Visits', iconKey: 'visits' },
  { resource: RESOURCES.PHOTOS, label: 'Site Photos', iconKey: 'photos' },
  { resource: RESOURCES.COMMS, label: 'Communication', iconKey: 'comms' },
  { resource: RESOURCES.REPORTS, label: 'Reports', iconKey: 'reports' },
  { resource: RESOURCES.LISTINGS, label: 'Inventory', iconKey: 'listings' },
];

// Scope label map for UI display.
export const SCOPE_LABELS = {
  none: 'No access',
  own: 'Own records',
  team: 'Team records',
  project: 'Project records',
  all: 'All records',
};

export const SCOPE_COLORS = {
  none: '#8A8F8C',
  own: '#6F7BB3',
  team: '#3F7B6F',
  project: '#C49B4A',
  all: '#0F1A1F',
};

// scopeOf returns the configured scope for a user on a resource+action.
// Returns 'none' if the user has no entry.
export function scopeOf(user, resource, action) {
  const matrix = user?.permissionMatrix;
  if (!matrix) return SCOPES.NONE;
  const scopes = matrix[resource];
  if (!scopes) return SCOPES.NONE;
  return scopes[action] || SCOPES.NONE;
}

// can checks whether a user can perform `action` on `resource`.
// If `record` is omitted, returns true when any scope > 'none' is granted.
// If `record` is provided, returns true only when the record passes the scope.
export function can(user, resource, action, record = null) {
  const scope = scopeOf(user, resource, action);
  if (scope === SCOPES.NONE) return false;
  if (!record) return true;

  switch (scope) {
    case SCOPES.ALL:
      return true;
    case SCOPES.OWN: {
      if (!user) return false;
      // Listings extension point: a listing is "owned" by a user when the user
      // is either the assignee or the original collector. This keeps the generic
      // permission helper untouched for other resources.
      if (resource === RESOURCES.LISTINGS) {
        return Boolean(
          record.assignedTo === user.id || record.createdBy === user.id
        );
      }
      return record.ownerId === user.id;
    }
    case SCOPES.TEAM:
      return Boolean(user && record.teamId && record.teamId === user.teamId);
    case SCOPES.PROJECT:
      return Boolean(
        user && record.projectId && Array.isArray(user.projectIds)
          && user.projectIds.includes(record.projectId)
      );
    default:
      return false;
  }
}

// filterByScope trims a record collection down to what `user` can `action`
// on `resource`. Used by list views so they don't need to know scope rules.
export function filterByScope(user, resource, action, records) {
  const scope = scopeOf(user, resource, action);
  if (scope === SCOPES.NONE) return [];
  if (scope === SCOPES.ALL) return records;
  if (!user) return [];
  return records.filter((record) => can(user, resource, action, record));
}

// maxScope returns the highest scope across actions for a resource.
// Useful for "show this nav item if user has any access".
export function maxScope(user, resource) {
  if (!user) return SCOPES.NONE;
  let best = SCOPES.NONE;
  for (const action of ACTIONS) {
    const s = scopeOf(user, resource, action);
    if (SCOPE_WEIGHT[s] > SCOPE_WEIGHT[best]) best = s;
  }
  return best;
}

// hasAnyAccess is a quick check for nav visibility.
export function hasAnyAccess(user, resource) {
  return maxScope(user, resource) !== SCOPES.NONE;
}

// isSystemRole protects system roles from deletion or full overwrite.
export function isSystemRole(roleId) {
  return Boolean(ROLE_DEFINITIONS[roleId]?.isSystem);
}

// mergeMatrix overrides a base matrix with customisations.
// Used after an admin edits a non-system role's matrix.
export function mergeMatrix(base, overrides) {
  const next = {};
  for (const [resource, actions] of Object.entries(base || {})) {
    next[resource] = { ...actions, ...(overrides?.[resource] || {}) };
  }
  return next;
}

// describeRecord returns a string identifying a record for permission error UI.
export function describeRecord(record) {
  if (!record) return '';
  return record.name || record.title || record.id || '';
}
