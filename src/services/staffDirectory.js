// Staff directory — the eligible-assignee source for listing assignment.
//
// WHY THIS EXISTS
// ---------------
// Both the desktop "Assign listing" picker and the mobile reassign control
// need a list of people a listing can be assigned to. That list must never
// come from `state.users` in live mode: the store's roster is seeded demo
// data, and its ids do not exist in the backend, so every "Assign" would
// 404.
//
// In live mode the source is GET /api/v1/users (see staffApi.js), which the
// backend tenant-scopes and scope-filters by the caller's `staff:view`
// grant. The hook fetches once per mount with loading / error / retry
// state, following the listingsData.jsx pattern: on error the staff list is
// [] — never seed — and the pickers surface the failure with a retry
// affordance.
//
// Demo mode keeps working exactly as before: the seeded roster is the
// source, and the pickers render.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { isApiRepositoryActive } from './index.js';
import { staffApi } from './staffApi.js';

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
 * Demo mode: the seeded roster, filtered to assignable roles. Status
 * 'ready', no error.
 *
 * Live mode: fetched from GET /api/v1/users (limit 100, the largest page
 * the directory offers — assignment pickers need the whole visible roster,
 * not a paginated slice). Status cycles 'loading' → 'ready' | 'error'. On
 * error the staff list is [] — never seed — and `retry` re-issues the
 * request. `available` is true only when there is at least one person to
 * offer; an empty directory and a failed load both withhold the picker,
 * with `reason` saying which.
 *
 * @returns {{
 *   staff: object[],
 *   available: boolean,
 *   loading: boolean,
 *   source: 'seed'|'live'|'unavailable',
 *   reason: string|null,
 *   error: Error|null,
 *   retry: () => void,
 * }}
 */
export function useAssignableStaff() {
  const { state } = useStore();
  const live = isApiRepositoryActive();
  const [directory, setDirectory] = useState({ staff: [], status: 'loading', error: null });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setDirectory((prev) => ({ ...prev, status: 'loading', error: null }));
    try {
      const result = await staffApi.list({ limit: 100 });
      if (requestId !== requestIdRef.current) return;
      setDirectory({ staff: result.items || [], status: 'ready', error: null });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setDirectory({ staff: [], status: 'error', error: err });
    }
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    load();
    return undefined;
  }, [live, load]);

  return useMemo(() => {
    if (!live) {
      return {
        staff: (state.users || []).filter((u) => ASSIGNABLE_ROLES.includes(u.role)),
        available: true,
        loading: false,
        source: 'seed',
        reason: null,
        error: null,
        retry: () => {},
      };
    }
    if (directory.status === 'loading') {
      return {
        staff: [],
        available: false,
        loading: true,
        source: 'live',
        reason: null,
        error: null,
        retry: load,
      };
    }
    if (directory.status === 'error') {
      return {
        staff: [],
        available: false,
        loading: false,
        source: 'unavailable',
        reason: 'Could not load the staff directory. Check the connection and try again.',
        error: directory.error,
        retry: load,
      };
    }
    if (directory.staff.length === 0) {
      return {
        staff: [],
        available: false,
        loading: false,
        source: 'live',
        reason: 'No active staff are visible to you, so there is nobody to assign to.',
        error: null,
        retry: load,
      };
    }
    return {
      staff: directory.staff,
      available: true,
      loading: false,
      source: 'live',
      reason: null,
      error: null,
      retry: load,
    };
  }, [live, state.users, directory, load]);
}
