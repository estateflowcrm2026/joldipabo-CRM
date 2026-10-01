// MFA persistence.
//
// Every function takes a `client` so the caller controls the transaction,
// matching the other repositories. The rule learned the hard way in
// refresh() and logout() applies here: a security action that must
// survive an error needs its own committed transaction, because throwing
// from inside one rolls it back. Challenge consumption is therefore
// written as "return normally, throw afterwards" in mfaService.js.
//
// Secret storage: `mfa_secret` holds the AES-256-GCM ciphertext produced
// by mfaCrypto, never the plaintext base32. Backup codes are stored as
// SHA-256 of the normalised code — they are high-entropy and single-use,
// so a slow hash buys nothing and a fast one lets a stolen table be
// checked exhaustively.

import { createHash, randomBytes } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Roles that MUST have MFA before production launch. */
export const MFA_REQUIRED_ROLES = new Set(['admin', 'super-admin']);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

/**
 * Whether a role must have MFA.
 *
 * @param {string} roleId
 * @returns {boolean}
 */
export function roleRequiresMfa(roleId) {
  return MFA_REQUIRED_ROLES.has(String(roleId || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// Enrolment state
// ---------------------------------------------------------------------------

/**
 * Read the MFA columns for a user.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @returns {Promise<{mfaEnabled: boolean, mfaSecret: string|null, lastStep: number|null, enabledAt: Date|null}>}
 */
export async function getMfaState(client, userId) {
  const { rows } = await client.query(
    `SELECT mfa_enabled, mfa_secret, mfa_last_step, mfa_enabled_at
       FROM users WHERE id = $1`,
    [userId],
  );
  return {
    mfaEnabled: Boolean(rows[0]?.mfa_enabled),
    mfaSecret: rows[0]?.mfa_secret ?? null,
    // `mfa_last_step` is a `bigint`, and `pg` returns 64-bit integers as
    // STRINGS to avoid precision loss. Coerced here so callers can do
    // arithmetic on it. Left as a string, `lastStep + 1` concatenates
    // ("59686972" + 1 → "596869721") rather than incrementing, which is
    // how a caller ends up asking for a TOTP step that is ten thousand
    // increments away and being refused as invalid.
    //
    // Postgres-side comparisons are unaffected — `mfa_last_step < $2` is
    // evaluated by the server, where the value is numeric.
    lastStep: rows[0]?.mfa_last_step == null ? null : Number(rows[0].mfa_last_step),
    enabledAt: rows[0]?.mfa_enabled_at ?? null,
  };
}

/**
 * Store a pending (unverified) secret during setup.
 *
 * `mfa_enabled` stays false until the user proves they can generate a
 * code, so a half-finished setup cannot lock anyone out.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @param {string} encryptedSecret
 */
export async function setPendingSecret(client, userId, encryptedSecret) {
  await client.query(
    `UPDATE users SET mfa_secret = $2, mfa_enabled = false, updated_at = now()
      WHERE id = $1`,
    [userId, encryptedSecret],
  );
}

/**
 * Turn MFA on after a successful first code.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @param {number} step the counter that was accepted, for replay defence
 * @param {string[]} backupCodeHashes
 */
export async function enableMfa(client, userId, step, backupCodeHashes) {
  await client.query(
    `UPDATE users
        SET mfa_enabled = true,
            mfa_enabled_at = COALESCE(mfa_enabled_at, now()),
            mfa_last_step = $2,
            updated_at = now()
      WHERE id = $1`,
    [userId, step],
  );
  await replaceBackupCodes(client, userId, backupCodeHashes);
}

/**
 * Replace the backup codes WITHOUT touching `mfa_last_step`.
 *
 * WHY THIS IS SEPARATE
 * --------------------
 * Regeneration used to call `enableMfa(..., state.lastStep, ...)`, where
 * `state` was read BEFORE the current code was verified. So the write put
 * back the step as it was, undoing the advance the verification had just
 * made. The next TOTP code — a perfectly valid one the user would read
 * off their phone — was then rejected as `mfa-code-replayed`, because its
 * counter equalled the one just spent. Found 2026-09-28 while verifying
 * the sign-in flow: a user who regenerated their backup codes and then
 * reached for their authenticator was locked out until the window rolled.
 *
 * The step belongs to the TOTP factor alone. Backup codes never advance it,
 * so replacing them must not write it either.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @param {string[]} backupCodeHashes
 */
export async function replaceBackupCodesOnly(client, userId, backupCodeHashes, labels) {
  await replaceBackupCodes(client, userId, backupCodeHashes, labels);
}

/**
 * Turn MFA off, destroying the secret and every backup code.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 */
export async function disableMfa(client, userId) {
  await client.query(
    `UPDATE users
        SET mfa_enabled = false,
            mfa_secret = NULL,
            mfa_last_step = NULL,
            mfa_enabled_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [userId],
  );
  await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
}

/**
 * Record the highest TOTP step accepted, refusing a replay.
 *
 * The comparison is `>` and happens in SQL, so two concurrent requests
 * presenting the same code cannot both win: the second sees the row
 * already advanced and matches no rows.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @param {number} step
 * @returns {Promise<boolean>} false when the step was already used
 */
export async function consumeTotpStep(client, userId, step) {
  const { rowCount } = await client.query(
    `UPDATE users
        SET mfa_last_step = $2, mfa_last_used_at = now()
      WHERE id = $1
        AND (mfa_last_step IS NULL OR mfa_last_step < $2)`,
    [userId, step],
  );
  return rowCount === 1;
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

/**
 * Generate human-typable backup codes.
 *
 * 10 codes of 10 characters in two groups, from a 32-character alphabet
 * with the visually ambiguous characters removed. Entropy is 50 bits per
 * code, which is ample for single-use codes behind a rate limit.
 *
 * @param {number} [count]
 * @returns {{code: string, hash: string}[]} the plaintext is returned
 *          exactly once, at generation; only `hash` is persisted
 */
export function generateBackupCodes(count = 10) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(10);
    let raw = '';
    for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
    // The code is DISPLAYED with a hyphen, but HASHED normalised — so a
    // user who retypes it without the hyphen still matches. Hashing the
    // displayed form instead would mean `hashBackupCode(code)` (which
    // normalises) never equals the stored hash, and every backup code
    // would silently fail to verify.
    out.push({ code: `${raw.slice(0, 5)}-${raw.slice(5)}`, hash: hashBackupCode(raw) });
  }
  return out;
}

/**
 * Normalise a user-typed backup code.
 *
 * Case and separators are not significant: users retype these from
 * paper. Uppercasing and stripping non-alphanumerics means `abcd-efgh`
 * and `ABCDEFGH` are the same code.
 *
 * @param {string} code
 * @returns {string}
 */
export function normaliseBackupCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** @param {string} code @returns {string} */
export function hashBackupCode(code) {
  return sha256(normaliseBackupCode(code));
}

/**
 * Replace every backup code for a user.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @param {string[]} hashes
 * @param {string[]} [labels]
 */
export async function replaceBackupCodes(client, userId, hashes, labels = []) {
  await client.query('DELETE FROM mfa_backup_codes WHERE user_id = $1', [userId]);
  for (let i = 0; i < hashes.length; i += 1) {
    await client.query(
      `INSERT INTO mfa_backup_codes (id, user_id, code_hash, label)
       VALUES ($1, $2, $3, $4)`,
      [`mbc_${randomBytes(8).toString('hex')}`, userId, hashes[i], labels[i] ?? `${i + 1}`],
    );
  }
}

/**
 * Spend a backup code, atomically.
 *
 * The `used_at IS NULL` predicate in the UPDATE is the single-use
 * guarantee: two concurrent uses of the same code cannot both take it.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @param {string} code
 * @returns {Promise<{ok: boolean, remaining: number}>}
 */
export async function consumeBackupCode(client, userId, code) {
  const hash = hashBackupCode(code);
  const { rowCount } = await client.query(
    `UPDATE mfa_backup_codes
        SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hash],
  );
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return { ok: rowCount === 1, remaining: rows[0].n };
}

/**
 * How many unused backup codes remain.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function countUnusedBackupCodes(client, userId) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

/** @type {number} seconds a challenge stays valid */
export const CHALLENGE_TTL_SECONDS = 300;

/**
 * Mint a challenge token. The plaintext is returned to the client; only
 * its hash is stored.
 *
 * @returns {{token: string, id: string, expiresAt: Date}}
 */
export function newChallengeToken() {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    id: `mfc_${randomBytes(8).toString('hex')}`,
    hash: sha256(token),
  };
}

/**
 * Persist a challenge.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {object} input
 * @returns {Promise<{id: string, expiresAt: Date}>}
 */
export async function createChallenge(client, { id, hash, userId, tenantId, ip, userAgent, ttlSeconds = CHALLENGE_TTL_SECONDS }) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await client.query(
    `INSERT INTO mfa_challenges (id, user_id, tenant_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, userId, tenantId, hash, ip ?? null, userAgent ?? null, expiresAt],
  );
  return { id, expiresAt };
}

/**
 * Look up a live challenge by token.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} token
 * @returns {Promise<{id: string, userId: string, tenantId: string, attempts: number, maxAttempts: number}|null>}
 */
export async function findChallenge(client, token) {
  const { rows } = await client.query(
    `SELECT id, user_id, tenant_id, attempts, max_attempts
       FROM mfa_challenges
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    userId: rows[0].user_id,
    tenantId: rows[0].tenant_id,
    attempts: rows[0].attempts,
    maxAttempts: rows[0].max_attempts,
  };
}

/**
 * Count a failed attempt and report whether the challenge is now spent.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} challengeId
 * @returns {Promise<{exhausted: boolean, gone: boolean}>}
 *   `gone` means the row no longer exists — already consumed, or deleted.
 *   Reported separately from `exhausted` because the two mean different
 *   things: `gone` is "start over", `exhausted` is "you burned your
 *   attempts". Collapsing them turns a client that raced a completed
 *   challenge into a "too many codes" error it cannot act on.
 */
export async function recordChallengeFailure(client, challengeId) {
  const { rows } = await client.query(
    `UPDATE mfa_challenges
        SET attempts = attempts + 1
      WHERE id = $1
      RETURNING attempts, max_attempts`,
    [challengeId],
  );
  if (rows.length === 0) return { exhausted: false, gone: true };
  return { exhausted: rows[0].attempts >= rows[0].max_attempts, gone: false };
}

/**
 * Mark a challenge consumed.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @param {string} challengeId
 */
export async function consumeChallenge(client, challengeId) {
  await client.query('UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1', [challengeId]);
}

/**
 * Delete challenges that have expired or been consumed.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} client
 * @returns {Promise<number>} rows removed
 */
export async function pruneChallenges(client) {
  const { rowCount } = await client.query(
    `DELETE FROM mfa_challenges
      WHERE expires_at < now() - interval '1 day' OR consumed_at IS NOT NULL`,
  );
  return rowCount ?? 0;
}
