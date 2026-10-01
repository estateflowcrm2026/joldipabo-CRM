// Access-token signing and verification tests.
//
// These are the tests that were missing when the token service was a
// placeholder. Until 2026-09-24 `verifyAccessToken` base64-decoded the
// payload and checked nothing else, so a token with an empty signature
// was accepted — reproduced as:
//     header.payload.  →  {sub:'u-super', tid:'org_acme', exp:future}
// Every test below is a case that used to pass a forged token through.
//
// Run with `npm test` (src/auth/*.test.js is in the glob, and
// .env.test supplies JWT_SECRET).

import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import { config } from '../config/index.js';
import {
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  hashRefreshToken,
  resolveSigningKey,
  isDevFallbackAllowed,
  hasUsableSigningKey,
} from './tokenService.js';

const SECRET = process.env.JWT_SECRET;
const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DEV_AUTH_ENABLED: process.env.DEV_AUTH_ENABLED,
  JWT_SECRET: process.env.JWT_SECRET,
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Build a token the way an attacker would: arbitrary claims + our own key. */
function forge(claims, key, header = { alg: 'HS256', typ: 'JWT' }) {
  const h = b64url(header);
  const p = b64url(claims);
  const input = `${h}.${p}`;
  return `${input}.${createHmac('sha256', key).update(input, 'ascii').digest('base64url')}`;
}

const validClaims = (over = {}) => ({
  sub: 'u-asha',
  tid: 'org_acme',
  rid: 'field-executive',
  sid: 'rs_123',
  jti: 'at_test',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  iss: config.jwt.issuer,
  aud: config.jwt.audience,
  ...over,
});

before(() => {
  assert.ok(SECRET, 'JWT_SECRET must be set — run via `npm test`, which loads .env.test');
});

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  delete process.env.DEV_AUTH_ENABLED;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// 1. The headline regression: an unsigned token must never verify
// ---------------------------------------------------------------------------

test('an unsigned header.payload. token is refused', () => {
  // The exact forgery used against the pre-2026-09-24 implementation.
  const forged = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(validClaims())}.`;
  assert.throws(() => verifyAccessToken(forged), /signature is missing/i);
});

test('an unsigned token is refused even with super-admin claims', () => {
  const forged = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(
    validClaims({ sub: 'u-super', rid: 'super-admin' }),
  )}.`;
  assert.throws(() => verifyAccessToken(forged), /signature is missing/i);
});

test('an empty signature does not match an empty expected signature', () => {
  // Guards the degenerate case where both sides are '' and a naive
  // comparison would call that a match.
  const forged = `a.${b64url(validClaims())}.`;
  assert.throws(() => verifyAccessToken(forged));
});

// ---------------------------------------------------------------------------
// 2. Wrong secret
// ---------------------------------------------------------------------------

test('a token signed with the wrong secret is refused', () => {
  const forged = forge(validClaims(), 'attacker-guessed-key');
  assert.throws(() => verifyAccessToken(forged), /signature is invalid/i);
});

test('a token signed with a near-miss secret is refused', () => {
  const near = `${SECRET.slice(0, -1)}X`;
  const forged = forge(validClaims(), near);
  assert.throws(() => verifyAccessToken(forged), /signature is invalid/i);
});

test('rotating the secret invalidates previously issued tokens', () => {
  const { token } = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' });
  assert.doesNotThrow(() => verifyAccessToken(token));

  process.env.JWT_SECRET = randomBytes(48).toString('base64url');
  assert.throws(() => verifyAccessToken(token), /signature is invalid/i);
});

// ---------------------------------------------------------------------------
// 3. Expiry
// ---------------------------------------------------------------------------

test('an expired token is refused', () => {
  const expired = forge(
    validClaims({ iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }),
    SECRET,
  );
  assert.throws(() => verifyAccessToken(expired), /expired/i);
});

test('a token at exactly its expiry is refused', () => {
  const now = Math.floor(Date.now() / 1000);
  const atBoundary = forge(validClaims({ iat: now - 900, exp: now }), SECRET);
  assert.throws(() => verifyAccessToken(atBoundary), /expired/i);
});

test('the expiry check honours an injected clock', () => {
  const { token } = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' });
  const future = Math.floor(Date.now() / 1000) + config.jwt.accessTtlSeconds + 60;
  assert.throws(() => verifyAccessToken(token, { now: future }), /expired/i);
});

test('a token issued far in the future is refused', () => {
  const now = Math.floor(Date.now() / 1000);
  const future = forge(validClaims({ iat: now + 7200, exp: now + 8100 }), SECRET);
  assert.throws(() => verifyAccessToken(future), /not yet valid/i);
});

test('small clock skew is tolerated', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewed = forge(validClaims({ iat: now + 30, exp: now + 930 }), SECRET);
  assert.doesNotThrow(() => verifyAccessToken(skewed));
});

// ---------------------------------------------------------------------------
// 4. Issuer and audience
// ---------------------------------------------------------------------------

test('a token with the wrong issuer is refused', () => {
  const forged = forge(validClaims({ iss: 'some-other-service' }), SECRET);
  assert.throws(() => verifyAccessToken(forged), /issuer/i);
});

test('a token with the wrong audience is refused', () => {
  const forged = forge(validClaims({ aud: 'another-client' }), SECRET);
  assert.throws(() => verifyAccessToken(forged), /audience/i);
});

test('issuer and audience are enforced before expiry', () => {
  // Order matters only for which message a caller sees; both refuse.
  const forged = forge(validClaims({ iss: 'x', exp: 1 }), SECRET);
  assert.throws(() => verifyAccessToken(forged));
});

// ---------------------------------------------------------------------------
// 5. Structural validity
// ---------------------------------------------------------------------------

test('required claims must be present', () => {
  const noSub = forge({ ...validClaims(), sub: undefined }, SECRET);
  assert.throws(() => verifyAccessToken(noSub), /missing sub or tid/i);

  const noTid = forge({ ...validClaims(), tid: 42 }, SECRET);
  assert.throws(() => verifyAccessToken(noTid), /missing sub or tid/i);
});

test('malformed input is refused', () => {
  assert.throws(() => verifyAccessToken(''), /empty/i);
  assert.throws(() => verifyAccessToken('not-a-token'), /malformed/i);
  assert.throws(() => verifyAccessToken('only.two'), /malformed/i);
  assert.throws(() => verifyAccessToken('a.b.c.d'), /malformed/i);
  assert.throws(() => verifyAccessToken(null), /empty/i);
  assert.throws(() => verifyAccessToken(123), /empty/i);
});

test('a validly signed token with a non-JSON payload is refused', () => {
  const h = b64url({ alg: 'HS256', typ: 'JWT' });
  const p = Buffer.from('not json at all').toString('base64url');
  const input = `${h}.${p}`;
  const sig = createHmac('sha256', SECRET).update(input, 'ascii').digest('base64url');
  assert.throws(() => verifyAccessToken(`${input}.${sig}`), /not valid JSON/i);
});

// ---------------------------------------------------------------------------
// 6. Round-trip and claim shape
// ---------------------------------------------------------------------------

test('a freshly issued token verifies and round-trips its claims', () => {
  const issued = issueAccessToken({
    sub: 'u-asha',
    tid: 'org_acme',
    rid: 'field-executive',
    sid: 'rs_abc',
  });
  const claims = verifyAccessToken(issued.token);
  assert.equal(claims.sub, 'u-asha');
  assert.equal(claims.tid, 'org_acme');
  assert.equal(claims.rid, 'field-executive');
  assert.equal(claims.sid, 'rs_abc');
  assert.equal(claims.iss, config.jwt.issuer);
  assert.equal(claims.aud, config.jwt.audience);
  assert.equal(issued.claims.jti, claims.jti);
  assert.equal(issued.expiresIn, config.jwt.accessTtlSeconds);
});

test('each issued token gets a unique jti', () => {
  const a = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' });
  const b = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' });
  assert.notEqual(a.jti, b.jti);
  assert.match(a.jti, /^at_[0-9a-f]{24}$/);
});

test('issuing requires both sub and tid', () => {
  assert.throws(() => issueAccessToken({ tid: 'org_acme' }), /sub/i);
  assert.throws(() => issueAccessToken({ sub: 'u-asha' }), /tid/i);
});

test('rid and sid default to null when not supplied', () => {
  const { claims } = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' });
  assert.equal(claims.rid, null);
  assert.equal(claims.sid, null);
});

// ---------------------------------------------------------------------------
// 7. Signing key resolution
// ---------------------------------------------------------------------------

test('the configured secret is used when present', () => {
  assert.equal(resolveSigningKey(), SECRET);
});

test('the dev fallback is refused in production', () => {
  delete process.env.JWT_SECRET;
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.NODE_ENV = 'production';
  assert.throws(() => resolveSigningKey(), /JWT_SECRET is not set/);
  assert.equal(isDevFallbackAllowed(), false);
});

test('the dev fallback is available in dev with the flag on', () => {
  delete process.env.JWT_SECRET;
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  assert.equal(isDevFallbackAllowed(), true);
  assert.equal(resolveSigningKey(), config.jwt.devFallbackSecret);
});

test('no fallback at all without the dev flag', () => {
  delete process.env.JWT_SECRET;
  delete process.env.DEV_AUTH_ENABLED;
  process.env.NODE_ENV = 'development';
  assert.throws(() => resolveSigningKey(), /not available/);
  assert.equal(hasUsableSigningKey(), false);
});

test('a token signed with the dev fallback fails once a real secret is set', () => {
  delete process.env.JWT_SECRET;
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  const { token } = issueAccessToken({ sub: 'u-asha', tid: 'org_acme' });
  assert.doesNotThrow(() => verifyAccessToken(token));

  process.env.JWT_SECRET = SECRET;
  assert.throws(() => verifyAccessToken(token), /signature is invalid/i);
});

// ---------------------------------------------------------------------------
// 8. Refresh tokens are unchanged
// ---------------------------------------------------------------------------

test('refresh tokens are opaque, random, and stored hashed', () => {
  const a = issueRefreshToken();
  const b = issueRefreshToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, hashRefreshToken(a.token));
  assert.notEqual(a.token, a.tokenHash, 'the plaintext must not be the stored value');
  assert.match(a.tokenHash, /^[0-9a-f]{64}$/);
  assert.ok(new Date(a.expiresAt) > new Date());
});

test('hashRefreshToken is deterministic and idempotent', () => {
  assert.equal(hashRefreshToken('abc'), hashRefreshToken('abc'));
});
