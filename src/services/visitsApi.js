import { apiRequest } from './apiClient.js';

const path = (id) => `/visits/${encodeURIComponent(id)}`;

export const visitsApi = {
  list: (query, signal) => apiRequest('/visits', { query, signal }),
  get: (id, signal) => apiRequest(path(id), { signal }),
  assignees: (signal) => apiRequest('/visits/assignees', { signal }),
  create: (body) => apiRequest('/visits', { method: 'POST', body }),
  status: (id, body) => apiRequest(`${path(id)}/status`, { method: 'POST', body }),
  assign: (id, body) => apiRequest(`${path(id)}/assign`, { method: 'POST', body }),
  addViewing: (id, body) => apiRequest(`${path(id)}/viewings`, { method: 'POST', body }),
};
