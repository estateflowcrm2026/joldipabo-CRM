// Re-sign audit rows whose signature no longer matches their contents.
//
//   cd server
//   node --env-file=.env scripts/resign-audit.js
//   node --env-file=.env scripts/resign-audit.js --dry-run
//
// WHY THIS IS A SCRIPT AND NOT PART OF THE MIGRATION
// --------------------------------------------------
// The migration that introduced `actor_id` (007) originally re-signed in
// SQL. It could not work: `jsonb` orders object keys by LENGTH then
// bytewise, `JSON.stringify` orders them alphabetically, and jsonb's
// `::text` adds whitespace that JSON.stringify does not. The SQL
// produced a hash no verifier could reproduce.
//
// A second implementation of a signing routine is what caused the
// original bug in the first place — `writeAuditRecord` and
// `verifyAuditRow` had drifted apart, and rows were failing verification
// against themselves. So the backfill calls the one shared
// `auditCanonical()` rather than restating the format.
//
// SCOPE
// -----
// Only rows that currently FAIL verification are re-signed, and only
// after a `--dry-run` has shown you which ones. A row that fails because
// somebody genuinely altered it is indistinguishable, by construction,
// from a row that failed for a structural reason, so this script is
// deliberately a separate, explicit step rather than something a
// migration does to you unattended.
//
// The rows this is meant for are those whose actor was deleted: the
// ON DELETE SET NULL cascade nulled a signed field, so the signature no
// longer described the row. Re-signing records the state the row is
// actually in, which is the truth. It does not reconstruct the missing
// actor id — that information is gone.
//
// Exit 0 = nothing left unverified (or --dry-run completed).

import { getDb, closeDb, isDbConfigured } from '../src/db/client.js';
import { verifyAuditRow, auditCanonical, __auditHmacKey } from '../src/audit/auditLog.js';

const DRY_RUN = process.argv.includes('--dry-run');

// A tenant id that satisfies the NOT NULL constraint, used only for the
// self-check probe. No row is ever written with it.
const TENANT_PROBE = 'org_audit_probe';

if (!isDbConfigured()) {
  console.error('resign-audit requires DATABASE_URL.');
  process.exit(2);
}

const key = __auditHmacKey();
if (!key) {
  console.error(
    'resign-audit requires JWT_SECRET. The audit signing key is derived from it,\n' +
      'so without it there is nothing to sign with and every row would verify as\n' +
      '"nothing to check against" — which is not the same as intact.',
  );
  process.exit(2);
}

const { createHmac } = await import('node:crypto');

const db = getDb();

// --since <ISO timestamp> restricts the check to rows written after that
// moment.
//
// WHY THIS EXISTS FOR CI
// ----------------------
// The audit signing key is derived from JWT_SECRET. A CI job that uses a
// different secret from the one that signed the rows already in the
// database will find EVERY row unverified — a false alarm that makes the
// job permanently red and, worse, teaches everyone to ignore an audit
// integrity failure. This bit during the first CI dry run: 180 of 222
// rows "failed" purely because the key differed.
//
// So CI records a timestamp before it starts and checks only what it
// wrote. Those rows were signed by the key the job is holding, so a
// failure there is a real regression rather than a key mismatch. The full
// history is still available to a human with `npm run audit:resign`.
//
// A key mismatch is also reported explicitly rather than as a wall of
// per-row failures, because that is what it almost always is.
const sinceArg = process.argv.includes('--since')
  ? process.argv[process.argv.indexOf('--since') + 1]
  : null;

let rows;
if (sinceArg) {
  const { rows: fresh } = await db.query(
    'SELECT * FROM audit_log WHERE timestamp >= $1 ORDER BY timestamp',
    [sinceArg],
  );
  rows = fresh;
  console.log(`\n[resign] checking ${rows.length} row(s) written since ${sinceArg}`);
} else {
  ({ rows } = await db.query('SELECT * FROM audit_log ORDER BY timestamp'));
}

const broken = rows.filter((r) => !verifyAuditRow(r));
const intact = rows.length - broken.length;

console.log(`\n[resign] ${rows.length} audit row(s): ${intact} verify, ${broken.length} do not.`);

if (broken.length === 0) {
  console.log('[resign] nothing to do.');
  await closeDb();
  process.exit(0);
}

// Distinguish "this key never signed these rows" from "these rows were
// altered". The rate is not a reliable signal — a long-lived database
// legitimately holds a mix of rows written by the current key, rows whose
// actor was cascade-nulled, and rows written by a key that has since
// rotated out.
//
// What IS reliable: write a row signed by the current key and check it.
// If that verifies, the key and the verifier agree and every failure below
// is about the stored rows. If the round trip is broken, the failures say
// nothing about tampering and saying otherwise would be worse than
// silence.
if (broken.length > 0) {
  const { auditCanonical } = await import('../src/audit/auditLog.js');
  const canonical = auditCanonical({
    id: 'au_probe',
    tenantId: TENANT_PROBE,
    userId: null,
    action: 'probe',
    entity: 'probe',
    entityId: null,
    metadata: { a: 1 },
    timestamp: '2020-01-01T00:00:00.000Z',
  });
  const probeSig = createHmac('sha256', key).update(canonical).digest('hex');
  const roundTripOk = verifyAuditRow({
    id: 'au_probe',
    tenant_id: TENANT_PROBE,
    user_id: null,
    actor_id: null,
    action: 'probe',
    entity: 'probe',
    entity_id: null,
    metadata: { a: 1 },
    timestamp: new Date('2020-01-01T00:00:00.000Z'),
    hmac: probeSig,
  });

  if (!roundTripOk) {
    console.error('');
    console.error('[resign] a row signed by this environment does not verify, so the');
    console.error('  failures below are not evidence of tampering. The audit key is');
    console.error('  derived from JWT_SECRET; either it is wrong, or the canonical form');
    console.error('  has drifted. See docs/SUPABASE_VERIFICATION.md §8.');
    console.error('');
    await closeDb();
    process.exit(3);
  }

  // Key and verifier agree, so at least one stored row should verify too
  // unless the database was written by a different key entirely.
  //
  // Reported in --dry-run only. The non-dry-run path exists precisely to
  // repair rows that do not verify, including after a key rotation, so
  // blocking it here would make the tool unable to do its job. Dry-run is
  // where the operator is deciding whether to act, and "nothing verifies"
  // is the moment to say "check your key first".
  if (intact === 0 && DRY_RUN) {
    console.error('');
    console.error('[resign] NO row verifies with this environment\'s key.');
    console.error('  The rows were signed with a different JWT_SECRET — nothing in the');
    console.error('  database was altered. To check only what this run wrote:');
    console.error('    npm run audit:resign:dry -- --since <ISO timestamp>');
    console.error('');
    await closeDb();
    process.exit(3);
  }
}

// Group by cause, so the operator can see whether this looks like the
// expected cascade or like something nobody can explain.
const byCause = new Map();
for (const r of broken) {
  const cause = r.user_id === null ? 'actor deleted (user_id nulled by cascade)' : 'user_id present — investigate';
  byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
}
for (const [cause, n] of byCause) {
  console.log(`[resign]   ${n} — ${cause}`);
}

if (DRY_RUN) {
  console.log('\n[resign] --dry-run: no rows were changed. Re-run without it to apply.');
  await closeDb();
  process.exit(0);
}

let signed = 0;
for (const r of broken) {
  const hmac = createHmac('sha256', key)
    .update(
      auditCanonical({
        id: r.id,
        tenantId: r.tenant_id,
        userId: r.actor_id === undefined ? r.user_id : r.actor_id,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        metadata: r.metadata,
        timestamp: r.timestamp,
      }),
    )
    .digest('hex');
  await db.query('UPDATE audit_log SET hmac = $2 WHERE id = $1', [r.id, hmac]);
  signed += 1;
}

console.log(`[resign] re-signed ${signed} row(s).`);

// Prove it worked rather than asserting it.
const { rows: after } = await db.query('SELECT * FROM audit_log ORDER BY timestamp');
const stillBroken = after.filter((r) => !verifyAuditRow(r));
console.log(`[resign] after: ${after.length - stillBroken.length}/${after.length} verify.`);
if (stillBroken.length > 0) {
  console.error(`[resign] ${stillBroken.length} row(s) still fail verification.`);
  await closeDb();
  process.exit(1);
}

await closeDb();
process.exit(0);
