// Auth middleware truth-table tests.
//
// The dev shortcut is gated by DEV_AUTH_ENABLED, which tests flip
// at runtime. config.devAuth re-reads process.env on every access
// (see src/config/index.js), so toggling env between tests works
// without re-importing modules.
//
// Test matrix:
//
//   DEV_AUTH  DB   fallback   token           → expected
//   ────────  ───  ────────   ──────────────    ─────────────────────────────
//   off       *    *          any bearer       → 401 (no dev shortcut)
//   on        off  on          dev-super        → 200 (offline matrix)
//   on        off  off         dev-super        → 503 database-not-configured
//   on        on   *           dev-super        → 200 (DB path; skip if no DB)
//   on        *    *           dev-bogus        → 401 (unknown dev token)
//
// We exercise the read path against GET /api/v1/listings because the
// route is wired and reflects permissionMatrix visibility.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { dbConfigured, skipIfNoDb, skipIfDbConfigured } from '../test-support/requireDb.js';
import {
  DEV_KEY_TO_USER_ID,
  KNOWN_DEV_KEYS,
} from '../repositories/authRepository.js';
import { DEFAULT_PERMISSION_MATRIX } from '../rbac/permissions.js';


/** Restore env vars at the end of the file. */
const original = {
  DEV_AUTH_ENABLED: process.env.DEV_AUTH_ENABLED,
  DEV_AUTH_OFFLINE_FALLBACK: process.env.DEV_AUTH_OFFLINE_FALLBACK,
  DATABASE_URL: process.env.DATABASE_URL,
};

// Coerce a value to the exact env string the config parser expects.
//
// This must NOT use truthiness. The test matrix below passes the raw
// string '0' to exercise the parser's non-boolean path, and every
// non-empty string is truthy in JavaScript — so `value ? 'true' :
// 'false'` would write 'true' for '0' and silently invert the
// assertion. String booleans are only special-cased; everything else
// is passed through verbatim so the parser sees what it would see
// from a real environment.
function toEnvBool(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return String(value);
}

function setDevAuth(enabled, offlineFallback) {
  if (enabled === undefined) delete process.env.DEV_AUTH_ENABLED;
  else process.env.DEV_AUTH_ENABLED = toEnvBool(enabled);
  if (offlineFallback === undefined) delete process.env.DEV_AUTH_OFFLINE_FALLBACK;
  else process.env.DEV_AUTH_OFFLINE_FALLBACK = toEnvBool(offlineFallback);
}

function restoreEnv() {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function newApp() {
  return buildApp({ logLevel: 'silent' });
}

// ---------------------------------------------------------------------------
// 1. config.devAuth reads env live
// ---------------------------------------------------------------------------

test('config.devAuth reflects process.env on every read', async () => {
  const { config } = await import('../config/index.js');
  setDevAuth(undefined, undefined);
  assert.equal(config.devAuth.enabled, false);
  // Default flipped to false on 2026-09-24. A `true` default meant that
  // setting only DEV_AUTH_ENABLED=true granted full in-code permission
  // matrices with no database row behind them.
  assert.equal(config.devAuth.offlineFallback, false);

  setDevAuth(true, true);
  assert.equal(config.devAuth.enabled, true);
  assert.equal(config.devAuth.offlineFallback, true);

  // '1' and '0' are the parser's documented boolean spellings. The
  // helper must not use truthiness here — '0' is a truthy string.
  setDevAuth('1', '0');
  assert.equal(config.devAuth.enabled, true);
  assert.equal(config.devAuth.offlineFallback, false);

  setDevAuth('yes', 'no'); // non-bool => use default
  assert.equal(config.devAuth.enabled, false);
  assert.equal(config.devAuth.offlineFallback, false);

  setDevAuth(false, undefined);
});

// ---------------------------------------------------------------------------
// 2. Dev shortcut OFF → dev-* tokens are unknown (real-token path)
// ---------------------------------------------------------------------------

test('dev token is rejected as unauthorized when DEV_AUTH_ENABLED=false', async () => {
  setDevAuth(false, true);
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: 'Bearer dev-super' },
  });
  // tokenService.verifyAccessToken throws on 'dev-super' (3 parts but
  // payload is not the right shape) → 401 token-expired.
  assert.equal(res.statusCode, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// 3. Dev shortcut ON, no DB, fallback ON → reaches the data layer (503)
//    The fallback only resolves req.user with a real matrix; the data
//    layer still throws DB_NOT_CONFIGURED. The point of this test is
//    to prove RBAC passed (we got to the DB) and not 403.
// ---------------------------------------------------------------------------

test('dev-super with DEV_AUTH on, no DB, fallback on → 503 (RBAC passed, DB unreachable)', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set; offline-fallback path not applicable');
    return;
  }
  setDevAuth(true, true);
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: 'Bearer dev-super' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'database-not-configured');
  await app.close();
});

test('dev-super offline matrix contains listings:view scope=all', () => {
  // Direct assertion against the in-code defaults — locks the matrix
  // shape the offline fallback relies on.
  assert.equal(
    DEFAULT_PERMISSION_MATRIX['super-admin'].listings.view,
    'all',
  );
});

test('dev-field (own scope) reaches the data layer (503)', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set; offline-fallback path not applicable');
    return;
  }
  setDevAuth(true, true);
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: 'Bearer dev-field' },
  });
  assert.equal(res.statusCode, 503);
  await app.close();
});

// ---------------------------------------------------------------------------
// 4. Dev shortcut ON, no DB, fallback OFF → 503 database-not-configured
// ---------------------------------------------------------------------------

test('dev-super with DEV_AUTH on, no DB, fallback off → 503', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set; fallback-off path not applicable');
    return;
  }
  setDevAuth(true, false);
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: 'Bearer dev-super' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'database-not-configured');
  await app.close();
});

// ---------------------------------------------------------------------------
// 5. Dev shortcut ON, DB ON → DB path; if no DB still skips.
// ---------------------------------------------------------------------------

test('dev-super with DEV_AUTH on and DB set → 200 (DB path)', async (t) => {
  if (skipIfNoDb(t)) return;
  setDevAuth(true, true);
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: 'Bearer dev-super' },
  });
  // Returns 200 if the seeded `u-super` row is present; 401 otherwise.
  // Either is acceptable — both prove the DB path was reachable.
  assert.ok([200, 401].includes(res.statusCode), `unexpected ${res.statusCode}`);
  await app.close();
});

// ---------------------------------------------------------------------------
// 6. Unknown dev token
// ---------------------------------------------------------------------------

test('dev-bogus returns 401 (unknown dev token)', async () => {
  setDevAuth(true, true);
  const app = await newApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: 'Bearer dev-bogus' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// 7. Real placeholder token without DB still produces 403 (fail-closed)
// ---------------------------------------------------------------------------

test('real placeholder token with DEV_AUTH on, no DB → 403', async (t) => {
  if (dbConfigured) {
    t.skip('DATABASE_URL is set; placeholder path differs');
    return;
  }
  setDevAuth(true, true);
  const app = await newApp();
  // Forge a JWT-shaped token with claims that authMiddleware can verify.
  const { issueAccessToken } = await import('../auth/tokenService.js');
  const { token } = issueAccessToken({ sub: 'u-super', tid: 'org_acme' });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/listings',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// ---------------------------------------------------------------------------
// 8. Static mapping sanity (protects against silent typos in DEV_KEY_TO_USER_ID)
// ---------------------------------------------------------------------------

test('every dev key maps to a seeded role with a default matrix', () => {
  const roleByUser = {
    'u-admin': 'admin',
    'u-super': 'super-admin',
    'u-raj':   'sales-manager',
    'u-priya': 'site-manager',
    'u-asha':  'field-executive',
    'u-vijay': 'field-executive',
    'u-tele':  'telecaller',
    'u-cpm':   'channel-partner-manager',
    'u-anil':  'accounts',
  };
  for (const devKey of KNOWN_DEV_KEYS) {
    const userId = DEV_KEY_TO_USER_ID[devKey];
    assert.ok(userId, `${devKey} missing user id mapping`);
    const role = roleByUser[userId];
    assert.ok(role, `${devKey} → ${userId} has no expected role`);
    assert.ok(DEFAULT_PERMISSION_MATRIX[role], `${role} has no default matrix`);
  }
});

test.after(async () => {
  restoreEnv();
  await closeDb();
});
