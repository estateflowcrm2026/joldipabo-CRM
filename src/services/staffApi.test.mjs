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

  await staffApi.create({
    name: 'New Hire', email: 'hire@acme.example', roleId: 'field-executive',
    teamId: 't_north', initialPassword: 'a-strong-password-1',
  });
  assert.match(calls.at(-1).url, /\/users$/);
  assert.equal(calls.at(-1).options.method, 'POST');
  const createdBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(createdBody.initialPassword, 'a-strong-password-1');

  await staffApi.resetPassword('u-asha', { newPassword: 'a-new-password-2' });
  assert.match(calls.at(-1).url, /\/users\/u-asha\/reset-password$/);
  assert.equal(calls.at(-1).options.method, 'POST');
  const resetBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(resetBody.newPassword, 'a-new-password-2');

  console.log('staff API: 4 assertions passed');
} finally {
  globalThis.fetch = originalFetch;
}
