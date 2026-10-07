// Manual staff provisioning tests: createStaff + adminResetPassword.
//
// Driven by a small in-memory `pg` stand-in, so the whole flow is
// verifiable without a database — the same pattern as
// onboardingService.test.js. The SQL itself is exercised by the
// DB-integration suites in routes/users.test.js when DATABASE_URL is set.
//
// Covered:
//   * create succeeds, hashes with Argon2id, audits `created-user`, and
//     never stores or returns the plaintext
//   * duplicate (tenant_id, email) is a 409 duplicate-email
//   * weak initialPassword is a 400 weak-password
//   * unknown role / bad status / unknown team are refused
//   * non-super-admin cannot create a super-admin (403)
//   * reset sets a new hash, clears lockout, revokes sessions, audits
//     `admin-password-reset`, never returns the password
//   * reset of an unknown or cross-tenant user is a 404
//   * non-super-admin cannot reset a super-admin's password (403)
//   * permission denial is enforced at the route layer (see users.test.js)
//
// Run with `npm test` (src/repositories/*.test.js is in the glob).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const db = {
  users: new Map(),
  teams: [
    { id: 't_north', tenant_id: 'org_acme', deleted_at: null },
    { id: 't_south', tenant_id: 'org_acme', deleted_at: null },
    { id: 't_other', tenant_id: 'org_other', deleted_at: null },
  ],
  audits: [],
  revokedSessions: [],
};

/** A `pg`-shaped client modelling the statements the flow issues. */
function client() {
  return {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      if (/SELECT id, tenant_id FROM teams WHERE id = \$1/.test(sql)) {
        const team = db.teams.find((t) => t.id === params[0] && !t.deleted_at);
        return { rows: team ? [{ id: team.id, tenant_id: team.tenant_id }] : [], rowCount: 1 };
      }

      if (/^INSERT INTO users/.test(sql)) {
        const [id, tenantId, name, email, phone, roleId, teamId, designation, status, hash] = params;
        if ([...db.users.values()].some((u) => u.tenant_id === tenantId && u.email === email)) {
          const err = new Error('duplicate key value violates unique constraint "users_tenant_id_email_key"');
          err.code = '23505';
          throw err;
        }
        const u = {
          id, tenant_id: tenantId, name, email, phone, role_id: roleId,
          team_id: teamId, designation, status, password_hash: hash,
          password_changed_at: new Date().toISOString(),
          failed_login_count: 0, locked_until: null,
          joined_at: new Date().toISOString(), deleted_at: null,
        };
        db.users.set(id, u);
        return { rows: [{ id, email, status }], rowCount: 1 };
      }

      if (/FROM users WHERE id = \$1 AND tenant_id = \$2 AND deleted_at IS NULL/.test(sql)) {
        const u = db.users.get(params[0]);
        const match = u && !u.deleted_at && u.tenant_id === params[1] ? u : null;
        return {
          rows: match
            ? [{ id: match.id, tenant_id: match.tenant_id, email: match.email, role_id: match.role_id }]
            : [],
          rowCount: 1,
        };
      }

      if (/SET password_hash = \$2,/.test(sql)) {
        const u = db.users.get(params[0]);
        if (u) {
          u.password_hash = params[1];
          u.password_changed_at = new Date().toISOString();
          u.failed_login_count = 0;
          u.locked_until = null;
        }
        return { rows: [], rowCount: 1 };
      }

      if (/UPDATE refresh_sessions SET revoked_at = now\(\) WHERE user_id/.test(sql)) {
        db.revokedSessions.push(params[0]);
        return { rows: [], rowCount: 0 };
      }

      if (/^INSERT INTO audit_log/.test(sql)) {
        db.audits.push(params);
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`staff-management fake: unmodelled query — ${sql.slice(0, 90)}`);
    },
  };
}

const svc = await import('./staffManagement.js');

const ADMIN = { id: 'u-admin', tenantId: 'org_acme', role: 'admin', name: 'Demo Admin' };
const SUPER = { id: 'u-super', tenantId: 'org_acme', role: 'super-admin', name: 'Demo Super' };
const C = () => client();

const GOOD_PASSWORD = 'a-strong-initial-password-1';
const NEW_PASSWORD = 'a-brand-new-password-2';

beforeEach(() => {
  db.users.clear();
  db.audits.length = 0;
  db.revokedSessions.length = 0;
});

function seedUser(overrides = {}) {
  const u = {
    id: 'u_seed_1',
    tenant_id: 'org_acme',
    name: 'Seed User',
    email: 'seed@acme.example',
    role_id: 'field-executive',
    status: 'Active',
    password_hash: '$argon2id$old',
    failed_login_count: 3,
    locked_until: new Date(Date.now() + 60000).toISOString(),
    deleted_at: null,
    ...overrides,
  };
  db.users.set(u.id, u);
  return u;
}

// ---------------------------------------------------------------------------
// 1. Create
// ---------------------------------------------------------------------------

test('createStaff creates an Active user with a hashed password', async () => {
  const out = await svc.createStaff({
    client: C(), actor: ADMIN,
    name: 'New Hire', email: 'New.Hire@Acme.Example',
    roleId: 'field-executive', teamId: 't_north',
    designation: 'Field Executive', initialPassword: GOOD_PASSWORD,
  });

  assert.equal(out.email, 'new.hire@acme.example', 'email is normalised');
  assert.equal(out.status, 'Active', 'default status is Active');
  const stored = db.users.get(out.id);
  assert.ok(stored.password_hash.startsWith('$argon2id$'), 'the password is hashed');
  assert.ok(!stored.password_hash.includes(GOOD_PASSWORD), 'the hash does not embed the plaintext');
  assert.ok(!JSON.stringify(out).includes(GOOD_PASSWORD), 'the response never carries the password');
});

test('createStaff writes a created-user audit row without the password', async () => {
  const out = await svc.createStaff({
    client: C(), actor: ADMIN,
    name: 'Audited', email: 'audited@acme.example',
    roleId: 'telecaller', initialPassword: GOOD_PASSWORD,
  });
  const row = db.audits.at(-1);
  assert.equal(row[4], 'created-user');
  assert.equal(row[6], out.id);
  const meta = JSON.parse(row[7]);
  assert.equal(meta.email, 'audited@acme.example');
  assert.equal(meta.method, 'manual');
  assert.ok(!JSON.stringify(row).includes(GOOD_PASSWORD), 'the password is never audited');
});

test('createStaff refuses a duplicate email in the same tenant with 409', async () => {
  const args = {
    client: C(), actor: ADMIN, name: 'Dup', roleId: 'field-executive',
    initialPassword: GOOD_PASSWORD,
  };
  await svc.createStaff({ ...args, email: 'dup@acme.example' });
  await assert.rejects(
    () => svc.createStaff({ ...args, email: 'dup@acme.example' }),
    (err) => err.statusCode === 409 && err.code === 'duplicate-email',
  );
});

test('createStaff enforces the password policy with 400', async () => {
  await assert.rejects(
    () => svc.createStaff({
      client: C(), actor: ADMIN, name: 'Weak', email: 'weak@acme.example',
      roleId: 'field-executive', initialPassword: 'short',
    }),
    (err) => err.statusCode === 400 && err.code === 'weak-password',
  );
});

test('createStaff requires an initial password', async () => {
  await assert.rejects(
    () => svc.createStaff({
      client: C(), actor: ADMIN, name: 'Nopw', email: 'nopw@acme.example',
      roleId: 'field-executive',
    }),
    (err) => err.statusCode === 400 && /initialPassword/.test(err.message),
  );
});

test('createStaff rejects an unknown role with invalid-enum', async () => {
  await assert.rejects(
    () => svc.createStaff({
      client: C(), actor: ADMIN, name: 'Jan', email: 'jan@acme.example',
      roleId: 'janitor', initialPassword: GOOD_PASSWORD,
    }),
    (err) => err.statusCode === 400 && err.code === 'invalid-enum',
  );
});

test('createStaff rejects Invited status — that state belongs to the email flow', async () => {
  await assert.rejects(
    () => svc.createStaff({
      client: C(), actor: ADMIN, name: 'Inv', email: 'inv@acme.example',
      roleId: 'field-executive', status: 'Invited', initialPassword: GOOD_PASSWORD,
    }),
    (err) => err.statusCode === 400 && err.code === 'invalid-enum',
  );
});

test('createStaff rejects an unknown or cross-tenant team', async () => {
  const base = {
    client: C(), actor: ADMIN, name: 'T', roleId: 'field-executive',
    initialPassword: GOOD_PASSWORD,
  };
  await assert.rejects(
    () => svc.createStaff({ ...base, email: 't1@acme.example', teamId: 't_missing' }),
    (err) => err.statusCode === 404 && err.code === 'team-not-found',
  );
  await assert.rejects(
    () => svc.createStaff({ ...base, email: 't2@acme.example', teamId: 't_other' }),
    (err) => err.statusCode === 404 && err.code === 'team-not-found',
  );
});

test('a non-super-admin cannot create a super-admin', async () => {
  await assert.rejects(
    () => svc.createStaff({
      client: C(), actor: ADMIN, name: 'Root', email: 'root@acme.example',
      roleId: 'super-admin', initialPassword: GOOD_PASSWORD,
    }),
    (err) => err.statusCode === 403 && err.code === 'super-admin-protected',
  );
});

test('a super-admin can create a super-admin', async () => {
  const out = await svc.createStaff({
    client: C(), actor: SUPER, name: 'Root', email: 'root@acme.example',
    roleId: 'super-admin', initialPassword: GOOD_PASSWORD,
  });
  assert.ok(out.id);
});

// ---------------------------------------------------------------------------
// 2. Admin reset
// ---------------------------------------------------------------------------

test('adminResetPassword sets a new hash, clears lockout, revokes sessions', async () => {
  const target = seedUser();
  const out = await svc.adminResetPassword({
    client: C(), actor: ADMIN, userId: target.id, newPassword: NEW_PASSWORD,
  });

  assert.deepEqual(out, { ok: true, userId: target.id, sessionsRevoked: 0 });
  const stored = db.users.get(target.id);
  assert.ok(stored.password_hash.startsWith('$argon2id$'), 'the new password is hashed');
  assert.ok(!stored.password_hash.includes(NEW_PASSWORD));
  assert.equal(stored.failed_login_count, 0, 'the failure counter is cleared');
  assert.equal(stored.locked_until, null, 'the lockout is cleared');
  assert.deepEqual(db.revokedSessions, [target.id], 'every session is revoked');
  assert.ok(!JSON.stringify(out).includes(NEW_PASSWORD), 'the response never carries the password');
});

test('adminResetPassword writes an admin-password-reset audit row', async () => {
  const target = seedUser();
  await svc.adminResetPassword({
    client: C(), actor: ADMIN, userId: target.id, newPassword: NEW_PASSWORD,
  });
  const row = db.audits.at(-1);
  assert.equal(row[4], 'admin-password-reset');
  assert.equal(row[6], target.id);
  const meta = JSON.parse(row[7]);
  assert.equal(meta.reason, 'admin-reset');
  assert.ok(!JSON.stringify(row).includes(NEW_PASSWORD), 'the password is never audited');
});

test('adminResetPassword of an unknown user is a 404', async () => {
  await assert.rejects(
    () => svc.adminResetPassword({
      client: C(), actor: ADMIN, userId: 'u_missing', newPassword: NEW_PASSWORD,
    }),
    (err) => err.statusCode === 404,
  );
});

test('adminResetPassword cannot reach across tenants', async () => {
  const target = seedUser({ id: 'u_foreign', tenant_id: 'org_other', email: 'f@other.example' });
  await assert.rejects(
    () => svc.adminResetPassword({
      client: C(), actor: ADMIN, userId: target.id, newPassword: NEW_PASSWORD,
    }),
    // The actor's tenant scopes the lookup, so the row is simply absent.
    (err) => err.statusCode === 404,
  );
});

test('adminResetPassword enforces the password policy with 400', async () => {
  const target = seedUser();
  await assert.rejects(
    () => svc.adminResetPassword({
      client: C(), actor: ADMIN, userId: target.id, newPassword: 'x',
    }),
    (err) => err.statusCode === 400 && err.code === 'weak-password',
  );
});

test('a non-super-admin cannot reset a super-admin password', async () => {
  const target = seedUser({ id: 'u_root', role_id: 'super-admin', email: 'root@acme.example' });
  await assert.rejects(
    () => svc.adminResetPassword({
      client: C(), actor: ADMIN, userId: target.id, newPassword: NEW_PASSWORD,
    }),
    (err) => err.statusCode === 403 && err.code === 'super-admin-protected',
  );
});

test('a super-admin can reset a super-admin password', async () => {
  const target = seedUser({ id: 'u_root2', role_id: 'super-admin', email: 'root2@acme.example' });
  const out = await svc.adminResetPassword({
    client: C(), actor: SUPER, userId: target.id, newPassword: NEW_PASSWORD,
  });
  assert.equal(out.userId, target.id);
});
