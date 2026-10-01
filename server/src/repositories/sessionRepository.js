// Refresh sessions and login-attempt tracking.
//
// A "session family" is the chain of refresh tokens produced by one
// login. The first token seeds `family_id`; every rotation inherits it.
// That gives reuse detection something to revoke in one statement:
// presenting a token that was already rotated away is the signal that
// either an attacker or a buggy client has an old copy, and the safe
// response is to kill the whole family rather than guess which copy is
// the real one.
//
// Refresh tokens are never stored in the clear — only their SHA-256.
// The plaintext is returned to the client exactly once, at issue time.
//
// This module is persistence-shaped and takes an explicit `client`, so
// it can be unit-tested without a database and called inside an
// existing transaction.

import { randomBytes, createHash } from 'node:crypto';
import { issueRefreshToken, hashRefreshToken } from '../auth/tokenService.js';

const FAMILY_ID_BYTES = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

/** Lowercase and hash an email so it can be counted without storing it. */
export function identifierHash(identifier) {
  return createHash('sha256')
    .update(String(identifier || '').trim().toLowerCase(), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * Create the first refresh session for a login, and its access token.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tenantId
 * @param {string} [input.roleId]     — recorded for staleness checks
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @param {string} [input.deviceLabel]
 * @param {string} [input.deviceFingerprint]
 * @returns {Promise<{ sessionId, familyId, refreshToken, refreshTokenHash, refreshExpiresAt }>}
 */
export async function createSession(client, input) {
  const { token, tokenHash, expiresAt } = issueRefreshToken();
  const sessionId = newId('rs');
  const familyId = newId('fam');

  await client.query(
    `INSERT INTO refresh_sessions (
        id, user_id, tenant_id, token_hash,
        device_fingerprint, device_label, user_agent, ip,
        family_id, rotation_count, created_at, last_used_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, now(), now(), $10)`,
    [
      sessionId,
      input.userId,
      input.tenantId,
      tokenHash,
      input.deviceFingerprint ?? null,
      input.deviceLabel ?? null,
      input.userAgent ?? null,
      input.ip ?? null,
      familyId,
      expiresAt,
    ],
  );

  return {
    sessionId,
    familyId,
    refreshToken: token,
    refreshTokenHash: tokenHash,
    refreshExpiresAt: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Rotate
// ---------------------------------------------------------------------------

/**
 * Outcome of a rotation attempt.
 *
 * @typedef {{ ok: true, session: object, refreshToken: string, refreshTokenHash: string, refreshExpiresAt: string }
 *   | { ok: false, reason: 'not-found' | 'expired' | 'revoked' | 'compromise-detected' }} RotateResult
 */

/**
 * Exchange a refresh token for a new one.
 *
 * Reuse detection: the presented token is looked up by hash. If the row
 * is already revoked, the token is a replay — the client is either
 * stolen or buggy. The entire family is revoked and the caller is told
 * to require a fresh login. `compromised_at` distinguishes this from an
 * ordinary logout when an operator reads the audit trail.
 *
 * The old row is revoked and a new one inserted in the same
 * transaction, so a crash between them cannot leave two live tokens
 * for one rotation.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} refreshToken
 * @returns {Promise<RotateResult>}
 */
export async function rotateSession(client, refreshToken) {
  const presentedHash = hashRefreshToken(refreshToken);

  const { rows } = await client.query(
    `SELECT id, user_id, tenant_id, family_id, rotation_count,
            revoked_at, expires_at, compromised_at
       FROM refresh_sessions
      WHERE token_hash = $1
      FOR UPDATE`,
    [presentedHash],
  );

  if (rows.length === 0) return { ok: false, reason: 'not-found' };
  const current = rows[0];

  // Replay of a token that is no longer live.
  if (current.revoked_at) {
    if (current.family_id) {
      await client.query(
        `UPDATE refresh_sessions
            SET revoked_at = COALESCE(revoked_at, now()),
                compromised_at = COALESCE(compromised_at, now())
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [current.family_id],
      );
    }
    // The session identity travels back with the failure. The caller
    // writes a `refresh-token-replayed` audit row, and `audit_log.
    // tenant_id` is NOT NULL — a row written without it aborts the whole
    // transaction, which silently undid the family revocation above.
    return {
      ok: false,
      reason: 'compromise-detected',
      session: {
        id: current.id,
        userId: current.user_id,
        tenantId: current.tenant_id,
      },
    };
  }

  if (new Date(current.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Revoke the presented row, then mint its successor in the same
  // transaction.
  await client.query(
    'UPDATE refresh_sessions SET revoked_at = now(), last_used_at = now() WHERE id = $1',
    [current.id],
  );

  const { token, tokenHash, expiresAt } = issueRefreshToken();
  const nextId = newId('rs');

  await client.query(
    `INSERT INTO refresh_sessions (
        id, user_id, tenant_id, token_hash, family_id, parent_id,
        device_fingerprint, device_label, user_agent, ip,
        rotation_count, created_at, last_used_at, expires_at
     )
     SELECT $1, user_id, tenant_id, $2, COALESCE(family_id, id), id,
            device_fingerprint, device_label, user_agent, ip,
            rotation_count + 1, now(), now(), $3
       FROM refresh_sessions
      WHERE id = $4`,
    [nextId, tokenHash, expiresAt, current.id],
  );

  return {
    ok: true,
    session: {
      id: nextId,
      userId: current.user_id,
      tenantId: current.tenant_id,
      familyId: current.family_id || current.id,
      rotationCount: current.rotation_count + 1,
    },
    refreshToken: token,
    refreshTokenHash: tokenHash,
    refreshExpiresAt: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * Revoke a single session, addressed by its plaintext refresh token.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} refreshToken
 * @returns {Promise<boolean>} whether a live row was revoked
 */
export async function revokeSessionByToken(client, refreshToken) {
  return (await revokeSessionByTokenDetailed(client, refreshToken)) !== null;
}

/**
 * Revoke a live session and return what was revoked.
 *
 * The same UPDATE as {@link revokeSessionByToken}, with RETURNING, so the
 * caller can attribute the audit row. `audit_log.tenant_id` is NOT NULL,
 * and logout is frequently called without a request context — a service
 * or a route that only holds the refresh token — so the tenant has to
 * come from the row being revoked rather than from `req.user`.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} refreshToken
 * @returns {Promise<{id: string, userId: string, tenantId: string}|null>}
 *          null when no live row matched
 */
export async function revokeSessionByTokenDetailed(client, refreshToken) {
  const { rows } = await client.query(
    `UPDATE refresh_sessions
        SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id, user_id, tenant_id`,
    [hashRefreshToken(refreshToken)],
  );
  return rows.length > 0 ? { id: rows[0].id, userId: rows[0].user_id, tenantId: rows[0].tenant_id } : null;
}

/**
 * Revoke every live session for a user across all families.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @returns {Promise<number>} rows revoked
 */
export async function revokeAllSessions(client, userId) {
  const { rowCount } = await client.query(
    'UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rowCount;
}

/**
 * List a user's live sessions, newest first.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @returns {Promise<Array<object>>}
 */
export async function listLiveSessions(client, userId) {
  const { rows } = await client.query(
    `SELECT id, family_id, device_label, ip, user_agent,
            created_at, last_used_at, expires_at, trusted
       FROM refresh_sessions
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Login attempt counting
// ---------------------------------------------------------------------------

/**
 * Default lockout policy. Overridable per environment, but the defaults
 * are the values asserted in the tests.
 */
export const LOCKOUT_POLICY = {
  /** Failures allowed before a known account is locked. */
  userThreshold: 5,
  /** Failures allowed before an unknown address is locked out. */
  tenantThreshold: 10,
  /** How long a lockout lasts. */
  lockMs: 15 * 60 * 1000,
  /** A window of inactivity resets the counter. */
  windowMs: 60 * 60 * 1000,
};

function policy() {
  return {
    userThreshold: Number(process.env.LOGIN_LOCKOUT_THRESHOLD) || LOCKOUT_POLICY.userThreshold,
    tenantThreshold: Number(process.env.LOGIN_LOCKOUT_TENANT_THRESHOLD) || LOCKOUT_POLICY.tenantThreshold,
    lockMs: Number(process.env.LOGIN_LOCKOUT_MS) || LOCKOUT_POLICY.lockMs,
    windowMs: Number(process.env.LOGIN_LOCKOUT_WINDOW_MS) || LOCKOUT_POLICY.windowMs,
  };
}

/**
 * Read the lockout state for a known account.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @returns {Promise<{ locked: boolean, retryAfterMs: number, failedLoginCount: number }>}
 */
export async function getUserLockout(client, userId) {
  const { rows } = await client.query(
    'SELECT failed_login_count, locked_until FROM users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) return { locked: false, retryAfterMs: 0, failedLoginCount: 0 };

  const row = rows[0];
  const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
  const locked = lockedUntil > Date.now();
  return {
    locked,
    retryAfterMs: locked ? Math.max(0, lockedUntil - Date.now()) : 0,
    failedLoginCount: row.failed_login_count || 0,
  };
}

/**
 * Read the lockout state for an identifier, whether or not a user exists.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 * @param {string} identifier — email; hashed before storage
 * @returns {Promise<{ locked: boolean, retryAfterMs: number, failureCount: number }>}
 */
export async function getIdentifierLockout(client, tenantId, identifier) {
  const { rows } = await client.query(
    'SELECT failure_count, locked_until FROM login_attempts WHERE tenant_id = $1 AND identifier_hash = $2',
    [tenantId, identifierHash(identifier)],
  );
  if (rows.length === 0) return { locked: false, retryAfterMs: 0, failureCount: 0 };

  const row = rows[0];
  const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
  const locked = lockedUntil > Date.now();
  return {
    locked,
    retryAfterMs: locked ? Math.max(0, lockedUntil - Date.now()) : 0,
    failureCount: row.failure_count || 0,
  };
}

/**
 * Record a failed login.
 *
 * Two counters move: the per-user row (when the account exists) and the
 * per-identifier row (always, so a spray across many addresses is
 * visible even with no matching user). Both are updated in one
 * transaction so a crash cannot skew one relative to the other.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} input
 * @param {string} input.tenantId
 * @param {string} input.identifier — email
 * @param {string} [input.userId]
 * @returns {Promise<{ userLocked: boolean, identifierLocked: boolean }>}
 */
export async function recordFailedLogin(client, input) {
  const p = policy();
  const now = Date.now();
  const lockUntil = new Date(now + p.lockMs).toISOString();

  let userLocked = false;
  if (input.userId) {
    const { rows } = await client.query(
      `UPDATE users
          SET failed_login_count = CASE
                WHEN failed_login_count >= $2 THEN $2
                ELSE failed_login_count + 1 END,
              locked_until = CASE
                WHEN failed_login_count + 1 >= $2 THEN $3
                ELSE locked_until END
        WHERE id = $1
      RETURNING locked_until`,
      [input.userId, p.userThreshold, lockUntil],
    );
    if (rows.length > 0 && rows[0].locked_until) {
      userLocked = new Date(rows[0].locked_until).getTime() > now;
    }
  }

  const { rows: idRows } = await client.query(
    `INSERT INTO login_attempts (
        tenant_id, identifier_hash, failure_count, first_failed_at, last_failed_at, locked_until
     ) VALUES ($1, $2, 1, now(), now(), NULL)
     ON CONFLICT (tenant_id, identifier_hash) DO UPDATE SET
        failure_count = CASE
          WHEN login_attempts.last_failed_at < now() - ($4::int * interval '1 millisecond')
            THEN 1
          ELSE login_attempts.failure_count + 1 END,
        last_failed_at = now(),
        locked_until = CASE
          WHEN (CASE
                  WHEN login_attempts.last_failed_at < now() - ($4::int * interval '1 millisecond')
                    THEN 1
                  ELSE login_attempts.failure_count + 1 END) >= $3
            THEN $5
          ELSE login_attempts.locked_until END
     RETURNING locked_until`,
    [input.tenantId, identifierHash(input.identifier), p.tenantThreshold, p.windowMs, lockUntil],
  );

  const identifierLocked =
    idRows.length > 0 && idRows[0].locked_until
      ? new Date(idRows[0].locked_until).getTime() > now
      : false;

  return { userLocked, identifierLocked };
}

/**
 * Clear failure state after a successful login.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {string} tenantId
 * @param {string} identifier — email
 * @returns {Promise<void>}
 */
export async function clearFailedLogins(client, userId, tenantId, identifier) {
  await client.query(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
    [userId],
  );
  await client.query(
    'DELETE FROM login_attempts WHERE tenant_id = $1 AND identifier_hash = $2',
    [tenantId, identifierHash(identifier)],
  );
}

export { newId };
