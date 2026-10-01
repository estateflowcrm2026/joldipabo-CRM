// Postgres connection layer.
//
// - Reads DATABASE_URL from config.
// - Lazily creates one `pg` Pool on first use.
// - If DATABASE_URL is missing, every operation throws a clear
//   not-configured error instead of crashing boot.
// - `closeDb()` drains the pool; server.js calls it on shutdown.
//
// TWO CONNECTION STRINGS, TWO JOBS
// --------------------------------
//   DATABASE_URL       migrations, `db:seed`, `db:reset`, admin work.
//                      Connects as a role that OWNS the tables.
//
//   APP_DATABASE_URL   the running application. Optional; when set it is
//                      what the pool uses, and it is expected to name a
//                      NON-OWNER role, because a role that owns the
//                      tables or has BYPASSRLS makes every row-level
//                      security policy inert. See
//                      docs/RLS_ROLLOUT_PLAN.md §1.
//
// When APP_DATABASE_URL is unset the pool falls back to DATABASE_URL,
// so a development machine and every existing setup keep working
// unchanged. What changes is only that production is REFUSED when the
// runtime role would bypass RLS — see assertSafeToStart.
//
// No ORM. Raw `pg` only. Handlers call `query(text, params)` or wrap
// multi-statement work in `transaction(fn)`.

import { Pool } from 'pg';
import { config } from '../config/index.js';
import { resolveSsl } from './sslConfig.js';

export const DB_NOT_CONFIGURED = 'database-not-configured';

/** @type {import('pg').Pool | null} */
let pool = null;

/**
 * The connection string the pool is built from.
 *
 * Read from `process.env` at the moment the pool is created, rather than
 * only from `config.databaseUrl`. `config` is frozen when its module
 * first loads, and the pool is a singleton, so a caller that repoints
 * `DATABASE_URL` at a different database between uses — the migration
 * verifier does exactly this, once per scratch database — would
 * otherwise keep talking to whichever database happened to be first.
 *
 * For a running server this is identical to reading `config`: nothing
 * mutates `process.env` after boot. Only the verification scripts, which
 * deliberately do, see a difference.
 *
 * APP_DATABASE_URL takes precedence when present. It is the runtime
 * role; DATABASE_URL is the admin role. Reading `process.env` first
 * means a verification script that repoints DATABASE_URL still wins for
 * itself, which is what the scratch-database runner depends on.
 *
 * @returns {string|null}
 */
function currentDatabaseUrl() {
  return (
    process.env.APP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    config.appDatabaseUrl ||
    config.databaseUrl ||
    null
  );
}

/**
 * The ADMIN connection string, for work that needs privileges the
 * application role deliberately does not have: DDL, GRANT/REVOKE, and
 * `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.
 *
 * Added 2026-09-28, after `db:migrate` began failing with
 * "permission denied for schema public" — correctly. Setting
 * APP_DATABASE_URL made the migration runner connect as
 * `estateflow_app`, which owns nothing, so every DDL statement failed.
 * The split between the two roles is real, and the tools that need the
 * owner have to say so.
 *
 * There is no fallback to APP_DATABASE_URL: a migration that silently
 * ran with fewer privileges would fail later, in a more confusing place.
 *
 * @returns {string|null}
 */
export function adminDatabaseUrl() {
  return process.env.DATABASE_URL || config.databaseUrl || null;
}

/**
 * True when a DATABASE_URL is present (does not test reachability).
 * @returns {boolean}
 */
export function isDbConfigured() {
  return Boolean(currentDatabaseUrl());
}

/**
 * Return the shared pool, creating it on first use.
 * Throws a not-configured error when DATABASE_URL is missing.
 * @returns {import('pg').Pool}
 */
export function getDb() {
  const databaseUrl = currentDatabaseUrl();
  if (!databaseUrl) {
    const err = new Error(
      'DATABASE_URL is not set. The backend boots without a database; ' +
        'any query fails with this error until DATABASE_URL is provided. ' +
        'See server/README.md "Local Postgres".',
    );
    err.code = DB_NOT_CONFIGURED;
    throw err;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      // Small and boring. Tune when load testing starts.
      max: config.database.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Applied per-connection so a runaway query cannot pin a pool
      // slot indefinitely. Without these, one bad query plus
      // `max: 10` exhausted slots would make every later request fail
      // on connectionTimeoutMillis.
      statement_timeout: config.database.statementTimeoutMs,
      // Keeps a migration from deadlocking against live traffic.
      lock_timeout: config.database.lockTimeoutMs,
      // `false` for a local cleartext Postgres; an options object when
      // TLS is on. Resolved per environment — see ./sslConfig.js.
      ssl: resolveSsl({
        databaseUrl,
        ssl: config.dbSsl,
        isProduction: process.env.NODE_ENV === 'production',
      }),
    });
    pool.on('error', (err) => {
      // Idle-client errors would otherwise crash the process silently.
      // Log and keep going; the next query opens a fresh client.
      console.error('[db] idle pool client error:', err?.message ?? err);
    });
  }
  return pool;
}

/**
 * Run a single query against the pool.
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params = []) {
  return getDb().query(text, params);
}

/**
 * Run one query with a tenant context set, in its own transaction.
 *
 * THIS IS THE ADAPTER RLS NEEDS
 * -----------------------------
 * A policy reads `current_setting('app.tenant_id')`, and that setting is
 * transaction-scoped. A repository that issues a single statement
 * through the pool has no transaction of its own, so it has nowhere to
 * put the context — and with RLS enabled it silently sees no rows and
 * every INSERT is rejected with "new row violates row-level security
 * policy".
 *
 * `withTenant` fixes that but needs a multi-statement block. This is the
 * single-statement form, so a repository can opt in without restructuring
 * its control flow:
 *
 *     const result = await tenantQuery(user, sql, params);
 *
 * One extra round trip per query, which is the honest cost of putting
 * the tenant in the database rather than in a WHERE clause. Batching
 * remains available through `withTenant`.
 *
 * @param {{tenantId: string}} user
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function tenantQuery(user, text, params = []) {
  if (!user?.tenantId) {
    // Fail closed. Returning an empty result instead would turn a
    // missing tenant into "this tenant has no listings", which is a
    // much harder bug to see than a thrown error.
    throw new Error('tenantQuery requires a user with a tenantId.');
  }
  return withTenant({ tenantId: user.tenantId }, (client) => client.query(text, params));
}

/**
 * Run `fn(client)` inside a transaction. Commits on success,
 * rolls back on throw, always releases the client.
 *
 * Use this for multi-statement work. The returned client is the only
 * handle that should be used inside `fn` — mixing pool-level `query`
 * calls into a transaction body can deadlock against itself.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
  const client = await getDb().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback failure means the connection is already dead; release it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction that first sets the request tenant.
 *
 * This is what an RLS policy reads:
 *
 *     tenant_id = current_setting('app.tenant_id', true)
 *
 * `set_config(..., true)` is transaction-scoped, so the value is
 * discarded at COMMIT/ROLLBACK and cannot leak to the next request that
 * borrows the same pooled connection. A session-level setting would
 * persist across pool reuse and cross tenants — the failure mode this
 * argument exists to prevent.
 *
 * Ordering matters: the setting is applied as the FIRST statement in the
 * transaction, so no query inside `fn` can run before the context
 * exists. Under RLS, a query with no context sees nothing, so a
 * statement that escaped this ordering would return zero rows rather
 * than the wrong tenant's — noisy, not silent.
 *
 * `missing_ok` (`true` in the policy's `current_setting`) is what makes
 * the absence of a tenant deny rather than allow: `tenant_id = NULL` is
 * never true.
 *
 * @template T
 * @param {{ tenantId: string }} ctx
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @throws {Error} when no tenantId is given — fail closed, because a
 *   typo must not silently run the block with no isolation at all.
 */
export async function withTenant(ctx, fn) {
  if (!ctx?.tenantId) {
    throw new Error(
      'withTenant requires a tenantId.\n' +
        '  Running tenant-scoped work without one would execute with no tenant\n' +
        '  context, which under RLS means zero rows and without it means every\n' +
        '  tenant. Refusing is the safe default.',
    );
  }
  if (typeof fn !== 'function') {
    throw new TypeError('withTenant requires a function.');
  }
  return transaction(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.tenantId]);
    return fn(client);
  });
}

/**
 * Run `fn` inside a transaction with NO tenant context.
 *
 * Exists so that the paths which genuinely have no tenant — resolving a
 * tenant by slug during login, reading `organisations`, the migration
 * runner — say so at the call site rather than quietly using
 * `transaction()` and leaving a reader to wonder which one they are in.
 *
 * Under RLS a protected table is invisible in here, which is correct:
 * those reads belong to the small set of tables RLS does not cover yet
 * (docs/RLS_ROLLOUT_PLAN.md §2d).
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withoutTenant(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withoutTenant requires a function.');
  }
  return transaction(async (client) => {
    // Explicitly cleared, not merely absent. If a pooled connection ever
    // did carry a stale value — a future change to the setting's scope,
    // or a `SET` issued directly — this makes the intent unambiguous
    // rather than depending on the absence happening to hold.
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    return fn(client);
  });
}

/**
 * Drain the pool. Safe to call when unconfigured or already closed.
 * @returns {Promise<void>}
 */
export async function closeDb() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
