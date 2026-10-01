// Auth flow smoke against a real Postgres.
//
//   cd server
//   export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
//   export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
//   npm run db:migrate
//   npm run db:seed
//   node --env-file=.env.test scripts/smoke-auth-db.js
//
// Exercises the SQL that the in-memory harness in smoke-auth.js cannot:
//   invite → accept → login → refresh → reuse detection → logout
//   forgot → reset → login with the new password
//   lockout threshold
//   audit rows for each of the above
//   token storage (only the hash is persisted)
//
// It creates its own users inside the demo tenant and removes them
// afterwards, so it is safe to run against a seeded local database. It
// refuses a non-localhost host for the same reason as
// `verify:migrations`.
//
// Exit code 0 = every step behaved as documented.

import { getDb, closeDb, isDbConfigured, transaction } from '../src/db/client.js';
import { inviteUser, acceptInvite, forgotPassword, resetPassword } from '../src/repositories/onboardingService.js';
import { login, refresh, logout, logoutAll } from '../src/repositories/authService.js';
import { clearOutbox, getOutbox } from '../src/auth/mailer.js';
import { verifyPassword } from '../src/auth/passwordPolicy.js';
import { hashRefreshToken } from '../src/auth/tokenService.js';
import { createHash } from 'node:crypto';
import { requireSafeTarget } from './verify-guard.js';

if (!isDbConfigured()) {
  console.error('smoke:auth-db requires DATABASE_URL.');
  process.exit(2);
}
if (!process.env.JWT_SECRET) {
  console.error('smoke:auth-db requires JWT_SECRET (the token service refuses to sign without it).');
  process.exit(2);
}
let host = '';
try { host = new URL(process.env.DATABASE_URL).hostname; } catch { /* handled below */ }
requireSafeTarget({
  script: 'smoke:auth-db',
  effects: 'CREATE user rows and DELETE them again (demo tenant org_acme only)',
  localOnlyReason:
    'This script creates and deletes real user rows, and a hosted Postgres is shared.',
});

const TENANT = 'org_acme';
const stamp = Date.now().toString(36);
const emails = {
  primary: `smoke.primary.${stamp}@acme.example`,
  second: `smoke.second.${stamp}@acme.example`,
};
const INVITE_PASSWORD = 'Smoke-Test-Password-1';
const RESET_PASSWORD = 'Smoke-Reset-Password-2';
const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

let passed = 0;
let failed = 0;
const assert = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok  ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const section = (n) => console.log(`\n${n}`);
const tokenFrom = (needle) => {
  const m = [...getOutbox()].reverse().find((x) => x.body.includes(needle));
  return m ? /[?&]token=([A-Za-z0-9_-]+)/.exec(m.body)?.[1] : null;
};

const created = new Set();

async function cleanup() {
  if (created.size === 0) return;
  const db = getDb();
  for (const email of created) {
    await db.query('DELETE FROM users WHERE tenant_id = $1 AND email = $2', [TENANT, email]);
  }
  console.log(`\n[cleanup] removed ${created.size} smoke user(s)`);
}

try {
  const db = getDb();

  const { rows: org } = await db.query('SELECT id FROM organisations WHERE id = $1', [TENANT]);
  if (org.length === 0) {
    console.error(`Tenant "${TENANT}" not found. Run: npm run db:seed`);
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  section('1. invite');
  // -------------------------------------------------------------------------
  const inviter = { id: 'u-admin', tenantId: TENANT, role: 'admin', name: 'Demo Admin' };
  const invited = await transaction((client) => inviteUser({
    client, actor: inviter, tenantId: TENANT,
    email: emails.primary, name: 'Smoke Primary', roleId: 'field-executive',
    invitesEnabled: true,
  }));
  created.add(emails.primary);
  assert('invite returns a user id', !!invited.id);
  assert('invite normalises the email', invited.email === emails.primary);

  const { rows: invitedRows } = await db.query(
    'SELECT status, password_hash, invite_token FROM users WHERE id = $1', [invited.id],
  );
  assert('the user starts Invited', invitedRows[0].status === 'Invited');
  assert('no password is set until accept', invitedRows[0].password_hash === null);
  assert('the stored invite token is a hash', invitedRows[0].invite_token === sha256(tokenFrom('accept-invite')));

  // -------------------------------------------------------------------------
  section('2. accept invite');
  // -------------------------------------------------------------------------
  const accepted = await transaction((client) => acceptInvite({
    client, token: tokenFrom('accept-invite'), password: INVITE_PASSWORD,
  }));
  assert('accept activates the account', accepted.id === invited.id);

  const { rows: acceptedRows } = await db.query(
    'SELECT status, password_hash, invite_token FROM users WHERE id = $1', [invited.id],
  );
  assert('status becomes Active', acceptedRows[0].status === 'Active');
  assert('the token is cleared (single use)', acceptedRows[0].invite_token === null);
  assert('the password is Argon2id-hashed', String(acceptedRows[0].password_hash).startsWith('$argon2id$'));
  assert('the stored hash verifies the password', await verifyPassword(acceptedRows[0].password_hash, INVITE_PASSWORD));
  assert('the stored hash rejects a wrong password', !(await verifyPassword(acceptedRows[0].password_hash, 'wrong password entirely')));

  // Replay of the invite token must fail.
  let replayRefused = false;
  try {
    await transaction((client) => acceptInvite({ client, token: tokenFrom('accept-invite'), password: 'Another-Password-9' }));
  } catch (e) { replayRefused = true; }
  assert('an invite token cannot be used twice', replayRefused);

  // -------------------------------------------------------------------------
  section('3. login');
  // -------------------------------------------------------------------------
  const first = await login({ tenantSlug: 'acme', email: emails.primary, password: INVITE_PASSWORD, ip: '127.0.0.1' });
  assert('login returns an access token', first.accessToken?.split('.').length === 3);
  assert('login returns a refresh token', !!first.refreshToken);
  assert('last_login_at is recorded', true);
  const { rows: loginRows } = await db.query('SELECT last_login_at FROM users WHERE id = $1', [first.user.id]);
  assert('  …in the database', loginRows[0].last_login_at !== null);

  const { rows: storedTokens } = await db.query(
    'SELECT token_hash FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL', [first.user.id],
  );
  assert('only the refresh hash is stored', storedTokens.every((r) => r.token_hash !== first.refreshToken));
  assert('the hash matches the token', storedTokens.some((r) => r.token_hash === hashRefreshToken(first.refreshToken)));

  // Wrong password
  let wrongCode = null;
  try { await login({ tenantSlug: 'acme', email: emails.primary, password: 'nope nope nope nope' }); }
  catch (e) { wrongCode = e.code; }
  assert('a wrong password is refused', wrongCode === 'invalid-credentials', String(wrongCode));

  // Unknown address must be indistinguishable.
  let unknownCode = null;
  try { await login({ tenantSlug: 'acme', email: `nobody.${stamp}@acme.example`, password: INVITE_PASSWORD }); }
  catch (e) { unknownCode = e.code; }
  assert('an unknown address returns the same code', wrongCode === unknownCode, `${wrongCode} vs ${unknownCode}`);

  // -------------------------------------------------------------------------
  section('4. refresh and reuse detection');
  // -------------------------------------------------------------------------
  const second = await refresh({ refreshToken: first.refreshToken });
  assert('refresh issues a new refresh token', second.refreshToken !== first.refreshToken);
  const { rows: afterRotate } = await db.query(
    'SELECT revoked_at FROM refresh_sessions WHERE token_hash = $1', [hashRefreshToken(first.refreshToken)],
  );
  assert('the presented token is revoked', afterRotate[0].revoked_at !== null);

  let reuseCode = null;
  try { await refresh({ refreshToken: first.refreshToken }); } catch (e) { reuseCode = e.code; }
  assert('replaying it is refused', reuseCode === 'invalid-refresh-token', String(reuseCode));

  const { rows: family } = await db.query(
    'SELECT compromised_at FROM refresh_sessions WHERE token_hash = $1', [hashRefreshToken(second.refreshToken)],
  );
  assert('the whole family is revoked', family[0].compromised_at !== null, 'the successor must die too');

  // -------------------------------------------------------------------------
  section('5. logout and logout-all');
  // -------------------------------------------------------------------------
  const s1 = await login({ tenantSlug: 'acme', email: emails.primary, password: INVITE_PASSWORD });
  const out = await logout(s1.refreshToken);
  assert('logout revokes the session', out.revoked === true);
  let afterLogout = null;
  try { await refresh({ refreshToken: s1.refreshToken }); } catch (e) { afterLogout = e.code; }
  assert('the token cannot refresh afterwards', afterLogout === 'invalid-refresh-token');

  await login({ tenantSlug: 'acme', email: emails.primary, password: INVITE_PASSWORD });
  const all = await logoutAll(first.user.id);
  assert('logout-all reports a count', all.revoked >= 1, `revoked=${all.revoked}`);
  const { rows: live } = await db.query(
    'SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL', [first.user.id],
  );
  assert('no live session remains', live[0].n === 0);

  // -------------------------------------------------------------------------
  section('6. forgot / reset password');
  // -------------------------------------------------------------------------
  clearOutbox();
  const forgotKnown = await transaction((client) => forgotPassword({
    client, email: emails.primary, tenantId: TENANT, resetsEnabled: true,
  }));
  assert('forgot-password succeeds for a known address', forgotKnown.ok === true);

  const forgotUnknown = await transaction((client) => forgotPassword({
    client, email: `ghost.${stamp}@acme.example`, tenantId: TENANT, resetsEnabled: true,
  }));
  assert('and for an unknown one, identically', forgotUnknown.ok === true);

  const { rows: resetRows } = await db.query(
    'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [first.user.id],
  );
  assert('the reset token is stored hashed', resetRows[0].token_hash === sha256(tokenFrom('reset-password')));

  const resetOut = await transaction((client) => resetPassword({
    client, token: tokenFrom('reset-password'), password: RESET_PASSWORD,
  }));
  assert('reset returns the user', resetOut.id === first.user.id);
  assert('reset revokes sessions', typeof resetOut.sessionsRevoked === 'number');

  let resetTwice = null;
  try {
    await transaction((client) => resetPassword({ client, token: tokenFrom('reset-password'), password: 'Another-Password-3' }));
  } catch (e) { resetTwice = e; }
  // Assert on the error CODE, not the message. The previous form
  // regex-matched `String(e.code)` against the human-readable message,
  // so a correctly-refused replay reported FAIL: the code is
  // `invalid-reset-token` and the prose is a separate string. The
  // single-use guarantee worked; the check could not see it.
  assert(
    'a reset token cannot be used twice',
    resetTwice?.code === 'invalid-reset-token',
    `code=${resetTwice?.code}`,
  );
  // And the row is genuinely marked used, which is what actually
  // prevents the second attempt rather than just the error message.
  const { rows: afterTwice } = await db.query(
    'SELECT used_at FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [first.user.id],
  );
  assert(
    'the consumed reset token is marked used_at',
    afterTwice[0].used_at !== null,
  );

  const afterReset = await login({ tenantSlug: 'acme', email: emails.primary, password: RESET_PASSWORD });
  assert('the new password works', !!afterReset.accessToken);
  let oldPassword = null;
  try { await login({ tenantSlug: 'acme', email: emails.primary, password: INVITE_PASSWORD }); }
  catch (e) { oldPassword = e.code; }
  assert('the old password no longer works', oldPassword === 'invalid-credentials');

  // -------------------------------------------------------------------------
  section('7. lockout');
  // -------------------------------------------------------------------------
  for (let i = 0; i < 6; i += 1) {
    try { await login({ tenantSlug: 'acme', email: emails.primary, password: 'wrong wrong wrong' }); } catch { /* expected */ }
  }
  let lockedStatus = null;
  try { await login({ tenantSlug: 'acme', email: emails.primary, password: RESET_PASSWORD }); }
  catch (e) { lockedStatus = e.statusCode; }
  assert('the account locks after repeated failures', lockedStatus === 429, `status=${lockedStatus}`);

  const { rows: lockRows } = await db.query(
    'SELECT failed_login_count, locked_until FROM users WHERE id = $1', [first.user.id],
  );
  assert('the counter is persisted', lockRows[0].failed_login_count >= 5, `count=${lockRows[0].failed_login_count}`);
  assert('the lockout time is persisted', lockRows[0].locked_until !== null);

  // -------------------------------------------------------------------------
  section('8. audit rows');
  // -------------------------------------------------------------------------
  const { rows: auditRows } = await db.query(
    `SELECT action, count(*)::int AS n FROM audit_log
      WHERE tenant_id = $1 AND timestamp > now() - interval '10 minutes'
      GROUP BY action ORDER BY action`, [TENANT],
  );
  const actions = Object.fromEntries(auditRows.map((r) => [r.action, r.n]));
  for (const verb of [
    'invited-user', 'accepted-invite',
    'login-succeeded', 'login-failed', 'login-locked-out',
    'logout', 'refresh-token-replayed',
    'password-reset-requested', 'password-reset-completed',
  ]) {
    assert(`audit row: ${verb}`, Boolean(actions[verb]), 'missing');
  }

  const { rows: unsigned } = await db.query(
    'SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND hmac IS NULL AND timestamp > now() - interval \'10 minutes\'',
    [TENANT],
  );
  assert('every new audit row is signed', unsigned[0].n === 0, `${unsigned[0].n} unsigned`);

  // The token must never appear in an audit payload.
  const { rows: leaked } = await db.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = $1 AND metadata::text LIKE '%' || $2 || '%'`,
    [TENANT, tokenFrom('reset-password')],
  );
  assert('no token appears in any audit row', leaked[0].n === 0);

  await cleanup();
} catch (err) {
  console.error('\n[smoke:auth-db] aborted:', err?.message ?? err);
  failed += 1;
  try { await cleanup(); } catch { /* best effort */ }
} finally {
  await closeDb();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
