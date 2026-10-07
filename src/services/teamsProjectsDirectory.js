// Teams + projects directories — the live sources for team and project
// pickers and filters in live mode.
//
// WHY THIS EXISTS
// ---------------
// Pickers must never draw from `state.teams` / `state.projects` in live mode:
// the store's rosters are seeded demo data, and their ids do not exist in
// the backend, so every write carrying one would 404 (or silently attach a
// meaningless id).
//
// In live mode the sources are GET /api/v1/teams and GET /api/v1/projects
// (see teamsApi.js / projectsApi.js), which the backend tenant-scopes and
// scope-filters by the caller's grants. Each hook fetches once per mount
// with loading / error / retry state, following the staffDirectory.jsx
// pattern: on error the list is [] — never seed — and the pickers surface
// the failure with a retry affordance.
//
// Demo mode keeps working exactly as before: the seeded rosters are the
// sources.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import { isApiRepositoryActive } from './index.js';
import { teamsApi } from './teamsApi.js';
import { projectsApi } from './projectsApi.js';

function useDirectory({ live, seedItems, fetchList, emptyReason }) {
  const [directory, setDirectory] = useState({ items: [], status: 'loading', error: null });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setDirectory((prev) => ({ ...prev, status: 'loading', error: null }));
    try {
      const result = await fetchList({ limit: 100 });
      if (requestId !== requestIdRef.current) return;
      setDirectory({ items: result.items || [], status: 'ready', error: null });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setDirectory({ items: [], status: 'error', error: err });
    }
  }, [fetchList]);

  useEffect(() => {
    if (!live) return undefined;
    load();
    return undefined;
  }, [live, load]);

  return useMemo(() => {
    if (!live) {
      return {
        items: seedItems,
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
        items: [],
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
        items: [],
        available: false,
        loading: false,
        source: 'unavailable',
        reason: 'Could not load the directory. Check the connection and try again.',
        error: directory.error,
        retry: load,
      };
    }
    if (directory.items.length === 0) {
      return {
        items: [],
        available: false,
        loading: false,
        source: 'live',
        reason: emptyReason,
        error: null,
        retry: load,
      };
    }
    return {
      items: directory.items,
      available: true,
      loading: false,
      source: 'live',
      reason: null,
      error: null,
      retry: load,
    };
  }, [live, seedItems, directory, load, emptyReason]);
}

/**
 * The team picker/filter source.
 *
 * Demo mode: the seeded roster. Live mode: fetched from GET /api/v1/teams
 * (limit 100). Status cycles 'loading' → 'ready' | 'error'.
 *
 * @returns {{ items: object[], available: boolean, loading: boolean,
 *   source: 'seed'|'live'|'unavailable', reason: string|null,
 *   error: Error|null, retry: () => void }}
 */
export function useTeamsDirectory() {
  const { state } = useStore();
  const live = isApiRepositoryActive();
  return useDirectory({
    live,
    seedItems: state.teams || [],
    fetchList: teamsApi.list,
    emptyReason: 'No teams are visible to you.',
  });
}

/**
 * The project picker/filter source.
 *
 * Demo mode: the seeded roster. Live mode: fetched from
 * GET /api/v1/projects (limit 100). Status cycles 'loading' → 'ready' |
 * 'error'.
 *
 * @returns {{ items: object[], available: boolean, loading: boolean,
 *   source: 'seed'|'live'|'unavailable', reason: string|null,
 *   error: Error|null, retry: () => void }}
 */
export function useProjectsDirectory() {
  const { state } = useStore();
  const live = isApiRepositoryActive();
  return useDirectory({
    live,
    seedItems: state.projects || [],
    fetchList: projectsApi.list,
    emptyReason: 'No projects are visible to you.',
  });
}
