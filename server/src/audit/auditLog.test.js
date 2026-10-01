// Audit-log tests.
//
// Two things are pinned here:
//
//   1. An event is actually INSERTed, inside the caller's transaction.
//      Until 2026-09-24 `recordAudit` only logged to Fastify and nothing
//      ever reached the table.
//   2. The canonical form used for the HMAC is stable — sorted keys, a
//      fixed field set — so a row written today verifies the same way
//      after a restart. A canonical form that depended on JS object key
//      insertion order would make every row look tampered after a
//      refactor.
//
// Run with `npm test` (src/**/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuditRecord,
  writeAuditRecord,
  verifyAuditRow,
  logAuditOnly,
} from './auditLog.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-in-production-0000';

const fakeClient = () => {
  const rows = [];
  return {
    rows,
    async query(text, params) {
      if (/INSERT INTO audit_log/.test(text)) {
        rows.push(params);
        return { rowCount: 1 };
      }
      throw new Error(`audit fake: unmodelled query — ${text.slice(0, 60)}`);
    },
  };
};

// ---------------------------------------------------------------------------
// 1. Insert
// ---------------------------------------------------------------------------

test('an event is inserted with the documented column order', async () => {
  const client = fakeClient();
  const record = buildAuditRecord({
    tenantId: 'org_acme',
    userId: 'u-asha',
    action: 'login-succeeded',
    entity: 'user',
    entityId: 'u-asha',
    metadata: { role: 'field-executive' },
  });
  await writeAuditRecord(client, record);

  assert.equal(client.rows.length, 1);
  // id, tenant_id, user_id, actor_id, action, entity, entity_id,
  // metadata, timestamp, hmac — one entry per column in the INSERT.
  const row = client.rows[0];
  assert.equal(row[0], record.id);
  assert.equal(row[1], 'org_acme');
  assert.equal(row[2], 'u-asha');
  assert.equal(row[3], 'u-asha', 'actor_id mirrors user_id at write time');
  assert.equal(row[4], 'login-succeeded');
  assert.equal(row[5], 'user');
  assert.equal(row[6], 'u-asha');
  assert.equal(JSON.parse(row[7]).role, 'field-executive');
  assert.equal(row[8], record.timestamp);
  assert.ok(row[9], 'the hmac column is populated when a key exists');
});

test('request context is merged into metadata', () => {
  const record = buildAuditRecord({
    req: { ip: '10.0.0.5', id: 'req-1', headers: { 'user-agent': 'curl/8' } },
    tenantId: 'org_acme',
    userId: 'u-1',
    action: 'logout',
    entity: 'refresh_session',
  });
  assert.equal(record.metadata.ip, '10.0.0.5');
  assert.equal(record.metadata.requestId, 'req-1');
  assert.equal(record.metadata.userAgent, 'curl/8');
});

test('explicit metadata overrides request context', () => {
  const record = buildAuditRecord({
    req: { ip: '10.0.0.5', id: 'req-1', headers: {} },
    tenantId: 'org_acme',
    userId: 'u-1',
    action: 'login-failed',
    entity: 'user',
    metadata: { ip: '203.0.113.9' },
  });
  assert.equal(record.metadata.ip, '203.0.113.9', 'a caller-supplied value wins');
});

// ---------------------------------------------------------------------------
// 2. Signature
// ---------------------------------------------------------------------------

test('a freshly written row verifies', async () => {
  const client = fakeClient();
  const record = buildAuditRecord({
    tenantId: 'org_acme',
    userId: 'u-asha',
    action: 'invited-user',
    entity: 'user',
    entityId: 'u-new',
    // Deliberately unsorted, to prove the canonical form sorts.
    metadata: { zebra: 1, alpha: 2, middle: { z: 1, a: 2 } },
  });
  await writeAuditRecord(client, record);

  // Destructured against the documented column order, which now includes
  // `actor_id` between `user_id` and `action`. Skipping a column here
  // silently shifts every later one, so the position is explicit.
  const [id, tenantId, userId, actorId, action, entity, entityId, metadata, timestamp, hmac] =
    client.rows[0];
  assert.equal(
    verifyAuditRow({ id, tenant_id: tenantId, user_id: userId, actor_id: actorId, action, entity, entity_id: entityId, metadata: JSON.parse(metadata), timestamp, hmac }),
    true,
  );
});

test('a tampered field fails verification', async () => {
  const client = fakeClient();
  const record = buildAuditRecord({
    tenantId: 'org_acme', userId: 'u-1', action: 'login-succeeded', entity: 'user', entityId: 'u-1',
  });
  await writeAuditRecord(client, record);
  const row = client.rows[0];

  // An attacker who edits the recorded action to erase evidence of a
  // successful login. The signature no longer matches.
  const tampered = {
    id: row[0], tenant_id: row[1], user_id: row[2], actor_id: row[3],
    action: 'login-failed',           // was 'login-succeeded'
    entity: row[5], entity_id: row[6],
    metadata: JSON.parse(row[7]), timestamp: row[8], hmac: row[9],
  };
  assert.equal(verifyAuditRow(tampered), false);
});

test('a tampered metadata payload fails verification', async () => {
  const client = fakeClient();
  const record = buildAuditRecord({
    tenantId: 'org_acme', userId: 'u-1', action: 'password-reset-completed',
    entity: 'user', entityId: 'u-1', metadata: { sessionsRevoked: 3 },
  });
  await writeAuditRecord(client, record);
  const row = client.rows[0];

  const tampered = {
    id: row[0], tenant_id: row[1], user_id: row[2], actor_id: row[3],
    action: row[4], entity: row[5],
    entity_id: row[6],
    metadata: { sessionsRevoked: 0 },   // was 3
    timestamp: row[8], hmac: row[9],
  };
  assert.equal(verifyAuditRow(tampered), false, 'a rewritten count is detected');
});

test('the signature is stable across a key-order change', async () => {
  // Same logical record, metadata keys inserted in a different order.
  // Both must produce the same hmac, or every refactor that reorders an
  // object literal would make the whole log look tampered.
  //
  // The id and timestamp are part of what is signed and are generated
  // per record, so they are pinned here — otherwise this would compare
  // two genuinely different events and pass or fail for the wrong
  // reason. What is under test is only the metadata ordering.
  const pinned = { id: 'au_fixed', timestamp: '2026-09-24T00:00:00.000Z' };
  const build = (metadata) => ({
    ...buildAuditRecord({
      tenantId: 'org_acme', userId: 'u-1', action: 'x', entity: 'user', metadata,
    }),
    ...pinned,
  });

  const ca = fakeClient();
  const cb = fakeClient();
  await writeAuditRecord(ca, build({ alpha: 1, zeta: 2, beta: 3 }));
  await writeAuditRecord(cb, build({ beta: 3, alpha: 1, zeta: 2 }));
  assert.equal(ca.rows[0][9], cb.rows[0][9], 'key order does not change the signature');
});

test('the signature changes when any signed field changes', async () => {
  const base = {
    tenantId: 'org_acme', userId: 'u-1', action: 'x', entity: 'user',
    metadata: { alpha: 1 },
  };
  const signed = async (over) => {
    const client = fakeClient();
    await writeAuditRecord(client, {
      ...buildAuditRecord(base),
      id: 'au_fixed',
      timestamp: '2026-09-24T00:00:00.000Z',
      ...over,
    });
    return client.rows[0][9];
  };
  const reference = await signed({});

  for (const over of [
    { tenantId: 'org_other' },
    { userId: 'u-2' },
    { action: 'y' },
    { entity: 'other' },
    { entityId: 'u-1' },
    { metadata: { alpha: 2 } },
  ]) {
    assert.notEqual(await signed(over), reference, `changing ${Object.keys(over)[0]} must change the signature`);
  }
});

test('a missing hmac makes no claim either way', () => {
  // Rows written before a key was configured, or by a deployment without
  // one, must not be reported as tampered. `assert_audit_integrity`
  // reports them separately as 'unsigned'.
  assert.equal(verifyAuditRow({ id: 'x', hmac: null }), true);
});

test('logAuditOnly works without a client', () => {
  const logged = [];
  const record = logAuditOnly(
    { info: (obj) => logged.push(obj) },
    { tenantId: 'org_acme', userId: 'u-1', action: 'background-job', entity: 'session' },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].audit.action, 'background-job');
  assert.equal(record.entity, 'session');
});

test('each record gets a unique id', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) {
    ids.add(buildAuditRecord({ action: 'x', entity: 'y' }).id);
  }
  assert.equal(ids.size, 50);
  assert.ok([...ids][0].startsWith('au_'));
});

// ---------------------------------------------------------------------------
// 5. Tamper-evidence across a user deletion  (regression, 2026-09-27)
// ---------------------------------------------------------------------------
//
// `audit_log.user_id` is `ON DELETE SET NULL`, so deleting a user
// rewrites a field the HMAC used to cover. Every audit row that user
// produced then failed `verifyAuditRow` — 38 of 42 rows on the
// verification database, none of them tampered with. The writer and the
// verifier had also drifted apart, so a re-sign could not repair them.
//
// The fix signs `actor_id`, an immutable copy nothing updates. These two
// tests pin the property that was actually broken.

test('deleting a user does not invalidate their audit rows', async () => {
  const client = fakeClient();
  const record = buildAuditRecord({
    tenantId: 'org_acme',
    userId: 'u-doomed',
    action: 'login-succeeded',
    entity: 'user',
    entityId: 'u-doomed',
  });
  await writeAuditRecord(client, record);

  // Column order matches the INSERT: id, tenant_id, user_id, actor_id,
  // action, entity, entity_id, metadata, timestamp, hmac.
  const [, , userId, actorId, , , , , , hmac] = client.rows[0];
  // The insert carries the same value in both columns.
  assert.equal(userId, 'u-doomed');
  assert.equal(actorId, 'u-doomed', 'actor_id is written at insert time');

  // Postgres applies ON DELETE SET NULL: user_id becomes null, actor_id
  // is untouched.
  const stored = {
    id: record.id,
    tenant_id: 'org_acme',
    user_id: null,
    actor_id: 'u-doomed',
    action: record.action,
    entity: record.entity,
    entity_id: record.entityId,
    metadata: record.metadata,
    timestamp: record.timestamp,
    hmac,
  };
  assert.equal(verifyAuditRow(stored), true, 'still verifies after the cascade nulls user_id');
});

test('a change to any signed field is still detected', async () => {
  const client = fakeClient();
  const record = buildAuditRecord({
    tenantId: 'org_acme',
    userId: 'u-1',
    action: 'login-succeeded',
    entity: 'user',
    entityId: 'u-1',
  });
  await writeAuditRecord(client, record);
  const [, , , , , , , , , hmac] = client.rows[0];
  const stored = {
    id: record.id,
    tenant_id: 'org_acme',
    user_id: 'u-1',
    actor_id: 'u-1',
    action: record.action,
    entity: record.entity,
    entity_id: record.entityId,
    metadata: record.metadata,
    timestamp: record.timestamp,
    hmac,
  };
  assert.equal(verifyAuditRow(stored), true);

  // actor_id is signed, so rewriting it is tampering.
  assert.equal(verifyAuditRow({ ...stored, actor_id: 'u-someone-else' }), false);
  assert.equal(verifyAuditRow({ ...stored, metadata: { ...stored.metadata, ip: '1.2.3.4' } }), false);
  assert.equal(verifyAuditRow({ ...stored, action: 'logout' }), false);
});
