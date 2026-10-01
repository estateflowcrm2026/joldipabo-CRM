// The REQUIRE_DB gate.
//
//   node --env-file=.env.test --test src/test-support/*.test.js
//
// This is the mechanism that stops CI going green with the database
// untested. It is worth testing for the same reason any guard is: a gate
// that silently stops gating is worse than no gate, because the failure
// it was added to prevent comes back unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, '_require-db-probe.mjs');

/** Run the probe in a child process with a controlled environment. */
function runProbe(env) {
  // These tests are about the ABSENCE of a database, so the probe's
  // environment is built from scratch rather than inherited. Inheriting
  // would make them fail on exactly the machines they are meant to
  // describe — a developer or CI job that *has* DATABASE_URL set.
  //
  // Only the few variables Windows needs to start node are carried over;
  // dropping them breaks the child outright.
  const base = { PATH: process.env.PATH };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }

  try {
    const out = execFileSync(process.execPath, [probe], {
      encoding: 'utf8',
      env: { ...base, ...env },
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('with no database and no REQUIRE_DB, the gate skips', () => {
  const r = runProbe({});
  assert.equal(r.ok, true, 'a contributor with no database is not blocked');
  assert.match(r.out, /RESULT: skipped-db-test/);
  assert.match(r.out, /RESULT: ran-degraded-test/);
});

test('with no database but REQUIRE_DB=1, the gate fails the run', () => {
  const r = runProbe({ REQUIRE_DB: '1' });
  assert.equal(r.ok, false, 'CI must not go green with the database untested');
  assert.match(r.out, /REQUIRE_DB=1 but DATABASE_URL is not set/);
});

test('the failure names the environment variable that is missing', () => {
  const r = runProbe({ REQUIRE_DB: '1' });
  assert.match(r.out, /DATABASE_URL/, 'says what to set');
  assert.match(r.out, /REQUIRE_DB/, 'says how to opt out');
});

test('with a database, the gate runs regardless of REQUIRE_DB', () => {
  const r = runProbe({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', REQUIRE_DB: '1' });
  assert.equal(r.ok, true, 'the gate must not block a run that has a database');
  assert.match(r.out, /RESULT: ran-db-test/);
  assert.doesNotMatch(r.out, /REQUIRE_DB=1 but DATABASE_URL/);
});

test('the degraded-path gate is never escalated by REQUIRE_DB', () => {
  // skipIfDbConfigured asserts behaviour that needs NO database. It must
  // keep skipping when one is present even in CI, otherwise the
  // "query() throws a not-configured error" tests would start failing.
  const r = runProbe({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', REQUIRE_DB: '1' });
  assert.equal(r.ok, true, 'degraded-path tests skip in CI too');
  assert.match(r.out, /RESULT: ran-db-test/);
  assert.match(r.out, /RESULT: skipped-degraded-test/);
});
