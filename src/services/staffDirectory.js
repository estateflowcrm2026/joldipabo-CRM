// Staff directory — the eligible-assignee source for listing assignment.
//
// WHY THIS EXISTS
// ---------------
// Both the desktop "Assign listing" picker and the mobile reassign control
// need a list of people a listing can be assigned to. Until now that list
// came straight from `state.users`, which is the seeded demo roster — and
// `state.users` is populated with seed data EVEN IN LIVE MODE. Showing it
// in a live build means offering the operator a dropdown of strangers whose
// ids do not exist in the backend, so every "Assign" would 404.
//
// A live build must draw assignees from the backend. The backend has no
// implemented staff-list endpoint yet:
//
//   GET /api/v1/users  → { items: [], placeholder: true }   (server/src/routes/users.js)
//   GET /api/v1/teams  → { items: [], placeholder: true }
//
// So today there is NO backend source. Rather than silently show seed
// strangers, live mode withholds the assignment control entirely and
// reports the dependency (see the `reason` field). When a real staff
// endpoint lands, this hook is the one place that learns about it.
//
// Demo mode keeps working exactly as before: the seeded roster is the
// source, and the pickers render.

import { useMemo } from 'react';
import { useStore } from '../state/store.jsx';
import { isApiRepositoryActive } from './index.js';

/**
 * Roles that may own a listing. Mirrors the roles that appear in the demo
 * assignment pickers and that hold a listings scope. The backend enforces
 * its own rule (the target must be Active and in the caller's tenant); this
 * list only shapes the demo dropdown.
 */
export const ASSIGNABLE_ROLES = Object.freeze([
  'super-admin',
  'admin',
  'sales-manager',
  'site-manager',
  'channel-partner-manager',
  'field-executive',
]);

/**
 * The eligible-assignee source.
 *
 * @returns {{
 *   staff: object[],        — eligible people, or [] when unavailable
 *   available: boolean,     — whether assignment can be offered at all
 *   source: 'seed'|'unavailable',
 *   reason: string|null,    — why it is unavailable, for the UI to surface
 * }}
 */
export function useAssignableStaff() {
  const { state } = useStore();
  const live = isApiRepositoryActive();

  return useMemo(() => {
    if (live) {
      return {
        staff: [],
        available: false,
        source: 'unavailable',
        reason:
          'The backend has no staff directory endpoint yet, so a listing ' +
          'cannot be assigned to a real person from here. Assignment is ' +
          'withheld in live mode rather than offering seeded demo users.',
      };
    }
    return {
      staff: (state.users || []).filter((u) => ASSIGNABLE_ROLES.includes(u.role)),
      available: true,
      source: 'seed',
      reason: null,
    };
  }, [live, state.users]);
}
