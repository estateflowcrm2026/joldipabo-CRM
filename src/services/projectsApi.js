import { apiRequest } from './apiClient.js';

/**
 * Projects directory — GET /api/v1/projects.
 *
 * The live source for project pickers and filters in live mode. The backend
 * tenant-scopes and scope-filters by the caller's `projects:view` grant
 * (all / team-member-projects+own / own / own / none-fail-closed). The DTO
 * carries the manager's name and unit counts — amenities, RERA numbers and
 * possession dates are not exposed.
 *
 * Filters mirror the backend allow-list (q, city, stage) plus the
 * leads-list pagination convention (limit default 25, max 100).
 */
export const projectsApi = {
  list: (query, signal) => apiRequest('/projects', { query, signal }),
};
