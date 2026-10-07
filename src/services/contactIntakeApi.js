import { apiRequest } from './apiClient.js';

export const contactIntakeApi = {
  listContacts: (query, signal) => apiRequest('/contacts', { query, signal }),
  getContact: (id, signal) => apiRequest(`/contacts/${encodeURIComponent(id)}`, { signal }),
  listCalls: (id, query, signal) => apiRequest(`/contacts/${encodeURIComponent(id)}/calls`, { query, signal }),
  createContact: (body) => apiRequest('/contacts', { method: 'POST', body }),
  logCall: (id, body) => apiRequest(`/contacts/${encodeURIComponent(id)}/calls`, { method: 'POST', body }),
  convert: (id) => apiRequest(`/contacts/${encodeURIComponent(id)}/convert`, { method: 'POST' }),
  listLeads: (query, signal) => apiRequest('/leads', { query, signal }),
  getLead: (id, signal) => apiRequest(`/leads/${encodeURIComponent(id)}`, { signal }),
  updateLead: (id, body) => apiRequest(`/leads/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
};
