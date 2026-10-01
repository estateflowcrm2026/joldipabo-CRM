// Account-lifecycle tests: invite, accept, forgot, reset.
//
// Driven by a small in-memory `pg` stand-in and a captured-mail outbox,
// so the whole lifecycle is verifiable without a database. The SQL
// itself is exercised by the DB-integration suites when DATABASE_URL is
// set, and by `npm run verify:migrations`.
//
// Run with `npm test` (src/repositories/*.test.js is in the glob).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { clearOutbox, getOutbox } from '../auth/mailer.js';

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

const db = {
  organisations: [{ id: 'org_acme', slug: 'acme', name: 'Acme', status: 'Active', deleted_at: null }],
  users: new Map(),
  resetTokens: [],
  audits: [],
};

const USER_FIELDS = (u) => ({
  id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name, role_id: u.role_id,
  status: u.status, phone: u.phone, team_id: u.team_id, branch_id: u.branch_id,
  designation: u.designation, permission_matrix: u.permission_matrix,
  invited_at: u.invited_at, invite_token: u.invite_token, invite_expires_at: u.invite_expires_at,
  joined_at: u.joined_at, deleted_at: u.deleted_at,
});

/** A `pg`-shaped client modelling the statements the lifecycle issues. */
function client() {
  return {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      if (/^INSERT INTO users/.test(sql)) {
        const [id, tenantId, branchId, name, email, phone, roleId, teamId, designation, perm, inviteHash, expiresAt] = params;
        if ([...db.users.values()].some((u) => u.tenant_id === tenantId && u.email === email)) {
          const err = new Error('duplicate key');
          err.code = '23505';
          throw err;
        }
        const u = {
          ...USER_FIELDS({}), id, tenant_id: tenantId, email, name, role_id: roleId,
          status: 'Invited', phone, team_id: teamId, branch_id: branchId, designation,
          permission_matrix: perm, invited_at: new Date().toISOString(),
          invite_token: inviteHash, invite_expires_at: expiresAt,
          password_hash: null, failed_login_count: 0, locked_until: null,
          joined_at: null, deleted_at: null,
        };
        db.users.set(id, u);
        return { rows: [], rowCount: 1 };
      }

      if (/FROM users\s+WHERE invite_token = \$1/.test(sql)) {
        const u = [...db.users.values()].find(
          (x) => x.invite_token === params[0] && !x.deleted_at,
        );
        return { rows: u ? [{ id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name, role_id: u.role_id, invite_expires_at: u.invite_expires_at }] : [], rowCount: 1 };
      }

      if (/SET password_hash = \$2,\s+password_changed_at = now\(\),\s+status = 'Active'/.test(sql)) {
        const [id, hash] = params;
        const u = db.users.get(id);
        if (!u) return { rows: [], rowCount: 0 };
        u.password_hash = hash;
        u.status = 'Active';
        u.joined_at = u.joined_at || new Date().toISOString();
        u.invite_token = null;
        u.invite_expires_at = null;
        u.failed_login_count = 0;
        u.locked_until = null;
        return { rows: [USER_FIELDS(u)], rowCount: 1 };
      }

      // forgot-password: find the candidate
      if (/FROM users\s+WHERE tenant_id = \$1 AND lower\(email\) = \$2/.test(sql)) {
        const [tenantId, email] = params;
        const u = [...db.users.values()].find(
          (x) => x.tenant_id === tenantId && x.email === String(email).toLowerCase()
            && !x.deleted_at && x.status !== 'Suspended',
        );
        return { rows: u ? [{ id: u.id, tenant_id: u.tenant_id, name: u.name, email: u.email }] : [], rowCount: 1 };
      }

      // forgot-password: invalidate outstanding tokens
      if (/UPDATE password_reset_tokens SET used_at = now\(\) WHERE user_id/.test(sql)) {
        db.resetTokens.forEach((t) => { if (t.user_id === params[0] && !t.used_at) t.used_at = new Date().toISOString(); });
        return { rows: [], rowCount: 1 };
      }

      if (/^INSERT INTO password_reset_tokens/.test(sql)) {
        const [id, userId, hash, expiresAt] = params;
        db.resetTokens.push({ id, user_id: userId, token_hash: hash, expires_at: expiresAt, used_at: null, created_at: new Date().toISOString() });
        return { rows: [], rowCount: 1 };
      }

      // reset-password: consume
      if (/FROM password_reset_tokens rt\s+JOIN users u/.test(sql)) {
        const t = db.resetTokens.find((x) => x.token_hash === params[0] && !x.used_at);
        const u = t ? db.users.get(t.user_id) : null;
        if (!t || !u || u.deleted_at) return { rows: [], rowCount: 0 };
        return {
          rows: [{ token_id: t.id, expires_at: t.expires_at, id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name }],
          rowCount: 1,
        };
      }

      if (/UPDATE password_reset_tokens SET used_at = now\(\) WHERE id = \$1/.test(sql)) {
        const t = db.resetTokens.find((x) => x.id === params[0]);
        if (t) t.used_at = new Date().toISOString();
        return { rows: [], rowCount: 1 };
      }

      if (/SET password_hash = \$2,\s+password_changed_at = now\(\),\s+failed_login_count = 0/.test(sql)) {
        const u = db.users.get(params[0]);
        if (u) { u.password_hash = params[1]; u.failed_login_count = 0; u.locked_until = null; }
        return { rows: [], rowCount: 1 };
      }

      if (/UPDATE refresh_sessions SET revoked_at = now\(\) WHERE user_id/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      if (/^INSERT INTO audit_log/.test(sql)) {
        db.audits.push(params);
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`onboarding fake: unmodelled query — ${sql.slice(0, 90)}`);
    },
  };
}

const svc = await import('./onboardingService.js');

const ACTOR = { id: 'u-admin', tenantId: 'org_acme', role: 'admin', name: 'Demo Admin' };
const C = () => client();
const latestToken = (needle) => {
  const msg = [...getOutbox()].reverse().find((m) => m.body.includes(needle));
  assert.ok(msg, `no captured message containing "${needle}"`);
  return /[?&]token=([A-Za-z0-9_-]+)/.exec(msg.body)?.[1];
};

beforeEach(() => {
  db.users.clear();
  db.resetTokens.length = 0;
  db.audits.length = 0;
  clearOutbox();
});

// ---------------------------------------------------------------------------
// 1. Invite
// ---------------------------------------------------------------------------

test('invite creates an Invited user and emails a link', async () => {
  const out = await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'New.Person@Acme.Example', name: 'New Person',
    roleId: 'field-executive', invitesEnabled: true,
  });

  assert.equal(out.email, 'new.person@acme.example', 'email is normalised');
  const u = db.users.get(out.id);
  assert.equal(u.status, 'Invited', 'a new account cannot log in until it accepts');
  assert.equal(u.password_hash, null, 'no password exists yet');
  assert.ok(u.invite_token, 'an invite token is stored');
  assert.notEqual(u.invite_token, latestToken('accept-invite'), 'only the hash is stored');
  assert.equal(u.invite_token, sha256(latestToken('accept-invite')));
});

test('invite writes an audit row and never the token', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'a@acme.example', name: 'A', roleId: 'field-executive', invitesEnabled: true,
  });
  const row = db.audits.at(-1);
  assert.equal(row[4], 'invited-user');
  const meta = JSON.parse(row[7]);
  assert.equal(meta.email, 'a@acme.example');
  assert.equal(meta.roleId, 'field-executive');
  assert.equal(meta.inviterRole, 'admin');
  assert.ok(!JSON.stringify(row).includes(latestToken('accept-invite')), 'the token is never audited');
});

test('invite refuses a duplicate address in the same tenant', async () => {
  const args = { client: C(), actor: ACTOR, tenantId: 'org_acme', name: 'A', roleId: 'field-executive', invitesEnabled: true };
  await svc.inviteUser({ ...args, email: 'dup@acme.example' });
  await assert.rejects(() => svc.inviteUser({ ...args, email: 'dup@acme.example' }));
});

test('invite validates its inputs', async () => {
  const base = { client: C(), actor: ACTOR, tenantId: 'org_acme', invitesEnabled: true };
  await assert.rejects(() => svc.inviteUser({ ...base, name: 'A', roleId: 'r' }), /email/);
  await assert.rejects(() => svc.inviteUser({ ...base, email: 'a@x.com', roleId: 'r' }), /name/);
  await assert.rejects(() => svc.inviteUser({ ...base, email: 'a@x.com', name: 'A' }), /roleId/);
  // An address with no '@' is rejected as malformed, not accepted as
  // a local-only identifier.
  await assert.rejects(
    () => svc.inviteUser({ ...base, email: 'not-an-email', name: 'A', roleId: 'r' }),
    /email/,
  );
});

test('the invite kill-switch refuses the flow', async () => {
  await assert.rejects(
    () => svc.inviteUser({ client: C(), actor: ACTOR, tenantId: 'org_acme', email: 'a@x.com', name: 'A', roleId: 'r', invitesEnabled: false }),
    /invitations are disabled/i,
  );
});

// ---------------------------------------------------------------------------
// 2. Accept invite
// ---------------------------------------------------------------------------

test('accepting an invite sets the password and activates the account', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'join@acme.example', name: 'Join', roleId: 'field-executive', invitesEnabled: true,
  });
  const token = latestToken('accept-invite');

  const out = await svc.acceptInvite({ client: C(), token, password: 'a-good-password-123' });
  assert.equal(out.email, 'join@acme.example');

  const u = db.users.get(out.id);
  assert.equal(u.status, 'Active');
  assert.ok(u.password_hash.startsWith('$argon2id$'), 'the password is hashed');
  assert.equal(u.invite_token, null, 'the token is cleared — single use');
  assert.equal(db.audits.at(-1)[4], 'accepted-invite');
});

test('an invite token cannot be used twice', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'once@acme.example', name: 'Once', roleId: 'field-executive', invitesEnabled: true,
  });
  const token = latestToken('accept-invite');
  await svc.acceptInvite({ client: C(), token, password: 'a-good-password-123' });
  await assert.rejects(
    () => svc.acceptInvite({ client: C(), token, password: 'another-password-456' }),
    /not valid/i,
  );
});

test('an expired invite is refused', async () => {
  const c = C();
  await svc.inviteUser({
    client: c, actor: ACTOR, tenantId: 'org_acme',
    email: 'exp@acme.example', name: 'Exp', roleId: 'field-executive', invitesEnabled: true,
  });
  const token = latestToken('accept-invite');
  // Backdate the stored expiry.
  for (const u of db.users.values()) u.invite_expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    () => svc.acceptInvite({ client: C(), token, password: 'a-good-password-123' }),
    /expired/i,
  );
});

test('accepting enforces the password policy', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'weak@acme.example', name: 'Weak', roleId: 'field-executive', invitesEnabled: true,
  });
  const token = latestToken('accept-invite');
  await assert.rejects(() => svc.acceptInvite({ client: C(), token, password: 'short' }), /at least/);
});

test('a forged invite token is refused', async () => {
  await assert.rejects(
    () => svc.acceptInvite({ client: C(), token: 'made-up', password: 'a-good-password-123' }),
    /not valid/i,
  );
});

// ---------------------------------------------------------------------------
// 3. Forgot password
// ---------------------------------------------------------------------------

test('forgot-password emails a link and stores only the hash', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'reset@acme.example', name: 'Reset', roleId: 'field-executive', invitesEnabled: true,
  });
  await svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'a-good-password-123' });

  await svc.forgotPassword({ client: C(), email: 'reset@acme.example', tenantId: 'org_acme', resetsEnabled: true });
  const token = latestToken('reset-password');
  assert.ok(token);
  const stored = db.resetTokens.at(-1);
  assert.equal(stored.token_hash, sha256(token));
  assert.notEqual(stored.token_hash, token);
});

test('forgot-password for an unknown address succeeds identically', async () => {
  const out = await svc.forgotPassword({
    client: C(), email: 'nobody@acme.example', tenantId: 'org_acme', resetsEnabled: true,
  });
  assert.equal(out.ok, true, 'the response does not reveal that no account exists');
  assert.equal(db.resetTokens.length, 0, 'and no token is created');
  // The attempt is still audited, so an operator can see the spray.
  assert.equal(db.audits.at(-1)[4], 'password-reset-requested');
  assert.ok(JSON.parse(db.audits.at(-1)[7]).delivered === false);
});

test('a new reset request invalidates any outstanding one', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'twice@acme.example', name: 'Twice', roleId: 'field-executive', invitesEnabled: true,
  });
  await svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'a-good-password-123' });

  await svc.forgotPassword({ client: C(), email: 'twice@acme.example', tenantId: 'org_acme', resetsEnabled: true });
  const first = latestToken('reset-password');
  await svc.forgotPassword({ client: C(), email: 'twice@acme.example', tenantId: 'org_acme', resetsEnabled: true });

  // The first link is dead; the second works.
  await assert.rejects(
    () => svc.resetPassword({ client: C(), token: first, password: 'a-new-password-999' }),
    /not valid or has already been used/i,
  );
});

// ---------------------------------------------------------------------------
// 4. Reset password
// ---------------------------------------------------------------------------

test('resetting sets the password and revokes every session', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'recover@acme.example', name: 'Recover', roleId: 'field-executive', invitesEnabled: true,
  });
  const id = svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'a-good-password-123' }).then((r) => r.id);
  const userId = await id;

  await svc.forgotPassword({ client: C(), email: 'recover@acme.example', tenantId: 'org_acme', resetsEnabled: true });
  const out = await svc.resetPassword({ client: C(), token: latestToken('reset-password'), password: 'a-brand-new-pass-777' });

  assert.equal(out.id, userId);
  assert.ok(db.users.get(userId).password_hash.startsWith('$argon2id$'));
  assert.equal(db.resetTokens.at(-1).used_at !== null, true, 'the token is consumed');

  const row = db.audits.at(-1);
  assert.equal(row[4], 'password-reset-completed');
  assert.equal(JSON.parse(row[7]).sessionsRevoked, 0, 'revocation is recorded even at zero');
});

test('a reset token cannot be used twice', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'single@acme.example', name: 'Single', roleId: 'field-executive', invitesEnabled: true,
  });
  await svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'a-good-password-123' });
  await svc.forgotPassword({ client: C(), email: 'single@acme.example', tenantId: 'org_acme', resetsEnabled: true });
  const token = latestToken('reset-password');

  await svc.resetPassword({ client: C(), token, password: 'first-new-password-1' });
  await assert.rejects(
    () => svc.resetPassword({ client: C(), token, password: 'second-new-password-2' }),
    /not valid or has already been used/i,
  );
});

test('an expired reset token is consumed and refused', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'stale@acme.example', name: 'Stale', roleId: 'field-executive', invitesEnabled: true,
  });
  await svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'a-good-password-123' });
  await svc.forgotPassword({ client: C(), email: 'stale@acme.example', tenantId: 'org_acme', resetsEnabled: true });
  const token = latestToken('reset-password');
  db.resetTokens.at(-1).expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    () => svc.resetPassword({ client: C(), token, password: 'a-new-password-123' }),
    /expired/i,
  );
  assert.equal(db.resetTokens.at(-1).used_at !== null, true, 'an expired token is burned, not left live');
});

test('resetting enforces the password policy', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'weakreset@acme.example', name: 'W', roleId: 'field-executive', invitesEnabled: true,
  });
  await svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'a-good-password-123' });
  await svc.forgotPassword({ client: C(), email: 'weakreset@acme.example', tenantId: 'org_acme', resetsEnabled: true });
  await assert.rejects(
    () => svc.resetPassword({ client: C(), token: latestToken('reset-password'), password: 'x' }),
    /at least/,
  );
});

test('the reset kill-switch refuses the flow', async () => {
  await assert.rejects(
    () => svc.forgotPassword({ client: C(), email: 'a@acme.example', tenantId: 'org_acme', resetsEnabled: false }),
    /disabled/i,
  );
});

// ---------------------------------------------------------------------------
// 5. Mailer
// ---------------------------------------------------------------------------

test('captured messages never contain a raw password', async () => {
  await svc.inviteUser({
    client: C(), actor: ACTOR, tenantId: 'org_acme',
    email: 'p@acme.example', name: 'P', roleId: 'field-executive', invitesEnabled: true,
  });
  await svc.acceptInvite({ client: C(), token: latestToken('accept-invite'), password: 'my-secret-password-1' });
  for (const m of getOutbox()) {
    assert.ok(!m.body.includes('my-secret-password-1'), 'no message body carries the password');
  }
});

test('the outbox is bounded', () => {
  for (let i = 0; i < 150; i += 1) {
    // Each send appends; the ring buffer must not grow without limit.
    svc.forgotPassword({ client: C(), email: `x${i}@acme.example`, tenantId: 'org_acme', resetsEnabled: true })
      .catch(() => {});
  }
  assert.ok(getOutbox().length <= 100, `outbox grew to ${getOutbox().length}`);
});
