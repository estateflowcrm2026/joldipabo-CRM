// DB-layer tests. All run WITHOUT a database by default.
//
// When DATABASE_URL is unset (the normal case here):
//   - app boots and /ready reports not-configured
//   - query() throws a clear not-configured error
//   - checkReadiness() returns not-configured
//   - closeDb() is a safe no-op
//
// When DATABASE_URL is set (developer machine with Postgres):
//   - the not-configured assertions are skipped
//   - a SELECT 1 smoke query runs instead

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../app.js';
import { closeDb, DB_NOT_CONFIGURED, isDbConfigured, query } from './client.js';
import { checkReadiness } from './health.js';
import { dbConfigured as configured, skipIfNoDb } from '../test-support/requireDb.js';

test('missing DATABASE_URL does not crash app boot', async () => {
  const app = await buildApp({ logLevel: 'silent' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});

test('/ready reports not-configured when DATABASE_URL is absent', async (t) => {
  if (configured) {
    t.skip('DATABASE_URL is set; not-configured path not applicable');
    return;
  }
  const app = await buildApp({ logLevel: 'silent' });
  const res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok', database: 'not-configured' });
  await app.close();
});

test('query() fails with a clear not-configured error when absent', async (t) => {
  if (configured) {
    t.skip('DATABASE_URL is set; not-configured path not applicable');
    return;
  }
  await assert.rejects(() => query('SELECT 1'), (err) => {
    assert.equal(err.code, DB_NOT_CONFIGURED);
    assert.match(err.message, /DATABASE_URL is not set/);
    return true;
  });
});

test('checkReadiness() returns not-configured when absent', async (t) => {
  if (configured) {
    t.skip('DATABASE_URL is set; not-configured path not applicable');
    return;
  }
  const out = await checkReadiness();
  assert.deepEqual(out, { status: 'ok', database: 'not-configured' });
});

test('closeDb() is a safe no-op when never connected', async () => {
  await closeDb();
});

test('SELECT 1 smoke query when DATABASE_URL is present', async (t) => {
  if (skipIfNoDb(t)) return;
  assert.equal(isDbConfigured(), true);
  const { rows } = await query('SELECT 1 AS ok');
  assert.deepEqual(rows, [{ ok: 1 }]);
  const out = await checkReadiness();
  assert.deepEqual(out, { status: 'ok', database: 'connected' });
  await closeDb();
});
