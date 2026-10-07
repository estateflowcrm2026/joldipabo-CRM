import { apiRequest } from './apiClient.js';

/**
 * Teams directory — GET /api/v1/teams.
 *
 * The live source for team pickers and filters in live mode. The backend
 * tenant-scopes and scope-filters by the caller's `staff:view` grant, so the
 * caller only ever sees who they may see. `teams` has no status column, so
 * `q` is the only filter. The DTO carries member counts and the lead's
 * name — nothing secret exists on this table.
 *
 * Filters mirror the backend allow-list (q) plus the leads-list pagination
 * convention (limit default 25, max 100).
 */
export const teamsApi = {
  list: (query, signal) => apiRequest('/teams', { query, signal }),
};
