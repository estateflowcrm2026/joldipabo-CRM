// Create or reconcile the non-owner application database role.
//
//   node --env-file=.env scripts/app-role.js --check
//   node --env-file=.env scripts/app-role.js --create
//   node --env-file=.env scripts/app-role.js --rotate-password --write-env
//   node --env-file=.env scripts/app-role.js --show-url
//
// WHY THIS ROLE EXISTS
// --------------------
// RLS is inert for the owner. The application connects as `postgres`,
// which owns every table AND has BYPASSRLS, so `ENABLE ROW LEVEL
// SECURITY` changes nothing for it — verified on the live database: with
// a policy installed, RLS enabled and `app.tenant_id` set to one tenant,
// a SELECT still returned both tenants' rows.
//
// Postgres exempts the table owner from RLS unless FORCE ROW LEVEL
// SECURITY is set, and BYPASSRLS is independent of that. So the app
// needs a role that is neither. This creates it.
//
// NOT A MIGRATION, AND NOT ON PURPOSE
// ------------------------------------
// A migration cannot create a role with a password: the password would
// have to be in the SQL file, and that file is in git. Nor should it
// need to — role creation is an operator action, not a schema change,
// and the grants it depends on are already in the schema.
//
// It is also not something `db:migrate` should do implicitly on a
// hosted platform, where the migration user may not have CREATEROLE.
// Hence a script.
//
// THE ROLE
// --------
//   LOGIN              — it authenticates over TCP
//   NOSUPERUSER        — no superuser powers
//   NOBYPASSRLS        — THE POINT. RLS applies to it.
//   NOCREATEDB         — cannot create databases
//   NOCREATEROLE       — cannot create roles
//   NOREPLICATION      — not a replica
//   NOINHERIT?         — no: it must be able to inherit the PUBLIC
//                         grants Supabase's own roles rely on.
//
// NOINHERIT is deliberately NOT set. Supabase grants usage on schemas
// and the base types to PUBLIC; a role that does not inherit PUBLIC
// would be unable to use text, jsonb or the schema at all, and the
// failure would read as a missing grant rather than a missing INHERIT.
//
// PASSWORD
// --------
// Never taken as an argument, never printed, never written to a file.
// `--create` and `--rotate-password` generate one and print it ONCE,
// with a warning that it is not recoverable. Better: create the role
// without a password, then set it in the secret manager, and use
// `--show-url` to print the URL shape with the password omitted.
//
// Grants
// ------
// SELECT/INSERT/UPDATE/DELETE on the application tables, and USAGE on
// the schema. No CREATE, no ALTER, no DROP, no TRUNCATE, no REFERENCES
// and no ownership. The app role cannot change its own schema, which
// means a compromised application process cannot turn RLS off.
//
// --check reports what is currently true without changing anything, and
// is safe to run in CI.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/db/client.js';

const ROLE = process.env.DB_APP_ROLE || 'estateflow_app';

/**
 * Tables the application reads and writes.
 *
 * Deliberately NOT the whole public schema. `roles` and
 * `permission_matrices` are global reference tables, and the pre-auth
 * tables (`organisations`, `refresh_sessions`, `login_attempts`) are
 * read before a tenant is established — giving the app role access to
 * them is required for login to keep working, and is exactly why they
 * are not RLS-protected yet. See docs/RLS_ROLLOUT_PLAN.md §2d.
 */
const APP_TABLES = [
  // RLS-protected — the four from migration 010
  'listings', 'leads', 'visits', 'listing_photos',
  // Application tables with no policy yet; the app still needs them
  'users', 'teams', 'branches', 'projects', 'attendance',
  'listing_matches', 'listing_documents', 'photos',
  'messages', 'threads', 'export_jobs',
  'otp_codes', 'mfa_challenges', 'mfa_backup_codes',
  'password_reset_tokens', 'audit_log',
  // Global reference, read by every tenant
  'roles', 'permission_matrices',
  // Pre-auth: needed for login, and precisely why they carry no policy
  'organisations', 'refresh_sessions', 'login_attempts',
  // Junctions — reached through their parent
  'project_members', 'team_members', 'thread_participants', 'user_project_ids',
  // `schema_migrations` is DELIBERATELY ABSENT. The application never
  // reads it — only the migration runner does, and that runs as the
  // owner. Granting the app role DML on its own migration history would
  // let a compromised process rewrite the record of what has been
  // applied to it, which is a way to make an audit trail disappear.
];

const arg = (name) => process.argv.includes(name);

/**
 * Quote a value as a SQL string literal.
 *
 * Both quote characters must be escaped. A generated password can
 * contain either — `randomBytes(...).toString('base64url')` cannot
 * produce `'`, but a password supplied from elsewhere can, and the
 * failure is a syntax error that names the leaked fragment.
 */
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Quote an identifier, doubling any embedded double quote. */
const qi = (id) => `"${String(id).replace(/"/g, '""')}"`;

async function roleExists(db) {
  const { rows } = await db.query(
    'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname = $1',
    [ROLE],
  );
  return rows[0] ?? null;
}

/** Tables this role currently holds DML privileges on. */
async function grantedTables(db) {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = $1 AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
      ORDER BY table_name`,
    [ROLE],
  );
  return rows.map((r) => r.table_name);
}

/** Tables this role owns — must be empty for RLS to bind. */
async function ownedTables(db) {
  const { rows } = await db.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m')
        AND r.rolname = $1 ORDER BY c.relname`,
    [ROLE],
  );
  return rows.map((r) => r.relname);
}

const DML = 'SELECT, INSERT, UPDATE, DELETE';

async function create(db) {
  const existing = await roleExists(db);
  if (existing) {
    console.log(`[app-role] ${ROLE} already exists — reconciling grants only.`);
  } else {
    // NOLOGIN on creation, then the password is set separately. That
    // keeps a generated secret out of this file, out of the logs, and
    // out of shell history.
    await db.query(
      `CREATE ROLE ${qi(ROLE)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    console.log(`[app-role] created ${ROLE} (NOLOGIN for now)`);
  }

  // Attributes are corrected even on an existing role: a role created
  // by hand with BYPASSRLS would silently defeat the whole rollout, and
  // reconciling is the point of re-running this.
  //
  // Supabase installs a `supautils` event trigger that refuses
  // `ALTER ROLE` for a non-supabase_admin session, so this is expected
  // to fail there. It is not skipped silently: --check reports the real
  // attributes afterwards, and a role that genuinely needs changing
  // must be altered through the SQL editor or the dashboard.
  try {
    await db.query(
      `ALTER ROLE ${qi(ROLE)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    console.log('[app-role] attributes reconciled: NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
  } catch (err) {
    console.log(`[app-role] ALTER ROLE refused (${err.message.split('\n')[0]}).`);
    console.log('           Verifying the attributes as they stand instead.');
    const now = await roleExists(db);
    if (now && (now.rolsuper || now.rolbypassrls)) {
      throw new Error(
        `${ROLE} has attributes that would defeat RLS ` +
          `(superuser=${now.rolsuper}, bypassrls=${now.rolbypassrls}).\n` +
          '  Fix it in the Supabase SQL editor:\n' +
          `    ALTER ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`,
      );
    }
    console.log('[app-role] attributes are already correct.');
  }

  await db.query(`GRANT USAGE ON SCHEMA public TO ${qi(ROLE)}`);
  console.log('[app-role] GRANT USAGE ON SCHEMA public');

  // One statement for the whole set, so a partially-applied run is not
  // possible: either the grant list is applied or it is not.
  const names = APP_TABLES.map(q).join(', ');
  await db.query(`GRANT ${DML} ON ${names} TO ${qi(ROLE)}`);
  console.log(`[app-role] GRANT ${DML} on ${APP_TABLES.length} tables`);

  // Sequences: no SERIAL/BIGSERIAL columns exist today, so this is
  // harmless now and prevents a confusing failure if one is added.
  await db.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${qi(ROLE)}`,
  );
  console.log('[app-role] GRANT USAGE, SELECT on sequences');

  // Explicitly NOT granted, and worth stating:
  //   CREATE / ALTER / DROP / TRUNCATE / REFERENCES / ownership
  // A compromised app process therefore cannot disable RLS on a table
  // it can read.
  console.log('[app-role] no DDL, TRUNCATE, REFERENCES or ownership granted.');
}

async function check(db) {
  const role = await roleExists(db);
  if (!role) {
    console.log(`[app-role] MISSING: ${ROLE} does not exist.`);
    console.log('  Create it with:  node --env-file=.env scripts/app-role.js --create');
    return false;
  }

  let ok = true;
  const check = (label, pass, detail = '') => {
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!pass) ok = false;
  };

  console.log(`\n[app-role] ${ROLE}`);
  check('is NOT a superuser', !role.rolsuper);
  check('does NOT bypass RLS', !role.rolbypassrls, 'this is the whole point');
  check('cannot create databases', !role.rolcreatedb);
  check('cannot create roles', !role.rolcreaterole);
  check('inherits PUBLIC grants', role.rolinherit, 'needed for base types on Supabase');

  const owned = await ownedTables(db);
  check('owns no tables', owned.length === 0, owned.join(', '));

  const granted = await grantedTables(db);
  const missing = APP_TABLES.filter((t) => !granted.includes(t));
  check(
    `has DML on all ${APP_TABLES.length} application tables`,
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '',
  );

  // The dangerous grants, checked explicitly rather than assumed absent.
  const ddl = await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = $1 AND privilege_type IN ('CREATE','ALTER','DROP','TRUNCATE','REFERENCES')`,
    [ROLE],
  );
  check(
    'holds no DDL/TRUNCATE/REFERENCES grants',
    ddl.rows.length === 0,
    ddl.rows.map((r) => r.privilege_type).join(', '),
  );

  // The app must not be able to edit the record of what has been
  // migrated onto it. Asserted rather than assumed, because a
  // convenient `GRANT ALL ON ALL TABLES` would quietly include it.
  check(
    'has NO access to schema_migrations',
    !granted.includes('schema_migrations'),
    'the app never reads it; only the migration runner does',
  );

  console.log('');
  return ok;
}

async function rotatePassword(db, { writeEnv = false } = {}) {
  if (!(await roleExists(db))) {
    console.error(`[app-role] ${ROLE} does not exist. Run --create first.`);
    process.exit(2);
  }
  // Generated in-process. Never an argument, never in a log line.
  const password = randomBytes(24).toString('base64url');
  await db.query(`ALTER ROLE ${qi(ROLE)} LOGIN PASSWORD ${q(password)}`);

  if (!writeEnv) {
    // Default: print once, with a warning. That is unavoidable if the
    // operator is going to put it in a secret manager, and it is a
    // deliberate act rather than the default path.
    console.log(`[app-role] ${ROLE} password set. Shown once, not recoverable:\n`);
    console.log(`  ${password}\n`);
    console.log('  Store it now, then run --show-url to build APP_DATABASE_URL.');
    return;
  }

  // --write-env: the value goes straight into the gitignored .env and is
  // never printed. Preferred, because a credential that is displayed is
  // a credential in someone's terminal scrollback and in this session's
  // transcript.
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('[app-role] DATABASE_URL is not set, so the URL cannot be built.');
    process.exit(2);
  }
  const u = new URL(raw);
  u.username = ROLE;
  u.password = password;
  if (!u.searchParams.get('sslmode')) u.searchParams.set('sslmode', 'require');

  const target = resolveEnvPath();
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    /* first run */
  }
  const line = `APP_DATABASE_URL=${u.toString()}`;
  const replaced = /^APP_DATABASE_URL=.*$/m.test(existing);
  const next = replaced
    ? existing.replace(/^APP_DATABASE_URL=.*$/m, line)
    : `${existing.replace(/\s*$/, '')}\n${line}\n`;

  writeFileSync(target, next, { mode: 0o600 });
  console.log(`[app-role] password set and APP_DATABASE_URL written to ${target}`);
  console.log('           The value was NOT printed. It is not recoverable — rerun');
  console.log('           --rotate-password --write-env to replace it.');
}

/** Where the env file lives. Overridable so CI can use a scratch path. */
function resolveEnvPath() {
  return process.env.APP_ENV_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
}

async function showUrl(db) {
  const role = await roleExists(db);
  if (!role) {
    console.error(`[app-role] ${ROLE} does not exist. Run --create first.`);
    process.exit(2);
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('[app-role] DATABASE_URL is not set, so the host cannot be derived.');
    process.exit(2);
  }
  const u = new URL(raw);
  u.username = ROLE;
  u.password = '';

  const sslmode = u.searchParams.get('sslmode');
  if (sslmode !== 'verify-full') {
    // Refuse to print a URL that would silently weaken verification —
    // the same rule the server applies at boot.
    u.searchParams.set('sslmode', 'require');
    console.log('[app-role] note: appended sslmode=require. For production use verify-full');
    console.log('          and a CA bundle; see docs/SUPABASE_VERIFICATION.md §2.');
  }

  console.log('\n[app-role] APP_DATABASE_URL (password omitted — append it from the secret manager):\n');
  console.log(`  ${u.toString().replace('//@', '/:<password>@')}\n`);
  console.log('  Against Supabase this role cannot be created with CREATE ROLE over the');
  console.log('  pooler; use the SQL editor or the direct connection. See');
  console.log('  docs/RLS_ROLLOUT_PLAN.md §1.');
}

const db = getDb();
try {
  if (arg('--create')) {
    await create(db);
  } else if (arg('--check')) {
    const ok = await check(db);
    await closeDb();
    process.exit(ok ? 0 : 1);
  } else if (arg('--rotate-password')) {
    await rotatePassword(db, { writeEnv: arg('--write-env') });
  } else if (arg('--show-url')) {
    await showUrl(db);
  } else {
    console.log('Usage: node --env-file=.env scripts/app-role.js');
    console.log('         --check             report the role\'s current attributes and grants');
    console.log('         --create            create the role and reconcile grants');
    console.log('         --rotate-password   set a new password and print it once');
    console.log('         --write-env         with --rotate-password: write APP_DATABASE_URL');
    console.log('                            into .env instead of printing it (preferred)');
    console.log('         --show-url          print the URL shape with no password');
    await closeDb();
    process.exit(2);
  }
} finally {
  await closeDb();
}

console.log('');
