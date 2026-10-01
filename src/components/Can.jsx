// Permission gate. Every UI surface that depends on access goes through <Can>.
//
// Usage:
//   <Can resource="leads" action="create">
//     <Button>New lead</Button>
//   </Can>
//
//   <Can resource="leads" action="edit" record={lead}>
//     <Button>Edit</Button>
//   </Can>
//
//   <Can resource="leads" action="view" fallback={<RestrictedState />}>
//     <LeadTable />
//   </Can>
//
// The gate is intentionally dumb: it asks the store, the store asks the matrix.

import React from 'react';
import { useStore } from '../state/store.jsx';
import { RestrictedState } from './ui.jsx';

export function Can({
  resource,
  action,
  record = null,
  children,
  fallback = null,
  showFallbackAsRestricted = false,
  scopeOnly = false,
}) {
  const { can, scopeOf, currentUser, roleDefinitions } = useStore();
  if (!currentUser) return null;

  // scopeOnly lets callers branch on the granted scope without checking a record,
  // e.g. <Can resource="leads" action="view" scopeOnly>{scoped}</Can>
  if (scopeOnly) {
    const scope = scopeOf(resource, action);
    if (scope === 'none') return fallback;
    return typeof children === 'function' ? children(scope) : children;
  }

  const allowed = can(resource, action, record);
  if (allowed) return children;

  if (fallback) return fallback;
  if (showFallbackAsRestricted) {
    const role = roleDefinitions[currentUser.role]?.name || currentUser.role;
    return (
      <RestrictedState
        resource={resource}
        action={action}
        scope={scopeOf(resource, action)}
        role={role}
      />
    );
  }
  return null;
}

// Helper hook for ad-hoc checks (e.g., inside event handlers).
export function usePermissions() {
  const { can, scopeOf, currentUser } = useStore();
  return {
    can: (resource, action, record = null) => can(resource, action, record),
    scopeOf: (resource, action) => scopeOf(resource, action),
    role: currentUser?.role,
  };
}
