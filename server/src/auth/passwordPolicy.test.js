// Password hashing tests.
//
// The Argon2id parameters are lowered here via the `overrides` argument
// so the suite runs in a second rather than a minute. Production
// parameters are asserted separately, so a test that only exercises the
// fast path cannot hide a misconfigured default.
//
// Run with `npm test` (src/auth/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  needsPasswordRehash,
  parseHash,
  validatePassword,
  currentParams,
  MIN_LENGTH,
  MAX_LENGTH,
} from './passwordPolicy.js';

// Minimal-cost Argon2id: same algorithm, ~64x less work. Only for tests.
const FAST = { memoryCost: 64, timeCost: 1, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';

// ---------------------------------------------------------------------------
// 1. Production parameters
// ---------------------------------------------------------------------------

test('production parameters meet the OWASP minimum', () => {
  const p = currentParams();
  assert.equal(p.memoryCost, 19_456, 'm must be at least 19456 KiB (19 MiB)');
  assert.equal(p.timeCost, 2);
  assert.equal(p.parallelism, 1);
});

test('env vars can raise the cost but not to something weaker than the floor', () => {
  // Raising is the point; a bad env value must not weaken the default.
  const saved = {
    m: process.env.PASSWORD_MEMORY_COST,
    t: process.env.PASSWORD_TIME_COST,
    p: process.env.PASSWORD_PARALLELISM,
  };
  try {
    process.env.PASSWORD_MEMORY_COST = '65536';
    assert.equal(currentParams().memoryCost, 65_536);

    process.env.PASSWORD_MEMORY_COST = 'not-a-number';
    assert.equal(currentParams().memoryCost, 19_456, 'a bad value falls back');
    process.env.PASSWORD_MEMORY_COST = '0';
    assert.equal(currentParams().memoryCost, 19_456, 'zero falls back');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Hash format
// ---------------------------------------------------------------------------

test('hashPassword produces a PHC-formatted Argon2id hash', async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  assert.match(hash, /^\$argon2id\$v=19\$/);
  assert.ok(hash.includes('m='), 'memory cost must be recorded');
  assert.ok(hash.includes('t='), 'time cost must be recorded');
  assert.ok(hash.includes('p='), 'parallelism must be recorded');
});

test('the stored hash never contains the plaintext', async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  assert.ok(!hash.includes(PASSWORD));
  assert.ok(!hash.includes('correct horse'));
});

test('hashing is salted — the same password hashes differently each time', async () => {
  const a = await hashPassword(PASSWORD, FAST);
  const b = await hashPassword(PASSWORD, FAST);
  assert.notEqual(a, b, 'a shared salt would make hashes comparable across users');
  // But both must still verify.
  assert.equal(await verifyPassword(a, PASSWORD), true);
  assert.equal(await verifyPassword(b, PASSWORD), true);
});

test('parseHash reads back the stored parameters', async () => {
  const hash = await hashPassword(PASSWORD, { ...FAST, memoryCost: 128, timeCost: 3 });
  const parsed = parseHash(hash);
  assert.equal(parsed.algorithm, 'argon2id');
  assert.equal(parsed.version, 19);
  assert.equal(parsed.memoryCost, 128);
  assert.equal(parsed.timeCost, 3);
  assert.equal(parsed.parallelism, 1);
});

test('parseHash returns null for junk', () => {
  assert.equal(parseHash(''), null);
  assert.equal(parseHash('argon2id$v=19$m=1,t=1,p=1$salt$hash'), null, 'no leading $');
  assert.equal(parseHash('$argon2id$broken'), null);
  assert.equal(parseHash(null), null);
  assert.equal(parseHash(undefined), null);
});

// ---------------------------------------------------------------------------
// 3. Verification
// ---------------------------------------------------------------------------

test('the correct password verifies', async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  assert.equal(await verifyPassword(hash, PASSWORD), true);
});

test('a wrong password does not verify', async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  assert.equal(await verifyPassword(hash, 'wrong password entirely'), false);
  assert.equal(await verifyPassword(hash, PASSWORD + 'x'), false);
  assert.equal(await verifyPassword(hash, PASSWORD.toUpperCase()), false);
  assert.equal(await verifyPassword(hash, ''), false);
});

test('unicode and long passwords round-trip', async () => {
  for (const pw of ['pässwörd-🔐-with-emoji', 'a'.repeat(MAX_LENGTH)]) {
    const hash = await hashPassword(pw, FAST);
    assert.equal(await verifyPassword(hash, pw), true, `failed for ${pw.slice(0, 12)}`);
    assert.equal(await verifyPassword(hash, `${pw}x`), false);
  }
});

// ---------------------------------------------------------------------------
// 4. Malformed input must fail closed, not throw
// ---------------------------------------------------------------------------

test('a malformed stored hash returns false rather than throwing', async () => {
  // These are exactly the values a corrupted or legacy column can hold.
  for (const bad of ['', 'argon2id:$pending', 'not-a-hash', '$', '$$$', null, undefined, 42, {}]) {
    assert.equal(await verifyPassword(bad, PASSWORD), false, `expected false for ${String(bad)}`);
  }
});

test('a valid hash of a different password is not accepted', async () => {
  const a = await hashPassword('password one here', FAST);
  const b = await hashPassword('password two here', FAST);
  assert.equal(await verifyPassword(a, 'password two here'), false);
  assert.equal(await verifyPassword(b, 'password one here'), false);
});

test('a non-string password is rejected without throwing', async () => {
  const hash = await hashPassword(PASSWORD, FAST);
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(await verifyPassword(hash, bad), false);
  }
});

test('hashPassword rejects empty and non-string input', async () => {
  await assert.rejects(() => hashPassword(''), /non-empty/);
  await assert.rejects(() => hashPassword(null), /non-empty/);
  await assert.rejects(() => hashPassword(123), /non-empty/);
});

// ---------------------------------------------------------------------------
// 5. Rehash policy
// ---------------------------------------------------------------------------

test('a current hash needs no rehash', async () => {
  // Built at exactly the current production parameters.
  const hash = await hashPassword(PASSWORD);
  assert.equal(needsPasswordRehash(hash), false);
});

test('a hash below the current policy needs a rehash', async () => {
  const weak = await hashPassword(PASSWORD, { memoryCost: 64, timeCost: 1, parallelism: 1 });
  assert.equal(needsPasswordRehash(weak), true);
});

test('an unparseable or wrong-algorithm hash needs a rehash', async () => {
  assert.equal(needsPasswordRehash('argon2id:$pending'), true);
  assert.equal(needsPasswordRehash(''), true);
  assert.equal(needsPasswordRehash(null), true);
  assert.equal(needsPasswordRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'), true);
});

// ---------------------------------------------------------------------------
// 6. Policy
// ---------------------------------------------------------------------------

test('validatePassword enforces the length bounds', () => {
  assert.doesNotThrow(() => validatePassword('a'.repeat(MIN_LENGTH)));
  assert.throws(() => validatePassword('a'.repeat(MIN_LENGTH - 1)), /at least/);
  assert.doesNotThrow(() => validatePassword('a'.repeat(MAX_LENGTH)));
  assert.throws(() => validatePassword('a'.repeat(MAX_LENGTH + 1)), /at most/);
  assert.throws(() => validatePassword(null), /must be a string/);
  assert.throws(() => validatePassword(42), /must be a string/);
});
