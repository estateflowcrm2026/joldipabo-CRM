// Shared safety gate for the two verification scripts that WRITE to a
// database:
//
//   verify-migrations.js  creates and drops scratch databases (or schemas)
//   smoke-auth-db.js     creates and deletes real user rows
//
// Both default to localhost only. A hosted Postgres — Supabase, RDS,
// Neon — is shared infrastructure, so pointing either script at one has
// to be an explicit, visible decision rather than something a stray env
// var causes by accident.
//
// Three conditions must hold before a remote host is accepted:
//
//   1. VERIFY_ALLOW_REMOTE=1 is set. Without it the localhost check is
//      unchanged and still refuses, so existing local setups keep
//      working exactly as before.
//   2. NODE_ENV is not production. Verification is destructive by
//      design; it must never be pointed at a production database.
//   3. The target is printed in full — user, host, port, database —
//      with the password masked, along with what the run is about to do
//      to it, so the operator sees the host in the terminal before the
//      writes happen.
//
// The localhost refusal predates this module and is preserved; this
// adds an escape hatch, it does not replace the default.
//
// SCRATCH SCOPES
// --------------
// A scratch database (`ef_verify_fresh_*`, `ef_verify_drift_*`) is the
// strictest isolation and is what local runs use. It is not always
// available on managed Postgres:
//
//   * Supabase's connection pooler (Supavisor) keeps one backend open
//     per database for as long as that database exists, so DROP DATABASE
//     always fails with 55006 "is being accessed by other users" and the
//     scratch database is orphaned. That is not a race that retrying can
//     win — measured, not assumed.
//   * Some hosted plans do not grant CREATEDB to the connecting role at
//     all.
//
// So a schema-scoped mode exists for those environments. A scratch
// SCHEMA (`ef_verify_<stamp>`) gives the same "clean, disposable, never
// the real data" property, works through a pooler, and is dropped in
// milliseconds. Set VERIFY_SCOPE=schema to use it, or VERIFY_SCOPE=auto
// (the default) to let the script fall back to it after detecting a
// pooler or a missing CREATEDB privilege.

import { exit } from 'node:process';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * A scratch database may only be dropped if its name matches this. The
 * prefix is fixed in verify-migrations.js, so this is the check that makes
 * "it never drops the main database" an enforced property rather than a
 * claim in a comment: a name that is not a verify-migrations scratch
 * database is refused outright, whatever asked for it to be dropped.
 */
const DROPPABLE_SCRATCH_DB = /^ef_verify_(fresh|drift)_[a-z0-9]+$/;

/**
 * Same idea for the schema-scoped fallback. The suffix is part of the
 * name, so the pattern allows it — the property being enforced is that
 * the name starts with the reserved prefix and carries only the script's
 * own lowercase stamp, not that it has no suffix.
 */
const DROPPABLE_SCRATCH_SCHEMA = /^ef_verify_[a-z0-9_]+$/;

export const ALLOW_REMOTE_ENV = 'VERIFY_ALLOW_REMOTE';
export const SCOPE_ENV = 'VERIFY_SCOPE';

function refuse(...lines) {
  console.error(...lines);
  exit(2);
}

/** Connection string with the password replaced, safe to log. */
export function redactUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '****';
    return url.toString();
  } catch {
    return '(DATABASE_URL could not be parsed)';
  }
}

/** True when the URL points at Supabase's connection pooler. */
export function isPoolerHost(host) {
  return host.endsWith('.pooler.supabase.com');
}

/**
 * Validate the target database and print what this run will do to it.
 *
 * @param {object} input
 * @param {string} input.script   script name, for the refusal text
 * @param {string} input.effects  what the script is about to do to the
 *                                server, printed on success
 * @param {string} [input.localOnlyReason] why localhost-only is the default
 * @returns {{baseUrl: string, adminDb: string, remote: boolean, pooler: boolean}}
 */
export function requireSafeTarget({ script, effects, localOnlyReason }) {
  const baseUrl = process.env.DATABASE_URL;

  if (!baseUrl) {
    refuse(`${script} requires DATABASE_URL.`);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    refuse(`${script}: DATABASE_URL is not a valid URL.`);
  }

  const host = url.hostname;
  const adminDb = url.pathname.replace(/^\//, '') || 'postgres';
  const isLocal = LOCAL_HOSTS.has(host);

  if (!isLocal && process.env[ALLOW_REMOTE_ENV] !== '1') {
    refuse(
      `${script} refuses to run: DATABASE_URL host is "${host}".`,
      '',
      localOnlyReason,
      '',
      'This is the default on purpose — the script would run against shared',
      'infrastructure. To override it deliberately:',
      '',
      `  ${ALLOW_REMOTE_ENV}=1 ${script}`,
      '',
      `That flag also requires NODE_ENV to be something other than`,
      '"production", and prints the full target before any write happens.',
    );
  }

  // Checked after the host check so a local run that is somehow in a
  // production environment is still refused.
  if (process.env.NODE_ENV === 'production') {
    refuse(
      `${script} refuses to run: NODE_ENV=production.`,
      '',
      'Verification creates and destroys database objects. It must never be',
      'pointed at a production database, even a local mirror of one.',
    );
  }

  const pooler = isPoolerHost(host);

  if (!isLocal) {
    console.log(`[guard] target   ${redactUrl(baseUrl)}`);
    console.log(`[guard] host     ${host}:${url.port || '5432'}`);
    console.log(`[guard] user     ${url.username || '(default)'}`);
    console.log(`[guard] database ${adminDb}`);
    console.log(`[guard] NODE_ENV ${process.env.NODE_ENV || '(unset)'}`);
    if (pooler) {
      console.log('[guard] mode     connection POOLER (scratch-databases mode is unavailable)');
    }
    console.log(`[guard] ${ALLOW_REMOTE_ENV}=1 — remote target accepted.`);
    console.log(`[guard] THIS RUN WILL ${effects}`);
    console.log(`[guard] It will NOT drop the "${adminDb}" database.`);
    console.log('');
  }

  return { baseUrl, adminDb, remote: !isLocal, pooler };
}

/**
 * Refuse to drop a database whose name is not a verify-migrations scratch
 * database.
 *
 * @param {string} name
 */
export function assertDroppableScratchDb(name) {
  if (!DROPPABLE_SCRATCH_DB.test(name)) {
    refuse(
      `Refusing to DROP DATABASE "${name}".`,
      '',
      'Only verify-migrations scratch databases may be dropped, and their',
      `names must match ${DROPPABLE_SCRATCH_DB}. This is a bug if you did`,
      'not expect it: no code path should ask to drop anything else.',
    );
  }
}

/**
 * Refuse to drop a schema whose name is not a verify-migrations scratch
 * schema.
 *
 * @param {string} name
 */
export function assertDroppableScratchSchema(name) {
  if (!DROPPABLE_SCRATCH_SCHEMA.test(name)) {
    refuse(
      `Refusing to DROP SCHEMA "${name}".`,
      '',
      'Only verify-migrations scratch schemas may be dropped, and their',
      `names must match ${DROPPABLE_SCRATCH_SCHEMA}. This is a bug if you`,
      'did not expect it.',
    );
  }
}
