// Live development-only verification for the follow-up due-list workflow.
//
// Builds synthetic fixtures through HTTP — an overdue lead, an upcoming
// lead, and a contact with an overdue call follow-up — then asserts the
// due/overdue/upcoming/owner windows on GET /leads and GET /contacts,
// proves completion flows (log outcome call + PATCH lead nextFollowUp,
// including clearing it), proves the outstanding follow-up surfaces in
// the lead timeline, and cleans up exactly its own rows (audit events
// retained).
//
// Run: FOLLOWUP_VERIFY_WRITE=1 npm run verify:followups
// Credentials come from the environment (DATABASE_URL / APP_DATABASE_URL),
// never the command line.

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.FOLLOWUP_VERIFY_WRITE !== '1') {
  throw new Error('Development verification requires FOLLOWUP_VERIFY_WRITE=1.');
}

const suffix = randomBytes(8).toString('hex');
const marker = `FOLLOWUP_VERIFY_${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({ connectionString: adminUrl, ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }) });
const app = await buildApp({ logLevel: 'silent' });
let connected = false;
const leadIds = [];
let contactId = null;
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

const qs = (params) => Object.entries(params)
  .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  .join('&');

try {
  await admin.connect();
  connected = true;

  const now = Date.now();
  const overdueDue = new Date(now - 2 * 86_400_000).toISOString();
  const upcomingDue = new Date(now + 2 * 86_400_000).toISOString();
  const nowIso = new Date(now).toISOString();

  // Two leads through HTTP: one overdue, one upcoming.
  for (const [kind, nextFollowUp] of [['overdue', overdueDue], ['upcoming', upcomingDue]]) {
    const response = await request('dev-admin', 'POST', '/leads', {
      name: `${marker} ${kind}`,
      phone: '+910000000099',
      nextFollowUp,
    });
    check(response.status === 201, `lead ${kind} created with nextFollowUp (${response.status})`);
    leadIds.push(response.body.id);
  }
  const [overdueLeadId, upcomingLeadId] = leadIds;

  // Overdue window isolates the overdue lead.
  let response = await request('dev-admin', 'GET', `/leads?${qs({ followUpTo: nowIso, q: marker, limit: 10 })}`);
  check(response.status === 200, `overdue window returns 200 (${response.status})`);
  check(
    response.body.items.length === 1 && response.body.items[0].id === overdueLeadId,
    'overdue window isolates the overdue lead',
  );

  // Upcoming window isolates the upcoming lead.
  response = await request('dev-admin', 'GET', `/leads?${qs({ followUpFrom: nowIso, q: marker, limit: 10 })}`);
  check(response.status === 200, `upcoming window returns 200 (${response.status})`);
  check(
    response.body.items.length === 1 && response.body.items[0].id === upcomingLeadId,
    'upcoming window isolates the upcoming lead',
  );

  // Due-today window: start of the current UTC day to the next.
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  response = await request('dev-admin', 'GET', `/leads?${qs({
    followUpFrom: dayStart.toISOString(),
    followUpTo: dayEnd.toISOString(),
    q: marker,
    limit: 10,
  })}`);
  check(response.status === 200, `due-today window returns 200 (${response.status})`);
  check(
    !response.body.items.some((item) => item.id === overdueLeadId)
    && !response.body.items.some((item) => item.id === upcomingLeadId),
    'due-today window excludes fixtures due on other days',
  );

  // Oldest-due-first ordering across both fixtures.
  response = await request('dev-admin', 'GET', `/leads?${qs({ followUpSet: 'set', q: marker, limit: 10 })}`);
  check(response.status === 200, `set window returns 200 (${response.status})`);
  check(
    response.body.items.map((item) => item.id).join(',') === `${overdueLeadId},${upcomingLeadId}`,
    'set window orders oldest-due-first',
  );

  // Owner filter: fixtures belong to u-admin, so u-asha's queue is empty.
  response = await request('dev-field', 'GET', `/leads?${qs({ followUpSet: 'set', q: marker, ownerId: 'u-asha', limit: 10 })}`);
  check(response.status === 200, `owner queue returns 200 (${response.status})`);
  check(response.body.pagination.total === 0, 'own-scoped queue hides another owner’s fixtures');

  // Outstanding follow-up surfaces in the lead timeline.
  response = await request('dev-admin', 'GET', `/leads/${overdueLeadId}/timeline`);
  check(response.status === 200, `timeline returns 200 (${response.status})`);
  const followUpItem = response.body.items.find((item) => item.type === 'follow_up');
  check(
    followUpItem && followUpItem.occurredAt === overdueDue,
    'timeline carries the outstanding follow-up at the due time',
  );

  // Complete the follow-up: PATCH the lead to clear the due time.
  response = await request('dev-admin', 'PATCH', `/leads/${overdueLeadId}`, { nextFollowUp: null });
  check(response.status === 200 && response.body.nextFollowUp === null, 'clearing nextFollowUp completes the follow-up');
  response = await request('dev-admin', 'GET', `/leads?${qs({ followUpSet: 'unset', q: marker, limit: 10 })}`);
  check(
    response.status === 200 && response.body.items.some((item) => item.id === overdueLeadId),
    'completed lead appears in the unset list',
  );
  response = await request('dev-admin', 'GET', `/leads/${overdueLeadId}/timeline`);
  check(
    response.status === 200 && !response.body.items.some((item) => item.type === 'follow_up'),
    'completed follow-up leaves the timeline',
  );

  // Contact queue: a contact whose latest call sets an overdue follow-up.
  response = await request('dev-admin', 'POST', '/contacts', {
    name: `${marker} contact`,
    phone: '+910000000098',
    requirements: marker,
  });
  check(response.status === 201, `contact created through HTTP (${response.status})`);
  contactId = response.body.id;

  response = await request('dev-admin', 'POST', `/contacts/${contactId}/calls`, {
    direction: 'outbound',
    outcome: 'follow_up',
    occurredAt: new Date(now - 86_400_000).toISOString(),
    notes: marker,
    nextFollowUp: new Date(now - 3_600_000).toISOString(),
  });
  check(response.status === 201, `outcome call logged with nextFollowUp (${response.status})`);

  response = await request('dev-admin', 'GET', `/contacts?${qs({ followUpTo: nowIso, q: marker, limit: 10 })}`);
  check(response.status === 200, `contact overdue window returns 200 (${response.status})`);
  check(
    response.body.items.length === 1
    && response.body.items[0].id === contactId
    && typeof response.body.items[0].nextFollowUp === 'string',
    'contact overdue window finds the fixture with its effective follow-up',
  );

  // Complete via a new outcome call that sets the next follow-up: the
  // effective MAX moves forward and the history is preserved.
  const nextDue = new Date(now + 3 * 86_400_000).toISOString();
  response = await request('dev-admin', 'POST', `/contacts/${contactId}/calls`, {
    direction: 'outbound',
    outcome: 'interested',
    occurredAt: nowIso,
    notes: marker,
    nextFollowUp: nextDue,
  });
  check(response.status === 201, `completion call logged with the next follow-up (${response.status})`);
  response = await request('dev-admin', 'GET', `/contacts/${contactId}/calls?limit=10`);
  check(response.status === 200 && response.body.pagination.total === 2, 'both calls remain in history');
  response = await request('dev-admin', 'GET', `/contacts?${qs({ followUpTo: nowIso, q: marker, limit: 10 })}`);
  check(response.status === 200 && response.body.pagination.total === 0, 'completed contact leaves the overdue window');
  response = await request('dev-admin', 'GET', `/contacts?${qs({ followUpFrom: nowIso, q: marker, limit: 10 })}`);
  check(
    response.status === 200
    && response.body.items.length === 1
    && response.body.items[0].nextFollowUp === nextDue,
    'contact reappears in the upcoming window at the new due time',
  );

  console.log(`${checks} follow-up checks passed`);
} finally {
  if (connected && (contactId || leadIds.length)) {
    if (contactId) {
      await admin.query('DELETE FROM contact_calls WHERE tenant_id = $1 AND contact_id = $2 AND notes = $3', ['org_acme', contactId, marker]);
      await admin.query('DELETE FROM contacts WHERE tenant_id = $1 AND id = $2', ['org_acme', contactId]);
    }
    for (const leadId of leadIds) {
      await admin.query('DELETE FROM leads WHERE tenant_id = $1 AND id = $2', ['org_acme', leadId]);
    }
    const remaining = await admin.query(`SELECT
      (SELECT COUNT(*)::int FROM contacts WHERE id = $1) AS contacts,
      (SELECT COUNT(*)::int FROM contact_calls WHERE contact_id = $1) AS calls,
      (SELECT COUNT(*)::int FROM leads WHERE id = ANY ($2)) AS leads`,
    [contactId, leadIds]);
    const counts = remaining.rows[0];
    check(
      Number(counts.contacts) === 0 && Number(counts.calls) === 0 && Number(counts.leads) === 0,
      'synthetic records removed; audit events retained',
    );
  }
  if (connected) await admin.end();
  await app.close();
  await closeDb();
}
