// Migration runner. Standalone script, not imported by the app.
//
// Usage:
//   npm run db:migrate   # apply pending migrations (idempotent)
//   npm run db:seed      # migrate, then load seed-demo.sql (skips if seeded)
//   npm run db:reset     # DROP everything and re-migrate (heavily guarded)
//
// Safety properties
// ------------------
// 1. CHECKSUMS. Each applied migration records a SHA-256 of its SQL file.
//    On every run, an already-applied migration whose file no longer
//    hashes to the recorded value causes a hard failure. Editing a shipped
//    migration is therefore a loud, immediate error rather than silent
//    drift. Migrations 001 and 002 are FROZEN; see the header in each file.
//
// 2. ADVISORY LOCK. The runner holds a session-level Postgres advisory
//    lock for the duration. Two concurrent deploys cannot both migrate:
//    the second blocks, then sees the first one's result. Without this,
//    two replicas starting together would both read "001 not applied" and
//    both apply it.
//
// 3. ORDERING. Migrations are applied in array order, always. The runner
//    refuses to proceed if a migration is recorded as applied but an
//    earlier one is not — that would mean history was tampered with.
//
// 4. PARTIAL FAILURE. Each file is sent as a single parameterless query,
//    which uses the simple query protocol; Postgres wraps that in an
//    implicit transaction. If statement 40 of a file fails, 1-39 roll
//    back and the migration is not recorded. The next run retries cleanly.
//    The known weak link is the gap AFTER the DDL: a crash between the
//    SQL and the tracking-row insert leaves the schema applied but
//    unrecorded. Idempotency rescues this at the cost of a full re-run.
//
// Tracking: applied migrations live in `schema_migrations(name, checksum,
// applied_at)`. seed-demo.sql uses plain INSERTs, so it is NOT re-runnable;
// db:seed guards by checking whether `organisations` already has rows.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb, adminDatabaseUrl, isDbConfigured, closeDb } from './client.js';
import { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

// Ordered. Append new migrations at the end; never reorder or remove.
// 001 and 002 are FROZEN — do not edit the files they point at.
//
// 005-seed-dev-credentials.sql is deliberately NOT in this list. It sets
// a known password on every demo user and is applied by hand, only
// against a local database — see the header in that file and
// `npm run seed:dev-credentials`.
const MIGRATIONS = [
  { name: '001-schema', file: 'schema.sql' },
  { name: '002-indexes', file: 'indexes.sql' },
  { name: '003-cross-vertical', file: '003-cross-vertical.sql' },
  { name: '004-auth-sessions', file: '004-auth-sessions.sql' },
  { name: '006-audit-integrity', file: '006-audit-integrity.sql' },
  { name: '007-audit-actor-preservation', file: '007-audit-actor-preservation.sql' },
  { name: '008-mfa', file: '008-mfa.sql' },
  { name: '009-mfa-challenge-revocation', file: '009-mfa-challenge-revocation.sql' },
  { name: '010-rls-listings-leads', file: '010-rls-listings-leads.sql' },
  { name: '011-photos-deprecated', file: '011-photos-deprecated.sql' },
  { name: '012-contact-intake', file: '012-contact-intake.sql' },
  { name: '013-visit-viewings', file: '013-visit-viewings.sql' },
  { name: '014-visit-event-snapshots', file: '014-visit-event-snapshots.sql' },
];

const SEED_FILE = 'seed-demo.sql';
const RESET_GUARD_ENV = 'ESTATEFLOW_ALLOW_RESET';

// Arbitrary but fixed. Any two clients using the same constant exclude
// each other; a client using a different constant does not. 0x1_5FE_F10A
// is mnemonic-ish and unlikely to collide with another tool.
const MIGRATION_LOCK_ID = 0x15fef10a;

/** SHA-256 of a migration file's contents, hex-encoded. */
export function checksumFor(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function readSql(file) {
  return readFileSync(join(here, file), 'utf8');
}

async function ensureMigrationsTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Added separately so a pre-2026-09-24 database (which has the table
  // without this column) migrates in place instead of erroring.
  await db.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum text
  `);
}

/**
 * Take a session-level advisory lock. Blocks until acquired.
 *
 * pg_advisory_lock is session-scoped, so it is released when the
 * connection closes — including on a crash. That is the property we
 * want: a killed migration runner must not leave a permanent lock.
 */
async function acquireLock(db) {
  await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
}

/**
 * Tell migrations whether row-level security should be enabled.
 *
 * A migration is SQL and cannot read `process.env`, so the mode is
 * handed to it as a session setting that the policy block in
 * `010-rls-listings-leads.sql` reads.
 *
 * Session-scoped (`false`, not `true`) rather than transaction-scoped:
 * the migrations run outside an explicit transaction, each file in its
 * own implicit one, so a transaction-local value would be gone before
 * the file that needs it ran. It is still confined to this connection,
 * which the runner closes at the end.
 *
 * An unset or blank deployment mode resolves to 'preserve' for migrations.
 * Existing RLS remains unchanged. Disabling it requires explicit 'off'.
 * Runtime mode defaults are not permission to downgrade database security.
 */
async function exposeRlsMode(db) {
  const { rlsMode } = await import('./rlsMode.js');
  // Runtime defaults must not become an implicit database rollback.
  // With no explicit mode, leave existing table security unchanged.
  const mode = String(process.env.DB_RLS_MODE ?? '').trim() ? rlsMode() : 'preserve';
  await db.query("SELECT set_config('app.rls_enabled', $1, false)", [mode]);
  return mode;
}

async function releaseLock(db) {
  // Best-effort. If the connection is already gone, Postgres has
  // released the lock for us and there is nothing to undo.
  try {
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  } catch {
    /* connection is gone; the lock died with it */
  }
}

/** name -> { checksum, appliedAt } for every recorded migration. */
async function appliedRecords(db) {
  const { rows } = await db.query(
    'SELECT name, checksum, applied_at FROM schema_migrations',
  );
  return new Map(rows.map((r) => [r.name, r]));
}

/**
 * Bring the protected tables' RLS state in line with `DB_RLS_MODE`.
 *
 * WHY THIS RUNS EVERY TIME, NOT ONLY ON FIRST APPLICATION
 * ------------------------------------------------------
 * 010 is recorded once, so the ENABLE inside it runs once. A deployment
 * that applies 010 with the default `off`, then sets `DB_RLS_MODE=probe`
 * and re-runs, would find the flag having done nothing — and the
 * obvious conclusion ("the mode does not work") would be wrong. Worse in
 * the other direction: removing the flag must not implicitly disable RLS.
 * Rollback remains available through an explicitly configured 'off' mode.
 *
 * So the mode is a PROPERTY of the deployment, applied on every run,
 * and `db:migrate` is the thing that reconciles it. That makes
 * "change one variable and re-run migrate" the complete rollback, which
 * is what makes probe safe to adopt incrementally.
 *
 * Idempotent, and a no-op when nothing differs.
 */
const RLS_TABLES = ['listings', 'leads', 'visits', 'listing_photos'];

export async function syncRlsState(db, mode) {
  if (mode == null || mode === '' || mode === 'preserve') return 0;
  if (!['off', 'probe', 'enforce'].includes(mode)) {
    throw new Error(`Invalid migration RLS mode: ${mode}`);
  }
  const shouldEnable = mode !== 'off';
  let changed = 0;
  for (const t of RLS_TABLES) {
    const { rows } = await db.query(
      'SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass',
      [t],
    );
    if (!rows.length) continue;
    if (Boolean(rows[0].relrowsecurity) === shouldEnable) continue;
    await db.query(
      `ALTER TABLE ${t} ${shouldEnable ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`,
    );
    changed += 1;
  }
  if (changed > 0) {
    console.log(
      `[migrate] DB_RLS_MODE=${mode} — ${changed === 'auto' ? 'auto' : changed} table(s) ` +
        `${shouldEnable ? 'enabled' : 'disabled'} RLS.`,
    );
  }
  return changed;
}

/**
 * Fail loudly when an applied migration's file has changed.
 *
 * This is the check that would have caught the 2026-09-23 in-place edit
 * to 001-schema at the moment it happened, instead of months later.
 *
 * A row with a NULL checksum is tolerated: databases created before
 * checksums existed have no baseline to compare against. The next edit
 * to such a file will be caught, because the checksum is backfilled on
 * first run.
 */
export function verifyChecksums(records, migrations, readFile) {
  const problems = [];
  for (const { name, file } of migrations) {
    const record = records.get(name);
    if (!record) continue;
    if (record.checksum == null) continue; // pre-checksum baseline unknown

    const current = checksumFor(readFile(file));
    if (current !== record.checksum) {
      problems.push({ name, file, recorded: record.checksum, current });
    }
  }
  return problems;
}

function formatChecksumProblems(problems) {
  const lines = problems.map(
    ({ name, file, recorded, current }) =>
      `\n  ${name} (${file})\n` +
      `    recorded: ${recorded}\n` +
      `    current:  ${current}`,
  );
  return (
    'Refusing to migrate: an already-applied migration file has changed.\n\n' +
    `${problems.length} migration${problems.length === 1 ? '' : 's'} drifted:${lines.join('')}\n\n` +
    'Applied migrations are immutable. Editing one leaves every database that\n' +
    'already ran it with a different schema than a freshly-created one — which\n' +
    'is exactly the failure this check exists to prevent.\n\n' +
    'How to fix, depending on intent:\n' +
    '  * You meant to add schema  → put it in a NEW numbered file (004-…)\n' +
    '                             and register it in MIGRATIONS.\n' +
    '  * This is a local scratch DB → drop and recreate it:\n' +
    '      ESTATEFLOW_ALLOW_RESET=yes npm run db:reset\n' +
    '  * You need to reconcile a production database → write a corrective\n' +
    '    migration; do not rewrite history.\n\n' +
    'See docs/PRODUCT_PRODUCTION_ROADMAP.md §4.6.'
  );
}

/** Guard against tampered or partially-recorded history. */
function verifyOrder(records, migrations) {
  const applied = migrations.filter((m) => records.has(m.name));
  for (let i = 1; i < applied.length; i += 1) {
    if (!records.has(migrations[i - 1].name)) {
      throw new Error(
        `Refusing to migrate: migration history is out of order.\n\n` +
          `  ${migrations[i - 1].name} has not been applied, but the later\n` +
          `  ${applied[i].name} has.\n\n` +
          'Apply the missing migration first, or recreate the database.',
      );
    }
  }
}

async function applyMigration(db, { name, file }) {
  const sql = readSql(file);
  const checksum = checksumFor(sql);
  await db.query(sql);
  await db.query(
    `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum`,
    [name, checksum],
  );
  console.log(`[migrate] applied ${name} (${file})`);
}

/**
 * The migration connection.
 *
 * Deliberately NOT the shared pool. Once APP_DATABASE_URL is set, that
 * pool connects as `estateflow_app`, which owns nothing — so every
 * CREATE TABLE, ALTER TABLE and GRANT would fail with
 * "permission denied for schema public". The failure is correct: the app
 * role is not supposed to be able to change the schema. The tools that
 * legitimately do must therefore ask for the admin connection by name.
 *
 * A dedicated Pool rather than mutating process.env, so the owner URL is
 * not visible to anything else reading the environment.
 */
let adminPool = null;

function getAdminDb() {
  const url = adminDatabaseUrl();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Migrations need the owner connection; ' +
        'APP_DATABASE_URL (the application role) deliberately cannot run DDL.',
    );
  }
  if (!adminPool) {
    adminPool = new Pool({
      connectionString: url,
      max: 1,
      // Same statement/lock timeouts as the runtime pool, so a migration
      // cannot hang forever against live traffic.
      statement_timeout: 60_000,
      lock_timeout: 10_000,
    });
  }
  return adminPool;
}

async function closeAdminDb() {
  if (!adminPool) return;
  const p = adminPool;
  adminPool = null;
  await p.end();
}

async function migrate() {
  const db = getAdminDb();
  await ensureMigrationsTable(db);
  await acquireLock(db);
  try {
    const rls = await exposeRlsMode(db);
    const records = await appliedRecords(db);

    // Immutability check runs BEFORE any DDL so a drifted history fails
    // without touching the schema.
    const problems = verifyChecksums(records, MIGRATIONS, readSql);
    if (problems.length > 0) {
      throw new Error(formatChecksumProblems(problems));
    }

    verifyOrder(records, MIGRATIONS);

    for (const m of MIGRATIONS) {
      if (records.has(m.name)) {
        // Backfill a checksum for rows recorded before checksums existed,
        // so the immutability check is armed from this point on.
        if (records.get(m.name).checksum == null) {
          await db.query(
            'UPDATE schema_migrations SET checksum = $2 WHERE name = $1',
            [m.name, checksumFor(readSql(m.file))],
          );
          console.log(`[migrate] recorded checksum for ${m.name}`);
        }
        console.log(`[migrate] skipping ${m.name} (already applied)`);
        continue;
      }
      await applyMigration(db, m);
    }

    // Reconcile the RLS mode on every run, not only when 010 is first
    // applied — see syncRlsState for why.
    await syncRlsState(db, rls);

    console.log('[migrate] done.');
  } finally {
    await releaseLock(db);
  }
}

async function seed() {
  await migrate();
  const db = getAdminDb();
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM organisations');
  if (rows[0].n > 0) {
    console.log('[seed] organisations already has rows; skipping seed-demo.sql.');
    console.log('[seed] To re-seed from scratch, use npm run db:reset (guarded).');
    return;
  }
  await db.query(readSql(SEED_FILE));
  console.log('[seed] applied seed-demo.sql.');
}

function resetGuardedUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function reset() {
  if (process.env[RESET_GUARD_ENV] !== 'yes') {
    console.error(
      `[reset] REFUSED. Set ${RESET_GUARD_ENV}=yes to allow a destructive reset.\n` +
        '[reset] Example: ESTATEFLOW_ALLOW_RESET=yes npm run db:reset',
    );
    process.exit(2);
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!resetGuardedUrl(url)) {
    console.error(
      '[reset] REFUSED. db:reset only runs against localhost / 127.0.0.1.\n' +
        '[reset] Refusing to drop a potentially shared or production database.',
    );
    process.exit(2);
  }
  const db = getAdminDb();
  console.log('[reset] dropping schema (public) and re-migrating…');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await ensureMigrationsTable(db);
  for (const m of MIGRATIONS) {
    await applyMigration(db, m);
  }
  console.log('[reset] done. Run npm run db:seed to load demo data.');
}

async function main() {
  if (!isDbConfigured()) {
    console.error(
      '[migrate] DATABASE_URL is not set. Nothing to do.\n' +
        '[migrate] See server/README.md "Local Postgres" for setup.',
    );
    process.exit(2);
  }
  const args = new Set(process.argv.slice(2));
  try {
    if (args.has('--reset')) await reset();
    else if (args.has('--seed')) await seed();
    else await migrate();
  } finally {
    await closeAdminDb();
    await closeDb();
  }
}

// Only run when executed directly (`node src/db/migrate.js`), not on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[migrate] failed:', err?.message ?? err);
    process.exit(1);
  });
}

export { migrate, seed, reset, MIGRATIONS, MIGRATION_LOCK_ID };
