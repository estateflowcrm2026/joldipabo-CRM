import { apiRequest } from './apiClient.js';

/**
 * Staff directory — GET /api/v1/users.
 *
 * The live source for every assignee/owner picker in live mode. The backend
 * tenant-scopes and scope-filters by the caller's `staff:view` grant, so the
 * caller only ever sees who they may see. The DTO carries no secrets.
 *
 * Filters mirror the backend allow-list (role, teamId, status, q) plus the
 * leads-list pagination convention (limit default 25, max 100).
 *
 * Manual provisioning (no email — the admin shares the password out of
 * band, and it is never shown again):
 *   create({ name, email, phone?, roleId, teamId?, designation?, status?,
 *            initialPassword })
 *     → { id, email, status }
 *   resetPassword(userId, { newPassword }) → { ok, userId, sessionsRevoked }
 */
export const staffApi = {
  list: (query, signal) => apiRequest('/users', { query, signal }),
  create: (input, signal) => apiRequest('/users', { method: 'POST', body: input, signal }),
  resetPassword: (userId, input, signal) =>
    apiRequest(`/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST', body: input, signal,
    }),
};
