import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.VISIT_VERIFY_WRITE !== '1') {
  throw new Error('Development verification requires VISIT_VERIFY_WRITE=1.');
}
const suffix = randomBytes(8).toString('hex');
const leadId = `ld_visit_verify_${suffix}`;
const teleLeadId = `ld_visit_tele_${suffix}`;
const listingId = `ls_visit_verify_${suffix}`;
const marker = `VISIT_VERIFY_${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({ connectionString: adminUrl, ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }) });
const app = await buildApp({ logLevel: 'silent' });
const visitIds = [];
let connected = false;
let fixtureInserted = false;
let checks = 0;

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  checks += 1;
  console.log(`ok ${message}`);
}
async function request(token, method, url, payload) {
  const response = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });
  let body;
  try { body = response.json(); } catch { body = response.body; }
  return { status: response.statusCode, body };
}

try {
  await admin.connect(); connected = true;
  const flags = await admin.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('visits','visit_events','visit_viewings') ORDER BY c.relname`);
  check(flags.rows.length === 3 && flags.rows.every((row) => row.relrowsecurity),
    `visit and history tables enforce RLS (${flags.rows.map((row) => `${row.relname}=${row.relrowsecurity}`).join(', ')})`);
  const staff = await admin.query(`SELECT id,team_id FROM users WHERE tenant_id='org_acme' AND id IN ('u-asha','u-vijay','u-raj') AND status='Active'`);
  check(staff.rows.length === 3, 'known development staff are active');
  await admin.query(`INSERT INTO leads (id,tenant_id,name,phone,owner_id,team_id,created_by)
    VALUES ($1,'org_acme',$2,'+910000000099','u-raj','t_north','u-raj')`, [leadId, marker]);
  fixtureInserted = true;
  await admin.query(`INSERT INTO leads (id,tenant_id,name,phone,owner_id,team_id,created_by)
    VALUES ($1,'org_acme',$2,'+910000000099','u-tele','t_north','u-tele')`, [teleLeadId, marker]);
  await admin.query(`INSERT INTO listings (id,tenant_id,title,service_category,property_type,listing_intent,created_by,assigned_to,team_id)
    VALUES ($1,'org_acme',$2,'rent','apartment','available_for_rent','u-raj','u-asha','t_north')`, [listingId, marker]);

  let response = await request('dev-admin', 'GET', '/visits/assignees');
  check(response.status === 200 && response.body.items.some((item) => item.id === 'u-asha'), 'active executive appears in assignment picker');
  response = await request('dev-field', 'GET', '/visits/assignees');
  check(response.status === 200 && response.body.items.length === 1 && response.body.items[0].id === 'u-asha', 'executive can choose themself for own-scope scheduling');
  response = await request('dev-tele', 'GET', '/visits/assignees');
  check(response.status === 200 && response.body.items.some((item) => item.id === 'u-asha')
    && response.body.items.every((item) => item.teamId === 't_north'), 'telecaller sees only team executives');
  response = await request('dev-tele', 'POST', '/visits', { leadId: teleLeadId, assignedTo: 'u-asha', scheduledAt: new Date(Date.now() + 86400000).toISOString() });
  check(response.status === 201, `telecaller schedules own lead for team executive (${response.status})`);
  const teleVisitId = response.body.id; visitIds.push(teleVisitId);
  response = await request('dev-tele', 'POST', `/visits/${teleVisitId}/status`, { status: 'Accepted' });
  check(response.status === 400, 'telecaller cannot claim executive on-site progress');
  response = await request('dev-admin', 'POST', '/visits', { leadId, assignedTo: 'u-asha', listingId, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
  check(response.status === 201, `admin schedules visit (${response.status}: ${JSON.stringify(response.body.error || {})})`);
  const northId = response.body.id; visitIds.push(northId);
  response = await request('dev-field', 'GET', '/visits');
  check(response.status === 200 && response.body.items.some((item) => item.id === northId), 'assigned executive sees visit');
  response = await request('dev-sales', 'GET', `/visits/${northId}`);
  check(response.status === 200, 'in-team manager sees visit');
  for (const status of ['Accepted', 'On the way', 'Reached']) {
    response = await request('dev-field', 'POST', `/visits/${northId}/status`, { status });
    check(response.status === 200, `executive records ${status}`);
  }
  response = await request('dev-field', 'POST', `/visits/${northId}/viewings`, {
    listingId, shownAt: new Date().toISOString(), assistanceStatus: 'assisted', feedback: marker,
  });
  check(response.status === 201 && response.body.agentId === 'u-asha', 'viewing captures listing, time, feedback and executive');
  response = await request('dev-field', 'POST', `/visits/${northId}/status`, { status: 'Client assisted' });
  check(response.status === 200, 'executive records client assistance');
  response = await request('dev-field', 'POST', `/visits/${northId}/status`, { status: 'Completed' });
  check(response.status === 200, 'executive completes visit');
  response = await request('dev-sales', 'GET', `/visits/${northId}`);
  check(response.status === 200 && response.body.events.length === 6 && response.body.viewings.length === 1
    && response.body.events.every((event) => event.scheduledAt && event.assignedTo === 'u-asha'),
  'manager sees full visit and viewing history with schedule snapshots');
  response = await request('dev-sales', 'GET', `/visits?leadId=${leadId}`);
  check(response.status === 200 && response.body.items.some((item) => item.id === northId && item.viewingCount === 1),
    'lead history list includes the assisted-property count');

  // Reschedule preserves history: the visit keeps one row, the event log
  // gains the new schedule, and the prior schedule stays on earlier events.
  const originalAt = new Date(Date.now() + 86400000).toISOString();
  response = await request('dev-admin', 'POST', '/visits', { leadId, assignedTo: 'u-asha', scheduledAt: originalAt });
  check(response.status === 201, 'admin schedules a reschedulable visit');
  const reschedId = response.body.id; visitIds.push(reschedId);
  response = await request('dev-admin', 'POST', `/visits/${reschedId}/status`, { status: 'Visit rescheduled' });
  check(response.status === 400, 'reschedule without a new time is refused');
  const movedAt = new Date(Date.now() + 3 * 86400000).toISOString();
  response = await request('dev-admin', 'POST', `/visits/${reschedId}/status`, { status: 'Visit rescheduled', scheduledAt: movedAt, note: marker });
  check(response.status === 200, 'manager reschedules with a new time');
  response = await request('dev-sales', 'GET', `/visits/${reschedId}`);
  check(response.status === 200 && response.body.status === 'Visit rescheduled'
    && response.body.events.length === 2
    && response.body.events[0].scheduledAt === originalAt
    && response.body.events[1].scheduledAt === movedAt,
  'reschedule appends history; current and previous schedules both visible');

  // Manager tracking-board filters: window, status, and executive.
  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date(Date.now() + 7 * 86400000).toISOString();
  response = await request('dev-sales', 'GET', `/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&order=asc`);
  check(response.status === 200 && response.body.items.some((item) => item.id === reschedId)
    && response.body.items.every((item) => item.viewingCount !== undefined && item.updatedAt),
  'tracking window returns board columns (viewing count, last update)');
  response = await request('dev-sales', 'GET', `/visits?status=${encodeURIComponent('Visit rescheduled')}&assignedTo=u-asha`);
  check(response.status === 200 && response.body.items.some((item) => item.id === reschedId)
    && response.body.items.every((item) => item.status === 'Visit rescheduled' && item.assignedTo === 'u-asha'),
  'tracking filters narrow by status and executive');
  response = await request('dev-sales', 'GET', '/visits?order=bogus');
  check(response.status === 400, 'unknown tracking filter values are rejected');

  response = await request('dev-admin', 'POST', '/visits', { leadId, assignedTo: 'u-vijay', scheduledAt: new Date(Date.now() + 172800000).toISOString() });
  check(response.status === 201, 'admin schedules visit for another team');
  const southId = response.body.id; visitIds.push(southId);
  const leadSummary = await admin.query('SELECT visit_status FROM leads WHERE tenant_id=$1 AND id=$2', ['org_acme', leadId]);
  check(leadSummary.rows[0].visit_status === 'visit_planned', 'new active visit keeps lead summary planned despite prior completion');
  response = await request('dev-sales', 'GET', `/visits/${southId}`);
  check(response.status === 404, 'manager cannot open an out-of-team visit');
  response = await request('dev-field', 'GET', `/visits/${southId}`);
  check(response.status === 404, 'executive cannot open another executive visit');
  response = await request('dev-field', 'POST', `/visits/${southId}/status`, { status: 'Accepted' });
  check(response.status === 404, 'executive cannot update another executive visit');
  response = await request('dev-tele', 'POST', `/visits/${southId}/viewings`, {
    listingId, shownAt: new Date().toISOString(), assistanceStatus: 'assisted',
  });
  check(response.status !== 201, 'telecaller cannot record an executive viewing');
  console.log(`${checks} visit checks passed`);
} finally {
  if (connected && fixtureInserted) {
    for (const visitId of visitIds) {
      await admin.query('DELETE FROM visit_viewings WHERE tenant_id=$1 AND visit_id=$2', ['org_acme', visitId]);
      await admin.query('DELETE FROM visit_events WHERE tenant_id=$1 AND visit_id=$2', ['org_acme', visitId]);
      await admin.query('DELETE FROM visits WHERE tenant_id=$1 AND id=$2', ['org_acme', visitId]);
    }
    await admin.query('DELETE FROM listings WHERE tenant_id=$1 AND id=$2 AND title=$3', ['org_acme', listingId, marker]);
    await admin.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', leadId, marker]);
    await admin.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', teleLeadId, marker]);
    const remaining = await admin.query(`SELECT
      (SELECT COUNT(*)::int FROM leads WHERE id=ANY($1::text[])) AS leads,
      (SELECT COUNT(*)::int FROM listings WHERE id=$2) AS listings,
      (SELECT COUNT(*)::int FROM visits WHERE id=ANY($3::text[])) AS visits`, [[leadId, teleLeadId], listingId, visitIds]);
    check(Object.values(remaining.rows[0]).every((value) => value === 0), 'synthetic records removed; audit events retained');
  }
  if (connected) await admin.end();
  await app.close();
  await closeDb();
}
