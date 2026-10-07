import assert from 'node:assert/strict';
import { contactIntakeApi } from './contactIntakeApi.js';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return new Response(JSON.stringify({ items: [], pagination: { total: 0 }, id: 'ct_1', leadId: 'ld_1' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

try {
  await contactIntakeApi.listContacts({ q: 'Asha', limit: 25, offset: 25 });
  assert.match(calls.at(-1).url, /\/contacts\?q=Asha&limit=25&offset=25$/);

  await contactIntakeApi.logCall('ct_1', { direction: 'inbound', outcome: 'interested' });
  assert.match(calls.at(-1).url, /\/contacts\/ct_1\/calls$/);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { direction: 'inbound', outcome: 'interested' });

  await contactIntakeApi.convert('ct_1');
  assert.match(calls.at(-1).url, /\/contacts\/ct_1\/convert$/);
  assert.equal(calls.at(-1).options.method, 'POST');

  await contactIntakeApi.updateLead('ld_1', { status: 'Contacted', nextFollowUp: null });
  assert.match(calls.at(-1).url, /\/leads\/ld_1$/);
  assert.equal(calls.at(-1).options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { status: 'Contacted', nextFollowUp: null });

  await contactIntakeApi.getContact('ct_/unsafe');
  assert.match(calls.at(-1).url, /\/contacts\/ct_%2Funsafe$/);

  await contactIntakeApi.listLeads({ followUpTo: '2026-10-06T00:00:00.000Z', q: 'Asha', limit: 25, offset: 0 });
  assert.match(calls.at(-1).url, /\/leads\?followUpTo=2026-10-06T00%3A00%3A00\.000Z&q=Asha&limit=25&offset=0$/);

  await contactIntakeApi.listContacts({ followUpSet: 'set', limit: 25, offset: 0 });
  assert.match(calls.at(-1).url, /\/contacts\?followUpSet=set&limit=25&offset=0$/);
  console.log('contact intake API: 12 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
