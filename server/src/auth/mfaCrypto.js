// Encryption for TOTP secrets at rest.
//
// WHY
// ---
// `users.mfa_secret` is a TOTP shared secret. Anyone who reads it can
// generate valid codes for that user forever, and unlike a password there
// is nothing to rotate away from a leaked copy — the secret IS the
// factor. A password hash is deliberately slow; this is the opposite case,
// where the value must be recoverable by the server but useless to anyone
// who steals the row.
//
// AES-256-GCM: authenticated, so a modified ciphertext fails to decrypt
// rather than yielding a garbage secret that would then be "verified"
// against attacker-chosen codes.
//
// KEY DERIVATION
// --------------
// One secret to manage (JWT_SECRET) rather than a second one to forget.
// The derived key is namespaced with `mfa-secret:` so it is not itself a
// valid JWT signing key, and the derivation is HKDF-SHA256, which is what
// it exists for.
//
// THIS IS NOT A KMS
// -----------------
// Rotating JWT_SECRET invalidates every stored TOTP secret, which locks
// every MFA user out. That is a real operational coupling and it is
// documented in docs/AUTH_TENANT_SECURITY_PLAN.md §12. Moving the key to
// a KMS with independent rotation is a P1 (roadmap §2.1), not something
// this file pretends to solve.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const PREFIX = 'v1';

/**
 * The 32-byte data key, derived per call so a test that rotates
 * `process.env.JWT_SECRET` sees the effect immediately (config is frozen
 * at import for everything else).
 *
 * @returns {Buffer|null} null when no secret is configured
 */
function dataKey() {
  const secret = config.jwt.secret;
  if (!secret || secret.trim() === '') return null;
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('mfa-secret:v1', 'utf8'), 32),
  );
}

/**
 * Whether secrets can be encrypted in this deployment.
 *
 * @returns {boolean}
 */
export function mfaEncryptionAvailable() {
  return dataKey() !== null;
}

/**
 * Encrypt a TOTP secret for storage.
 *
 * @param {string} plaintext the base32 TOTP secret
 * @returns {string} `v1:<iv-b64>:<tag-b64>:<ct-b64>`
 * @throws {Error} when no JWT_SECRET is configured
 */
export function encryptSecret(plaintext) {
  const key = dataKey();
  if (!key) {
    throw new Error(
      'MFA secret encryption requires JWT_SECRET.\n' +
        '  Set it before enabling MFA; see docs/ENVIRONMENT.md.',
    );
  }
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new Error('encryptSecret requires a non-empty string.');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a stored secret.
 *
 * @param {string} stored value produced by {@link encryptSecret}
 * @returns {string|null} the plaintext, or null when it cannot be read
 */
export function decryptSecret(stored) {
  if (!stored) return null;
  const key = dataKey();
  if (!key) return null;

  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // A failed auth tag means the row was modified or the key is wrong.
    // Both are "cannot read this secret" — never a partial plaintext.
    return null;
  }
}

/**
 * Whether a stored value looks like something this module produced.
 *
 * Lets the caller distinguish "no MFA configured" from "MFA configured
 * but the secret is unreadable", which are very different states for an
 * operator: the second means nobody can log in with a code.
 *
 * @param {string|null} stored
 * @returns {boolean}
 */
export function isEncryptedSecret(stored) {
  return typeof stored === 'string' && stored.split(':').length === 4 && stored.startsWith(`${PREFIX}:`);
}

/** Re-exported so tests can assert constant-time comparison is available. */
export { timingSafeEqual };
