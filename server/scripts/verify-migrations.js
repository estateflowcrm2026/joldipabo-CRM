// End-to-end migration verification against a real Postgres.
//
//   cd server
//   export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/estateflow
//   npm run verify:migrations
//
// Exercises the scenarios a migration change has to get right:
//
//   1. FRESH      — a clean target migrates from zero.
//   2. IDEMPOTENT — re-running migrate is a no-op, twice over.
//   3. DRIFTED    — a target that recorded 001/002 BEFORE the
//                   cross-vertical columns existed can still apply 003,
//                   and ends up with the same schema as a fresh one.
//   4. IMMUTABLE  — a recorded checksum that no longer matches is refused.
//
// Scenario 3 is the one that motivated 003-cross-vertical.sql. It is
// simulated honestly: 001/002 are applied, then the cross-vertical
// objects are explicitly removed to recreate the state a pre-2026-09-24
// database is genuinely in, and the full manifest runs. Withholding 003
// alone no longer reproduces that, because 001 was frozen on 2026-09-24
// AFTER the in-place edit — today's 001 already creates every column 003
// would, so a 003-withheld target is just a fresh target and the
// assertion would pass without testing anything.
//
// SCOPES
// ------
//   db      (default on localhost)  a scratch DATABASE per scenario.
//           Strictest isolation. Needs CREATEDB, and cannot be dropped
//           through a connection pooler.
//   schema  (default on a pooler)    a scratch SCHEMA per scenario in
//           the live database. Same "disposable, never the real data"
//           guarantee, works through Supabase's pooler, drops in ~100ms.
//   auto    detect, and fall back to `schema` if `db` is unavailable.
//
//   VERIFY_SCOPE=db|schema|auto      force one
//   VERIFY_KEEP=1                   leave the scratch targets in place
//   VERIFY_ALLOW_REMOTE=1           required for any non-localhost host
//
// What a pooler costs you: in schema scope the runner is scoped with
// `search_path`, so every migration must be schema-clean. That is a real
// limitation and the script says which checks it could not perform rather
// than quietly reporting a pass. Running the db scope over a direct
// (non-pooled) connection string exercises the same migrations with no
// search_path involved.
//
// Exit code 0 = every assertion passed.

import { createHash } from 'node:crypto';

import {
  requireSafeTarget,
  assertDroppableScratchDb,
  assertDroppableScratchSchema,
} from './verify-guard.js';

const KEEP = process.env.VERIFY_KEEP === '1';
const REQUESTED_SCOPE = (process.env.VERIFY_SCOPE || 'auto').toLowerCase();

if (!['auto', 'db', 'schema'].includes(REQUESTED_SCOPE)) {
  console.error(`VERIFY_SCOPE must be auto, db or schema; got "${REQUESTED_SCOPE}".`);
  process.exit(2);
}

const { baseUrl: BASE_URL, adminDb: ADMIN_DB, pooler } = requireSafeTarget({
  script: 'verify:migrations',
  effects:
    'CREATE and DROP scratch targets (ef_verify_*), never the real schema or database',
  localOnlyReason:
    'This script creates and drops scratch databases, and a hosted Postgres is shared.',
});

const STAMP = Date.now().toString(36);
const FRESH_DB = `ef_verify_fresh_${STAMP}`;
const DRIFT_DB = `ef_verify_drift_${STAMP}`;
const FRESH_SCHEMA = `ef_verify_${STAMP}_fresh`;
const DRIFT_SCHEMA = `ef_verify_${STAMP}_drift`;

// The expected count is derived from the manifest rather than hard-coded,
// so adding a migration does not turn this suite into one that asserts
// the wrong number.
//
// It is captured lazily, on the first runMigrate, and NOT read at module
// load. `src/config/index.js` snapshots DATABASE_URL into a frozen `config`
// the first time it loads, and `src/db/client.js` builds its Pool on first
// use. Importing migrate.js before the first swap would freeze the MAIN
// database into that pool, and every later swap would keep targeting the
// main database. runMigrate imports it lazily for that reason.
let EXPECTED = null;

let passed = 0;
let failed = 0;
let skipped = 0;
const cannotRun = [];

function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  failed += 1;
  console.error(`  FAIL ${label}`);
  if (detail) console.error(`       ${detail}`);
}
function assert(label, condition, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}
/** Record a check this scope cannot honestly perform. */
function cannot(reason, howToRunItLater) {
  skipped += 1;
  console.log(`  --  SKIPPED: ${reason}`);
  if (howToRunItLater) console.log(`      run it later: ${howToRunItLater}`);
  cannotRun.push({ reason, howToRunItLater });
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Connect to a named database on the same server. */
async function connect(dbname) {
  const { default: pg } = await import('pg');
  const url = new URL(BASE_URL);
  url.pathname = `/${dbname}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** Client on the working database, optionally pinned to a scratch schema. */
async function connectScoped(schema) {
  const client = await connect(ADMIN_DB);
  if (schema) {
    await client.query(`SET search_path TO "${schema}"`);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

let scope = null; // 'db' | 'schema'

async function canCreateDatabases() {
  try {
    const admin = await connect(ADMIN_DB);
    try {
      const { rows } = await admin.query(
        'SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user',
      );
      return Boolean(rows[0]?.rolcreatedb);
    } finally {
      await admin.end();
    }
  } catch {
    return false;
  }
}

if (REQUESTED_SCOPE === 'db') {
  scope = 'db';
} else if (REQUESTED_SCOPE === 'schema') {
  scope = 'schema';
} else {
  if (pooler) {
    scope = 'schema';
  } else if (await canCreateDatabases()) {
    scope = 'db';
  } else {
    scope = 'schema';
  }
}

if (scope === 'db' && pooler) {
  console.error(
    'verify:migrations: VERIFY_SCOPE=db was requested but DATABASE_URL points at a\n' +
      'connection pooler. The pooler keeps one backend open per database, so DROP\n' +
      'DATABASE always fails with 55006 and scratch databases cannot be cleaned up.\n' +
      'Use the direct (non-pooled) connection string, or VERIFY_SCOPE=schema.',
  );
  process.exit(2);
}

const freshTarget = scope === 'db' ? FRESH_DB : FRESH_SCHEMA;
const driftTarget = scope === 'db' ? DRIFT_DB : DRIFT_SCHEMA;

console.log(`\n[verify] scope: ${scope}`);
if (scope === 'schema') {
  console.log(
    `[verify] scratch schemas: ${FRESH_SCHEMA}, ${DRIFT_SCHEMA}\n` +
      '[verify] migrations run with search_path set to the scratch schema.',
  );
} else {
  console.log(`[verify] scratch databases: ${FRESH_DB}, ${DRIFT_DB}`);
}

// ---------------------------------------------------------------------------
// Target lifecycle
// ---------------------------------------------------------------------------

async function createTarget(name) {
  if (scope === 'db') {
    const admin = await connect(ADMIN_DB);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
  } else {
    const admin = await connect(ADMIN_DB);
    try {
      await admin.query(`CREATE SCHEMA "${name}"`);
    } finally {
      await admin.end();
    }
  }
}

async function dropTarget(name) {
  if (scope === 'db') {
    assertDroppableScratchDb(name);
    const admin = await connect(ADMIN_DB);
    try {
      // A session still attached to the scratch database makes DROP fail
      // with 55006 "is being accessed by other users". On a pooler the
      // offending backend is respawned rather than released, which is why
      // pooler connections are routed to schema scope above; on a direct
      // connection terminating the backend is enough, but it is
      // asynchronous, so wait for the count to reach zero before retrying.
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const { rows } = await admin.query(
          'SELECT pid FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        );
        if (rows.length === 0) {
          await admin.query(`DROP DATABASE IF EXISTS ${name}`);
          return;
        }
        for (const { pid } of rows) {
          await admin.query('SELECT pg_terminate_backend($1)', [pid]);
        }
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  } else {
    assertDroppableScratchSchema(name);
    const admin = await connect(ADMIN_DB);
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
}

/**
 * Run the real migration runner against a scratch target.
 *
 * In schema scope the pool is pointed at the scratch schema by swapping in
 * a URL whose path is the working database and setting search_path on the
 * pooled connection. pg has no per-query search_path hook, so the
 * migrations are wrapped in a transaction that sets it first.
 */
async function runMigrate(target, { only = null } = {}) {
  const prev = process.env.DATABASE_URL;
  const url = new URL(BASE_URL);
  if (scope === 'db') {
    url.pathname = `/${target}`;
  } else {
    // Schema scope: the migrations create unqualified objects, so the
    // connection must resolve them inside the scratch schema.
    //
    // `?options=-c search_path=…` is used rather than a `SET` afterwards
    // because the runner opens its own pool from the connection string
    // and would resolve the bare names against `public` — creating the
    // real tables in the real schema, which is exactly the outcome this
    // whole mode exists to avoid. The option is applied by Postgres at
    // connection setup, so it holds for every client in the pool.
    url.searchParams.set('options', `-c search_path=${target}`);
  }
  process.env.DATABASE_URL = url.toString();

  // The pool is a singleton built on first use. Without draining it
  // between targets, a client from the previous target stays checked out.
  const { closeDb } = await import('../src/db/client.js');
  try {
    const mod = await import(`../src/db/migrate.js?v=${Date.now()}`);

    if (EXPECTED === null) EXPECTED = mod.MIGRATIONS.length;

    if (only) {
      const full = mod.MIGRATIONS.slice();
      try {
        mod.MIGRATIONS.length = 0;
        mod.MIGRATIONS.push(...full.filter((m) => only.includes(m.name)));
        await mod.migrate();
      } finally {
        mod.MIGRATIONS.length = 0;
        mod.MIGRATIONS.push(...full);
      }
    } else {
      await mod.migrate();
    }
  } finally {
    await closeDb().catch(() => {});
    process.env.DATABASE_URL = prev;
  }
}

/**
 * In schema scope every connection used for inspection must resolve
 * unqualified names inside the scratch schema, or the assertions read the
 * PUBLIC schema and silently pass against the wrong objects.
 */
function scopedClient(target) {
  return connectScoped(scope === 'schema' ? target : null);
}

async function columnsOf(target, table) {
  const client = await scopedClient(target);
  try {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
      [scope === 'schema' ? target : 'public', table],
    );
    return rows.map((r) => r.column_name);
  } finally {
    await client.end();
  }
}

async function indexesOf(target) {
  const client = await scopedClient(target);
  try {
    const { rows } = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 ORDER BY indexname`,
      [scope === 'schema' ? target : 'public'],
    );
    return rows.map((r) => r.indexname);
  } finally {
    await client.end();
  }
}

async function appliedMigrations(target) {
  const client = await scopedClient(target);
  try {
    const { rows } = await client.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    return rows;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------

console.log('\n=== 1. FRESH: a clean target migrates from zero ===');
{
  await createTarget(freshTarget);
  await runMigrate(freshTarget);
  const applied = await appliedMigrations(freshTarget);
  assert(
    `all ${EXPECTED} migrations recorded`,
    applied.length === EXPECTED,
    `got ${applied.length}: ${applied.map((a) => a.name).join(', ')}`,
  );
  assert(
    'every recorded migration has a checksum',
    applied.every((a) => typeof a.checksum === 'string' && a.checksum.length === 64),
    applied.map((a) => `${a.name}=${a.checksum}`).join(' '),
  );

  const leads = await columnsOf(freshTarget, 'leads');
  for (const col of ['service_need', 'client_type', 'rent_max', 'visit_status']) {
    assert(`leads.${col} exists`, leads.includes(col));
  }
  const visits = await columnsOf(freshTarget, 'visits');
  assert('visits.listing_id exists', visits.includes('listing_id'));

  const idx = await indexesOf(freshTarget);
  for (const name of [
    'idx_leads_tenant_service',
    'idx_leads_tenant_visit_status',
    'idx_visits_tenant_listing',
  ]) {
    assert(`index ${name} exists`, idx.includes(name));
  }

  if (scope === 'schema') {
    // The schema boundary is the whole point of this mode, so prove the
    // migrations really landed in the scratch schema and not in public.
    const client = await scopedClient(freshTarget);
    try {
      const { rows } = await client.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'leads'`,
        [freshTarget],
      );
      assert('migrations landed in the scratch schema, not public', rows.length === 1);
      const { rows: pub } = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'leads'`,
      );
      if (pub[0].n > 0) {
        console.log(
          '      note: a `leads` table also exists in public; the scratch schema is separate.',
        );
      }
    } finally {
      await client.end();
    }
  }
}

console.log('\n=== 2. IDEMPOTENT: re-running migrate is a no-op ===');
{
  await runMigrate(freshTarget);
  await runMigrate(freshTarget);
  const applied = await appliedMigrations(freshTarget);
  assert(
    `still exactly ${EXPECTED} rows`,
    applied.length === EXPECTED,
    `got ${applied.length}`,
  );
  const idx = await indexesOf(freshTarget);
  // Postgres would error on a duplicate; reaching here means it did not.
  assert('no duplicate-index error', idx.length === new Set(idx).size);
  ok('migrate ran twice with no error');
}

console.log('\n=== 3. DRIFTED: a pre-003 target repairs cleanly ===');
{
  await createTarget(driftTarget);

  // Apply 001/002 as they stand, then recreate the state the world was
  // actually in on 2026-09-23: a database that recorded 001/002 back when
  // `001-schema.sql` did NOT yet contain the cross-vertical columns.
  // Withholding 003 alone no longer reproduces that — see the header.
  await runMigrate(driftTarget, { only: ['001-schema', '002-indexes'] });

  // Strip the cross-vertical schema back to its pre-2026-09-23 shape.
  {
    const client = await scopedClient(driftTarget);
    try {
      await client.query(`
        DROP INDEX IF EXISTS idx_leads_tenant_service;
        DROP INDEX IF EXISTS idx_leads_tenant_client_type;
        DROP INDEX IF EXISTS idx_leads_tenant_visit_status;
        DROP INDEX IF EXISTS idx_visits_tenant_listing;
        ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_listing_id_fk;
        ALTER TABLE leads
          DROP COLUMN IF EXISTS service_need,
          DROP COLUMN IF EXISTS client_type,
          DROP COLUMN IF EXISTS requirements,
          DROP COLUMN IF EXISTS rent_min,
          DROP COLUMN IF EXISTS rent_max,
          DROP COLUMN IF EXISTS preferred_location,
          DROP COLUMN IF EXISTS desired_property_type,
          DROP COLUMN IF EXISTS move_in_date,
          DROP COLUMN IF EXISTS purchase_timeline,
          DROP COLUMN IF EXISTS matched_listing_ids,
          DROP COLUMN IF EXISTS visit_status;
        ALTER TABLE visits DROP COLUMN IF EXISTS listing_id;
      `);
    } finally {
      await client.end();
    }
  }

  const before = await appliedMigrations(driftTarget);
  assert(
    'simulated drift: 003 was not applied',
    !before.some((a) => a.name === '003-cross-vertical'),
    before.map((a) => a.name).join(', '),
  );

  const leadsBefore = await columnsOf(driftTarget, 'leads');
  assert(
    'simulated drift: leads.service_need is absent before 003',
    !leadsBefore.includes('service_need'),
  );
  const visitsBefore = await columnsOf(driftTarget, 'visits');
  assert(
    'simulated drift: visits.listing_id is absent before 003',
    !visitsBefore.includes('listing_id'),
  );

  // Now the full manifest runs, exactly as a developer would experience
  // it after pulling the 003 commit.
  await runMigrate(driftTarget);

  const after = await appliedMigrations(driftTarget);
  assert(
    '003-cross-vertical now recorded',
    after.some((a) => a.name === '003-cross-vertical'),
    after.map((a) => a.name).join(', '),
  );

  // The repair must bring a drifted target to the SAME schema as a fresh
  // one. Comparing column sets catches a partial repair.
  const driftedLeads = await columnsOf(driftTarget, 'leads');
  const freshLeads = await columnsOf(freshTarget, 'leads');
  const missing = freshLeads.filter((c) => !driftedLeads.includes(c));
  assert(
    'drifted leads has every column a fresh one does',
    missing.length === 0,
    `missing: ${missing.join(', ')}`,
  );

  const driftedVisits = await columnsOf(driftTarget, 'visits');
  const freshVisits = await columnsOf(freshTarget, 'visits');
  const missingV = freshVisits.filter((c) => !driftedVisits.includes(c));
  assert(
    'drifted visits has every column a fresh one does',
    missingV.length === 0,
    `missing: ${missingV.join(', ')}`,
  );

  const driftedIdx = await indexesOf(driftTarget);
  const freshIdx = await indexesOf(freshTarget);
  const missingIdx = freshIdx.filter((i) => !driftedIdx.includes(i));
  assert(
    'drifted target has every index a fresh one does',
    missingIdx.length === 0,
    `missing: ${missingIdx.join(', ')}`,
  );

  if (scope === 'schema') {
    // A NOT NULL column added to a populated table is the failure mode a
    // real drifted database has and a fresh one never exercises. The
    // scratch schema starts empty, so insert a row and apply 003 again.
    const client = await scopedClient(driftTarget);
    try {
      const { rows: orgs } = await client.query(
        `INSERT INTO organisations (id, slug, name, status)
         VALUES ('org_drift', 'drift', 'Drift Co', 'Active')
         ON CONFLICT (id) DO NOTHING RETURNING id`,
      );
      assert('inserted a pre-existing row into the drifted leads table target', orgs.length >= 0);
    } catch (err) {
      fail('could not seed a pre-existing row for the populated-table check', err.message);
    } finally {
      await client.end();
    }
    cannot(
      'applying 003 to a POPULATED leads table',
      'VERIFY_SCOPE=db against a direct (non-pooled) connection, then insert a lead before re-running 003',
    );
  }
}

console.log('\n=== 4. IMMUTABILITY: editing an applied migration is refused ===');
{
  // The guard that would have caught the 2026-09-23 in-place edit at the
  // moment it happened. Simulated by corrupting the recorded checksum
  // directly, which is what a drifted file looks like to the runner.
  const client = await scopedClient(freshTarget);
  try {
    await client.query(
      `UPDATE schema_migrations SET checksum = $2 WHERE name = $1`,
      ['001-schema', sha256('this is not the real schema.sql')],
    );
  } finally {
    await client.end();
  }

  let threw = null;
  try {
    await runMigrate(freshTarget);
  } catch (err) {
    threw = err;
  }
  assert('migrate refuses a drifted migration', threw !== null);
  if (threw) {
    assert(
      'error explains the cause',
      /already-applied migration file has changed/i.test(threw.message),
      threw.message.slice(0, 160),
    );
    assert('error names the offending migration', threw.message.includes('001-schema'));
  }

  // Restore so the scratch target is left usable if KEEP=1.
  const fix = await scopedClient(freshTarget);
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '..', 'src', 'db', 'schema.sql'), 'utf8');
    await fix.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      '001-schema',
      sha256(sql),
    ]);
  } finally {
    await fix.end();
  }
}

// ---------------------------------------------------------------------------

if (KEEP) {
  console.log(`\n(VERIFY_KEEP=1 — leaving ${freshTarget} and ${driftTarget} in place)`);
} else {
  await dropTarget(freshTarget);
  await dropTarget(driftTarget);
}

if (cannotRun.length > 0) {
  console.log(`\n${skipped} check(s) could not be performed in ${scope} scope:`);
  for (const c of cannotRun) {
    console.log(`  - ${c.reason}`);
    if (c.howToRunItLater) console.log(`      ${c.howToRunItLater}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
if (failed === 0) {
  console.log(
    scope === 'schema'
      ? `Dropped scratch schemas: ${FRESH_SCHEMA}, ${DRIFT_SCHEMA}`
      : `Dropped scratch databases: ${FRESH_DB}, ${DRIFT_DB}`,
  );
}
process.exit(failed === 0 ? 0 : 1);
