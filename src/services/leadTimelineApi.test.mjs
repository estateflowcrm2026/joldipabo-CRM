import assert from 'node:assert/strict';
import { leadTimelineApi } from './leadTimelineApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ leadId: 'ld_1', items: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await leadTimelineApi.get('ld_1');
  assert.match(calls.at(-1).url, /\/leads\/ld_1\/timeline$/);
  assert.equal(calls.at(-1).options.method, 'GET');

  await leadTimelineApi.get('lead_/unsafe');
  assert.match(calls.at(-1).url, /\/leads\/lead_%2Funsafe\/timeline$/);
  console.log('lead timeline API: 3 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
