import { apiRequest } from './apiClient.js';

// Lead timeline — one chronological history per lead, read-only.
//
// Backed by GET /api/v1/leads/:id/timeline. Returns
// `{ leadId, items: [{ id, type, occurredAt, title, detail, actor, meta }] }`
// where type is one of: contact_created | call | lead_created |
// visit_event | viewing | follow_up. Out-of-scope rows are skipped
// server-side; an out-of-scope lead 404s like GET /leads/:id.

const path = (id) => `/leads/${encodeURIComponent(id)}/timeline`;

export const leadTimelineApi = {
  get: (id, signal) => apiRequest(path(id), { signal }),
};
