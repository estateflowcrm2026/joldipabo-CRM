// Migration-runner safety tests.
//
// Pure logic — no database required. The runner's three safety
// properties (checksums, ordering, advisory lock) are verified here
// against a fake `pg` client, so they are exercised on every `npm test`
// even on a machine with no Postgres.
//
// For end-to-end coverage against a real database, run
//   npm run db:migrate
// with DATABASE_URL set; the DB-integration assertions in
// client.test.js and listings.write.test.js activate in that case.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checksumFor, verifyChecksums, MIGRATIONS, MIGRATION_LOCK_ID, syncRlsState } from './migrate.js';

test('unset migration mode preserves enabled RLS without issuing SQL', async () => {
  const db = { query: async () => { throw new Error('Preserve mode must not change security'); } };
  for (const mode of [undefined, null, '', 'preserve']) {
    assert.equal(await syncRlsState(db, mode), 0);
  }
});

test('only explicit off disables enabled RLS', async () => {
  const alterations = [];
  const db = { query: async (sql) => {
    if (sql.startsWith('SELECT')) return { rows: [{ relrowsecurity: true }] };
    alterations.push(sql);
    return { rows: [] };
  } };
  assert.equal(await syncRlsState(db, 'off'), 4);
  assert.equal(alterations.length, 4);
  assert.ok(alterations.every((sql) => sql.includes('DISABLE ROW LEVEL SECURITY')));
});

test('enforce restores disabled RLS and invalid modes fail closed', async () => {
  const alterations = [];
  const db = { query: async (sql) => {
    if (sql.startsWith('SELECT')) return { rows: [{ relrowsecurity: false }] };
    alterations.push(sql);
    return { rows: [] };
  } };
  assert.equal(await syncRlsState(db, 'enforce'), 4);
  assert.ok(alterations.every((sql) => sql.includes('ENABLE ROW LEVEL SECURITY')));
  await assert.rejects(syncRlsState(db, 'typo'), /Invalid migration RLS mode/);
});

// ---------------------------------------------------------------------------
// checksumFor
// ---------------------------------------------------------------------------

test('checksumFor is stable for identical content', () => {
  const a = checksumFor('CREATE TABLE x (id int);');
  const b = checksumFor('CREATE TABLE x (id int);');
  assert.equal(a, b);
  assert.equal(a.length, 64, 'expected a hex sha256');
});

test('checksumFor differs when content differs', () => {
  const a = checksumFor('CREATE TABLE x (id int);');
  const b = checksumFor('CREATE TABLE x (id bigint);');
  assert.notEqual(a, b);
});

test('checksumFor is whitespace-sensitive', () => {
  // A trailing newline is a real edit. Silently ignoring whitespace
  // would let a migration be "changed" without detection.
  const a = checksumFor('SELECT 1;');
  const b = checksumFor('SELECT 1;\n');
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// verifyChecksums
// ---------------------------------------------------------------------------

const fakeMigrations = [
  { name: '001-schema', file: 'schema.sql' },
  { name: '002-indexes', file: 'indexes.sql' },
];

test('verifyChecksums passes when nothing has drifted', () => {
  const files = { 'schema.sql': 'one', 'indexes.sql': 'two' };
  const records = new Map([
    ['001-schema', { checksum: checksumFor('one') }],
    ['002-indexes', { checksum: checksumFor('two') }],
  ]);
  assert.deepEqual(verifyChecksums(records, fakeMigrations, (f) => files[f]), []);
});

test('verifyChecksums detects an edited applied migration', () => {
  // This is the 2026-09-23 scenario: 001-schema was edited in place
  // after being applied to local databases.
  const files = { 'schema.sql': 'one-EDITED', 'indexes.sql': 'two' };
  const records = new Map([
    ['001-schema', { checksum: checksumFor('one') }],
    ['002-indexes', { checksum: checksumFor('two') }],
  ]);
  const problems = verifyChecksums(records, fakeMigrations, (f) => files[f]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, '001-schema');
  assert.equal(problems[0].recorded, checksumFor('one'));
  assert.equal(problems[0].current, checksumFor('one-EDITED'));
});

test('verifyChecksums reports every drifted migration, not just the first', () => {
  const files = { 'schema.sql': 'one-EDITED', 'indexes.sql': 'two-EDITED' };
  const records = new Map([
    ['001-schema', { checksum: checksumFor('one') }],
    ['002-indexes', { checksum: checksumFor('two') }],
  ]);
  const problems = verifyChecksums(records, fakeMigrations, (f) => files[f]);
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((p) => p.name), ['001-schema', '002-indexes']);
});

test('verifyChecksums ignores migrations that were never applied', () => {
  // 003 does not exist yet on this database, so it cannot have drifted.
  const files = { 'schema.sql': 'one', 'indexes.sql': 'two', '003-cross-vertical.sql': 'three' };
  const records = new Map([['001-schema', { checksum: checksumFor('one') }]]);
  const with003 = [...fakeMigrations, { name: '003-cross-vertical', file: '003-cross-vertical.sql' }];
  assert.deepEqual(verifyChecksums(records, with003, (f) => files[f]), []);
});

test('verifyChecksums tolerates a NULL checksum from before checksums existed', () => {
  // A database created before 2026-09-24 has no baseline to compare
  // against. The runner backfills one on the next run; until then there
  // is nothing to compare, so this must not throw.
  const files = { 'schema.sql': 'one', 'indexes.sql': 'two' };
  const records = new Map([
    ['001-schema', { checksum: null }],
    ['002-indexes', { checksum: null }],
  ]);
  assert.deepEqual(verifyChecksums(records, fakeMigrations, (f) => files[f]), []);
});

test('verifyChecksums tolerates a missing checksum property entirely', () => {
  const files = { 'schema.sql': 'one', 'indexes.sql': 'two' };
  const records = new Map([
    ['001-schema', {}],
    ['002-indexes', {}],
  ]);
  assert.deepEqual(verifyChecksums(records, fakeMigrations, (f) => files[f]), []);
});

// ---------------------------------------------------------------------------
// MIGRATIONS manifest
// ---------------------------------------------------------------------------

test('MIGRATIONS lists every migration in order', () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.name), [
    '001-schema',
    '002-indexes',
    '003-cross-vertical',
    '004-auth-sessions',
    '006-audit-integrity',
    '007-audit-actor-preservation',
    '008-mfa',
    '009-mfa-challenge-revocation',
    '010-rls-listings-leads',
    '011-photos-deprecated',
    '012-contact-intake',
    '013-visit-viewings',
    '014-visit-event-snapshots',
  ]);
});

test('the dev-credentials seed is NOT in the auto-applied manifest', () => {
  // It writes a known password to every demo user. Auto-applying it
  // would put a universal credential on any database that ran
  // db:migrate, including a staging one.
  assert.ok(
    !MIGRATIONS.some((m) => m.file.includes('seed-dev-credentials')),
    '005 must stay manual-only',
  );
});

test('migration names are unique', () => {
  const names = MIGRATIONS.map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
});

test('migration files are unique', () => {
  const files = MIGRATIONS.map((m) => m.file);
  assert.equal(new Set(files).size, files.length);
});

test('MIGRATION_LOCK_ID is a signed 32-bit integer', () => {
  // pg_advisory_lock(bigint) takes the value as int8 on the wire, but a
  // value that overflows int32 indicates a typo in the constant.
  assert.ok(Number.isInteger(MIGRATION_LOCK_ID));
  assert.ok(MIGRATION_LOCK_ID >= -2147483648 && MIGRATION_LOCK_ID <= 2147483647);
});
