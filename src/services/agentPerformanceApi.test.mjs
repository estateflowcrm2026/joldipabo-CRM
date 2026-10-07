import assert from 'node:assert/strict';
import { agentPerformanceApi } from './agentPerformanceApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ items: [], range: { from: '2026-09-03', to: '2026-10-03' } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await agentPerformanceApi.get({ preset: 'monthly' });
  assert.match(calls.at(-1).url, /\/reports\/agent-performance\?preset=monthly$/);

  await agentPerformanceApi.get({ preset: 'custom', from: '2026-09-01', to: '2026-09-07' });
  assert.match(calls.at(-1).url, /preset=custom&from=2026-09-01&to=2026-09-07$/);

  await agentPerformanceApi.get({ preset: 'monthly', agentId: 'u-asha' });
  assert.match(calls.at(-1).url, /agentId=u-asha$/);
  console.log('agent performance API: 3 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
