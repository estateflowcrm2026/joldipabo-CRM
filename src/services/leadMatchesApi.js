import { apiRequest } from './apiClient.js';

// Lead ↔ listing matches — saved suggestions per lead, live API-backed.
//
// Backed by:
//   GET   /api/v1/leads/:id/matches               → { leadId, items: [...] }
//   POST  /api/v1/leads/:id/matches               → 201 { leadId, items: [...] }
//   PATCH /api/v1/leads/:id/matches/:listingId    → one updated match row
//   GET   /api/v1/listings/:id/interested-leads   → { listingId, items: [...] }
//
// Each item is `{ id, listingId, score, status, note, reason, matchedAt,
// listing: { id, title, city, locality, price, rentMonthly, bedrooms,
// propertyType, serviceCategory, availabilityStatus } }` where status is
// one of suggested | viewed_by_lead | visit_scheduled | rejected_by_lead |
// withdrawn. Out-of-scope listings are skipped server-side; an
// out-of-scope lead 404s like GET /leads/:id.

const path = (id) => `/leads/${encodeURIComponent(id)}/matches`;
const rowPath = (id, listingId) => `${path(id)}/${encodeURIComponent(listingId)}`;
const listingPath = (id) => `/listings/${encodeURIComponent(id)}/interested-leads`;

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
  // Listing-side pivot: saved matches for one listing, score-desc.
  // Optional `status` narrows to one match status.
  interestedLeads: (listingId, { status } = {}, signal) => {
    const params = new URLSearchParams();
    if (status != null && status !== '') params.set('status', String(status));
    const query = params.size ? `?${params}` : '';
    return apiRequest(`${listingPath(listingId)}${query}`, { signal });
  },
};
