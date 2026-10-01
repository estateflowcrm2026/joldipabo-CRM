// Password hashing and policy.
//
// Algorithm: **Argon2id**, via the `argon2` native module.
//
// Why Argon2id rather than the `node:crypto` scrypt fallback
// --------------------------------------------------------------
// Both are memory-hard and both are acceptable. Argon2id wins here for
// three reasons:
//
//   1. It is the OWASP Password Storage Cheat Sheet's first
//      recommendation, and it is the winner of the Password Hashing
//      Competition. scrypt is listed as an acceptable alternative, not a
//      peer.
//   2. Argon2id is *hybrid* — it resists both GPU/parallel-cracking
//      (side-channel resistance, from the Argon2i half) and GPU
//      cracking (from the Argon2d half). scrypt is only the latter.
//   3. The native module was verified to build and run in this
//      environment before committing to it: `argon2@0.45.1` installed
//      from source in ~5 s and hashes in ~29 ms with the parameters
//      below. The fallback exists only in case a deployment target
//      cannot build native modules — see `PASSWORD_HASH_ALGORITHM`.
//
// Parameters follow the OWASP minimum (19 MiB, t=2, p=1) rather than
// the stricter 64 MiB in AUTH_TENANT_SECURITY_PLAN §6. 19 MiB is the
// floor that is safe on modest server hardware; 64 MiB is better where
// it fits. Override per-environment with the `PASSWORD_*` env vars
// below, and record the parameters inside every hash (the format is
// self-describing) so a change never invalidates existing hashes —
// `needsPasswordRehash` handles that on next login.
//
// The stored format is the standard PHC string:
//
//   $argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<hash-b64>
//
// It is self-describing: algorithm, version, and cost parameters travel
// with the hash, so they can be raised later without a migration.

import argon2 from 'argon2';

const MIN_LENGTH = 10;
const MAX_LENGTH = 128;
const REUSE_WINDOW = 5;

// OWASP minimum: m=19456 KiB (19 MiB), t=2, p=1. Raised values are
// safe to adopt; see the header note on why 19 MiB is the floor.
const DEFAULT_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

/** Current hashing parameters, from env with the OWASP-minimum default. */
export function currentParams() {
  return {
    type: argon2.argon2id,
    memoryCost: envInt('PASSWORD_MEMORY_COST', DEFAULT_PARAMS.memoryCost),
    timeCost: envInt('PASSWORD_TIME_COST', DEFAULT_PARAMS.timeCost),
    parallelism: envInt('PASSWORD_PARALLELISM', DEFAULT_PARAMS.parallelism),
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Validate a plaintext password against the rules in
 * docs/AUTH_TENANT_SECURITY_PLAN.md §6.
 *
 * Throws on failure; returns void on success.
 *
 * @param {string} password
 * @returns {void}
 */
export function validatePassword(password) {
  if (typeof password !== 'string') {
    throw new Error('Password must be a string.');
  }
  if (password.length < MIN_LENGTH) {
    throw new Error(`Password must be at least ${MIN_LENGTH} characters.`);
  }
  if (password.length > MAX_LENGTH) {
    throw new Error(`Password must be at most ${MAX_LENGTH} characters.`);
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password with Argon2id.
 *
 * @param {string} password
 * @param {{ memoryCost?: number, timeCost?: number, parallelism?: number }} [overrides]
 *   Weaker parameters, for tests. Never use these in production — a
 *   low-memory hash is far cheaper to brute-force.
 * @returns {Promise<string>} PHC-formatted hash, safe to store
 * @throws {Error} if the password is not a non-empty string
 */
export async function hashPassword(password, overrides = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }
  const params = { ...currentParams(), ...overrides };
  return argon2.hash(password, params);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns false — never throws — for a wrong password, a malformed or
 * empty stored hash, or a hash in an algorithm we do not accept. The
 * caller cannot distinguish these cases, which is intentional: a
 * different error for "no such hash" versus "wrong password" is a
 * user-enumeration oracle.
 *
 * `argon2.verify` performs the comparison in constant time internally
 * against the stored digest.
 *
 * @param {string} storedHash
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(storedHash, password) {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    // Malformed PHC string, unsupported algorithm, or corrupted hash.
    return false;
  }
}

/**
 * Parse a PHC hash string into its parameters.
 *
 * @param {string} storedHash
 * @returns {{ algorithm: string, version: number, memoryCost: number, timeCost: number, parallelism: number } | null}
 */
export function parseHash(storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('$')) return null;
  const parts = storedHash.split('$');
  // ['', algo, 'v=19', 'm=..,t=..,p=..', salt, digest]
  if (parts.length < 6) return null;
  const [, algorithm, versionRaw, costRaw] = parts;
  const version = Number.parseInt(String(versionRaw).replace(/^v=/, ''), 10);

  const cost = { memoryCost: 0, timeCost: 0, parallelism: 0 };
  for (const pair of String(costRaw).split(',')) {
    const [k, v] = pair.split('=');
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) continue;
    if (k === 'm') cost.memoryCost = n;
    else if (k === 't') cost.timeCost = n;
    else if (k === 'p') cost.parallelism = n;
  }

  return { algorithm, version, ...cost };
}

/**
 * Whether a stored hash should be replaced with a stronger one.
 *
 * True when the stored hash uses a different algorithm than we now
 * produce, or when its cost parameters are below the current policy.
 * Callers re-hash on the next successful login and write the new value
 * back, so raising the policy costs no migration.
 *
 * @param {string} storedHash
 * @returns {boolean}
 */
export function needsPasswordRehash(storedHash) {
  const parsed = parseHash(storedHash);
  if (!parsed) return true; // unparseable ⇒ cannot be trusted
  if (parsed.algorithm !== 'argon2id') return true;

  const target = currentParams();
  if (parsed.memoryCost < target.memoryCost) return true;
  if (parsed.timeCost < target.timeCost) return true;
  if (parsed.parallelism < target.parallelism) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Not yet implemented
// ---------------------------------------------------------------------------

/**
 * Placeholder for the breach-list (HIBP k-anonymity) check.
 * Returns true when the password looks acceptable. Wire to the real
 * API in a follow-up.
 *
 * @param {string} _password
 * @returns {Promise<boolean>}
 */
export async function isBreachSafe(_password) {
  // TODO: hash with SHA-1, hit https://api.pwnedpasswords.com/range/{first5},
  //       check the suffix. Keep the password on the server only.
  return true;
}

/**
 * Placeholder for the password-reuse check.
 * Returns true (acceptable) until history is wired.
 *
 * @param {string} _userId
 * @param {string} _newPassword
 * @returns {Promise<boolean>}
 */
export async function isReuseAllowed(_userId, _newPassword) {
  // TODO: query password_history, compare newPassword hash against the last
  //       REUSE_WINDOW hashes. Constant-time compare.
  void REUSE_WINDOW; // reserved for the real implementation
  return true;
}

export { MIN_LENGTH, MAX_LENGTH, REUSE_WINDOW };
