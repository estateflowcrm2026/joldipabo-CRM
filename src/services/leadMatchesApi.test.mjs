import assert from 'node:assert/strict';
import { leadMatchesApi } from './leadMatchesApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ leadId: 'ld_1', items: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await leadMatchesApi.list('ld_1');
  assert.match(calls.at(-1).url, /\/leads\/ld_1\/matches$/);
  assert.equal(calls.at(-1).options.method, 'GET');

  await leadMatchesApi.refresh('ld_1');
  assert.match(calls.at(-1).url, /\/leads\/ld_1\/matches$/);
  assert.equal(calls.at(-1).options.method, 'POST');

  await leadMatchesApi.refresh('ld_1', { topN: 5, minScore: 35 });
  assert.match(calls.at(-1).url, /\/leads\/ld_1\/matches\?topN=5&minScore=35$/);

  await leadMatchesApi.update('ld_1', 'l_1', { status: 'viewed_by_lead' });
  assert.match(calls.at(-1).url, /\/leads\/ld_1\/matches\/l_1$/);
  assert.equal(calls.at(-1).options.method, 'PATCH');

  await leadMatchesApi.list('lead_/unsafe');
  assert.match(calls.at(-1).url, /\/leads\/lead_%2Funsafe\/matches$/);
  console.log('lead matches API: 7 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
