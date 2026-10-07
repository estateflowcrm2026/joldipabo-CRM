import { apiRequest } from './apiClient.js';

export const agentPerformanceApi = {
  get: (query, signal) => apiRequest('/reports/agent-performance', { query, signal }),
};
