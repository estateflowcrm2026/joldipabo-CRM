// Postgres TLS resolution tests.
//
// Pure — no connection is opened. These cover the decision that decides
// whether the database link is encrypted and whether the peer is
// authenticated, so they are worth pinning precisely.
//
// Run with `npm test` (src/db/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSsl, sslModeFromUrl, VALID_MODES } from './sslConfig.js';

// A real file: resolveSsl reads it eagerly, so a fake path would throw.
const caDir = mkdtempSync(join(tmpdir(), 'ef-ca-'));
const caPath = join(caDir, 'supabase-root.pem');
writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
const caMissing = join(caDir, 'does-not-exist.pem');
const caEmpty = join(caDir, 'empty.pem');
writeFileSync(caEmpty, '   \n');

const LOCAL = 'postgres://estateflow:estateflow@127.0.0.1:5432/estateflow';
const HOSTED = 'postgres://u:p@db.example.com:5432/estateflow';

const baseSsl = { mode: 'auto', rejectUnauthorized: true, ca: null, caFile: null };

const resolve = (overrides = {}, opts = {}) =>
  resolveSsl({ databaseUrl: LOCAL, ssl: { ...baseSsl, ...overrides }, ...opts });

// ---------------------------------------------------------------------------
// sslModeFromUrl
// ---------------------------------------------------------------------------

test('sslModeFromUrl reads the query parameter', () => {
  assert.equal(sslModeFromUrl(`${HOSTED}?sslmode=require`), 'require');
  assert.equal(sslModeFromUrl(`${HOSTED}?sslmode=verify-full`), 'verify-full');
});

test('sslModeFromUrl returns null when absent', () => {
  assert.equal(sslModeFromUrl(HOSTED), null);
  assert.equal(sslModeFromUrl(null), null);
});

test('sslModeFromUrl tolerates a malformed URL', () => {
  assert.equal(sslModeFromUrl('not a url'), null);
});

// ---------------------------------------------------------------------------
// auto — must not change an existing local setup
// ---------------------------------------------------------------------------

test('auto disables SSL for a plain local URL', () => {
  // The single most important regression guard: an existing Docker
  // Postgres setup must keep working with no configuration change.
  assert.equal(resolve(), false);
});

test('auto honours sslmode=require in the URL', () => {
  const out = resolveSsl({
    databaseUrl: `${HOSTED}?sslmode=require`,
    ssl: { ...baseSsl },
  });
  assert.equal(out.rejectUnauthorized, false);
});

test('auto honours sslmode=verify-full in the URL', () => {
  const out = resolveSsl({
    databaseUrl: `${HOSTED}?sslmode=verify-full`,
    ssl: { ...baseSsl },
  });
  assert.equal(out.rejectUnauthorized, true);
});

test('auto maps verify-ca onto require without skipping the host check silently', () => {
  // pg cannot express chain-without-hostname verification. Mapping to
  // `require` keeps the connection encrypted; the caveat is documented
  // in the module header rather than hidden.
  const out = resolveSsl({
    databaseUrl: `${HOSTED}?sslmode=verify-ca`,
    ssl: { ...baseSsl },
  });
  assert.equal(out.rejectUnauthorized, false);
});

// ---------------------------------------------------------------------------
// explicit modes
// ---------------------------------------------------------------------------

test('disable turns TLS off', () => {
  assert.equal(resolve({ mode: 'disable' }), false);
});

test('require encrypts but does not verify', () => {
  assert.deepEqual(resolve({ mode: 'require' }), { rejectUnauthorized: false });
});

test('verify-full verifies by default', () => {
  assert.deepEqual(resolve({ mode: 'verify-full' }), { rejectUnauthorized: true });
});

test('verify-full can be relaxed for a self-signed staging cert', () => {
  const out = resolve({ mode: 'verify-full', rejectUnauthorized: false });
  assert.equal(out.rejectUnauthorized, false);
});

test('an inline CA is passed through', () => {
  const out = resolve({ mode: 'verify-full', ca: '-----BEGIN CERTIFICATE-----' });
  assert.equal(out.ca, '-----BEGIN CERTIFICATE-----');
});

// ---------------------------------------------------------------------------
// production refusals — these are the point of the exercise
// ---------------------------------------------------------------------------

test('require is refused in production', () => {
  assert.throws(
    () => resolve({ mode: 'require' }, { isProduction: true }),
    /DB_SSL_MODE=require in production/,
  );
});

test('rejectUnauthorized=false is refused in production', () => {
  assert.throws(
    () => resolve({ mode: 'verify-full', rejectUnauthorized: false }, { isProduction: true }),
    /DB_SSL_REJECT_UNAUTHORIZED=false in production/,
  );
});

test('a production URL with sslmode=require is refused', () => {
  assert.throws(
    () =>
      resolveSsl({
        databaseUrl: `${HOSTED}?sslmode=require`,
        ssl: { ...baseSsl },
        isProduction: true,
      }),
    /DB_SSL_MODE=require in production/,
  );
});

test('a plain production URL still gets no TLS unless configured', () => {
  // Not refused — a production box could legitimately front Postgres
  // over a private network. Documented, not enforced. The safe default
  // is that operators must opt in to verify-full.
  assert.equal(resolve({}, { isProduction: true }), false);
});

test('production with verify-full is allowed', () => {
  assert.doesNotThrow(() => resolve({ mode: 'verify-full' }, { isProduction: true }));
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('an unrecognised mode is rejected with the valid list', () => {
  assert.throws(() => resolve({ mode: 'yes-please' }), /DB_SSL_MODE must be one of/);
});

test('a missing mode falls back to auto', () => {
  assert.equal(resolve({ mode: undefined }), false);
});

test('mode matching is case-insensitive', () => {
  assert.deepEqual(resolve({ mode: 'VERIFY-FULL' }), { rejectUnauthorized: true });
});

test('VALID_MODES documents the supported set', () => {
  assert.deepEqual([...VALID_MODES].sort(), ['auto', 'disable', 'require', 'verify-full']);
});

// ---------------------------------------------------------------------------
// Supabase — the private-CA case
// ---------------------------------------------------------------------------
//
// Supabase presents a three-level private hierarchy:
//
//     Supabase Root 2021 CA        self-signed, isCA
//       └─ Supabase Intermediate 2021 CA
//            └─ db.<project-ref>.supabase.co
//
// The root is in no system trust store, so `verify-full` against stock
// Node fails with "self-signed certificate in certificate chain" unless
// DB_SSL_CA_FILE supplies it. Confirmed against a live project on
// 2026-09-27: the same config with and without the CA file either
// connects or fails, with nothing in between.
//
// These pin the shape of the fix, not the certificate — the fingerprint
// lives in scripts/fetch-supabase-ca.js, where it can be rotated with a
// conscious edit.

const SUPABASE_DIRECT =
  'postgresql://postgres:PASS@db.abcdefghijklmnop.supabase.co:5432/postgres';
const SUPABASE_POOLER =
  'postgresql://postgres.abcdefghijklmnop:PASS@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

const caFileOverrides = (file) => ({ mode: 'verify-full', caFile: file });

test('verify-full reads the CA bundle from a file path', () => {
  // The file is only opened for real when a connection is made, so this
  // asserts the wiring — that the option is passed to pg as `ca` and
  // that verification stays on.
  const out = resolveSsl({
    databaseUrl: SUPABASE_DIRECT,
    ssl: { ...baseSsl, mode: 'verify-full', caFile: caPath },
  });
  assert.equal(out.rejectUnauthorized, true, 'verification stays enabled');
  assert.equal(out.ca, readFileSync(caPath, 'utf8'), 'the file is read and its contents passed to pg');
});

test('an inline CA is preferred over the system store', () => {
  const out = resolveSsl({
    databaseUrl: SUPABASE_DIRECT,
    ssl: { ...baseSsl, mode: 'verify-full', ca: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----' },
  });
  assert.equal(out.rejectUnauthorized, true);
  assert.ok(out.ca.includes('BEGIN CERTIFICATE'));
});

test('caFile wins over an inline ca when both are set', () => {
  // A leftover inline bundle in an environment variable should not
  // silently shadow a rotated file on disk — the file is the thing an
  // operator updates, so it must be the one used.
  const out = resolveSsl({
    databaseUrl: SUPABASE_DIRECT,
    ssl: { ...baseSsl, mode: 'verify-full', ca: 'inline-pem', caFile: caPath },
  });
  assert.equal(out.ca, readFileSync(caPath, 'utf8'));
});

test('production with verify-full and a CA file is allowed', () => {
  assert.doesNotThrow(() =>
    resolveSsl({
      databaseUrl: SUPABASE_DIRECT,
      ssl: { ...baseSsl, mode: 'verify-full', caFile: caPath },
      isProduction: true,
    }),
  );
});

test('an explicit DB_SSL_MODE=verify-full wins over the URL\'s sslmode=require', () => {
  // The dashboard's URI string ends in `?sslmode=require`, so it is the
  // thing most likely to get pasted into DATABASE_URL. When the operator
  // ALSO sets DB_SSL_MODE=verify-full, the explicit setting wins and the
  // link is verified — which is the safe outcome, so it must not throw.
  // The dangerous case is the other half: pasting the URL and setting
  // nothing, covered by the next test.
  const out = resolveSsl({
    databaseUrl: `${SUPABASE_DIRECT}?sslmode=require`,
    ssl: { ...baseSsl, mode: 'verify-full', caFile: caPath },
    isProduction: true,
  });
  assert.equal(out.rejectUnauthorized, true, 'the URL does not downgrade an explicit setting');
});

test('a pasted Supabase URL with sslmode=require and no DB_SSL_MODE is refused in production', () => {
  // mode defaults to `auto`, which honours the URL — and `require` is
  // refused at boot. This is the realistic copy-paste mistake.
  assert.throws(
    () =>
      resolveSsl({
        databaseUrl: `${SUPABASE_DIRECT}?sslmode=require`,
        ssl: { ...baseSsl, caFile: caPath },
        isProduction: true,
      }),
    /DB_SSL_MODE=require in production/,
  );
});

test('a Supabase URL with sslmode=verify-full needs no DB_SSL_MODE override', () => {
  // `auto` is the default, so appending the parameter to DATABASE_URL is
  // sufficient for an operator who never touches DB_SSL_MODE.
  const out = resolveSsl({
    databaseUrl: `${SUPABASE_DIRECT}?sslmode=verify-full`,
    ssl: { ...baseSsl, caFile: caPath },
  });
  assert.equal(out.rejectUnauthorized, true);
});

test('dev can use the Supabase pooler with require', () => {
  // The dev/testing path that the real verification run uses. It must
  // keep working: encrypted, unverified, and refused nowhere.
  const out = resolveSsl({
    databaseUrl: SUPABASE_POOLER,
    ssl: { ...baseSsl, mode: 'require' },
    isProduction: false,
  });
  assert.deepEqual(out, { rejectUnauthorized: false });
});

test('a missing CA file fails with the setting named, not a bare ENOENT', () => {
  // A raw ENOENT names a path the operator never typed and gives no hint
  // that DB_SSL_CA_FILE is the cause. This is the message a deploy sees.
  assert.throws(
    () =>
      resolveSsl({
        databaseUrl: SUPABASE_DIRECT,
        ssl: { ...baseSsl, mode: 'verify-full', caFile: caMissing },
      }),
    /DB_SSL_CA_FILE could not be read/,
  );
  try {
    resolveSsl({
      databaseUrl: SUPABASE_DIRECT,
      ssl: { ...baseSsl, mode: 'verify-full', caFile: caMissing },
    });
  } catch (err) {
    assert.ok(err.message.includes(caMissing), 'names the file it tried to read');
    assert.ok(err.message.includes('fetch-supabase-ca'), 'says how to obtain one');
  }
});

test('an empty CA file is refused', () => {
  // An empty bundle verifies nothing, and it fails later at connect time
  // with a TLS error that says nothing about the cause.
  assert.throws(
    () =>
      resolveSsl({
        databaseUrl: SUPABASE_DIRECT,
        ssl: { ...baseSsl, mode: 'verify-full', caFile: caEmpty },
      }),
    /DB_SSL_CA_FILE is empty/,
  );
});

test('a CA file problem is reported even outside production', () => {
  // verify-full is a legitimate staging choice too, so a broken path must
  // not be treated as a production-only problem.
  assert.throws(
    () =>
      resolveSsl({
        databaseUrl: SUPABASE_DIRECT,
        ssl: { ...baseSsl, mode: 'verify-full', caFile: caMissing },
        isProduction: false,
      }),
    /DB_SSL_CA_FILE could not be read/,
  );
});
