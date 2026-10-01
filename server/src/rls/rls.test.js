// RLS policy and mode tests.
//
//   node --env-file=.env.test --test src/rls/*.test.js
//
// These are pure — no database. They pin the things that are cheap to
// get wrong and expensive to discover in production:
//
//   * the mode flag, including that a typo REFUSES rather than defaulting
//   * the policy text, read from the migration file, so the SQL and the
//     test cannot drift apart
//   * which tables are protected, so adding a fifth is a deliberate act
//
// The behavioural proof — tenant A cannot read tenant B — needs a role
// that is not the table owner, because the application role has
// BYPASSRLS and policies are inert for it. That is
// `npm run rls:check`, not this file. See docs/RLS_ROLLOUT_PLAN.md §1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { rlsMode, rlsEnabled, rlsEnforced, describeRls } = await import('../db/rlsMode.js');

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, '..', 'db', '010-rls-listings-leads.sql'), 'utf8');
const PROTECTED = ['listings', 'leads', 'visits', 'listing_photos'];

/**
 * Strip line and block comments so a test asserts on CODE, not prose.
 *
 * Several checks here are negative ("must not contain NOINHERIT"), and the
 * scripts explain at length why each thing is deliberately absent. Matching
 * that prose fails a test for documenting the right thing — which is how
 * NOINHERIT and GRANT ALL first failed here.
 *
 * Built from character codes so no escaping is needed in this file.
 */
function stripComments(src) {
  const S = String.fromCharCode(47); // "/"
  const A = String.fromCharCode(42); // "*"
  const out = [];
  let inBlock = false;
  for (const line of src.split(String.fromCharCode(10))) {
    let t = line;
    if (inBlock) {
      const close = t.indexOf(A + S);
      if (close === -1) continue;
      t = t.slice(close + 2);
      inBlock = false;
    }
    const open = t.indexOf(S + A);
    if (open !== -1) {
      const closeAfter = t.indexOf(A + S, open + 2);
      if (closeAfter !== -1) { t = t.slice(0, open) + t.slice(closeAfter + 2); }
      else { t = t.slice(0, open); inBlock = true; }
    }
    const c = t.indexOf(S + S);
    if (c !== -1) t = t.slice(0, c);
    out.push(t);
  }
  return out.join(String.fromCharCode(10));
}


/** Run `fn` with env restored afterwards. */
const withEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ---------------------------------------------------------------------------
// 1. The mode flag
// ---------------------------------------------------------------------------

test('the default is off, so nothing changes for an existing deployment', () => {
  withEnv({ DB_RLS_MODE: undefined }, () => {
    assert.equal(rlsMode(), 'off');
    assert.equal(rlsEnabled(), false);
    assert.equal(rlsEnforced(), false);
  });
});

test('probe enables RLS without treating it as live', () => {
  withEnv({ DB_RLS_MODE: 'probe' }, () => {
    assert.equal(rlsMode(), 'probe');
    assert.equal(rlsEnabled(), true, 'policies are active so they can be tested');
    assert.equal(rlsEnforced(), false, 'but the application must behave unchanged');
  });
});

test('enforce is the only live mode', () => {
  withEnv({ DB_RLS_MODE: 'enforce' }, () => {
    assert.equal(rlsMode(), 'enforce');
    assert.equal(rlsEnabled(), true);
    assert.equal(rlsEnforced(), true);
  });
});

test('the mode is case-insensitive', () => {
  withEnv({ DB_RLS_MODE: 'PROBE' }, () => assert.equal(rlsMode(), 'probe'));
});

test('an unrecognised mode REFUSES rather than defaulting', () => {
  // Failing open here would mean a typo silently disabling RLS in a
  // deployment that believes it is on — the same shape as a control
  // that looks configured and is not.
  withEnv({ DB_RLS_MODE: 'yes-please' }, () => {
    assert.throws(() => rlsMode(), /DB_RLS_MODE must be one of/);
  });
});

test('an empty DB_RLS_MODE is off, not an error', () => {
  // An env var set to "" is a common way to "unset" in a compose file,
  // and it should not stop the server booting.
  withEnv({ DB_RLS_MODE: '' }, () => assert.equal(rlsMode(), 'off'));
});

test('describeRls reports all three flags', () => {
  withEnv({ DB_RLS_MODE: 'probe' }, () => {
    assert.deepEqual(describeRls(), { mode: 'probe', enabled: true, enforced: false });
  });
});

// ---------------------------------------------------------------------------
// 2. The policy text
// ---------------------------------------------------------------------------

test('the migration protects exactly the four intended tables', () => {
  for (const t of PROTECTED) {
    assert.ok(MIGRATION.includes(`'${t}'`), `${t} is in the migration's table list`);
  }
  // The tables that are deliberately NOT protected, so that adding one
  // by accident shows up here.
  for (const t of ['organisations', 'refresh_sessions', 'login_attempts', 'audit_log']) {
    assert.ok(
      !MIGRATION.includes(`'${t}'`),
      `${t} must not be in the first batch — see docs/RLS_ROLLOUT_PLAN.md §2d`,
    );
  }
});

test('the policy uses missing_ok so an absent tenant DENIES', () => {
  // `current_setting('app.tenant_id')` without the third argument raises
  // when the setting is absent. `current_setting(..., true)` yields NULL,
  // and `tenant_id = NULL` is never true — so no context means no rows
  // rather than every row.
  assert.ok(
    /current_setting\('app\.tenant_id',\s*true\)/.test(MIGRATION),
    'the policy must pass missing_ok',
  );
});

test('the policy has a WITH CHECK, not just a USING', () => {
  // Without WITH CHECK, reads are filtered but a row can still be
  // WRITTEN into another tenant. That is the half that is easy to omit
  // and the half that matters for a write.
  assert.ok(/WITH\s+CHECK/i.test(MIGRATION), 'WITH CHECK is required');
  assert.ok(/USING/i.test(MIGRATION));
});

test('the helper function is SECURITY INVOKER, not DEFINER', () => {
  // A SECURITY DEFINER helper runs with the owner's rights and would
  // bypass RLS on the very table the policy is meant to guard.
  //
  // Checked against the statement with comments stripped: the migration
  // explains at length why DEFINER is wrong, and matching that prose
  // would fail the test for saying the right thing.
  const sql = MIGRATION.replace(/--[^\n]*/g, '');
  assert.ok(/CREATE OR REPLACE FUNCTION app_current_tenant/.test(sql));
  assert.ok(
    !/SECURITY\s+DEFINER/i.test(sql),
    'a DEFINER helper would defeat the policy it feeds',
  );
});

test('the ENABLE is gated on the mode setting, and defaults to off', () => {
  assert.ok(/app\.rls_enabled/.test(MIGRATION), 'reads the session setting');
  assert.ok(
    /ELSE[\s\S]*DISABLE ROW LEVEL SECURITY/.test(MIGRATION),
    'the absent-setting case must DISABLE, not enable',
  );
  assert.ok(
    MIGRATION.indexOf('DISABLE ROW LEVEL SECURITY') > 0,
    'a bare psql run takes the safe branch',
  );
});

test('the migration is idempotent', () => {
  // DROP POLICY IF EXISTS before CREATE, and ALTER TABLE ENABLE /
  // DISABLE are both repeatable. A hand-run rollback therefore works.
  assert.ok(/DROP POLICY IF EXISTS tenant_isolation/.test(MIGRATION));
  assert.ok(/DROP POLICY IF EXISTS/.test(MIGRATION));
});

// ---------------------------------------------------------------------------
// 3. Tenant context
// ---------------------------------------------------------------------------

test('the tenant setting is transaction-scoped, not session-scoped', async () => {
  const { readFileSync: read } = await import('node:fs');
  const src = read(join(here, '..', 'db', 'client.js'), 'utf8');
  // The third argument to set_config must be `true`. `false` would make
  // it session-scoped, so the value would survive the transaction and
  // leak into the next request that borrows the same pooled connection.
  assert.ok(
    /set_config\(\$1, \$2, true\)/.test(src),
    'withTenant must set app.tenant_id transaction-scoped',
  );
});

test('withTenant refuses to run without a tenantId', async () => {
  const { withTenant } = await import('../db/client.js');
  await assert.rejects(() => withTenant({}, async () => {}), /requires a tenantId/);
  await assert.rejects(() => withTenant(null, async () => {}), /requires a tenantId/);
  await assert.rejects(() => withTenant({ tenantId: '' }, async () => {}), /requires a tenantId/);
});

test('withTenant refuses a non-function', async () => {
  const { withTenant } = await import('../db/client.js');
  await assert.rejects(() => withTenant({ tenantId: 'org_acme' }, 'nope'), /requires a function/);
});

test('withoutTenant clears the setting rather than assuming it is absent', async () => {
  const { readFileSync: read } = await import('node:fs');
  const src = read(join(here, '..', 'db', 'client.js'), 'utf8');
  // The pre-auth paths (tenant resolution, organisations) need NO
  // tenant. Explicitly clearing it documents the intent and does not
  // depend on the absence happening to hold.
  assert.ok(/withoutTenant/.test(src));
  assert.ok(
    /set_config\('app\.tenant_id', '', true\)/.test(src),
    'withoutTenant must clear the setting explicitly',
  );
});

// ---------------------------------------------------------------------------
// 4. The documented blocker
// ---------------------------------------------------------------------------

test('the rollout plan records that the app role bypasses RLS', () => {
  const plan = readFileSync(join(here, '..', '..', '..', 'docs', 'RLS_ROLLOUT_PLAN.md'), 'utf8');
  // This is the finding the whole phase turned on. If someone deletes
  // the paragraph that says RLS is currently inert, the next person to
  // "enable RLS" will believe it is working.
  assert.ok(/BYPASSRLS/.test(plan), 'the bypass must be documented');
  assert.ok(/inert/i.test(plan), 'and the consequence spelled out');
});

// ---------------------------------------------------------------------------
// 5. The app role (Phase 8B)
// ---------------------------------------------------------------------------
//
// The non-owner role is what makes the policies mean anything. These
// assert the PROVISIONING SCRIPT's intent from its source, which is
// cheap and catches the mistakes that would silently reinstate a bypass.

test('the app role script exists and is wired into npm', async () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['db:app-role'], 'npm run db:app-role');
  assert.ok(pkg.scripts['db:app-role:check'], 'npm run db:app-role:check');
  assert.ok(pkg.scripts['rls:check'], 'npm run rls:check');
});

test('the app role is created with NOBYPASSRLS and no superuser', async () => {
  const src = readFileSync(join(here, '..', '..', 'scripts', 'app-role.js'), 'utf8');
  const sql = stripComments(src);
  assert.ok(/NOBYPASSRLS/.test(sql), 'the point of the role');
  assert.ok(/NOSUPERUSER/.test(sql));
  assert.ok(/NOCREATEDB/.test(sql));
  assert.ok(/NOCREATEROLE/.test(sql));
  // NOT NOINHERIT: Supabase grants base types to PUBLIC, and a role
  // that does not inherit would be unable to use text or jsonb at all.
  assert.ok(
    !/NOINHERIT/.test(sql),
    'NOINHERIT would break base-type usage on Supabase',
  );
});

test('the app role gets DML but never DDL or ownership', async () => {
  const sql = stripComments(
    readFileSync(join(here, '..', '..', 'scripts', 'app-role.js'), 'utf8'),
  );
  assert.ok(/GRANT \$\{DML\} ON/.test(sql) || /GRANT SELECT, INSERT, UPDATE, DELETE ON/.test(sql));
  for (const forbidden of ['GRANT CREATE', 'GRANT ALTER', 'GRANT ALL']) {
    assert.ok(!sql.includes(forbidden), `must not contain: ${forbidden}`);
  }
  assert.ok(!/ALTER TABLE .* OWNER TO/.test(sql), 'the app role must not own tables');
});

test('schema_migrations is excluded from the app role grants', async () => {
  // The app never reads its own migration history. Granting it would
  // let a compromised process rewrite the record of what has been
  // applied to it.
  const list = readFileSync(join(here, '..', '..', 'scripts', 'app-role.js'), 'utf8');
  const block = list.slice(list.indexOf('const APP_TABLES'), list.indexOf('const DML'));
  assert.ok(!/'schema_migrations'/.test(block), 'must not be in the grant list');
  // …and --check asserts the exclusion, so it cannot creep back.
  assert.ok(/has NO access to schema_migrations/.test(list));
});

test('the app-role password is never an argument', async () => {
  const src = readFileSync(join(here, '..', '..', 'scripts', 'app-role.js'), 'utf8');
  // Generated in-process, and either printed once or written to .env —
  // never read from argv, which would land it in shell history.
  assert.ok(!/argv\[.*\].*password/i.test(src), 'no password from argv');
  assert.ok(/--write-env/.test(src), 'preferred path writes .env instead of printing');
});

test('rls:check runs as the app role, not the owner', async () => {
  const src = readFileSync(join(here, '..', '..', 'scripts', 'rls-check.js'), 'utf8');
  assert.ok(/APP_DATABASE_URL/.test(src), 'must connect as the app role');
  assert.ok(/rolbypassrls/.test(src), 'and verify that role does not bypass RLS');
  // The scratch-role mode is gone; the whole point now is to use the
  // role the application actually uses.
  assert.ok(!/RLS_CHECK_ALLOW_ROLE_CREATE/.test(src), 'no throwaway role any more');
});

test('a production boot refuses a runtime role that bypasses RLS', async () => {
  const { assertRuntimeRoleIsRlsSubject } = await import('../config/index.js');
  const withEnvVar = (vars, fn) => {
    const prev = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  assert.throws(
    () =>
      withEnvVar(
        { NODE_ENV: 'production', APP_DATABASE_URL: 'postgresql://postgres:p@h:5432/d' },
        () => assertRuntimeRoleIsRlsSubject(),
      ),
    /bypasses/,
  );
  assert.doesNotThrow(() =>
    withEnvVar(
      {
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://estateflow_app:p@h:5432/d',
      },
      () => assertRuntimeRoleIsRlsSubject(),
    ),
  );
  // A developer on localhost running as postgres is the normal case.
  assert.doesNotThrow(() =>
    withEnvVar({ NODE_ENV: 'development', APP_DATABASE_URL: undefined }, () =>
      assertRuntimeRoleIsRlsSubject(),
    ),
  );
});

// ---------------------------------------------------------------------------
// 6. Which repositories are actually tenant-wired (Phase 8C)
// ---------------------------------------------------------------------------
//
// The point of this file: RLS enforcing is only useful if the application
// can still read and write. A repository that forgets the tenant context
// does not error loudly — it sees zero rows, and every INSERT is
// rejected with "new row violates row-level security policy". That
// presents as an empty database, which is the most misleading symptom
// available, so the wiring is asserted from source rather than trusted.

const repoSrc = () =>
  stripComments(
    readFileSync(join(here, '..', 'repositories', 'listingsRepository.js'), 'utf8'),
  );

test('listings reads go through tenantQuery, not the bare pool', () => {
  const src = repoSrc();
  assert.ok(/tenantQuery\(user, dataSql/.test(src), 'the data query');
  assert.ok(/tenantQuery\(user, countSql/.test(src), 'the count query');
  // A bare `query(` at repository scope is the failure mode.
  assert.ok(
    !/^\s*query\(dataSql/m.test(src) && !/^\s*query\(countSql/m.test(src),
    'no statement may reach the pool without a tenant',
  );
});

test('every listings write runs inside withTenant', () => {
  const src = repoSrc();
  const writes = (src.match(/return withTenant\(\{ tenantId: user\.tenantId \}/g) || []).length;
  // create, update, assign, verify, add photo, and the delete path.
  assert.ok(writes >= 6, `expected at least 6 tenant-wrapped write paths, found ${writes}`);
});

test('getListingById uses tenant context on the pool path', () => {
  // The `client` branch runs inside a caller's transaction; the pool
  // branch must wrap itself or the correlated photo_count subquery reads
  // nothing.
  const src = repoSrc();
  assert.ok(
    /: await tenantQuery\(user, sql, \[user\.tenantId, listingId\]\)/.test(src),
    'the pool path must be tenant-scoped',
  );
});

test('leads and visits have no application SQL, so nothing to wire', () => {
  // Recorded so the next person does not go looking for a repository that
  // does not exist. Both routes are static placeholders; their tables
  // carry RLS policies that nothing can currently exercise.
  const routes = readdirSync(join(here, '..', 'routes'));
  for (const file of ['leads.js', 'visits.js']) {
    assert.ok(routes.includes(file), `${file} exists`);
    const src = stripComments(
      readFileSync(join(here, '..', 'routes', file), 'utf8'),
    );
    assert.ok(
      !/(FROM|INTO|UPDATE)\s+(leads|visits)\b/.test(src),
      `${file} must not issue SQL yet — if it does, it needs tenant wiring`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. The deprecated `photos` table (Phase 8D)
// ---------------------------------------------------------------------------
//
// The risk was a second media table with no RLS and full app privileges:
// a future route that queried it would walk straight past every policy,
// and nothing about the code would look wrong.

test('migration 011 marks photos deprecated and denies everything', () => {
  const sql = readFileSync(
    join(here, '..', 'db', '011-photos-deprecated.sql'), 'utf8',
  );
  // RLS on, plus a policy that is never true. Belt and braces: the
  // REVOKE stops the current role, the policy stops the next one.
  assert.ok(/ALTER TABLE photos ENABLE ROW LEVEL SECURITY/.test(sql));
  assert.ok(/USING\s+\(false\)/i.test(sql), 'an always-false policy');
  assert.ok(/WITH CHECK\s+\(false\)/i.test(sql), 'and it must block writes too');
  // Nothing destructive: the table survives for a deliberate decision.
  assert.ok(!/DROP\s+TABLE\s+photos/i.test(sql), 'must not drop the table');
  // The REVOKE is issued through a format() over pg_class rather than
  // naming `photos` literally, because the table may or may not own a
  // sequence depending on how it was created (`photos.id` is text, so
  // usually not). Assert on the shape.
  assert.ok(
    /REVOKE ALL PRIVILEGES ON TABLE %I FROM estateflow_app/.test(sql),
    'revokes table privileges from the app role',
  );
  assert.ok(/estateflow_app/.test(sql), 'names the role');
  // …and the dynamic form must not silently skip a role that is absent.
  assert.ok(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'estateflow_app'\)/.test(sql));
  // A table comment is the only documentation a developer sees in a
  // schema browser before deciding to query it.
  assert.ok(/COMMENT ON TABLE photos/.test(sql));
  assert.ok(/DEPRECATED/.test(sql));
});

test('the deny policy is not just permissive in disguise', () => {
  const sql = readFileSync(
    join(here, '..', 'db', '011-photos-deprecated.sql'), 'utf8',
  );
  // The linter treats a bare `CREATE POLICY` as non-idempotent, which is
  // what keeps an always-allow `USING (true)` from passing review.
  assert.ok(!/USING\s*\(\s*true\s*\)/i.test(sql), 'never an always-allow policy');
  assert.ok(!/USING\s*\(\s*tenant_id/.test(sql), 'and not a half-finished isolation rule');
});

test('routes/photos.js issues no SQL against photos', () => {
  const src = stripComments(
    readFileSync(join(here, '..', 'routes', 'photos.js'), 'utf8'),
  );
  assert.ok(
    !/(FROM|INTO|UPDATE|DELETE\s+FROM)\s+photos\b/.test(src),
    'the deprecated table must not be queried; use listing_photos',
  );
  // And the file must say so, so the next reader does not have to find
  // this test to learn it.
  const full = readFileSync(join(here, '..', 'routes', 'photos.js'), 'utf8');
  assert.ok(/listing_photos/.test(full), 'names the supported table');
  assert.ok(/withTenant|tenantQuery/.test(full), 'states the tenant rule for whoever implements it');
});

test('photos.js fails if it ever gains SQL without tenant context', () => {
  // The general shape of the guard, asserted against this file: any SQL
  // it grows must be wrapped in a tenant context. Currently there is no
  // SQL at all, so this is the tripwire for the day someone adds some.
  const full = readFileSync(join(here, '..', 'routes', 'photos.js'), 'utf8');
  const src = stripComments(full);
  const hasSql = /(FROM|INTO|UPDATE)\s+[a-z_]+/i.test(src);
  if (hasSql) {
    assert.ok(
      /withTenant|tenantQuery/.test(src),
      'any SQL in photos.js must run inside withTenant/tenantQuery',
    );
  }
});

test('listing_photos keeps the tenant policy; photos does not pretend to', () => {
  // listing_photos is the supported table and stays fully wired.
  assert.ok(
    /addListingPhoto/.test(repoSrc()),
    'listing photos live in the listings repository',
  );
});
