// End-to-end auth flow smoke, with an in-memory `pg` stand-in.
//
//   node scripts/smoke-auth.js
//
// Exercises the real login → refresh → reuse-detection → logout flow
// against an in-memory database, so the flow is verifiable on a machine
// with no Postgres. It proves the *logic*; the SQL itself is covered by
// the DB-integration suites when DATABASE_URL is set, and by
// `npm run verify:migrations`.
//
// Exit code 0 = every step behaved as documented.

import { hashRefreshToken } from '../src/auth/tokenService.js';

// ---------------------------------------------------------------------------
// In-memory store shaped like the tables the flow touches
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

const db = {
  organisations: [
    { id: 'org_acme', slug: 'acme', name: 'Acme', status: 'Active', deleted_at: null },
  ],
  users: new Map([
    ['u-asha', {
      id: 'u-asha', tenant_id: 'org_acme', email: 'asha@acme.example',
      role_id: 'field-executive', status: 'Active', deleted_at: null,
      password_hash: null, failed_login_count: 0, locked_until: null,
    }],
  ]),
  sessions: new Map(),
  attempts: new Map(),
  permissions: new Map(),
};

const row = (u, org) => ({
  id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name,
  role_id: u.role_id, status: u.status, password_hash: u.password_hash,
  failed_login_count: u.failed_login_count, locked_until: u.locked_until,
  permission_matrix: null, role_matrix: {}, branch_id: null, team_id: null,
  tenant_status: org?.status, tenant_deleted_at: org?.deleted_at ?? null,
});

/**
 * A `pg`-shaped client. Only the statements the auth flow issues are
 * modelled; an unmodelled one throws, so a silent behaviour change
 * cannot pass as a green test.
 */
function client() {
  return {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      // organisations lookup (resolveTenantId)
      if (/FROM organisations WHERE/.test(sql) && /deleted_at IS NULL/.test(sql)) {
        const needle = String(params[0] || '').toLowerCase();
        const rows = db.organisations.filter(
          (o) => !o.deleted_at && o.status !== 'Suspended' &&
            (o.slug === needle || o.id === needle || o.name.toLowerCase() === needle),
        );
        return { rows, rowCount: rows.length };
      }
      if (/FROM organisations$/.test(sql) || /ORDER BY id LIMIT/.test(sql)) {
        return { rows: db.organisations.slice(0, 2), rowCount: 1 };
      }

      // login candidate: user + tenant + org status
      if (/COALESCE\(pm.matrix/.test(sql) && /lower\(u.email\)/.test(sql)) {
        const [tenantId, email] = params;
        const u = [...db.users.values()].find(
          (x) => x.tenant_id === tenantId && !x.deleted_at &&
            x.email.toLowerCase() === String(email).toLowerCase(),
        );
        if (!u) return { rows: [], rowCount: 0 };
        return { rows: [row(u, db.organisations.find((o) => o.id === tenantId))], rowCount: 1 };
      }

      // identity lookup by (sub, tid)
      if (/COALESCE\(pm.matrix/.test(sql) && /u\.id = \$1/.test(sql)) {
        const [id, tenantId] = params;
        const u = db.users.get(id);
        if (!u || u.tenant_id !== tenantId || u.deleted_at) return { rows: [], rowCount: 0 };
        return { rows: [row(u, db.organisations.find((o) => o.id === tenantId))], rowCount: 1 };
      }

      // project membership
      if (/FROM user_project_ids/.test(sql)) return { rows: [], rowCount: 0 };

      // user lockout read
      if (/SELECT failed_login_count, locked_until FROM users/.test(sql)) {
        const u = db.users.get(params[0]);
        return {
          rows: u ? [{ failed_login_count: u.failed_login_count, locked_until: u.locked_until }] : [],
          rowCount: 1,
        };
      }

      // user lockout write
      if (/UPDATE users\s+SET failed_login_count = CASE/.test(sql)) {
        const u = db.users.get(params[0]);
        if (!u) return { rows: [], rowCount: 0 };
        const [id, threshold, lockUntil] = params;
        const next = Math.min(u.failed_login_count + 1, threshold);
        if (next >= threshold) u.locked_until = lockUntil;
        u.failed_login_count = next;
        return { rows: [{ locked_until: u.locked_until }], rowCount: 1 };
      }

      // clear on success
      if (/UPDATE users SET failed_login_count = 0/.test(sql)) {
        const u = db.users.get(params[0]);
        if (u) { u.failed_login_count = 0; u.locked_until = null; }
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE users SET password_hash = \$2/.test(sql)) {
        const u = db.users.get(params[0]);
        if (u) u.password_hash = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE users SET failed_login_count = 0, locked_until = NULL/.test(sql)) {
        const u = db.users.get(params[0]);
        if (u) { u.failed_login_count = 0; u.locked_until = null; }
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/UPDATE users SET last_login_at = now\(\) WHERE id/.test(sql)) {
        const u = db.users.get(params[0]);
        if (u) u.last_login_at = now();
        return { rows: [], rowCount: 1 };
      }

      // audit_log — Phase 4 writes real rows now, so the fake has to.
      if (/INSERT INTO audit_log/.test(sql)) {
        db.audits = db.audits || [];
        db.audits.push(params);
        return { rows: [], rowCount: 1 };
      }

      // login_attempts
      if (/SELECT failure_count, locked_until FROM login_attempts/.test(sql)) {
        const row = db.attempts.get(`${params[0]}|${params[1]}`);
        return {
          rows: row ? [{ failure_count: row.failure_count, locked_until: row.locked_until }] : [],
          rowCount: 1,
        };
      }
      if (/INSERT INTO login_attempts/.test(sql)) {
        const [tenantId, hash, threshold, windowMs, lockUntil] = params;
        const key = `${tenantId}|${hash}`;
        const prev = db.attempts.get(key);
        if (!prev) {
          db.attempts.set(key, { failure_count: 1, locked_until: null });
          return { rows: [{ locked_until: null }], rowCount: 1 };
        }
        const stale = Date.now() - new Date(prev.last_failed_at ?? 0).getTime() > windowMs;
        const count = stale ? 1 : prev.failure_count + 1;
        const locked = count >= threshold ? lockUntil : prev.locked_until;
        db.attempts.set(key, { failure_count: count, locked_until: locked, last_failed_at: Date.now() });
        return { rows: [{ locked_until: locked }], rowCount: 1 };
      }
      if (/DELETE FROM login_attempts/.test(sql)) {
        db.attempts.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }

      // refresh_sessions — create
      if (/^INSERT INTO refresh_sessions/.test(sql) && /family_id, rotation_count, created_at/.test(sql)) {
        const [id, userId, tenantId, hash, , , , , familyId, expiresAt] = params;
        db.sessions.set(hash, {
          id, user_id: userId, tenant_id: tenantId, token_hash: hash,
          family_id: familyId, parent_id: null, rotation_count: 0,
          revoked_at: null, compromised_at: null, expires_at: expiresAt,
          device_label: null, ip: null, trusted: false, last_used_at: now(),
        });
        return { rows: [], rowCount: 1 };
      }

      // refresh_sessions — lookup for rotation
      if (/^SELECT id, user_id, tenant_id, family_id/.test(sql)) {
        const row = db.sessions.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // revoke family on reuse
      if (/SET revoked_at = COALESCE\(revoked_at, now\(\)\)/.test(sql)) {
        let n = 0;
        for (const [h, r] of db.sessions) {
          if (r.family_id === params[0] && !r.revoked_at) {
            r.revoked_at = now(); r.compromised_at = now();
            db.sessions.set(h, r); n += 1;
          }
        }
        return { rows: [], rowCount: n };
      }

      // revoke by row id (rotation)
      if (/SET revoked_at = now\(\), last_used_at = now\(\) WHERE id/.test(sql)) {
        for (const [h, r] of db.sessions) {
          if (r.id === params[0]) { r.revoked_at = now(); db.sessions.set(h, r); return { rows: [], rowCount: 1 }; }
        }
        return { rows: [], rowCount: 0 };
      }

      // insert successor via SELECT
      if (/^INSERT INTO refresh_sessions/.test(sql) && /SELECT \$1, user_id/.test(sql)) {
        const [id, hash, expiresAt, sourceId] = params;
        const src = [...db.sessions.values()].find((r) => r.id === sourceId);
        if (!src) return { rows: [], rowCount: 0 };
        db.sessions.set(hash, {
          id, token_hash: hash, user_id: src.user_id, tenant_id: src.tenant_id,
          family_id: src.family_id || src.id, parent_id: src.id,
          rotation_count: src.rotation_count + 1, revoked_at: null,
          compromised_at: null, expires_at: expiresAt, last_used_at: now(),
        });
        return { rows: [], rowCount: 1 };
      }

      // revoke by token hash
      //
      // The statement carries a RETURNING clause: logout needs the
      // revoked row for the tenant, because `audit_log.tenant_id` is NOT
      // NULL and logout is often called with no request context. A fake
      // returning `rows: []` made logout report `revoked: false` and the
      // session survive — a real regression hidden behind a mock.
      if (/SET revoked_at = now\(\) WHERE token_hash/.test(sql)) {
        const row = db.sessions.get(params[0]);
        if (row && !row.revoked_at) {
          row.revoked_at = now();
          return {
            rows: [{ id: row.id, user_id: row.user_id, tenant_id: row.tenant_id }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // revoke all for a user
      if (/SET revoked_at = now\(\) WHERE user_id = \$1 AND revoked_at IS NULL/.test(sql)) {
        let n = 0;
        for (const [h, r] of db.sessions) {
          if (r.user_id === params[0] && !r.revoked_at) { r.revoked_at = now(); db.sessions.set(h, r); n += 1; }
        }
        return { rows: [], rowCount: n };
      }

      // list live
      if (/SELECT id, family_id, device_label/.test(sql)) {
        return { rows: [...db.sessions.values()].filter((r) => r.user_id === params[0] && !r.revoked_at), rowCount: 1 };
      }

      // --- MFA state ---
      // The harness users have no MFA, which is the state login() must
      // treat as "no challenge" when AUTH_MFA_ENFORCE is off. Returning
      // the row is what lets the MFA branch in login() be exercised for
      // the non-privileged case without a database.
      if (/SELECT mfa_enabled, mfa_secret/.test(sql)) {
        const u = db.users.get(params[0]);
        if (!u) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            mfa_enabled: u.mfa_enabled ?? false,
            mfa_secret: u.mfa_secret ?? null,
            mfa_last_step: u.mfa_last_step ?? null,
            mfa_enabled_at: u.mfa_enabled_at ?? null,
          }],
          rowCount: 1,
        };
      }

      throw new Error(`smoke-auth: unmodelled query — ${sql.slice(0, 100)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok  ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(name) { console.log(`\n${name}`); }

const PASSWORD = 'DemoJoldipabo!2026';

const { hashPassword } = await import('../src/auth/passwordPolicy.js');
const authService = await import('../src/repositories/authService.js');

const fake = client();

const LOGIN_CANDIDATE_SQL =
  'SELECT COALESCE(pm.matrix) AS role_matrix FROM users u ' +
  'LEFT JOIN permission_matrices pm ON pm.role_id = u.role_id ' +
  'WHERE u.tenant_id = $1 AND lower(u.email) = lower($2) AND u.deleted_at IS NULL';

const IDENTITY_SQL =
  'SELECT COALESCE(pm.matrix) AS role_matrix FROM users u ' +
  'LEFT JOIN permission_matrices pm ON pm.role_id = u.role_id ' +
  'WHERE u.id = $1 AND u.tenant_id = $2 AND u.deleted_at IS NULL';


const deps = {
  query: (text, params) => fake.query(text, params),
  transaction: async (fn) => fn({ query: (t, p) => fake.query(t, p) }),

  getLoginCandidate: async (tenantId, email) => {
    const { rows } = await fake.query(LOGIN_CANDIDATE_SQL, [tenantId, email]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      name: row.name,
      role: row.role_id,
      passwordHash: row.password_hash,
      failedLoginCount: row.failed_login_count,
      lockedUntil: row.locked_until,
      status: row.status,
    };
  },

  resolveAuthContext: async (userId, tenantId) => {
    const { rows } = await fake.query(IDENTITY_SQL, [userId, tenantId]);
    if (rows.length === 0) return { ok: false, reason: 'not-found' };
    const row = rows[0];
    if (String(row.status).toLowerCase() !== 'active') {
      return { ok: false, reason: 'user-inactive' };
    }
    return {
      ok: true,
      context: {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        email: row.email,
        role: row.role_id,
        teamId: row.team_id,
        projectIds: [],
        permissionMatrix: row.role_matrix || {},
        status: row.status,
      },
    };
  },
};

// Give the demo user a real hash, as the dev seed would.
db.users.get('u-asha').password_hash = await hashPassword(PASSWORD);

const base = { tenantSlug: 'acme', email: 'asha@acme.example', password: PASSWORD, ip: '127.0.0.1', userAgent: 'smoke' };

// ---------------------------------------------------------------------------

section('1. login — success');
let first;
{
  const out = await authService.login(base, deps);
  first = out;
  assert('returns an access token', typeof out.accessToken === 'string' && out.accessToken.split('.').length === 3);
  assert('returns a refresh token', typeof out.refreshToken === 'string' && out.refreshToken.length > 30);
  assert('returns the user with its role', out.user?.role === 'field-executive', out.user?.role);
  assert('issues a session id', typeof out.sessionId === 'string');
  const stored = [...db.sessions.values()].find((r) => r.token_hash === hashRefreshToken(out.refreshToken));
  assert('stores only the refresh hash, not the token', !!stored && stored.token_hash !== out.refreshToken);
}

section('2. login — wrong password is rejected and counted');
{
  try {
    await authService.login({ ...base, password: 'wrong wrong wrong' }, deps);
    assert('wrong password is refused', false, 'it succeeded');
  } catch (e) {
    assert('wrong password is refused', e.code === 'invalid-credentials', e.code);
  }
  const u = db.users.get('u-asha');
  assert('the failure is counted', u.failed_login_count >= 1, `count=${u.failed_login_count}`);
}

section('3. login — unknown email looks identical to a wrong password');
{
  let wrongPwdCode, unknownCode;
  try { await authService.login({ ...base, password: 'nope nope nope nope' }, deps); } catch (e) { wrongPwdCode = e.code; }
  try { await authService.login({ ...base, email: 'nobody@acme.example', password: PASSWORD }, deps); } catch (e) { unknownCode = e.code; }
  assert('both return the same code (no enumeration)', wrongPwdCode === unknownCode, `${wrongPwdCode} vs ${unknownCode}`);
  assert('and that code is invalid-credentials', wrongPwdCode === 'invalid-credentials', wrongPwdCode);
}

section('4. refresh — rotation');
let second;
{
  second = await authService.refresh({ refreshToken: first.refreshToken }, deps);
  assert('issues a new refresh token', second.refreshToken !== first.refreshToken);
  assert('issues a new access token', second.accessToken !== first.accessToken);
  const old = db.sessions.get(hashRefreshToken(first.refreshToken));
  assert('the old token is revoked', !!old?.revoked_at);
  const nw = db.sessions.get(hashRefreshToken(second.refreshToken));
  assert('the new token is live', !nw?.revoked_at);
  assert('the family is preserved', nw?.family_id === old?.family_id);
}

section('5. refresh — reuse detection revokes the family');
{
  try {
    await authService.refresh({ refreshToken: first.refreshToken }, deps); // replay the old one
    assert('replaying a rotated token is refused', false, 'it succeeded');
  } catch (e) {
    assert('replaying a rotated token is refused', e.code === 'invalid-refresh-token', e.code);
  }
  const live = db.sessions.get(hashRefreshToken(second.refreshToken));
  assert('the family is now dead (successor revoked too)', !!live?.revoked_at);
  assert('and marked compromised', !!live?.compromised_at);
  // The legitimate token is dead as a consequence of the reuse.
  try {
    await authService.refresh({ refreshToken: second.refreshToken }, deps);
    assert('the current token is refused too', false, 'it still worked');
  } catch (e) {
    assert('the current token is refused too', e.code === 'invalid-refresh-token');
  }
}

section('6. logout');
{
  // Fresh session to log out cleanly.
  const s = await authService.login(base, deps);
  const out = await authService.logout(s.refreshToken, deps);
  assert('logout revokes the session', out.revoked === true);
  try {
    await authService.refresh({ refreshToken: s.refreshToken }, deps);
    assert('the revoked token cannot refresh', false, 'it still worked');
  } catch (e) {
    assert('the revoked token cannot refresh', e.code === 'invalid-refresh-token');
  }
}

section('7. logout-all');
{
  const a = await authService.login(base, deps);
  const b = await authService.login(base, deps);
  const out = await authService.logoutAll('u-asha', deps);
  assert('revokes every session for the user', out.revoked >= 2, `revoked=${out.revoked}`);
  try {
    await authService.refresh({ refreshToken: b.refreshToken }, deps);
    assert('no session survives', false, 'one still worked');
  } catch (e) {
    assert('no session survives', e.code === 'invalid-refresh-token');
  }
}

section('8. lockout after repeated failures');
{
  // Reset, then fail enough times to cross the user threshold.
  const u = db.users.get('u-asha');
  u.failed_login_count = 0; u.locked_until = null;
  db.attempts.clear();

  let locked = false;
  for (let i = 0; i < 6; i += 1) {
    try { await authService.login({ ...base, password: 'bad bad bad bad' }, deps); } catch (e) {
      if (e.statusCode === 429) { locked = true; break; }
    }
  }
  assert('the account locks after repeated failures', locked, 'never reached 429');
  // And the correct password is refused while locked.
  try {
    await authService.login(base, deps);
    assert('correct password is refused while locked', false, 'it succeeded');
  } catch (e) {
    assert('correct password is refused while locked', e.statusCode === 429, `status=${e.statusCode}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
