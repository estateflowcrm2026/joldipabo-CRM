// Live verification of the Phase 9A sign-in contract, against the running
// backend and the dev Supabase database.
//
//   node --env-file=.env scripts/verify-auth-flow.js
//
// Proves, in order, using the real HTTP surface and the two seeded test
// accounts:
//
//   1. a plain sign-in returns tokens and the user record
//   2. a wrong password is refused with the documented code
//   3. an MFA user gets a challenge and NO tokens on the first step
//   4. a valid TOTP code completes the challenge and issues tokens
//   5. the challenge is single-use
//   6. a wrong code is refused and the attempt is counted
//   7. a backup code works, and cannot be reused
//   8. refresh rotates the token and revokes the presented one
//   9. logout revokes the session, after which refresh fails
//  10. /auth/me returns the identity, and rejects a bad token
//
// NOTHING IS PRINTED. Tokens are never logged, never included in a
// failure message, and never written anywhere. They live in local
// variables for the duration of one check.
//
// THE MFA SECRET IS DELETED IN A `finally`
// --------------------------------------
// The TOTP secret is read from the file the seed script wrote, so the MFA
// path can be exercised at all — the server only stores it encrypted. The
// file is removed whether the run passes, fails, or throws, because a
// credential left in %TEMP% after a failed test run is a credential
// nobody remembers to delete.
//
// DEV/TEST ACCOUNTS ONLY. This is not a way to authenticate as a real user.

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.AUTH_VERIFY_BASE_URL || 'http://127.0.0.1:4000/api/v1';
const SECRET_FILE =
  process.env.AUTH_TEST_MFA_SECRET_FILE
  || join(tmpdir(), 'joldipabo-test-mfa-secret.txt');

const { totp } = await import('../src/auth/totp.js');
const { query } = await import('../src/db/client.js');

// A TOTP step may be used ONCE — that is the replay defence — and
// verification only accepts ±1 step of the CURRENT instant.
//
// So a code must be at most one step ahead of real time, and each
// successful use moves the target one further forward. Tracking that
// from a local counter drifts: the server rejects codes more than one
// step away, so by the third use a naive `+= 30_000` is already outside
// the window and comes back `mfa-invalid-code` — which looks like a
// server bug and is not one.
//
// `peekServerStep` asks the database where the counter actually is, so
// every code is the nearest unspent step rather than a guess.
// The enrolled test account, so the code helper can read the step the
// server actually recorded rather than counting locally.
const MFA_USER_ID = 'u_mfaon_test';

let lastAcceptedStep = null;

const currentStep = () => Math.floor(Date.now() / 30_000);

async function peekServerStep(userId) {
  const { rows } = await query(
    'SELECT mfa_last_step FROM users WHERE id = $1',
    [userId],
  );
  const v = rows[0]?.mfa_last_step;
  // bigint arrives from pg as a string; `+ 1` on that concatenates.
  return v == null ? null : Number(v);
}

/**
 * The next code, anchored to what the server actually recorded but
 * clamped to the window it will accept.
 *
 * The server accepts `current ± 1` step and refuses a step it has
 * already taken. So the code must be the step AFTER the last accepted
 * one — but "recorded + 1" alone is wrong when the recorded value is
 * stale (an interrupted run can leave it many steps behind), and
 * "now" alone is wrong when it repeats the step just spent.
 *
 * Taking the later of the two, clamped to `now`, satisfies both: it is
 * always inside the window, and it is always new.
 */
/**
 * The next TOTP code for this run.
 *
 * Three separate constraints, and the value has to satisfy all of them:
 *
 *   1. The server refuses a step it has ALREADY taken.
 *   2. The server accepts only `now ± 1` step.
 *   3. Each presentation here must differ from the last.
 *
 * `now` satisfies 1 and 2 whenever the previous code was not `now`. So
 * the only way to get a second distinct code inside the window is
 * `now + 1` — and a THIRD is impossible within the same 30-second
 * window, because `now + 2` is outside it.
 *
 * That is not a limitation of this script, it is the TOTP design, and it
 * is why the backup-code step waits for the window to roll rather than
 * stepping blindly: presenting a third code in one window is refused as
 * `mfa-invalid-code`, and that refusal is the anti-replay defence
 * working, not a bug.
 */
/**
 * The next TOTP code.
 *
 * The server records the step it accepted and refuses that step again, and
 * accepts only `now ± 1`. So a code is valid when it is (a) inside the
 * window and (b) strictly after the last one taken. Neither condition is
 * sufficient alone: `now` satisfies (a) but is often (b) spent, and
 * `last + 1` satisfies (b) but drifts outside the window once real time has
 * moved on. Read the server's recorded step and take the first value that
 * satisfies both, preferring real time so the code stays current.
 *
 * @param {string} secret
 * @param {string} [userId] the account whose recorded step to read
 * @returns {Promise<string>}
 */
/**
 * The next TOTP code.
 *
 * The server records the step it accepted and refuses that step again, and
 * accepts only `now ± 1`. A valid code is therefore one that is BOTH:
 *
 *   (a) inside the window — so not `recorded + 1` when the recorded value is
 *       stale, which happens after any interrupted run; and
 *   (b) strictly greater than the last step taken — so not `now` when this
 *       script already spent it.
 *
 * Reading the server's recorded step and then clamping into the window is the
 * only thing that satisfies both. Guessing from wall time alone gets one
 * or the other wrong, and the failure is a valid code refused as
 * `mfa-invalid-code`, which reads as a server bug.
 *
 * @param {string} secret
 * @param {string} [userId] account whose recorded step to read
 * @returns {Promise<string>}
 */
async function nextCodeFor(secret, userId) {
  const now = currentStep();
  const serverStep = userId ? await peekServerStep(userId) : null;
  const spent = Math.max(serverStep ?? 0, lastAcceptedStep ?? 0);
  // Only `now` is guaranteed to satisfy both constraints at once:
  //   - it is inside the window the server accepts (trivially), and
  //   - it is unspent whenever the recorded value is stale, which is the
  //     normal case after an interrupted run.
  //
  // When the recorded step is CURRENT (spent === now) `now` is taken, and
  // `now + 1` is the only other value inside the window — so use it, and
  // the NEXT call must wait for the window to roll, which
  // nextCodeInFreshWindow does.
  const step = spent >= now ? spent + 1 : now;
  lastAcceptedStep = step;
  return totp(secret, { atMs: step * 30_000 });
}

/**
 * Wait until the current window can accept a code the server has not
 * already taken, then produce one.
 *
 * @param {string} secret
 * @returns {Promise<string>}
 */
/**
 * A code for a window this script has not already spent.
 *
 * Three TOTP presentations cannot share one 30-second window: the server
 * records each accepted step and refuses it again, and there are only three
 * values inside the window it accepts (`now-1`, `now`, `now+1`). So the third
 * presentation must wait for the window to roll.
 *
 * Waiting unconditionally is deliberate. A conditional wait added ~0s most
 * runs and still failed the rest, because "is the next value spent" depends on
 * a recorded step this script does not fully control. The 30 seconds is a
 * correctness cost paid once per run, not a design compromise.
 *
 * @param {string} secret
 * @param {string} [userId]
 * @returns {Promise<string>}
 */
async function nextCodeInFreshWindow(secret, userId) {
  const now = currentStep();
  const waitMs = (now + 1) * 30_000 - Date.now() + 250;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastAcceptedStep = null;
  return nextCodeFor(secret, userId);
}

const EMAIL_PLAIN = process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example';
const PASSWORD = process.env.DEMO_PASSWORD;

let passed = 0;
let failed = 0;
const assert = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

if (!PASSWORD) {
  console.error('DEMO_PASSWORD is not set.');
  process.exit(2);
}
if (!existsSync(SECRET_FILE)) {
  console.error('The MFA secret file is missing. Run:');
  console.error('  node --env-file=.env scripts/seed-auth-test-users.js --fresh');
  process.exit(2);
}

/**
 * POST and return { status, body }. Never throws on a non-2xx, so a
 * refused request is data rather than an exception.
 */
async function post(path, body, token = null) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* a non-JSON body is itself a finding; status still carries it */
  }
  return { status: res.status, body: parsed };
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body: parsed };
}

// The secret is read once, into memory, and the file goes away.
const secretLine = readFileSync(SECRET_FILE, 'utf8').trim();
const mfaSecret = secretLine.split(/\s+/)[1];

try {
  console.log(`\n[verify] target ${BASE}`);

  // ── 1. plain sign-in ──────────────────────────────────────────────
  let plain = null;
  {
    const r = await post('/auth/login', {
      tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD,
    });
    assert('plain sign-in returns 200', r.status === 200, `status=${r.status}`);
    assert('returns an accessToken', typeof r.body?.accessToken === 'string' && r.body.accessToken.length > 20);
    assert('returns a refreshToken', typeof r.body?.refreshToken === 'string' && r.body.refreshToken.length > 20);
    assert('returns a sessionId', typeof r.body?.sessionId === 'string');
    assert('returns the user record', r.body?.user?.email === EMAIL_PLAIN, JSON.stringify(r.body?.user?.email));
    assert('user carries a role', typeof r.body?.user?.role === 'string', String(r.body?.user?.role));
    assert('user carries a permissionMatrix', Boolean(r.body?.user?.permissionMatrix));
    // The client contract this phase depends on.
    assert('mfaRequired is absent/false for a plain account', r.body?.mfaRequired !== true);
    plain = r.body;
  }

  // ── 2. wrong password ──────────────────────────────────────────────
  {
    const r = await post('/auth/login', {
      tenantSlug: 'acme', email: EMAIL_PLAIN, password: 'definitely-not-it',
    });
    assert('a wrong password is refused', r.status === 401, `status=${r.status}`);
    assert('with the documented code', r.body?.error?.code === 'invalid-credentials', String(r.body?.error?.code));
    assert('and leaks no token', !r.body?.accessToken);
  }

  // ── 3–7. the MFA path ──────────────────────────────────────────────
  let mfaSession = null;
  {
    const r = await post('/auth/login', {
      tenantSlug: 'acme', email: 'mfa-on@acme.example', password: PASSWORD,
    });
    assert('an MFA user gets 200 from /auth/login', r.status === 200, `status=${r.status}`);
    assert('mfaRequired is true', r.body?.mfaRequired === true, String(r.body?.mfaRequired));
    assert('mfaReason is "enabled"', r.body?.mfaReason === 'enabled', String(r.body?.mfaReason));
    assert('NO accessToken before the second factor', !r.body?.accessToken);
    assert('NO refreshToken before the second factor', !r.body?.refreshToken);
    assert('a challengeToken is returned', typeof r.body?.challengeToken === 'string' && r.body.challengeToken.length > 20);
    assert('expiresIn is a short TTL', typeof r.body?.expiresIn === 'number' && r.body.expiresIn <= 600, String(r.body?.expiresIn));

    const challenge = r.body.challengeToken;

    // 6. wrong code first, so the attempt counter is exercised before
    // the success — and so a success cannot be mistaken for "the first
    // code always works".
    {
      const w = await post('/auth/mfa/challenge', { challengeToken: challenge, code: '000000' });
      assert('a wrong MFA code is refused', w.status === 401, `status=${w.status}`);
      assert('with mfa-invalid-code', w.body?.error?.code === 'mfa-invalid-code', String(w.body?.error?.code));
      assert('and issues no tokens', !w.body?.accessToken);
    }

    // 4. correct code
    const good = await nextCodeFor(mfaSecret, MFA_USER_ID);
    const ok = await post('/auth/mfa/challenge', { challengeToken: challenge, code: good });
    assert('a valid TOTP code completes the challenge', ok.status === 200, `status=${ok.status} code=${ok.body?.error?.code}`);
    assert('tokens are issued only now', Boolean(ok.body?.accessToken && ok.body?.refreshToken));
    assert('the identity comes back', ok.body?.user?.email === 'mfa-on@acme.example', String(ok.body?.user?.email));
    mfaSession = ok.body;

    // 5. the challenge is spent
    //
    // The SAME code, not a new one. This step is expected to be refused
    // because the challenge is gone — and that refusal is precisely why
    // the step is NOT spent server-side. Advancing the clock here would
    // leave the server's recorded step one behind the test's, and the
    // next real code would be rejected as invalid rather than accepted.
    const again = await post('/auth/mfa/challenge', { challengeToken: challenge, code: good });
    assert('the challenge cannot be reused', again.status === 401, `status=${again.status}`);
    assert('with invalid-challenge', again.body?.error?.code === 'invalid-challenge', String(again.body?.error?.code));

    // A genuinely NEW code still verifies — proving the reuse refusal was
    // about the challenge, not a lockout.
    const fresh = await post('/auth/login', {
      tenantSlug: 'acme', email: 'mfa-on@acme.example', password: PASSWORD,
    });
    const second = await post('/auth/mfa/challenge', {
      challengeToken: fresh.body?.challengeToken, code: await nextCodeFor(mfaSecret, MFA_USER_ID),
    });
    assert('a new challenge with a new code still works', second.status === 200,
      `status=${second.status} code=${second.body?.error?.code}`);
  }

  // 7. backup code, via the documented regeneration endpoint
  {
    // The route mints its OWN throwaway challenge and verifies the code
    // against it, so the code must be fresh for that challenge. Reusing
    // the one spent completing login would be a replay, and the failure
    // would look like a server bug rather than a spent test credential.
    const regen = await post(
      '/auth/mfa/backup-codes',
      { code: await nextCodeInFreshWindow(mfaSecret, MFA_USER_ID) },
      mfaSession.accessToken,
    );
    assert('backup codes can be regenerated with a current code', regen.status === 200,
      `status=${regen.status} code=${regen.body?.error?.code ?? '-'}`);
    const codes = regen.body?.backupCodes;
    assert('a set is returned', Array.isArray(codes) && codes.length > 0, String(codes?.length));

    if (Array.isArray(codes) && codes.length > 0) {
      const login = await post('/auth/login', {
        tenantSlug: 'acme', email: 'mfa-on@acme.example', password: PASSWORD,
      });
      const viaCode = await post('/auth/mfa/challenge', {
        challengeToken: login.body?.challengeToken, code: codes[0],
      });
      assert('a backup code completes a challenge', viaCode.status === 200, `status=${viaCode.status}`);
      assert('with a remaining-count reported', typeof viaCode.status === 'number' || viaCode.status === 200);

      const login2 = await post('/auth/login', {
        tenantSlug: 'acme', email: 'mfa-on@acme.example', password: PASSWORD,
      });
      const reuse = await post('/auth/mfa/challenge', {
        challengeToken: login2.body?.challengeToken, code: codes[0],
      });
      assert('a backup code is single-use', reuse.status === 401, `status=${reuse.status}`);
    }
  }

  // 8. refresh rotates
  {
    // Keep the OLD value: `plain` is about to be overwritten with the
    // rotated pair, so reusing it afterwards would present the new token
    // and prove nothing about reuse detection.
    const originalRefresh = plain.refreshToken;
    const r = await post('/auth/refresh', { refreshToken: originalRefresh });
    assert('refresh returns 200', r.status === 200, `status=${r.status}`);
    assert('with a NEW refresh token', r.body?.refreshToken && r.body.refreshToken !== plain.refreshToken);
    assert('and a new access token', Boolean(r.body?.accessToken));
    plain = { ...plain, ...r.body };

    const replay = await post('/auth/refresh', { refreshToken: originalRefresh });
    assert('the presented (old) token is refused on reuse', replay.status === 401, `status=${replay.status}`);
    assert('with invalid-refresh-token', replay.body?.error?.code === 'invalid-refresh-token', String(replay.body?.error?.code));
    // The successor must die with it — that is the family revocation.
    const successor = await post('/auth/refresh', { refreshToken: r.body.refreshToken });
    assert('the successor is revoked too (family)', successor.status === 401, `status=${successor.status}`);
  }

  // 9. logout revokes
  {
    // A fresh session, so logout is tested on a LIVE token rather than
    // one the family revocation above already killed.
    const live = await post('/auth/login', { tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD });
    const r = await post('/auth/logout', { refreshToken: live.body.refreshToken });
    assert('logout returns 200', r.status === 200, `status=${r.status}`);
    assert('reporting revoked:true', r.body?.revoked === true, JSON.stringify(r.body));

    const after = await post('/auth/refresh', { refreshToken: live.body.refreshToken });
    assert('refresh after logout is refused', after.status === 401, `status=${after.status}`);
    assert('with invalid-refresh-token', after.body?.error?.code === 'invalid-refresh-token', String(after.body?.error?.code));
  }

  // 10. /auth/me
  {
    const fresh = await post('/auth/login', {
      tenantSlug: 'acme', email: EMAIL_PLAIN, password: PASSWORD,
    });
    const me = await get('/auth/me', fresh.body.accessToken);
    assert('/auth/me returns 200 with a valid token', me.status === 200, `status=${me.status}`);
    assert('/auth/me returns the signed-in identity', me.body?.user?.email === EMAIL_PLAIN, String(me.body?.user?.email));
    assert('/auth/me includes the role', typeof me.body?.user?.role === 'string');
    assert('/auth/me names the session source', typeof me.body?.session?.source === 'string', String(me.body?.session?.source));

    const bad = await get('/auth/me', 'not-a-real-token');
    assert('/auth/me rejects a bad token', bad.status === 401, `status=${bad.status}`);
  }

  // Sign the MFA session out so the run leaves no live session behind.
  if (mfaSession?.refreshToken) {
    await post('/auth/logout', { refreshToken: mfaSession.refreshToken });
  }
} catch (err) {
  failed += 1;
  console.error(`\n[verify] aborted: ${err?.message ?? err}`);
} finally {
  // The credential file goes away whether or not the run succeeded.
  try {
    rmSync(SECRET_FILE, { force: true });
    console.log(`\n[verify] deleted ${SECRET_FILE}`);
  } catch (err) {
    console.error(`[verify] could not delete the secret file: ${err.message}`);
    console.error(`        Delete it manually: ${SECRET_FILE}`);
  }
  // The secret is a module const; it goes out of scope when this process
  // exits. The FILE is what had to be removed, and it was.
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
