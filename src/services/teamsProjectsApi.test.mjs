import assert from 'node:assert/strict';
import { teamsApi } from './teamsApi.js';
import { projectsApi } from './projectsApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ items: [], pagination: { limit: 25, offset: 0, total: 0 } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await teamsApi.list({ limit: 100 });
  assert.match(calls.at(-1).url, /\/teams\?limit=100$/);

  await teamsApi.list({ q: 'north', limit: 50, offset: 10 });
  assert.match(calls.at(-1).url, /\/teams\?q=north&limit=50&offset=10$/);

  await projectsApi.list({ limit: 100 });
  assert.match(calls.at(-1).url, /\/projects\?limit=100$/);

  await projectsApi.list({ q: 'sky', city: 'Bangalore', stage: 'Booking open', limit: 50 });
  assert.match(
    calls.at(-1).url,
    /\/projects\?q=sky&city=Bangalore&stage=Booking%20open&limit=50$/,
  );

  console.log('teams/projects API: 4 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
