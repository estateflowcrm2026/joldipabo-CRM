// Audit log helper.
//
// Append-only by design. The application DB role has no UPDATE/DELETE
// permission on `audit_log` (see docs/BACKEND_INTEGRATION_PLAN.md §6).
//
// Route handlers call `recordAudit(client, action, entity, entityId, meta)`
// INSIDE the same transaction as the mutation that triggered it, so a
// mutation cannot commit without its audit row and a rolled-back
// mutation cannot leave a phantom event.
//
// Until 2026-09-24 this only logged to Fastify and nothing was ever
// inserted. The auth flows call it for login, logout, refresh, lockout,
// invite and password reset.
//
// Verb vocabulary matches the frontend reducer (created-lead,
// checked-in, uploaded-photo, …) and the expanded set in
// docs/RBAC_SERVER_ENFORCEMENT.md §7.

import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

/**
 * @typedef {Object} AuditRecord
 * @property {string} id
 * @property {string|null} tenantId
 * @property {string|null} userId
 * @property {string} action
 * @property {string} entity
 * @property {string|null} entityId
 * @property {object} metadata
 * @property {string} timestamp
 */

/**
 * Where the signing key for the tamper-evidence `hmac` comes from.
 *
 * Derived from the JWT secret so there is one secret to manage, with a
 * domain separator so the derived key is not itself a valid JWT key.
 * Returns null when no secret is available — in that case the `hmac`
 * column stays null rather than being filled with something weak, and
 * the security checklist item "every row has a non-null hmac" stays
 * visibly unmet.
 */
function hmacKey() {
  if (config.jwt.secret && config.jwt.secret.trim() !== '') {
    return createHmac('sha256', 'audit-log:').update(config.jwt.secret).digest();
  }
  return null;
}

/**
 * Build the audit record without persisting it.
 *
 * @param {object} input
 * @param {object} [input.req]        Fastify request, for ip / userAgent / requestId
 * @param {string} [input.tenantId]   overrides `req.user.tenantId`
 * @param {string} [input.userId]     overrides `req.user.id`
 * @param {string} input.action
 * @param {string} input.entity
 * @param {string|null} [input.entityId]
 * @param {object} [input.metadata]
 * @returns {AuditRecord}
 */
export function buildAuditRecord({ req, tenantId, userId, action, entity, entityId = null, metadata = {} }) {
  const actor = req?.user;
  return {
    id: `au_${randomBytes(12).toString('hex')}`,
    tenantId: tenantId ?? actor?.tenantId ?? null,
    userId: userId ?? actor?.id ?? null,
    action,
    entity,
    entityId,
    metadata: {
      ...metadata,
      ip: metadata.ip ?? req?.ip ?? null,
      userAgent: metadata.userAgent ?? req?.headers?.['user-agent'] ?? null,
      requestId: metadata.requestId ?? req?.id ?? null,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Record an audit event.
 *
 * Pass the same `client` the mutation used, so both land in one
 * transaction. When `client` is omitted the insert runs on the pool and
 * commits independently — acceptable only for read-only endpoints that
 * are auditing an observation rather than a change.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {AuditRecord} record
 * @returns {Promise<AuditRecord>}
 */
/**
 * The canonical string an audit row is signed over.
 *
 * ONE implementation, used by the writer, the verifier, and the
 * re-signing migration. It used to be written out twice — once for
 * `writeAuditRecord` and once for `verifyAuditRow` — and the two copies
 * disagreed, so rows failed verification against themselves. The
 * migration in 007 then tried a third version in SQL and could not
 * match it either: `jsonb` orders object keys by LENGTH then bytewise,
 * where JS sorts them alphabetically, and its `::text` adds whitespace.
 * A canonical form with two implementations is not a canonical form.
 *
 * Keep the field set and the ordering frozen. Changing either
 * invalidates every signature ever written, and there is no re-sign path
 * short of running the backfill with the old key.
 *
 * @param {{id: string, tenantId: string|null, userId: string|null, action: string,
 *          entity: string, entityId: string|null, metadata: object,
 *          timestamp: string|Date}} row
 * @returns {string}
 */
export function auditCanonical(row) {
  return JSON.stringify({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    metadata: sortKeys(row.metadata),
    // A Date from `pg` and the ISO string the writer sent are not
    // interchangeable; both sides must normalise the same way.
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
  });
}

export async function writeAuditRecord(client, record) {
  const key = hmacKey();
  // `actorId`, NOT `userId`. `user_id` is a live foreign key with
  // ON DELETE SET NULL, so deleting a user rewrote a signed field and
  // every audit row that user produced stopped verifying — 38 of 42
  // rows on the verification database, all of them untouched. That is
  // indistinguishable from real tampering, so it is signed via
  // `actor_id`, which nothing updates. See 007-audit-actor-preservation.
  const canonical = auditCanonical({
    id: record.id,
    tenantId: record.tenantId,
    userId: record.actorId ?? record.userId,
    action: record.action,
    entity: record.entity,
    entityId: record.entityId,
    metadata: record.metadata,
    timestamp: record.timestamp,
  });
  const hmac = key ? createHmac('sha256', key).update(canonical).digest('hex') : null;

  // One placeholder per column, including actor_id, so the params array
  // lines up with the column list. (Reusing $3 for two columns produced
  // a 9-element array for a 10-column statement, which is the sort of
  // off-by-one that silently shifts every later column in a fake-client
  // test while working fine against real Postgres.)
  await client.query(
    `INSERT INTO audit_log (id, tenant_id, user_id, actor_id, action, entity, entity_id, metadata, timestamp, hmac)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      record.id,
      record.tenantId,
      record.userId,
      record.userId, // actor_id: the same value, captured immutably
      record.action,
      record.entity,
      record.entityId,
      JSON.stringify(record.metadata),
      record.timestamp,
      hmac,
    ],
  );
  return record;
}

/** Recursively sort object keys so JSON.stringify is stable. */
function sortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  return Object.keys(value)
    .sort()
    .reduce((acc, k) => {
      acc[k] = sortKeys(value[k]);
      return acc;
    }, {});
}

/**
 * Build and persist an audit event in one call.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {object} input — see {@link buildAuditRecord}
 * @returns {Promise<AuditRecord>}
 */
export async function recordAudit(client, input) {
  const record = buildAuditRecord(input);
  await writeAuditRecord(client, record);
  return record;
}

/**
 * Verify a stored row against its signature. Used by the integrity job
 * and by the security checklist (§9.4).
 *
 * @param {object} row — a `SELECT * FROM audit_log` row
 * @returns {boolean} true when the row is unmodified, or when no key is
 *   configured (in which case no claim is made either way)
 */
export function verifyAuditRow(row) {
  const key = hmacKey();
  if (!key || !row.hmac) return true; // nothing to check against
  // `actor_id` is what was signed. It is NULL only for rows written before
  // 007; those fall back to `user_id`, which is correct for any row whose
  // user has not since been deleted.
  const canonical = auditCanonical({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.actor_id === undefined ? row.user_id : row.actor_id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    metadata: row.metadata,
    timestamp: row.timestamp,
  });
  const expected = createHmac('sha256', key).update(canonical).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(row.hmac), 'hex');
  if (a.length !== b.length) return false;
  // eslint-disable-next-line no-bitwise
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Log to Fastify without persisting. Used where there is no transaction
 * to join — a background job, or a dev boot with no database.
 *
 * @param {object} logger Fastify logger
 * @param {object} input — see {@link buildAuditRecord}
 * @returns {AuditRecord}
 */
export function logAuditOnly(logger, input) {
  const record = buildAuditRecord(input);
  logger.info(
    { audit: record },
    `audit ${record.action} ${record.entity}${record.entityId ? `:${record.entityId}` : ''}`,
  );
  return record;
}

/**
 * The derived audit signing key, or null when no secret is configured.
 *
 * Exported for `scripts/resign-audit.js` only. A script that re-signs
 * rows must derive the key exactly as the writer does, and the only way
 * to guarantee that is to use this function rather than restate the
 * derivation.
 */
export { hmacKey as __auditHmacKey };
