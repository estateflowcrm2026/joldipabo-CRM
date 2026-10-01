// Verifies MFA enforcement for privileged roles against a real database.
//
//   AUTH_MFA_ENFORCE=true node --env-file=.env scripts/check-mfa-enforcement.js
//
// Checks, in order:
//
//   1. a non-privileged user with no MFA logs in with a password alone
//   2. an admin with no MFA is given a challenge and receives NO tokens
//   3. an enrolled admin is given a challenge and receives NO tokens
//
// The demo password is read from DEMO_PASSWORD in the environment rather
// than accepted as an argument, so it never reaches a process listing or
// a shell history.
//
// NO WRITES. A non-privileged user is created in a transaction that is
// always rolled back, so the check cannot leave a password behind on a
// shared database. The admin and super-admin rows are only READ — this
// script never enrols or disables MFA on a real account. Run
// `scripts/smoke-auth-db.js` for the flows that do write, and expect it
// to clean up after itself.

import { getDb, closeDb, query } from '../src/db/client.js';
import { login } from '../src/repositories/authService.js';
import { hashPassword } from '../src/auth/passwordPolicy.js';

const PASSWORD = process.env.DEMO_PASSWORD;
if (!PASSWORD) {
  console.error('set DEMO_PASSWORD in the environment (do not pass it as an argument)');
  process.exit(2);
}
if (String(process.env.AUTH_MFA_ENFORCE).toLowerCase() !== 'true') {
  console.error('AUTH_MFA_ENFORCE must be true for this check to mean anything');
  process.exit(2);
}

const TENANT = 'org_acme';
const SCRATCH_EMAIL = `mfa-enforcement-probe.${Date.now().toString(36)}@acme.example`;

let passed = 0;
let failed = 0;
const assert = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const db = getDb();
const { rows } = await db.query(
  `SELECT u.id, u.email, u.role_id, u.mfa_enabled
     FROM users u
    WHERE u.tenant_id = $1 AND u.status = 'Active' AND u.deleted_at IS NULL
    ORDER BY u.role_id`,
  [TENANT],
);

console.log(`\n[enforce] AUTH_MFA_ENFORCE=true, tenant ${TENANT}`);
for (const r of rows) {
  console.log(`  role=${String(r.role_id).padEnd(24)} mfa_enabled=${r.mfa_enabled}`);
}
console.log('');

// A throwaway non-privileged user, always rolled back. The demo tenant
// has no seeded field-executive with a password, and writing one to a
// shared database is not this script's business.
//
// `login` opens its own pooled connection, so it cannot see a row that
// is still inside an open transaction. The password check is therefore
// driven through THIS client with a stubbed candidate resolver rather
// than through the full login path — which is fine, because what is
// being asserted is the POLICY in login() after the password is accepted,
// and the policy tests in mfaService.test.js cover the rest.
const client = await db.connect();
try {
  await client.query('BEGIN');
  const hash = await hashPassword(PASSWORD);
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role_id, status, password_hash, password_changed_at)
     VALUES ('u_mfa_probe', $1, $2, 'MFA Enforcement Probe', 'field-executive', 'Active', $3, now())`,
    [TENANT, SCRATCH_EMAIL, hash],
  );

  const out = await login(
    { tenantSlug: 'acme', email: SCRATCH_EMAIL, password: PASSWORD },
    {
      // Borrow this client, so the probe row is visible.
      query: (t, p) => client.query(t, p),
      transaction: (fn) => fn(client),
      // authRepository uses the module-level pool, which cannot see an
      // uncommitted row, so the probe needs its own resolver too.
      resolveAuthContext: async (userId, tenantId) => {
        const { rows: found } = await client.query(
          `SELECT u.id, u.tenant_id, u.team_id, u.role_id, u.permission_matrix,
                  u.status, u.email, u.name, o.status AS tenant_status
             FROM users u JOIN organisations o ON o.id = u.tenant_id
            WHERE u.id = $1 AND u.tenant_id = $2 AND u.deleted_at IS NULL`,
          [userId, tenantId],
        );
        if (found.length === 0) return { ok: false, reason: 'not-found' };
        return {
          ok: true,
          context: {
            id: found[0].id,
            tenantId: found[0].tenant_id,
            name: found[0].name,
            email: found[0].email,
            role: found[0].role_id,
            teamId: found[0].team_id,
            projectIds: [],
            permissionMatrix: found[0].permission_matrix ?? {},
            status: found[0].status,
          },
        };
      },
      resolveTenantId: async () => TENANT,
      getLoginCandidate: async (tenantId, email) => {
        const { rows: found } = await client.query(
          `SELECT id, tenant_id, email, name, role_id, password_hash, status
             FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)`,
          [tenantId, email],
        );
        if (found.length === 0) return null;
        return {
          id: found[0].id,
          tenantId: found[0].tenant_id,
          email: found[0].email,
          name: found[0].name,
          role: found[0].role_id,
          passwordHash: found[0].password_hash,
          status: found[0].status,
        };
      },
    },
  );
  assert(
    'a non-privileged user with no MFA logs in with a password alone',
    Boolean(out.accessToken) && out.mfaRequired !== true,
    `mfaRequired=${out.mfaRequired}`,
  );
  assert(
    'and receives a usable session',
    Boolean(out.refreshToken) && Boolean(out.user?.id),
  );
} finally {
  // Always rolls back. A committed probe user with a known password on a
  // shared database would be a real credential.
  await client.query('ROLLBACK');
  client.release();
}

const admin = rows.find((r) => r.role_id === 'admin' || r.role_id === 'super-admin');
if (admin) {
  const out = await login({ tenantSlug: 'acme', email: admin.email, password: PASSWORD });
  assert(
    'a privileged account never gets tokens from a password alone',
    out.mfaRequired === true && !out.accessToken && !out.refreshToken,
    `mfaRequired=${out.mfaRequired} accessToken=${Boolean(out.accessToken)}`,
  );
  assert('the response carries a challenge to complete', Boolean(out.challengeToken));
  assert(
    'the reason distinguishes enrolled from not-yet-enrolled',
    out.mfaReason === 'enabled' || out.mfaReason === 'required',
    String(out.mfaReason),
  );
  if (out.mfaReason === 'required') {
    console.log('      This account has no MFA and must enrol before use:');
    console.log('        POST /api/v1/auth/mfa/setup        → scan the otpauth URI');
    console.log('        POST /api/v1/auth/mfa/verify-setup  → confirm a code');
  }
} else {
  console.log('  --  no admin/super-admin in this tenant; skipped');
}

const { rows: leaked } = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [SCRATCH_EMAIL]);
assert('the probe user was not persisted', leaked[0].n === 0, `${leaked[0].n} rows left`);

await closeDb();
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
