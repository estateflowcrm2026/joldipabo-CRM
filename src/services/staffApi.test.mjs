import assert from 'node:assert/strict';
import { staffApi } from './staffApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ items: [], pagination: { limit: 25, offset: 0, total: 0 } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await staffApi.list({ limit: 100 });
  assert.match(calls.at(-1).url, /\/users\?limit=100$/);

  await staffApi.list({ role: 'field-executive', teamId: 't_north', status: 'Active', q: 'asha' });
  assert.match(calls.at(-1).url, /\/users\?role=field-executive&teamId=t_north&status=Active&q=asha$/);

  console.log('staff API: 2 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
