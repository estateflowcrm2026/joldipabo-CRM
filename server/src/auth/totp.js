// TOTP (RFC 6238) — time-based one-time passwords.
//
// Standards-compatible so ordinary authenticator apps work: HMAC-SHA1,
// 6 digits, 30-second step, with a tolerance of one step either side to
// tolerate clock drift between the server and the phone.
//
// Implemented on node:crypto rather than a dependency. The algorithm is
// about 30 lines of well-specified maths (RFC 4226 §5 + RFC 6238), and
// every TOTP package would need node:crypto underneath anyway. The risk
// of a hand-rolled primitive is mitigated by the test vectors in
// totp.test.js, which come from RFC 6238 Appendix B.
//
// SECURITY NOTES
// --------------
// * Verification is CONSTANT TIME with respect to the code. A plain
//   `===` on a 6-digit value leaks the prefix through timing, and
//   `parseInt` differences leak it through the number of leading zeros.
//   Everything is compared as fixed-width strings and the final compare
//   is `timingSafeEqual`.
// * The window is checked outward from the current step, and every
//   candidate step in range is a candidate for acceptance — including
//   *earlier* ones. An implementation that only ever accepts the newest
//   step is subtly broken, because a code generated 29 seconds ago is
//   still valid on the next one. Callers must persist the accepted
//   counter to prevent replay; see `mfaService.js`.
// * A secret is base32. Lowercase and missing padding are tolerated,
//   because authenticator apps display secrets in every casing.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4226 / RFC 6238 defaults. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = 'sha1';
/** Steps of drift tolerated either side of now. */
export const TOTP_WINDOW = 1;

/** The label an authenticator app shows. */
export const TOTP_ISSUER = 'Joldipabo CRM';

/**
 * Encode bytes as RFC 4648 base32, no padding.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string}
 */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decode RFC 4648 base32. Tolerates lowercase, spaces and missing
 * padding, because secrets get retyped by hand from an authenticator app.
 *
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A new shared secret.
 *
 * 20 bytes is the RFC 4226 recommendation and what Google Authenticator
 * and friends expect. 32 bytes is also legal but some older apps reject it.
 *
 * @returns {string} base32
 */
export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

/**
 * The TOTP counter for a point in time.
 *
 * @param {number} [atMs]
 * @param {number} [period]
 * @returns {number}
 */
export function counterFor(atMs = Date.now(), period = TOTP_PERIOD_SECONDS) {
  return Math.floor(atMs / 1000 / period);
}

/**
 * HOTP for one counter value (RFC 4226).
 *
 * @param {string|Buffer} secret base32 or raw bytes
 * @param {number} counter
 * @param {number} [digits]
 * @returns {string} zero-padded to `digits`
 */
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  // 8-byte big-endian counter.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(buf).digest();

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  // `toString().padStart` rather than `% 1e6`: the latter yields a Number
  // and loses the leading zeros that the code is defined to have.
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * The code for a point in time.
 *
 * @param {string|Buffer} secret
 * @param {object} [opts]
 * @param {number} [opts.atMs]
 * @param {number} [opts.period]
 * @param {number} [opts.digits]
 * @returns {string}
 */
export function totp(secret, { atMs = Date.now(), period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = {}) {
  return hotp(secret, counterFor(atMs, period), digits);
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label is `Issuer:account`, which is what the spec prescribes and
 * what makes the entry group under the issuer in the app's UI. The secret
 * is the ONLY sensitive value here; the URI is shown once, at setup, and
 * the secret in it is stored encrypted.
 *
 * @param {object} input
 * @param {string} input.secret
 * @param {string} input.account  usually the email
 * @param {string} [input.issuer]
 * @returns {string}
 */
export function otpauthUri({ secret, account, issuer = TOTP_ISSUER }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Verify a submitted code.
 *
 * Returns the counter that matched, because the caller must persist it to
 * stop a replay. `null` means no code in the window matched.
 *
 * @param {object} input
 * @param {string} input.secret
 * @param {string} input.code
 * @param {object} [input.opts]
 * @param {number} [input.opts.atMs]
 * @param {number} [input.opts.period]
 * @param {number} [input.opts.digits]
 * @param {number} [input.opts.window]
 * @returns {number|null} the accepted counter
 */
export function verifyTotp({ secret, code, ...opts }) {
  const { window = TOTP_WINDOW, atMs = Date.now(), period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = opts;
  if (!secret) return null;
  // A submitted code is digits, or it is not a code. Rejecting here rather
  // than letting it fall through keeps the timing uniform.
  const submitted = String(code ?? '').trim();
  if (!/^\d+$/.test(submitted) || submitted.length !== digits) return null;

  const current = counterFor(atMs, period);

  // Newest first, so the most likely candidate is checked first. All
  // candidates are still checked: an attacker should not learn which
  // step matched from timing, and a code generated in the previous window
  // is legitimately still valid now.
  for (let delta = 0; delta <= window; delta += 1) {
    for (const candidate of delta === 0 ? [current] : [current - delta, current + delta]) {
      if (candidate < 0) continue;
      const expected = hotp(secret, candidate, digits);
      // Fixed-width comparison. `timingSafeEqual` throws on a length
      // mismatch, but both sides are `digits` long by construction.
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Seconds until the current code expires. Used by the UI to show a
 * countdown rather than letting a user type a code that just rolled over.
 *
 * @param {number} [atMs]
 * @param {number} [period]
 * @returns {number}
 */
export function secondsRemaining(atMs = Date.now(), period = TOTP_PERIOD_SECONDS) {
  return period - Math.floor((atMs / 1000) % period);
}
