import { apiRequest } from './apiClient.js';

// Lead ↔ listing matches — saved suggestions per lead, live API-backed.
//
// Backed by:
//   GET   /api/v1/leads/:id/matches               → { leadId, items: [...] }
//   POST  /api/v1/leads/:id/matches               → 201 { leadId, items: [...] }
//   PATCH /api/v1/leads/:id/matches/:listingId    → one updated match row
//
// Each item is `{ id, listingId, score, status, note, reason, matchedAt,
// listing: { id, title, city, locality, price, rentMonthly, bedrooms,
// propertyType, serviceCategory, availabilityStatus } }` where status is
// one of suggested | viewed_by_lead | visit_scheduled | rejected_by_lead |
// withdrawn. Out-of-scope listings are skipped server-side; an
// out-of-scope lead 404s like GET /leads/:id.

const path = (id) => `/leads/${encodeURIComponent(id)}/matches`;
const rowPath = (id, listingId) => `${path(id)}/${encodeURIComponent(listingId)}`;

export const leadMatchesApi = {
  list: (id, signal) => apiRequest(path(id), { signal }),
  refresh: (id, { topN, minScore } = {}, signal) => {
    const params = new URLSearchParams();
    if (topN != null) params.set('topN', String(topN));
    if (minScore != null) params.set('minScore', String(minScore));
    const query = params.size ? `?${params}` : '';
    return apiRequest(`${path(id)}${query}`, { method: 'POST', signal });
  },
  update: (id, listingId, changes, signal) =>
    apiRequest(rowPath(id, listingId), { method: 'PATCH', body: changes, signal }),
};
