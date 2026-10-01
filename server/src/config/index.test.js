// Production-safety guard tests.
//
// The guards under test exist to stop a misconfigured production
// deploy from serving with a privilege bypass. They are the first
// thing standing between an env mistake and a public super-admin
// endpoint, so they are tested directly rather than through a booted
// app.
//
// Run with: `npm test` (src/config/*.test.js is in the glob).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Exercises the boot guard with the environment set BEFORE the module
// loads, which is what a deploy does. config is frozen at import, so
// mutating process.env inside the test would not be observed.
const BOOT_PROBE = fileURLToPath(new URL('./_boot-probe.mjs', import.meta.url));

import {
  config,
  isDevAuthEnabled,
  assertProductionSafety,
  assertJwtSecretPresent,
  assertJwtSecretStrength,
  assertSafeToStart,
  assertRuntimeRoleIsRlsSubject,
  assertDatabaseTlsUsable,
} from './index.js';

const TOUCHED = [
  'NODE_ENV',
  'DEV_AUTH_ENABLED',
  'DEV_AUTH_OFFLINE_FALLBACK',
  'JWT_SECRET',
  'JWT_MIN_SECRET_LENGTH',
];

const original = {};
for (const key of TOUCHED) original[key] = process.env[key];

function clearAll() {
  for (const key of TOUCHED) delete process.env[key];
}

function restoreEnv() {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

beforeEach(clearAll);
afterEach(restoreEnv);

// ---------------------------------------------------------------------------
// 1. Dev auth is off by default
// ---------------------------------------------------------------------------

test('dev auth is disabled by default', () => {
  assert.equal(isDevAuthEnabled(), false);
});

test('offline fallback defaults to false, not true', () => {
  // Regression guard. A `true` default meant that setting only
  // DEV_AUTH_ENABLED=true granted full in-code permission matrices
  // with no database row to back them — one env slip, complete RBAC
  // bypass. Anyone relying on the old default must now opt in.
  assert.equal(config.devAuth.offlineFallback, false);
});

// ---------------------------------------------------------------------------
// 2. assertProductionSafety refuses dev auth in production
// ---------------------------------------------------------------------------

test('refuses to start when dev auth is on in production', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'true';
  assert.throws(() => assertProductionSafety(), /dev authentication is enabled/i);
});

test('refuses even with NODE_ENV=production spelled via default fallback', () => {
  // Guard against someone relaxing the check to a looser comparison.
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'true';
  assert.throws(() => assertProductionSafety(), /DEV_AUTH_ENABLED/);
});

test('error message names every flag to unset', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'true';
  let message = '';
  try {
    assertProductionSafety();
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /DEV_AUTH_ENABLED/);
  assert.match(message, /DEV_AUTH_OFFLINE_FALLBACK/);
  assert.match(message, /ENVIRONMENT\.md/);
});

test('allows dev auth outside production', () => {
  process.env.NODE_ENV = 'development';
  process.env.DEV_AUTH_ENABLED = 'true';
  assert.doesNotThrow(() => assertProductionSafety());
});

test('allows production when dev auth is off', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'false';
  assert.doesNotThrow(() => assertProductionSafety());
});

test('allows production when dev auth is unset entirely', () => {
  process.env.NODE_ENV = 'production';
  assert.doesNotThrow(() => assertProductionSafety());
});

test('does not treat staging as production', () => {
  process.env.NODE_ENV = 'staging';
  process.env.DEV_AUTH_ENABLED = 'true';
  assert.doesNotThrow(() => assertProductionSafety());
});

// ---------------------------------------------------------------------------
// 3. assertJwtSecretPresent
// ---------------------------------------------------------------------------

test('refuses to start in production without JWT_SECRET', () => {
  process.env.NODE_ENV = 'production';
  assert.throws(() => assertJwtSecretPresent(), /JWT_SECRET/);
});

test('refuses a whitespace-only JWT_SECRET', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = '   ';
  assert.throws(() => assertJwtSecretPresent(), /JWT_SECRET/);
});

test('allows production with a JWT_SECRET set', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'a-sufficiently-long-and-random-looking-secret-value';
  assert.doesNotThrow(() => assertJwtSecretPresent());
});

test('does not require JWT_SECRET outside production', () => {
  process.env.NODE_ENV = 'development';
  assert.doesNotThrow(() => assertJwtSecretPresent());
});

// ---------------------------------------------------------------------------
// 4. assertJwtSecretStrength
// ---------------------------------------------------------------------------

test('refuses a short production signing key', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'tooshort';
  assert.throws(() => assertJwtSecretStrength(), /minimum is 32/);
});

test('refuses a placeholder-shaped key however long it is', () => {
  // Padding a placeholder to pass a length check must not work.
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'replace-me-with-a-real-secret-from-kms';
  assert.throws(() => assertJwtSecretStrength(), /placeholder/i);
});

test('accepts a long random-looking production key', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'a-sufficiently-long-and-random-looking-value';
  assert.doesNotThrow(() => assertJwtSecretStrength());
});

test('JWT_MIN_SECRET_LENGTH=0 is an explicit opt-out', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'short';
  process.env.JWT_MIN_SECRET_LENGTH = '0';
  assert.doesNotThrow(() => assertJwtSecretStrength());
});

test('a placeholder is refused even with the length check disabled', () => {
  // The opt-out lowers the bar, it does not switch the guard off: a
  // literal 'changeme' is a deliberate mistake, not a short key.
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'changeme';
  process.env.JWT_MIN_SECRET_LENGTH = '0';
  assert.throws(() => assertJwtSecretStrength(), /placeholder/i);
});

test('the strength check does not apply outside production', () => {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'short';
  assert.doesNotThrow(() => assertJwtSecretStrength());
});

test('placeholder matching is whole-value, not substring', () => {
  // Substring matching would reject a legitimate random key that happens
  // to contain 'test' or 'secret', pushing operators toward short
  // memorable secrets — the opposite of what this guard is for.
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'Kx9pQm2vT7wZ4nR8sL3jH6bY1cF5dG0aE7uI2oP9nQ4wX8yZ3mB6vT1';
  assert.doesNotThrow(() => assertJwtSecretStrength());
});

// ---------------------------------------------------------------------------
// 5. assertSafeToStart runs every check
// ---------------------------------------------------------------------------

test('assertSafeToStart rejects a dev-auth-in-production boot', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'true';
  assert.throws(() => assertSafeToStart(), /dev authentication is enabled/i);
});

test('assertSafeToStart rejects a missing-secret production boot', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'false';
  assert.throws(() => assertSafeToStart(), /JWT_SECRET/);
});

test('assertSafeToStart rejects a weak production secret', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'false';
  process.env.JWT_SECRET = 'weak';
  assert.throws(() => assertSafeToStart(), /minimum is 32/);
});

test('assertSafeToStart accepts a correctly configured production boot', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'false';
  process.env.JWT_SECRET = 'a-sufficiently-long-and-random-looking-secret-value';
  // Required since 2026-09-27: production must not boot without MFA
  // enforced for privileged roles.
  process.env.AUTH_MFA_ENFORCE = 'true';
  // Required since 2026-09-28: production must not run as a role that
  // owns the tables or bypasses RLS.
  process.env.APP_DATABASE_URL =
    'postgresql://estateflow_app:pw@db.ref.supabase.co:5432/postgres';
  assert.doesNotThrow(() => assertSafeToStart());
});

// ---------------------------------------------------------------------------
// 5a. MFA enforcement
// ---------------------------------------------------------------------------
//
// A production deploy with MFA enforcement off is the one configuration
// that looks healthy and is not. A warning in the deploy log is easy to
// miss, so it stops the boot instead.

test('production refuses to boot without MFA enforcement', () => {
  process.env.NODE_ENV = 'production';
  // The earlier guards must pass first, or this test would pass for the
  // wrong reason whenever they happen to fail.
  process.env.DEV_AUTH_ENABLED = 'false';
  process.env.JWT_SECRET = 'a-sufficiently-long-and-random-looking-secret-value';
  delete process.env.AUTH_MFA_ENFORCE;
  assert.throws(() => assertSafeToStart(), /AUTH_MFA_ENFORCE is not true/);
});

test('production refuses MFA enforcement set to anything but true', () => {
  process.env.NODE_ENV = 'production';
  process.env.DEV_AUTH_ENABLED = 'false';
  process.env.JWT_SECRET = 'a-sufficiently-long-and-random-looking-secret-value';
  process.env.AUTH_MFA_ENFORCE = 'false';
  assert.throws(() => assertSafeToStart(), /AUTH_MFA_ENFORCE is not true/);
  process.env.AUTH_MFA_ENFORCE = '0';
  assert.throws(() => assertSafeToStart(), /AUTH_MFA_ENFORCE is not true/);
});

test('MFA enforcement is not required outside production', () => {
  // Otherwise a developer could never run the server at all, and a
  // staging box could not be built before the app can enrol anyone.
  process.env.NODE_ENV = 'development';
  process.env.DEV_AUTH_ENABLED = 'false';
  delete process.env.AUTH_MFA_ENFORCE;
  assert.doesNotThrow(() => assertSafeToStart());
});

test('assertSafeToStart accepts a normal development boot', () => {
  process.env.NODE_ENV = 'development';
  process.env.DEV_AUTH_ENABLED = 'true';
  assert.doesNotThrow(() => assertSafeToStart());
});

// ---------------------------------------------------------------------------
// 6. assertDatabaseTlsUsable — TLS is resolved at boot
// ---------------------------------------------------------------------------
//
// The pool resolves `ssl` lazily, so without this guard a typo'd
// DB_SSL_CA_FILE let the server bind a port, answer /health "ok", and only
// then fail every request that touched the database. These pin the
// fail-closed behaviour.

test('assertDatabaseTlsUsable is a no-op when no database is configured', () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    // Degraded mode is supported, not an error.
    assert.doesNotThrow(() => assertDatabaseTlsUsable());
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test('assertDatabaseTlsUsable accepts a readable CA bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ef-boot-ca-'));
  const file = join(dir, 'ca.pem');
  writeFileSync(file, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  process.env.DATABASE_URL = 'postgresql://u:p@db.example.supabase.co:5432/postgres';
  process.env.DB_SSL_MODE = 'verify-full';
  process.env.DB_SSL_CA_FILE = file;
  assert.doesNotThrow(() => assertDatabaseTlsUsable());
});

// config is frozen at import, so the remaining two cases are exercised in a
// subprocess with the environment set BEFORE the module loads — which is
// also what a deploy actually does.
test('assertDatabaseTlsUsable refuses a missing CA file', () => {
  const r = spawnSync(
    process.execPath,
    [BOOT_PROBE],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/postgres',
        DB_SSL_MODE: 'verify-full',
        DB_SSL_CA_FILE: join(tmpdir(), 'definitely-not-here-ca.pem'),
      },
    },
  );
  assert.notEqual(r.status, 0, 'the process must exit non-zero');
  assert.match(r.stderr, /DB_SSL_CA_FILE could not be read/);
});

test('assertDatabaseTlsUsable refuses an unsafe mode in production', () => {
  const r = spawnSync(
    process.execPath,
    [BOOT_PROBE],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@db.example.supabase.co:5432/postgres',
        DB_SSL_MODE: 'require',
        DB_SSL_CA_FILE: '',
      },
    },
  );
  assert.notEqual(r.status, 0, 'the process must exit non-zero');
  assert.match(r.stderr, /DB_SSL_MODE=require in production/);
});

// ---------------------------------------------------------------------------
// 5b. Runtime database role
// ---------------------------------------------------------------------------
//
// The application must not connect as a role that owns the tables or has
// BYPASSRLS: Postgres exempts the owner from row-level security, and
// exempts BYPASSRLS roles besides, so every installed policy would be
// present, correct and enforcing nothing.

test('production refuses to run as the owner role', () => {
  process.env.NODE_ENV = 'production';
  process.env.APP_DATABASE_URL = 'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres';
  assert.throws(() => assertRuntimeRoleIsRlsSubject(), /bypasses\s+row-level security/s);
});

test('production refuses service_role, which also bypasses RLS', () => {
  process.env.NODE_ENV = 'production';
  process.env.APP_DATABASE_URL = 'postgresql://service_role:pw@db.ref.supabase.co:5432/postgres';
  assert.throws(() => assertRuntimeRoleIsRlsSubject(), /bypasses/);
});

test('production refuses when APP_DATABASE_URL is absent', () => {
  // Falls back to DATABASE_URL, which is the migration role — the exact
  // state that made the 2026-09-28 policies inert.
  process.env.NODE_ENV = 'production';
  delete process.env.APP_DATABASE_URL;
  assert.throws(() => assertRuntimeRoleIsRlsSubject(), /APP_DATABASE_URL is not set/);
});

test('production accepts a dedicated non-owner role', () => {
  process.env.NODE_ENV = 'production';
  process.env.APP_DATABASE_URL =
    'postgresql://estateflow_app:pw@aws-0.pooler.supabase.com:5432/postgres?sslmode=require';
  assert.doesNotThrow(() => assertRuntimeRoleIsRlsSubject());
});

test('the role check does not fire outside production', () => {
  // A developer running as postgres on localhost is the normal case and
  // must not be blocked by a production-only guard.
  process.env.NODE_ENV = 'development';
  delete process.env.APP_DATABASE_URL;
  assert.doesNotThrow(() => assertRuntimeRoleIsRlsSubject());
});

test('a malformed APP_DATABASE_URL is reported clearly', () => {
  process.env.NODE_ENV = 'production';
  process.env.APP_DATABASE_URL = 'not a url';
  assert.throws(() => assertRuntimeRoleIsRlsSubject(), /not a valid URL/);
});
