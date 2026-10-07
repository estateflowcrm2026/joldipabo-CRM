import assert from 'node:assert/strict';
import { visitsApi } from './visitsApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ items: [], id: 'visit_1' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await visitsApi.list({ leadId: 'ld_1', limit: 25, offset: 0 });
  assert.match(calls.at(-1).url, /\/visits\?leadId=ld_1&limit=25&offset=0$/);

  await visitsApi.list({ status: 'Assigned', assignedTo: 'u_1', from: '2026-10-04T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', order: 'asc' });
  assert.match(calls.at(-1).url, /\/visits\?status=Assigned&assignedTo=u_1&from=2026-10-04T00%3A00%3A00\.000Z&to=2026-10-11T00%3A00%3A00\.000Z&order=asc$/);

  await visitsApi.create({ leadId: 'ld_1', assignedTo: 'u_1', scheduledAt: '2026-10-04T10:00:00Z' });
  assert.match(calls.at(-1).url, /\/visits$/);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(JSON.parse(calls.at(-1).options.body).assignedTo, 'u_1');

  await visitsApi.status('visit_1', { status: 'Accepted' });
  assert.match(calls.at(-1).url, /\/visits\/visit_1\/status$/);
  assert.equal(JSON.parse(calls.at(-1).options.body).status, 'Accepted');

  await visitsApi.addViewing('visit_1', { listingId: 'ls_1', assistanceStatus: 'assisted' });
  assert.match(calls.at(-1).url, /\/visits\/visit_1\/viewings$/);
  assert.equal(JSON.parse(calls.at(-1).options.body).listingId, 'ls_1');

  await visitsApi.get('visit_/unsafe');
  assert.match(calls.at(-1).url, /\/visits\/visit_%2Funsafe$/);
  console.log('visits API: 10 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
