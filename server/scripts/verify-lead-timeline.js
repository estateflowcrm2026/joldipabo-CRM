// Live development-only verification for GET /leads/:id/timeline.
//
// Builds one synthetic journey through HTTP — contact → call → convert →
// schedule visit → record viewing — then asserts the timeline merges every
// real source in oldest-first order, hides out-of-scope leads with 404,
// and cleans up exactly its own rows (audit events retained).
//
// Run: TIMELINE_VERIFY_WRITE=1 npm run verify:timeline
// Credentials come from the environment (DATABASE_URL / APP_DATABASE_URL),
// never the command line.

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.TIMELINE_VERIFY_WRITE !== '1') {
  throw new Error('Development verification requires TIMELINE_VERIFY_WRITE=1.');
}

const suffix = randomBytes(8).toString('hex');
const marker = `TIMELINE_VERIFY_${suffix}`;
const contactName = `timeline contact ${suffix}`;
const listingTitle = `timeline listing ${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({ connectionString: adminUrl, ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }) });
const app = await buildApp({ logLevel: 'silent' });
let connected = false;
let contactId = null;
let leadId = null;
let visitId = null;
let listingId = null;
let checks = 0;

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  checks += 1;
  console.log(`ok ${message}`);
}

async function request(token, method, url, payload) {
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  let body;
  try {
    body = response.json();
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body };
}

try {
  await admin.connect();
  connected = true;
  const flags = await admin.query(`SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity
      AND c.relname IN ('contacts', 'contact_calls', 'visits', 'visit_events', 'visit_viewings')`);
  check(flags.rows.length === 5, 'timeline source tables enforce RLS');

  // Contact → call → convert, all through HTTP so audit rows are real too.
  let response = await request('dev-admin', 'POST', '/contacts', {
    name: contactName,
    phone: '+910000000099',
    requirements: marker,
  });
  check(response.status === 201, `contact created through HTTP (${response.status})`);
  contactId = response.body.id;

  response = await request('dev-admin', 'POST', `/contacts/${contactId}/calls`, {
    direction: 'inbound',
    outcome: 'interested',
    occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    durationSeconds: 61,
    notes: marker,
  });
  check(response.status === 201, `call logged through HTTP (${response.status})`);

  response = await request('dev-admin', 'POST', `/contacts/${contactId}/convert`, {});
  check(response.status === 200 && response.body.created === true, 'contact converted to lead');
  leadId = response.body.leadId;

  // Listing + visit + viewing through HTTP so events/viewings are real.
  await admin.query(`INSERT INTO listings (id, tenant_id, title, service_category, property_type, listing_intent, created_by, assigned_to, team_id)
    VALUES ($1, 'org_acme', $2, 'rent', 'apartment', 'available_for_rent', 'u-admin', 'u-asha', 't_north')`, [`ls_timeline_${suffix}`, listingTitle]);
  listingId = `ls_timeline_${suffix}`;

  response = await request('dev-admin', 'POST', '/visits', {
    leadId,
    assignedTo: 'u-asha',
    listingId,
    scheduledAt: new Date().toISOString(),
  });
  check(response.status === 201, `visit scheduled through HTTP (${response.status})`);
  visitId = response.body.id;

  // Viewings require on-site progress: the visit must reach the client
  // first (same rule the visits verify script exercises).
  for (const status of ['Accepted', 'On the way', 'Reached']) {
    response = await request('dev-field', 'POST', `/visits/${visitId}/status`, { status });
    check(response.status === 200, `executive records ${status} (${response.status})`);
  }

  response = await request('dev-field', 'POST', `/visits/${visitId}/viewings`, {
    listingId,
    shownAt: new Date().toISOString(),
    assistanceStatus: 'assisted',
    feedback: marker,
  });
  check(response.status === 201, `viewing recorded through HTTP (${response.status})`);

  // The timeline merges every source in oldest-first order.
  response = await request('dev-admin', 'GET', `/leads/${leadId}/timeline`);
  check(response.status === 200, `timeline returns 200 (${response.status})`);
  const { items } = response.body;
  const types = items.map((item) => item.type);
  for (const expected of ['contact_created', 'call', 'lead_created', 'visit_event', 'viewing']) {
    check(types.includes(expected), `timeline includes ${expected} (${types.join(', ')})`);
  }
  for (let i = 1; i < items.length; i += 1) {
    check(items[i].occurredAt >= items[i - 1].occurredAt, 'timeline items are oldest-first');
  }
  const viewing = items.find((item) => item.type === 'viewing');
  check(viewing.title.includes(listingTitle) && viewing.detail === marker, 'viewing carries listing title and feedback');
  const call = items.find((item) => item.type === 'call');
  check(call.title.includes('Interested') && call.detail === marker, 'call carries outcome label and notes');

  // Visibility: out-of-scope lead hides with 404, same as GET /leads/:id.
  response = await request('dev-field2', 'GET', `/leads/${leadId}/timeline`);
  check(response.status === 404, `out-of-scope timeline hides existence (${response.status})`);

  // Unauthenticated caller is refused before any data is touched.
  const anon = await app.inject({ method: 'GET', url: `/api/v1/leads/${leadId}/timeline` });
  check(anon.statusCode === 401, 'unauthenticated timeline request is refused');

  console.log(`${checks} timeline checks passed`);
} finally {
  if (connected && (visitId || listingId || leadId || contactId)) {
    if (visitId) {
      await admin.query('DELETE FROM visit_viewings WHERE tenant_id = $1 AND visit_id = $2', ['org_acme', visitId]);
      await admin.query('DELETE FROM visit_events WHERE tenant_id = $1 AND visit_id = $2', ['org_acme', visitId]);
      await admin.query('DELETE FROM visits WHERE tenant_id = $1 AND id = $2', ['org_acme', visitId]);
    }
    if (listingId) {
      await admin.query('DELETE FROM listings WHERE tenant_id = $1 AND id = $2 AND title = $3', ['org_acme', listingId, listingTitle]);
    }
    if (contactId) {
      await admin.query('DELETE FROM contact_calls WHERE tenant_id = $1 AND contact_id = $2 AND notes = $3', ['org_acme', contactId, marker]);
    }
    if (leadId) {
      await admin.query('DELETE FROM contacts WHERE tenant_id = $1 AND lead_id = $2 AND name = $3', ['org_acme', leadId, contactName]);
      await admin.query('DELETE FROM leads WHERE tenant_id = $1 AND id = $2', ['org_acme', leadId]);
    }
    if (contactId) {
      await admin.query('DELETE FROM contacts WHERE tenant_id = $1 AND id = $2 AND name = $3', ['org_acme', contactId, contactName]);
    }
    const remaining = await admin.query(`SELECT
      (SELECT COUNT(*)::int FROM contacts WHERE id = $1) AS contacts,
      (SELECT COUNT(*)::int FROM leads WHERE id = $2) AS leads,
      (SELECT COUNT(*)::int FROM visits WHERE id = $3) AS visits`,
    [contactId, leadId, visitId]);
    check(Object.values(remaining.rows[0]).every((value) => value === 0), 'synthetic records removed; audit events retained');
  }
  if (connected) await admin.end();
  await app.close();
  await closeDb();
}
