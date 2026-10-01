// TOTP against the RFC test vectors.
//
// A hand-rolled primitive is only defensible if it is checked against the
// specification's own numbers, not against itself. RFC 4226 Appendix D
// gives HOTP values; RFC 6238 Appendix B gives TOTP at eight digits for
// the three hashes. If any of these change, the implementation is wrong.
//
// SHA1 is what authenticator apps expect. It is not a weakness here: the
// threat is a 6-digit code with a 30-second window and a server-side rate
// limit, not a long-lived key where collision resistance matters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verifyTotp,
  counterFor,
  otpauthUri,
  secondsRemaining,
} from './totp.js';

// RFC 4226 §5 uses the ASCII secret "12345678901234567890".
const RFC_SECRET_ASCII = Buffer.from('12345678901234567890');
const RFC_SECRET = base32Encode(RFC_SECRET_ASCII);

test('RFC 4226 Appendix D: HOTP values', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  expected.forEach((want, counter) => {
    assert.equal(hotp(RFC_SECRET_ASCII, counter), want, `counter ${counter}`);
  });
});

test('RFC 6238 Appendix B: TOTP with SHA-1, eight digits', () => {
  const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
  const expected = ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'];
  times.forEach((seconds, i) => {
    assert.equal(
      totp(RFC_SECRET, { atMs: seconds * 1000, digits: 8 }),
      expected[i],
      `T = ${seconds}`,
    );
  });
});

test('base32 round-trips', () => {
  for (const bytes of [
    Buffer.from('12345678901234567890'),
    Buffer.from('a'),
    Buffer.from('ab'),
    Buffer.from('abc'),
    Buffer.from('abcd'),
    Buffer.from('abcde'),
  ]) {
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('base32Decode tolerates lowercase and missing padding', () => {
  // Users retype secrets from an authenticator app by hand.
  assert.deepEqual(base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq'), RFC_SECRET_ASCII);
  assert.deepEqual(base32Decode('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'), RFC_SECRET_ASCII);
  assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ===='), RFC_SECRET_ASCII);
});

test('base32Decode rejects a character outside the alphabet', () => {
  // 0, 1, 8 and 9 are not in the RFC 4648 base32 alphabet.
  assert.throws(() => base32Decode('ABC0189'), /invalid base32/);
});

test('a generated secret is the RFC-recommended length', () => {
  // 20 bytes is what Google Authenticator and the RFC 4226 guidance expect.
  assert.equal(base32Decode(generateSecret()).length, 20);
});

test('the counter advances every 30 seconds', () => {
  assert.equal(counterFor(0), 0);
  assert.equal(counterFor(29_999), 0);
  assert.equal(counterFor(30_000), 1);
  assert.equal(counterFor(60_000), 2);
});

test('secondsRemaining counts down within the window', () => {
  assert.equal(secondsRemaining(0), 30);
  assert.equal(secondsRemaining(29_000), 1);
  assert.equal(secondsRemaining(30_000), 30);
});

test('a correct code verifies and returns its counter', () => {
  const at = 1_700_000_000_000;
  const code = totp(RFC_SECRET, { atMs: at });
  assert.equal(verifyTotp({ secret: RFC_SECRET, code, atMs: at }), counterFor(at));
});

test('one step of clock drift is tolerated either way', () => {
  const at = 1_700_000_000_000;
  // A phone whose clock is 20 seconds behind.
  const previous = totp(RFC_SECRET, { atMs: at - 20_000 });
  assert.notEqual(verifyTotp({ secret: RFC_SECRET, code: previous, atMs: at }), null);

  // And one that is 20 seconds ahead.
  const next = totp(RFC_SECRET, { atMs: at + 20_000 });
  assert.notEqual(verifyTotp({ secret: RFC_SECRET, code: next, atMs: at }), null);
});

test('two steps of drift is refused', () => {
  const at = 1_700_000_000_000;
  const stale = totp(RFC_SECRET, { atMs: at - 61_000 });
  assert.equal(verifyTotp({ secret: RFC_SECRET, code: stale, atMs: at }), null);
});

test('a wrong code is refused', () => {
  const at = 1_700_000_000_000;
  const code = totp(RFC_SECRET, { atMs: at });
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal(verifyTotp({ secret: RFC_SECRET, code: wrong, atMs: at }), null);
});

test('malformed input is refused without throwing', () => {
  const at = 1_700_000_000_000;
  for (const bad of ['', 'abcdef', '12345', '1234567', '12 45 6', null, undefined, {}, '12.34']) {
    assert.equal(
      verifyTotp({ secret: RFC_SECRET, code: bad, atMs: at }),
      null,
      `input: ${JSON.stringify(bad)}`,
    );
  }
});

test('a leading zero is preserved', () => {
  // RFC 6238 starts with 94287082 at eight digits, so the six-digit form
  // is 287082 — and the eight-digit vector exercises leading-zero
  // handling that a Number would destroy.
  const code = totp(RFC_SECRET, { atMs: 0 });
  assert.equal(code.length, 6);
  assert.match(code, /^\d{6}$/);
});

test('the otpauth URI is well formed', () => {
  const uri = otpauthUri({ secret: RFC_SECRET, account: 'admin@acme.example' });
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  assert.ok(uri.includes('issuer=Joldipabo+CRM'));
  assert.ok(uri.includes('algorithm=SHA1'));
  assert.ok(uri.includes('digits=6'));
  assert.ok(uri.includes('period=30'));
  // The label groups entries under the issuer in the app.
  assert.ok(uri.includes('Joldipabo%20CRM:'));
});

test('the otpauth URI escapes the account', () => {
  // An account containing a slash or an ampersand would otherwise break
  // the label or inject a parameter.
  const uri = otpauthUri({ secret: RFC_SECRET, account: 'a/b?x=1&y=2' });
  const [, afterScheme] = uri.split('otpauth://totp/');
  const [label, query] = afterScheme.split('?');
  assert.ok(!label.includes('/'), 'the label must not contain a path separator');
  const params = new URLSearchParams(query);
  assert.equal(params.get('issuer'), 'Joldipabo CRM', 'the injected & must not become a parameter');
});
