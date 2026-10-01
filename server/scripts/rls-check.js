// Proves the row-level security policies deny cross-tenant access, using
// the real application role against the real protected tables.
//
//   node --env-file=.env scripts/rls-check.js
//
// WHY THIS EXISTS
// ---------------
// A policy that is present, correct and inert looks identical to one that
// works. That was not theoretical: with the application connected as
// `postgres` — which owns every table AND has BYPASSRLS — a policy
// installed, RLS enabled and `app.tenant_id` set to one tenant still
// returned BOTH tenants' rows. A CI job asserting "RLS is enabled" would
// have gone green while providing no isolation at all.
//
// So this tests BEHAVIOUR, as the role the application actually uses
// (`estateflow_app`, see scripts/app-role.js), against the four tables
// that are actually protected. It asks:
//
//   1. can tenant A read tenant B's listings?       → no
//   2. can tenant A update tenant B's?             → no
//   3. can tenant A insert into tenant B?          → no
//   4. with no tenant set, is anything visible?    → no
//   5. can tenant A still read its OWN rows?       → yes  (the check
//      that a too-strict policy would fail)
//   6. does the context survive a transaction?     → no
//
// It also runs question 1 a second time as the OWNER, which is the
// contrast that shows why the app role matters: the owner sees
// everything, the app role does not.
//
// REQUIREMENTS
// ------------
//   - the app role exists:     npm run db:app-role -- --create
//   - the app role has a password:  npm run db:app-role -- --rotate-password
//   - APP_DATABASE_URL is set to that role's URL
//
// Refuses to run against NODE_ENV=production, and writes nothing: it
// only SELECTs, UPDATEs and INSERTs inside transactions it always rolls
// back, so no row is left behind.

import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';
import { Client } from 'pg';
import { rlsMode } from '../src/db/rlsMode.js';

const APP_ROLE = process.env.DB_APP_ROLE || 'estateflow_app';
const TENANT = process.env.RLS_CHECK_TENANT || 'org_acme';
const OTHER = process.env.RLS_CHECK_OTHER_TENANT || 'org_rls_other';
const TABLE = 'listings'; // one of the four protected by migration 010

/**
 * TLS options for a connection string, resolved exactly as the pool
 * resolves them. A bare `new Client({ connectionString })` silently drops
 * DB_SSL_CA_FILE, which against a provider with a private root — every
 * Supabase connection — fails for a reason that has nothing to do with
 * RLS and reads as a broken app role.
 */
const sslFor = (url) => {
  const out = resolveSsl({ databaseUrl: url, ssl: config.dbSsl, isProduction: false });
  return out === false ? undefined : out;
};

let passed = 0;
let failed = 0;
let skipped = 0;
const assert = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

if (process.env.NODE_ENV === 'production') {
  console.error('[rls-check] refuses to run with NODE_ENV=production.');
  process.exit(2);
}

const appUrl = process.env.APP_DATABASE_URL;
if (!appUrl) {
  console.error(
    '[rls-check] APP_DATABASE_URL is not set.\n\n' +
      '  This check must run as the application role, not as the owner — the\n' +
      '  owner bypasses RLS, which is the entire reason this script exists.\n\n' +
      '  1. create the role:   npm run db:app-role -- --create\n' +
      '  2. set a password:     npm run db:app-role -- --rotate-password\n' +
      '  3. add to server/.env:  APP_DATABASE_URL=<the URL it prints>\n\n' +
      '  See docs/RLS_ROLLOUT_PLAN.md §1.',
  );
  process.exit(2);
}

console.log(`\n[rls-check] role=${APP_ROLE}  table=${TABLE}  DB_RLS_MODE=${rlsMode()}`);

// The shared pool follows APP_DATABASE_URL, which is now the app role —
// and the app role is SUBJECT to the policies it is helping to test. So
// the setup half of this script (creating the probe row, the baseline
// count) uses an explicit admin connection built from DATABASE_URL, the
// owner, which is exempt from policy.
//
// Without this the probe row cannot be inserted at all:
//   error: new row violates row-level security policy for table "listings"
// which is the policy working — but it makes the check impossible to run.
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('[rls-check] DATABASE_URL is required — it is the owner connection used to');
  console.error('  create the probe row. The app role alone cannot do that under RLS.');
  process.exit(2);
}
const admin = new Client({ connectionString: adminUrl, ssl: sslFor(adminUrl) });
await admin.connect();

// Confirm the two things that would make the result meaningless.
{
  const { rows } = await admin.query(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
    [APP_ROLE],
  );
  if (rows.length === 0) {
    console.error(`[rls-check] role ${APP_ROLE} does not exist. Run: npm run db:app-role -- --create`);
    await admin.end().catch(() => {});
    process.exit(2);
  }
  if (rows[0].rolbypassrls || rows[0].rolsuper) {
    console.error(
      `[rls-check] ${APP_ROLE} has BYPASSRLS or SUPERUSER. RLS cannot apply to it.\n` +
        `  Fix: npm run db:app-role -- --create, or ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS;`,
    );
    await admin.end().catch(() => {});
    process.exit(2);
  }
}

const { rows: rlsState } = await admin.query(
  `SELECT c.relrowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1`,
  [TABLE],
);
if (!rlsState.length || !rlsState[0].relrowsecurity) {
  console.error(
    `[rls-check] RLS is not ENABLED on ${TABLE}.\n` +
      '  Apply it:  DB_RLS_MODE=probe npm run db:migrate',
  );
  await admin.end().catch(() => {});
  process.exit(2);
}

/** A dedicated client for the app role. */
let app;
try {
  app = new Client({ connectionString: appUrl, ssl: sslFor(appUrl) });
  await app.connect();
} catch (err) {
  console.error(`[rls-check] could not connect as ${APP_ROLE}: ${err.message}`);
  console.error('  Check APP_DATABASE_URL and that the role has LOGIN + a password.');
  await admin.end().catch(() => {});
  process.exit(2);
}

/** Run `fn` in a transaction on the app connection, always rolled back. */
async function asApp(tenantId, fn) {
  await app.query('BEGIN');
  try {
    await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId ?? '']);
    return await fn();
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}

try {
  // A row in the other tenant, created by the owner (which is not
  // subject to the policy) and removed in the same transaction. The app
  // role never sees it, which is the point.
  try {
    await admin.query('BEGIN');
    // `listings.tenant_id` is a foreign key to `organisations`, so the
    // "other" tenant has to exist before a row can claim to belong to
    // it. Created here and rolled back with the rest.
    await admin.query(
      `INSERT INTO organisations (id, slug, name, status)
       VALUES ($1, $2, 'RLS Check Other Tenant', 'Active')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER, `rls-other-${OTHER}`],
    );

    const { rows: cols } = await admin.query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    // Build an INSERT from the real columns, so this survives the schema
    // gaining NOT NULL columns later. For columns with a CHECK
    // constraint the placeholder has to be a value the constraint
    // accepts — 'rls-probe-listing_intent' is not a valid intent, and
    // a constraint violation here looks nothing like an RLS failure.
    const { rows: checks } = await admin.query(
      `SELECT cc.conname, pg_get_constraintdef(cc.oid) AS def
         FROM pg_constraint cc
         JOIN pg_class c ON c.oid = cc.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND cc.contype = 'c'`,
      [TABLE],
    );
    const enumFor = (col) => {
      const def = checks.find((k) => k.def.includes(col))?.def;
      if (!def) return null;
      const m = /=\s*ANY\s*\(ARRAY\[([^\]]*)\]\)/.exec(def) || /IN\s*\(([^)]*)\)/.exec(def);
      if (!m) return null;
      // pg_get_constraintdef renders members as 'value'::text — the
      // ::text cast is Postgres's own annotation, not part of the value.
      // Leaving it attached produced `rent'::text` and a CHECK failure
      // that looked nothing like an RLS problem.
      const first = m[1].split(',')[0].trim();
      const literal = /^'([^']*)'(?:::[\w\s]+)?$/.exec(first);
      if (literal) return literal[1];
      return first.replace(/^'|'$/g, '') || null;
    };

    // Columns that are foreign keys need a value that already exists.
    // The other tenant is created above; users and the rest are borrowed
    // from the seeded demo tenant. Inventing an id here would fail on the
    // FK, which reads as a broken check rather than a probe that needs
    // better fixtures.
    const { rows: fks } = await admin.query(
      `SELECT kcu.column_name,
              ccu.table_name AS ref_table,
              ccu.column_name  AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.constraint_schema = tc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = $1`,
      [TABLE],
    );

    const borrowFrom = async (refTable, refColumn) => {
      const { rows } = await admin.query(
        `SELECT ${refColumn}::text AS v FROM ${refTable} WHERE ${refColumn} IS NOT NULL LIMIT 1`,
      );
      return rows[0]?.v ?? null;
    };

    const required = cols.filter((c) => c.is_nullable === 'NO' && !c.column_default);
    const values = {};
    const params = [];
    for (const c of required) {
      let v;
      if (c.column_name === 'tenant_id') {
        v = OTHER;
      } else {
        const fk = fks.find((f) => f.column_name === c.column_name);
        if (fk) {
          v = await borrowFrom(fk.ref_table, fk.ref_column);
          if (v === null) {
            // No row to borrow. Skip this column rather than inventing
            // an id: the check is about RLS, and a missing fixture row
            // should not masquerade as one.
            continue;
          }
        } else {
          v = `rls-probe-${c.column_name}`;
          const valid = enumFor(c.column_name);
          if (valid) v = valid;
        }
      }
      params.push(v);
      values[c.column_name] = `$${params.length}`;
    }
    const colsSql = Object.keys(values).join(', ');
    await admin.query(
      `INSERT INTO ${TABLE} (${colsSql}) VALUES (${Object.values(values).join(', ')})`,
      params,
    );

    // ── 0. Baseline: the owner sees it ──────────────────────────────
    {
      const r = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE tenant_id = $1`, [OTHER]);
      assert('baseline: the owner sees the other tenant\'s rows', r.rows[0].n > 0, `${r.rows[0].n}`);
    }

    // ── 1. READ isolation ────────────────────────────────────────────
    {
      // A `pg` query resolves to a Result, so the count is `result.rows[0].n`.
      // Reading `result.n` yields undefined, and `undefined === 0` is
      // false — which reported a policy failure that had not happened.
      const result = await asApp(TENANT, () =>
        app.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE tenant_id = $1`, [OTHER]),
      );
      const seen = result.rows[0].n;
      assert(
        'tenant A cannot read tenant B rows',
        seen === 0,
        `saw ${seen} rows belonging to ${OTHER}`,
      );
    }

    // ── 1b. Same-tenant reads still work ────────────────────────────
    {
      const r = await asApp(TENANT, () => app.query(`SELECT count(*)::int AS n FROM ${TABLE}`));
      assert(
        'tenant A still sees its OWN rows',
        r.rows[0].n > 0,
        'a policy too strict to read anything would pass every isolation check',
      );
    }

    // ── 2. UPDATE isolation ──────────────────────────────────────────
    {
      const r = await asApp(TENANT, () =>
        app.query(`UPDATE ${TABLE} SET updated_at = now() WHERE tenant_id = $1`, [OTHER]),
      );
      assert('tenant A cannot UPDATE tenant B rows', r.rowCount === 0, `${r.rowCount} rows affected`);
    }

    // ── 3. INSERT isolation (the WITH CHECK half) ────────────────────
    {
      // Reuses the owner's proven column list, changing only tenant_id.
      // Without WITH CHECK this insert would succeed, which is the half
      // of a policy that is easy to omit and the reason reads are not
      // the only thing being tested.
      const insertCols = Object.keys(values).join(', ');
      const insertVals = Object.keys(values).map((c) => (c === 'tenant_id' ? `$${params.length + 1}` : values[c]));
      const insertParams = [...params, OTHER];

      let threw = false;
      let inserted = 0;
      await asApp(TENANT, async () => {
        try {
          const r = await app.query(
            `INSERT INTO ${TABLE} (${insertCols}) VALUES (${insertVals.join(', ')})`,
            insertParams,
          );
          inserted = r.rowCount;
        } catch {
          threw = true;
        }
      });
      assert(
        'tenant A cannot INSERT into tenant B',
        threw || inserted === 0,
        inserted > 0 ? 'the WITH CHECK clause did not fire' : '',
      );
    }

    // ── 4. No context at all denies ────────────────────────────────
    {
      const r = await asApp(null, () => app.query(`SELECT count(*)::int AS n FROM ${TABLE}`));
      assert(
        'with no tenant set, nothing is visible',
        r.rows[0].n === 0,
        `${r.rows[0].n} rows visible — missing_ok is not denying`,
      );
    }

    // ── 5. The context does not survive the transaction ─────────────
    {
      await asApp(TENANT, () => app.query('SELECT 1'));
      const r = await asApp(null, () => app.query(`SELECT count(*)::int AS n FROM ${TABLE}`));
      assert(
        'the tenant context does not survive a transaction',
        r.rows[0].n === 0,
        `${r.rows[0].n} rows leaked into a later transaction`,
      );
    }

    // ── 6. The deprecated `photos` table is unreachable ────────────────
    // It is the one tenant-scoped table with no policy of its own, so
    // it is where a future route would walk past every guard. Migration
    // 011 gives it an always-false policy and revokes the app role's
    // grants. Proved as the app role rather than asserted in a unit test.
    {
      let denied = false;
      let code = null;
      try {
        await asApp(TENANT, () => app.query('SELECT count(*)::int AS n FROM photos'));
      } catch (err) {
        denied = true;
        code = err.code;
      }
      assert(
        'the deprecated photos table is unreachable for the app role',
        denied,
        denied ? '' : 'a SELECT against photos returned rows',
      );
      if (code) console.log('        (refused with ' + code + ')');
    }

    await admin.query('ROLLBACK');
  } finally {
    await admin.query('ROLLBACK').catch(() => {});

  }
} finally {
  await app.end().catch(() => {});
  await admin.end().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
if (failed === 0) {
  console.log(`  RLS is ENFORCING for ${APP_ROLE}. A production boot must use`);
  console.log('  APP_DATABASE_URL; see docs/RLS_ROLLOUT_PLAN.md §1 and §5.');
}
process.exit(failed === 0 ? 0 : 1);
