// Live development-only HTTP verification. Creates a uniquely marked fixture,
// then removes exactly its contact, call, and lead rows with the admin role.
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { adminDatabaseUrl } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';
import { issueAccessToken } from '../src/auth/tokenService.js';

if (process.env.NODE_ENV === 'production' || process.env.CONTACT_VERIFY_WRITE !== '1') {
  throw new Error('Development-only verification requires CONTACT_VERIFY_WRITE=1.');
}

const adminUrl = adminDatabaseUrl();
if (!adminUrl || !process.env.APP_DATABASE_URL) {
  throw new Error('Both DATABASE_URL and APP_DATABASE_URL are required.');
}

const base = process.env.CONTACT_VERIFY_BASE_URL || 'http://127.0.0.1:4000';
const marker = `CONTACT_VERIFY_${randomBytes(8).toString('hex')}`;
const token = issueAccessToken({ sub: 'u-super', tid: 'org_acme' }).token;
const otherTenantToken = issueAccessToken({ sub: 'u-super', tid: 'org_nonexistent' }).token;
const fieldToken = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' }).token;
const admin = new Client({
  connectionString: adminUrl,
  ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }),
});
let contactId;
let callId;
let leadId;
let checks = 0;
let connected = false;

function expect(condition, description) {
  if (!condition) throw new Error(description);
  checks += 1;
  console.log(`ok ${description}`);
}

async function request(path, { method = 'GET', body, bearer = token } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

try {
  await admin.connect();
  connected = true;
  const created = await request('/contacts', {
    method: 'POST',
    body: { name: marker, phone: '+910000000099', requirements: '2 BHK near transit' },
  });
  contactId = created.data?.id;
  expect(created.status === 201 && typeof contactId === 'string', 'contact created through HTTP');

  const detail = await request(`/contacts/${contactId}`);
  expect(detail.status === 200 && detail.data.name === marker, 'contact detail round-trips');

  const hidden = await request(`/contacts/${contactId}`, { bearer: fieldToken });
  expect(hidden.status === 404, 'out-of-scope user gets existence-hiding 404');

  const foreign = await request(`/contacts/${contactId}`, { bearer: otherTenantToken });
  expect([401, 403, 404].includes(foreign.status), 'cross-tenant identity cannot read contact');

  const call = await request(`/contacts/${contactId}/calls`, {
    method: 'POST',
    body: {
      direction: 'inbound', outcome: 'interested', occurredAt: new Date().toISOString(),
      durationSeconds: 34, notes: marker, nextFollowUp: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  callId = call.data?.id;
  expect(call.status === 201 && typeof callId === 'string', 'call logged through HTTP');

  const history = await request(`/contacts/${contactId}/calls?limit=1&offset=0`);
  expect(history.status === 200 && history.data.items?.[0]?.id === callId && history.data.pagination?.total === 1, 'call history is pageable');

  const converted = await request(`/contacts/${contactId}/convert`, { method: 'POST' });
  leadId = converted.data?.leadId;
  expect(converted.status === 200 && converted.data.created === true && typeof leadId === 'string', 'contact converted to lead');

  const repeated = await request(`/contacts/${contactId}/convert`, { method: 'POST' });
  expect(repeated.status === 200 && repeated.data.created === false && repeated.data.leadId === leadId, 'repeat conversion is idempotent');

  const lead = await request(`/leads/${leadId}`);
  expect(lead.status === 200 && lead.data.name === marker, 'linked lead is readable');
} finally {
  try {
    if (connected) {
      // Never search by a broad prefix. Only clean the exact fixture created here.
      const rows = await admin.query('SELECT id, lead_id FROM contacts WHERE tenant_id=$1 AND name=$2 AND created_by=$3', ['org_acme', marker, 'u-super']);
      for (const row of rows.rows) {
        await admin.query('DELETE FROM contact_calls WHERE tenant_id=$1 AND contact_id=$2 AND notes=$3', ['org_acme', row.id, marker]);
        await admin.query('DELETE FROM contacts WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', row.id, marker]);
        if (row.lead_id) await admin.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', row.lead_id, marker]);
      }
      const leftover = await admin.query(`SELECT
        (SELECT COUNT(*)::int FROM contacts WHERE tenant_id=$1 AND name=$2) AS contacts,
        (SELECT COUNT(*)::int FROM leads WHERE tenant_id=$1 AND name=$2) AS leads,
        (SELECT COUNT(*)::int FROM contact_calls WHERE tenant_id=$1 AND notes=$2) AS calls`, ['org_acme', marker]);
      const counts = leftover.rows[0];
      if (counts.contacts || counts.leads || counts.calls) {
        throw new Error(`Verification fixture cleanup incomplete: ${JSON.stringify(counts)}`);
      }
      if (rows.rows.length) console.log('fixture contact, call, and lead removed; audit events retained');
    }
  } finally {
    if (connected) await admin.end();
  }
}

console.log(`${checks} passed, 0 failed`);
