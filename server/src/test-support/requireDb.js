// Contract for the DB-integration test suites.
//
// WHY THIS EXISTS
// ---------------
// The DB-integration tests used to skip silently whenever DATABASE_URL was
// absent, which is the normal case on a contributor's machine. The
// result: 14 tests reported as "skipped" and a green run, so CI could
// pass with the database entirely untested. That is how the auth
// transaction-rollback bug and the audit-HMAC cascade bug survived —
// neither is visible to a mock.
//
// A skipped DB test is therefore only honest when nobody asked for a
// database. This module makes that explicit:
//
//   REQUIRE_DB=1   the database is mandatory. Any DB-dependent test that
//                  would skip instead FAILS the run, naming the
//                  environment variable that was missing.
//   (unset)        the historical behaviour: skip, and the reason is
//                  printed in the test output.
//
// Set by .github/workflows/ci.yml. A developer can set it locally to
// check that they have not broken the database path without also running
// the full verification suite:
//
//   REQUIRE_DB=1 DATABASE_URL=… npm test
//
// Note the asymmetry this creates, which is deliberate: some tests assert
// behaviour that REQUIRES the absence of a database ("query() throws a
// not-configured error", "offline dev auth grants nothing"). Those skip
// when a database IS configured, and are not affected by REQUIRE_DB.
// Only the tests that need a database are escalated.

/** True when the database is reachable-by-configuration. */
export const dbConfigured = Boolean(process.env.DATABASE_URL);

/** True when a missing database should be a failure rather than a skip. */
export const dbRequired = process.env.REQUIRE_DB === '1';

/**
 * Gate for a test that needs a real database.
 *
 * @param {object} t      the node:test context, for `t.skip`
 * @returns {boolean}     true when the caller should skip its body
 * @throws {Error}        when REQUIRE_DB=1 and DATABASE_URL is missing
 */
export function skipIfNoDb(t) {
  if (dbConfigured) return false;

  if (dbRequired) {
    // Deliberately a throw, not t.skip. A skip here would be reported as
    // a skip and the run would still be green — the exact failure mode
    // this module exists to close.
    throw new Error(
      'REQUIRE_DB=1 but DATABASE_URL is not set.\n' +
        '  These tests need a real Postgres and must not be skipped in CI.\n' +
        '  Set DATABASE_URL, or unset REQUIRE_DB to run the suite without a database.\n' +
        '  See docs/SUPABASE_VERIFICATION.md §9 (CI).',
    );
  }

  t.skip('DATABASE_URL is not set; DB-integration tests skipped.');
  return true;
}

/**
 * Gate for a test that only applies when NO database is configured.
 *
 * Skips when a database is present. Never escalated by REQUIRE_DB: these
 * assert the degraded path, which is a supported deployment mode.
 *
 * @param {object} t
 * @param {string} [reason]
 * @returns {boolean} true when the caller should skip its body
 */
export function skipIfDbConfigured(t, reason = 'DATABASE_URL is set; not-configured path not applicable') {
  if (!dbConfigured) return false;
  t.skip(reason);
  return true;
}
