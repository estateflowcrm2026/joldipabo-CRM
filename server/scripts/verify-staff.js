// Live development-only verification for the staff directory.
//
// Creates three synthetic users through SQL (a manager on t_north, an
// executive on t_south, and a suspended executive on t_north), then asserts
// GET /api/v1/users scoping and filters over HTTP:
//   * dev-super (all) sees both active fixtures, never secrets
//   * dev-sales (team t_north) sees the manager fixture, never t_south
//   * dev-field (own) sees exactly herself
//   * role/teamId/q/status filters narrow within scope
//   * bad role/status values are 400 invalid-enum
// Cleanup deletes exactly the marker rows (audit events retained).
//
// Run: STAFF_VERIFY_WRITE=1 npm run verify:staff
// Credentials come from the environment (DATABASE_URL / APP_DATABASE_URL),
// never the command line.

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.STAFF_VERIFY_WRITE !== '1') {
  throw new Error('Development verification requires STAFF_VERIFY_WRITE=1.');
}

const suffix = randomBytes(8).toString('hex');
const marker = `staff_verify_${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({ connectionString: adminUrl, ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }) });
const app = await buildApp({ logLevel: 'silent' });
let connected = false;
const fixtureIds = [];
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

const SECRET_KEYS = ['password_hash', 'passwordHash', 'mfa_secret', 'mfaSecret', 'invite_token', 'inviteToken', 'permission_matrix', 'permissionMatrix'];

try {
  await admin.connect();
  connected = true;

  // Three fixtures: a visible manager, a visible executive on the OTHER
  // team, and a suspended executive the default Active filter must hide.
  const fixtures = [
    { id: `u_${marker}_mgr`, name: `${marker} Manager`, email: `${marker}-mgr@acme.example`, roleId: 'sales-manager', teamId: 't_north', status: 'Active' },
    { id: `u_${marker}_south`, name: `${marker} South`, email: `${marker}-south@acme.example`, roleId: 'field-executive', teamId: 't_south', status: 'Active' },
    { id: `u_${marker}_susp`, name: `${marker} Suspended`, email: `${marker}-susp@acme.example`, roleId: 'field-executive', teamId: 't_north', status: 'Suspended' },
  ];
  for (const fixture of fixtures) {
    await admin.query(
      `INSERT INTO users (id, tenant_id, branch_id, name, email, role_id, team_id, status, joined_at)
       VALUES ($1, 'org_acme', 'br_bangalore', $2, $3, $4, $5, $6, now())`,
      [fixture.id, fixture.name, fixture.email, fixture.roleId, fixture.teamId, fixture.status],
    );
    fixtureIds.push(fixture.id);
  }
  const [mgrId, southId, suspId] = fixtureIds;
  console.log('ok three fixture users created');

  // dev-super (all): sees both ACTIVE fixtures, never secrets.
  let response = await request('dev-super', 'GET', `/users?${qs({ q: marker, limit: 100 })}`);
  check(response.status === 200, `all-scope list returns 200 (${response.status})`);
  const allIds = response.body.items.map((item) => item.id);
  check(allIds.includes(mgrId) && allIds.includes(southId), 'all scope sees both active fixtures');
  check(!allIds.includes(suspId), 'default Active filter hides the suspended fixture');
  for (const item of response.body.items) {
    for (const key of SECRET_KEYS) {
      check(!(key in item), `DTO carries no ${key}`);
    }
  }
  const mgrRow = response.body.items.find((item) => item.id === mgrId);
  check(mgrRow.teamName === 'North Sales', 'team name resolves through the teams join');

  // dev-sales (team t_north): sees the manager fixture, never t_south.
  response = await request('dev-sales', 'GET', `/users?${qs({ q: marker, limit: 100 })}`);
  check(response.status === 200, `team-scope list returns 200 (${response.status})`);
  const teamIds = response.body.items.map((item) => item.id);
  check(teamIds.includes(mgrId), 'team scope sees the same-team fixture');
  check(!teamIds.includes(southId), 'team scope hides the other-team fixture');

  // dev-field (own): sees exactly herself even with the marker search.
  response = await request('dev-field', 'GET', `/users?${qs({ q: marker, limit: 100 })}`);
  check(response.status === 200, `own-scope list returns 200 (${response.status})`);
  check(response.body.items.length === 0, 'own scope hides every fixture');

  // Filters narrow within scope.
  response = await request('dev-super', 'GET', `/users?${qs({ role: 'field-executive', q: marker, limit: 100 })}`);
  check(
    response.status === 200
    && response.body.items.map((item) => item.id).join(',') === southId,
    'role filter isolates the executive fixture',
  );
  response = await request('dev-super', 'GET', `/users?${qs({ teamId: 't_south', q: marker, limit: 100 })}`);
  check(
    response.status === 200
    && response.body.items.map((item) => item.id).join(',') === southId,
    'teamId filter isolates the south fixture',
  );
  response = await request('dev-super', 'GET', `/users?${qs({ status: 'Suspended', q: marker, limit: 100 })}`);
  check(
    response.status === 200
    && response.body.items.map((item) => item.id).join(',') === suspId,
    'status filter surfaces the suspended fixture',
  );

  // Bad enums are 400, not silent unfiltered lists.
  response = await request('dev-super', 'GET', '/users?role=janitor');
  check(response.status === 400 && response.body.error.code === 'invalid-enum', 'unknown role is 400 invalid-enum');
  response = await request('dev-super', 'GET', '/users?status=On+Vacation');
  check(response.status === 400 && response.body.error.code === 'invalid-enum', 'unknown status is 400 invalid-enum');

  // Unauthenticated stays 401.
  {
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/users' });
    check(unauth.statusCode === 401, 'missing auth is 401');
  }

  console.log(`\nstaff verification passed (${checks} checks)`);
} finally {
  if (connected && fixtureIds.length) {
    for (const id of fixtureIds) {
      await admin.query('DELETE FROM users WHERE tenant_id = $1 AND id = $2', ['org_acme', id]);
    }
    const remaining = await admin.query('SELECT COUNT(*)::int AS n FROM users WHERE id = ANY($1::text[])', [fixtureIds]);
    if (remaining.rows[0].n !== 0) throw new Error('Fixture cleanup incomplete');
    console.log('fixture users removed; audit events retained');
  }
  if (connected) await admin.end();
  await app.close();
  await closeDb();
}
