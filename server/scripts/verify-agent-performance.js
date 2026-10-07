import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.AGENT_PERF_VERIFY_WRITE !== '1') {
  throw new Error('Development verification requires AGENT_PERF_VERIFY_WRITE=1.');
}
const suffix = randomBytes(8).toString('hex');
const marker = `AGENT_PERF_${suffix}`;
const leadA = `ld_perf_a_${suffix}`;
const leadB = `ld_perf_b_${suffix}`;
const listingId = `ls_perf_${suffix}`;
const visitRecentCompleted = `visit_perf_rc_${suffix}`;
const visitRecentCancelled = `visit_perf_rx_${suffix}`;
const visitOld = `visit_perf_old_${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({ connectionString: adminUrl, ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }) });
const app = await buildApp({ logLevel: 'silent' });
let connected = false;
let fixtureInserted = false;
let checks = 0;

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const dayOf = (days) => daysAgo(days).slice(0, 10); // YYYY-MM-DD for custom ranges

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  checks += 1;
  console.log(`ok ${message}`);
}
async function request(token, url) {
  const response = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  let body;
  try { body = response.json(); } catch { body = response.body; }
  return { status: response.statusCode, body };
}
const rowFor = (body, agentId) => (body.items || []).find((item) => item.agentId === agentId);

try {
  await admin.connect(); connected = true;
  const flags = await admin.query(`SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relname IN ('visits', 'visit_viewings')`);
  check(flags.rows.length === 2, 'visits and visit_viewings enforce RLS');
  const project = await admin.query(`SELECT id FROM projects WHERE tenant_id = 'org_acme' AND deleted_at IS NULL LIMIT 1`);
  check(project.rows.length === 1, 'a project exists for synthetic visits');
  const projectId = project.rows[0].id;

  await admin.query(`INSERT INTO leads (id, tenant_id, name, phone, owner_id, team_id, created_by)
    VALUES ($1, 'org_acme', $3, '+910000000099', 'u-raj', 't_north', 'u-raj'),
           ($2, 'org_acme', $3, '+910000000099', 'u-raj', 't_north', 'u-raj')`, [leadA, leadB, marker]);
  await admin.query(`INSERT INTO listings (id, tenant_id, title, service_category, property_type, listing_intent, created_by, assigned_to, team_id)
    VALUES ($1, 'org_acme', $2, 'rent', 'apartment', 'available_for_rent', 'u-raj', 'u-asha', 't_north')`, [listingId, marker]);
  fixtureInserted = true;
  // Recent completed visit on lead A with two assisted viewings; recent
  // cancelled visit on lead B with none; old completed visit outside the
  // monthly window with one assisted viewing.
  await admin.query(`INSERT INTO visits (id, tenant_id, lead_id, project_id, assigned_to, team_id, created_by, scheduled_at, status)
    VALUES ($1, 'org_acme', $4, $6, 'u-asha', 't_north', 'u-raj', $7, 'Completed'),
           ($2, 'org_acme', $5, $6, 'u-asha', 't_north', 'u-raj', $8, 'Visit cancelled'),
           ($3, 'org_acme', $4, $6, 'u-asha', 't_north', 'u-raj', $9, 'Completed')`,
  [visitRecentCompleted, visitRecentCancelled, visitOld, leadA, leadB, projectId, daysAgo(2), daysAgo(1), daysAgo(60)]);
  await admin.query(`INSERT INTO visit_viewings (id, tenant_id, visit_id, listing_id, agent_id, shown_at, assistance_status, feedback)
    VALUES ($1, 'org_acme', $4, $6, 'u-asha', $7, 'assisted', $8),
           ($2, 'org_acme', $4, $6, 'u-asha', $7, 'assisted', $8),
           ($3, 'org_acme', $5, $6, 'u-asha', $9, 'assisted', $8)`,
  [`viewing_perf_1_${suffix}`, `viewing_perf_2_${suffix}`, `viewing_perf_3_${suffix}`,
    visitRecentCompleted, visitOld, listingId, daysAgo(2), marker, daysAgo(60)]);

  // Monthly window: the two recent visits only.
  let response = await request('dev-admin', '/reports/agent-performance?preset=monthly');
  check(response.status === 200, `admin monthly report returns 200 (${response.status})`);
  let row = rowFor(response.body, 'u-asha');
  check(row && row.siteVisits === 2, 'monthly counts 2 recent site visits');
  check(row.clientsAssisted === 1, 'monthly counts 1 assisted client (lead A)');
  check(row.propertiesShown === 2, 'monthly counts 2 assisted properties');
  check(row.completedVisits === 1, 'monthly counts 1 completed visit');
  check(row.cancelledNoShows === 1, 'monthly counts 1 cancelled visit');

  // Yearly window pulls the old visit back in.
  response = await request('dev-admin', '/reports/agent-performance?preset=yearly');
  row = rowFor(response.body, 'u-asha');
  check(response.status === 200 && row.siteVisits === 3, 'yearly counts all 3 visits');
  check(row.propertiesShown === 3 && row.completedVisits === 2, 'yearly adds the old assisted viewing and completion');

  // Custom range limited to the old visit's calendar day.
  const oldDay = dayOf(60);
  response = await request('dev-admin', `/reports/agent-performance?preset=custom&from=${oldDay}&to=${oldDay}`);
  row = rowFor(response.body, 'u-asha');
  check(response.status === 200 && row.siteVisits === 1, 'custom range isolates the old visit');
  check(row.clientsAssisted === 1 && row.propertiesShown === 1, 'custom range carries its viewing metrics');

  // Agent filter and validation.
  response = await request('dev-admin', '/reports/agent-performance?preset=monthly&agentId=u-asha');
  check(response.status === 200 && response.body.items.length === 1, 'agentId narrows to one row');
  response = await request('dev-admin', '/reports/agent-performance?preset=daily');
  check(response.status === 400, 'unknown preset is rejected');
  response = await request('dev-admin', '/reports/agent-performance?preset=custom&from=2026-09-07&to=2026-09-01');
  check(response.status === 400, 'inverted custom range is rejected');

  // Role scope: own-scope executive sees only themself; a team manager sees
  // the team agent; an unauthenticated caller is refused.
  response = await request('dev-field', '/reports/agent-performance?preset=monthly');
  check(response.status === 200 && response.body.items.length === 1 && response.body.items[0].agentId === 'u-asha',
    'executive with own scope sees only themself');
  response = await request('dev-field', '/reports/agent-performance?preset=monthly&agentId=u-vijay');
  check(response.status === 200 && response.body.items.length === 0, 'executive cannot reach another agent row');
  response = await request('dev-sales', '/reports/agent-performance?preset=monthly');
  check(response.status === 200 && rowFor(response.body, 'u-asha')?.siteVisits === 2,
    'in-team manager sees the team agent metrics');
  const anon = await app.inject({ method: 'GET', url: '/api/v1/reports/agent-performance?preset=monthly' });
  check(anon.statusCode === 401, 'unauthenticated report request is refused');

  console.log(`${checks} agent-performance checks passed`);
} finally {
  if (connected && fixtureInserted) {
    await admin.query('DELETE FROM visit_viewings WHERE tenant_id = $1 AND visit_id = ANY($2::text[])',
      ['org_acme', [visitRecentCompleted, visitRecentCancelled, visitOld]]);
    await admin.query('DELETE FROM visit_events WHERE tenant_id = $1 AND visit_id = ANY($2::text[])',
      ['org_acme', [visitRecentCompleted, visitRecentCancelled, visitOld]]);
    await admin.query('DELETE FROM visits WHERE tenant_id = $1 AND id = ANY($2::text[])',
      ['org_acme', [visitRecentCompleted, visitRecentCancelled, visitOld]]);
    await admin.query('DELETE FROM listings WHERE tenant_id = $1 AND id = $2 AND title = $3', ['org_acme', listingId, marker]);
    await admin.query('DELETE FROM leads WHERE tenant_id = $1 AND id = ANY($2::text[]) AND name = $3',
      ['org_acme', [leadA, leadB], marker]);
    const remaining = await admin.query(`SELECT
      (SELECT COUNT(*)::int FROM leads WHERE id = ANY($1::text[])) AS leads,
      (SELECT COUNT(*)::int FROM listings WHERE id = $2) AS listings,
      (SELECT COUNT(*)::int FROM visits WHERE id = ANY($3::text[])) AS visits`,
    [[leadA, leadB], listingId, [visitRecentCompleted, visitRecentCancelled, visitOld]]);
    check(Object.values(remaining.rows[0]).every((value) => value === 0), 'synthetic records removed; audit events retained');
  }
  if (connected) await admin.end();
  await app.close();
  await closeDb();
}
