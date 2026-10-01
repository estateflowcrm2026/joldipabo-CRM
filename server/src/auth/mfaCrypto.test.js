// Encryption of TOTP secrets at rest.
//
// The property that matters is that a stolen row is not a valid factor:
// without the key, `mfa_secret` must be useless. The tamper cases matter
// just as much — a modified ciphertext that decrypted to *something*
// would be verified against attacker-chosen codes.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-in-production-0000';

const { encryptSecret, decryptSecret, isEncryptedSecret, mfaEncryptionAvailable } =
  await import('./mfaCrypto.js');

before(() => {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-only-secret-not-used-in-production-0000';
});

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('a secret round-trips', () => {
  assert.equal(decryptSecret(encryptSecret(SECRET)), SECRET);
});

test('the ciphertext is not the plaintext', () => {
  const stored = encryptSecret(SECRET);
  assert.notEqual(stored, SECRET);
  assert.ok(!stored.includes(SECRET), 'the base32 secret must not appear verbatim');
});

test('the stored form is recognisable as encrypted', () => {
  assert.equal(isEncryptedSecret(encryptSecret(SECRET)), true);
  assert.equal(isEncryptedSecret('GEZDGNBVGY3TQOJQ'), false, 'a bare secret is not encrypted');
  assert.equal(isEncryptedSecret(null), false);
});

test('the ciphertext differs every time', () => {
  // A fresh IV per encryption. Two rows with the same secret must not
  // share a ciphertext, or an attacker could tell which users share a
  // TOTP secret.
  assert.notEqual(encryptSecret(SECRET), encryptSecret(SECRET));
});

test('a modified ciphertext does not decrypt', () => {
  const stored = encryptSecret(SECRET);
  const parts = stored.split(':');
  // Flip a byte in the ciphertext body.
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');
  assert.equal(decryptSecret(tampered), null, 'AES-GCM must reject a modified body');
});

test('a modified auth tag does not decrypt', () => {
  const stored = encryptSecret(SECRET);
  const parts = stored.split(':');
  const tag = Buffer.from(parts[2], 'base64');
  tag[0] ^= 0xff;
  const tampered = [parts[0], parts[1], tag.toString('base64'), parts[3]].join(':');
  assert.equal(decryptSecret(tampered), null);
});

test('a malformed value returns null rather than throwing', () => {
  for (const bad of ['', 'nope', 'v1:a:b', 'v2:a:b:c', '::::', null, undefined, 'v1:!!!:!!!:!!!']) {
    assert.equal(decryptSecret(bad), null, `input: ${JSON.stringify(bad)}`);
  }
});

test('a secret encrypted under a different key is unreadable', async () => {
  // Simulates JWT_SECRET rotation. The result is a locked-out user, which
  // is why rotation is documented as an operational step rather than a
  // routine change — see docs/AUTH_TENANT_SECURITY_PLAN.md §12.
  const { createCipheriv, hkdfSync, randomBytes } = await import('node:crypto');
  const otherKey = Buffer.from(
    hkdfSync('sha256', Buffer.from('a-different-secret', 'utf8'), Buffer.alloc(0), Buffer.from('mfa-secret:v1', 'utf8'), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', otherKey, iv);
  const ct = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()]);
  const forged = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  assert.equal(decryptSecret(forged), null);
});

test('encryption is available when a secret is configured', () => {
  assert.equal(mfaEncryptionAvailable(), true);
});

test('encrypting an empty value is refused', () => {
  // An empty secret would be a factor nobody can satisfy.
  assert.throws(() => encryptSecret(''), /non-empty/);
  assert.throws(() => encryptSecret(null), /non-empty/);
});
