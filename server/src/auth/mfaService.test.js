// MFA service tests.
//
// A fake `pg` client rather than a live database, so the setup and
// challenge flows are covered on every `npm test` and not only when
// DATABASE_URL is set. The DB-backed equivalents live in
// `scripts/smoke-auth-db.js`.
//
// WHAT IS WORTH A FAKE AT ALL
// ---------------------------
// The cryptography is already pinned against the RFC vectors in
// totp.test.js. What a fake can test cheaply and a real database cannot
// test at all is the ORCHESTRATION: which state is committed before an
// error, whether a failed challenge still increments its counter, and
// whether a consumed challenge really is dead. Those are the defects
// this codebase has actually shipped — refresh() rolled back a security
// response because it threw from inside a transaction, and logout() did
// the same with an audit INSERT that violated a NOT NULL constraint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-in-production-0000';

const { totp, verifyTotp, counterFor } = await import('./totp.js');
const { decryptSecret } = await import('./mfaCrypto.js');
const M = await import('./mfaService.js');
const R = await import('../repositories/mfaRepository.js');

// The service reads `userId`; the test fixture originally used `id`,
// which made every lookup resolve to `undefined` and the fake silently
// wrote nothing. The name is spelled out here so that is not a
// possibility again.
const USER = {
  userId: 'u-1',
  id: 'u-1',
  tenantId: 'org_acme',
  email: 'admin@acme.example',
  role: 'admin',
};

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

/**
 * A `pg` client that understands the statements mfaRepository issues.
 *
 * Transactions are real in the sense that matters: `transaction()` commits
 * on success and, critically, DISCARDS writes when the callback throws.
 * Modelling that is the entire point — a fake that always committed would
 * hide exactly the rollback bug these tests exist to catch.
 */
function fakeDb(users = {}) {
  const state = {
    users: new Map(Object.entries(users)),
    challenges: new Map(),
    codes: new Map(),
    audits: [],
    now: Date.now(),
  };

  const apply = (client, text, params) => {
    const sql = text.replace(/\s+/g, ' ').trim();

    // --- users.mfa_* ---
    if (/SELECT mfa_enabled, mfa_secret/.test(sql)) {
      const u = state.users.get(params[0]);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (/SET mfa_secret = \$2, mfa_enabled = false/.test(sql)) {
      const u = state.users.get(params[0]);
      if (u) { u.mfa_secret = params[1]; u.mfa_enabled = false; }
      return { rows: [], rowCount: 1 };
    }
    if (/SET mfa_enabled = true/.test(sql)) {
      const u = state.users.get(params[0]);
      if (u) { u.mfa_enabled = true; u.mfa_last_step = params[1]; u.mfa_enabled_at ??= new Date(state.now); }
      // Migration 009 installs a trigger that burns outstanding challenges
      // whenever mfa_enabled or mfa_secret changes. Reproduced here because
      // it is a database guarantee, not application logic — an
      // application-side call would not survive a future route that
      // forgets to make it.
      for (const c of state.challenges.values()) {
        if (c.user_id === params[0] && !c.consumed_at) c.consumed_at = new Date(state.now);
      }
      return { rows: [], rowCount: 1 };
    }
    if (/SET mfa_enabled = false,\s*mfa_secret = NULL/.test(sql)) {
      const u = state.users.get(params[0]);
      if (u) { u.mfa_enabled = false; u.mfa_secret = null; u.mfa_last_step = null; }
      state.codes.delete(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/SET mfa_last_step = \$2, mfa_last_used_at/.test(sql)) {
      const u = state.users.get(params[0]);
      // The `> $2` predicate IS the replay defence.
      if (u && (u.mfa_last_step == null || u.mfa_last_step < params[1])) {
        u.mfa_last_step = params[1];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT mfa_enabled, mfa_enabled_at FROM users/.test(sql)) {
      const u = state.users.get(params[0]);
      return { rows: u ? [{ mfa_enabled: u.mfa_enabled, mfa_enabled_at: u.mfa_enabled_at ?? null }] : [] };
    }

    // --- mfa_challenges ---
    //
    // Keyed by ID, not by token hash. findChallenge looks a row up by the
    // hashed token, but recordChallengeFailure and consumeChallenge look
    // it up by id. Keying the fake by hash made those two silently find
    // nothing, so every attempt increment vanished and a challenge that
    // had just been completed read as one that no longer existed.
    if (/INSERT INTO mfa_challenges/.test(sql)) {
      state.challenges.set(params[0], {
        id: params[0], user_id: params[1], tenant_id: params[2],
        token_hash: params[3], attempts: 0, max_attempts: 5, consumed_at: null,
        expires_at: params[6],
      });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM mfa_challenges/.test(sql) && /token_hash = \$1/.test(sql)) {
      const c = [...state.challenges.values()].find((x) => x.token_hash === params[0]);
      if (!c || c.consumed_at || c.expires_at <= state.now) return { rows: [], rowCount: 0 };
      return { rows: [{ id: c.id, user_id: c.user_id, tenant_id: c.tenant_id, attempts: c.attempts, max_attempts: c.max_attempts }], rowCount: 1 };
    }
    if (/SET attempts = attempts \+ 1/.test(sql)) {
      const c = state.challenges.get(params[0]);
      if (!c) return { rows: [], rowCount: 0 };
      c.attempts += 1;
      return { rows: [{ attempts: c.attempts, max_attempts: c.max_attempts }], rowCount: 1 };
    }
    if (/SET consumed_at = now\(\) WHERE id = \$1/.test(sql)) {
      const c = state.challenges.get(params[0]);
      if (c) c.consumed_at = new Date(state.now);
      return { rows: [], rowCount: 1 };
    }

    // --- mfa_backup_codes ---
    if (/INSERT INTO mfa_backup_codes/.test(sql)) {
      const list = state.codes.get(params[1]) ?? [];
      list.push({ id: params[0], code_hash: params[2], label: params[3], used_at: null });
      state.codes.set(params[1], list);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM mfa_backup_codes WHERE user_id = \$1/.test(sql)) {
      state.codes.set(params[0], []);
      return { rows: [], rowCount: 1 };
    }
    if (/SET used_at = now\(\)\s*WHERE user_id = \$1 AND code_hash = \$2/.test(sql)) {
      const list = state.codes.get(params[0]) ?? [];
      const hit = list.find((c) => c.code_hash === params[1] && !c.used_at);
      if (hit) { hit.used_at = new Date(state.now); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (/count\(\*\)::int AS n FROM mfa_backup_codes/.test(sql)) {
      const n = (state.codes.get(params[0]) ?? []).filter((c) => !c.used_at).length;
      return { rows: [{ n }], rowCount: 1 };
    }

    // --- audit_log (asserted on, not modelled in detail) ---
    if (/INSERT INTO audit_log/.test(sql)) {
      // Column order is id, tenant_id, user_id, actor_id, action, …, so
      // `action` is params[4], not params[3]. Reading the wrong index
      // made every audit assertion below compare against a user id,
      // which is a spectacularly unhelpful way to fail.
      state.audits.push({ action: params[4], userId: params[2] });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`mfa fake: unmodelled query — ${sql.slice(0, 80)}`);
  };

  const client = {
    async query(text, params = []) {
      return apply(client, text, params);
    },
  };

  const transaction = async (fn) => {
    // Snapshot for rollback.
    const backup = JSON.stringify({
      users: [...state.users.entries()],
      challenges: [...state.challenges.entries()],
      codes: [...state.codes.entries()],
    });
    try {
      return await fn(client);
    } catch (err) {
      const snap = JSON.parse(backup);
      state.users = new Map(snap.users);
      state.challenges = new Map(snap.challenges);
      state.codes = new Map(snap.codes);
      throw err;
    }
  };

  return { state, client, transaction };
}

const depsFor = (db) => ({ transaction: db.transaction });
const freshUser = () => [USER.userId, { mfa_enabled: false, mfa_secret: null, mfa_last_step: null, mfa_enabled_at: null }];

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

test('startSetup returns a secret and an otpauth URI', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const out = await M.startSetup(USER, depsFor(db));

  assert.match(out.secret, /^[A-Z2-7]{32}$/, '20 bytes, base32');
  assert.ok(out.otpauthUri.startsWith('otpauth://totp/'));
  assert.equal(out.issuer, 'Joldipabo CRM');
});

test('startSetup stores the secret ENCRYPTED and leaves MFA disabled', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const out = await M.startSetup(USER, depsFor(db));
  const row = db.state.users.get(USER.userId);

  assert.notEqual(row.mfa_secret, out.secret, 'the plaintext must not be stored');
  assert.ok(row.mfa_secret.startsWith('v1:'), 'AES-256-GCM envelope');
  assert.equal(decryptSecret(row.mfa_secret), out.secret, 'and it must decrypt back');
  assert.equal(row.mfa_enabled, false, 'a half-finished setup must not lock anyone out');
});

test('startSetup writes mfa-setup-started', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await M.startSetup(USER, depsFor(db));
  assert.ok(db.state.audits.some((a) => a.action === 'mfa-setup-started'));
});

test('confirmSetup with a wrong code refuses and leaves MFA off', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const { secret } = await M.startSetup(USER, depsFor(db));

  await assert.rejects(
    () => M.confirmSetup({ ...USER, code: '000000' }, depsFor(db)),
    /not valid/,
  );
  assert.equal(db.state.users.get(USER.userId).mfa_enabled, false);
});

test('confirmSetup with a correct code enables MFA and returns backup codes', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const { secret } = await M.startSetup(USER, depsFor(db));

  const out = await M.confirmSetup({ ...USER, code: totp(secret) }, depsFor(db));

  assert.equal(db.state.users.get(USER.userId).mfa_enabled, true);
  assert.equal(out.backupCodes.length, 10);
  assert.equal(db.state.codes.get(USER.id).length, 10, 'all ten are persisted');
  assert.ok(db.state.audits.some((a) => a.action === 'mfa-enabled'));
});

test('backup codes are stored hashed, never in plaintext', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const { secret } = await M.startSetup(USER, depsFor(db));
  const { backupCodes } = await M.confirmSetup({ ...USER, code: totp(secret) }, depsFor(db));

  const stored = db.state.codes.get(USER.id);
  for (const code of backupCodes) {
    assert.ok(!stored.some((r) => r.code_hash === code), 'no plaintext in the table');
    assert.ok(stored.some((r) => r.code_hash === R.hashBackupCode(code)));
  }
});

test('confirmSetup cannot be called twice', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const { secret } = await M.startSetup(USER, depsFor(db));
  await M.confirmSetup({ ...USER, code: totp(secret) }, depsFor(db));

  await assert.rejects(
    () => M.confirmSetup({ ...USER, code: totp(secret) }, depsFor(db)),
    /already enabled/,
  );
});

test('confirmSetup before startSetup is refused', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await assert.rejects(
    () => M.confirmSetup({ ...USER, code: '123456' }, depsFor(db)),
    /Start MFA setup/,
  );
});

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

/**
 * Enrol this user and return the secret.
 *
 * Note that `confirmSetup` records the TOTP step it accepted, so a test
 * that then reuses `totp(secret)` is presenting an ALREADY-SPENT step.
 * That is correct behaviour and exactly what the replay test asserts —
 * but it means a caller wanting a fresh code must wait for the next
 * 30-second window. `nextStepWait` does that.
 */
async function enrolled(db) {
  const { secret } = await M.startSetup(USER, depsFor(db));
  await M.confirmSetup({ ...USER, code: totp(secret) }, depsFor(db));
  return secret;
}

/**
 * A TOTP code from the NEXT 30-second step.
 *
 * Enrolling spends the current step — that is what stops a shoulder-
 * surfer reusing the setup code as a login code. A test that enrols and
 * then logs in therefore needs a code from a LATER step, and waiting
 * 30 seconds of wall clock is not acceptable in a unit test.
 *
 * `atMs` is threaded through the service for exactly this: the counter
 * is computed from the supplied instant rather than Date.now(). In
 * production nothing supplies it, so nothing changes.
 */
const LATER = 30_000;
const atLaterStep = () => Date.now() + LATER;
const codeAt = (secret, atMs) => totp(secret, { atMs });

test('a challenge is issued and is not a session', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const ch = await M.issueChallenge(USER, depsFor(db));
  assert.ok(ch.challengeToken, 'an opaque token is returned to the client');
  assert.equal(ch.expiresIn, 300, 'five minutes');
  // Only the hash is persisted.
  assert.ok(db.state.challenges.size === 1);
  assert.ok(![...db.state.challenges.keys()].includes(ch.challengeToken));
});

test('the challenge token is not stored in the clear', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const ch = await M.issueChallenge(USER, depsFor(db));
  const row = [...db.state.challenges.values()][0];

  // The client holds the plaintext; the table holds a digest of it.
  assert.match(row.token_hash, /^[a-f0-9]{64}$/, 'a SHA-256 hex digest');
  assert.notEqual(row.token_hash, ch.challengeToken);
  assert.ok(
    ![...db.state.challenges.values()].some((r) => r.token_hash === ch.challengeToken),
    'the plaintext token must appear nowhere in the table',
  );
});

test('a correct TOTP code passes the challenge', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const secret = await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));

  const at = atLaterStep();
  const out = await M.verifyChallenge(
    { challengeToken: ch.challengeToken, code: codeAt(secret, at), atMs: at },
    depsFor(db),
  );
  assert.equal(out.userId, USER.userId);
  assert.equal(out.method, 'totp');
  assert.ok(db.state.audits.some((a) => a.action === 'mfa-challenge-passed'));
});

test('a wrong code fails and is audited', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const secret = await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));

  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: ch.challengeToken, code: '000000' }, depsFor(db)),
    /not valid/,
  );
  assert.ok(db.state.audits.some((a) => a.action === 'mfa-challenge-failed'));
});

test('a consumed challenge cannot be reused', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const secret = await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));

  const at = atLaterStep();
  await M.verifyChallenge({ challengeToken: ch.challengeToken, code: codeAt(secret, at), atMs: at }, depsFor(db));
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: ch.challengeToken, code: codeAt(secret, at), atMs: at }, depsFor(db)),
    /no longer valid/,
  );
});

test('an unknown challenge token is refused', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: 'nope', code: '123456' }, depsFor(db)),
    /no longer valid/,
  );
});

test('the same TOTP code cannot be used twice (replay)', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const secret = await enrolled(db);

  const at = atLaterStep();
  const code = codeAt(secret, at);
  const first = await M.issueChallenge(USER, depsFor(db));
  await M.verifyChallenge({ challengeToken: first.challengeToken, code, atMs: at }, depsFor(db));

  // A fresh challenge, the same code. Without the consumed-step record
  // this would pass, and an attacker who shoulder-surfs a code has a
  // usable window.
  const second = await M.issueChallenge(USER, depsFor(db));
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: second.challengeToken, code, atMs: at }, depsFor(db)),
    /already been used/,
  );
});

test('a failed attempt increments the counter DESPITE the throw', async () => {
  // The regression this pins: the counter is written in its own
  // transaction. Writing it inside the failing one would roll it back and
  // the challenge would never lock.
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));
  const row = [...db.state.challenges.values()][0];

  await assert.rejects(() => M.verifyChallenge({ challengeToken: ch.challengeToken, code: '000000' }, depsFor(db)));
  assert.equal(row.attempts, 1, 'the attempt must survive the throw');
});

test('the challenge locks after the maximum number of attempts', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const secret = await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));
  const row = [...db.state.challenges.values()][0];

  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => M.verifyChallenge({ challengeToken: ch.challengeToken, code: '000000' }, depsFor(db)));
  }
  assert.equal(row.attempts, 4);

  // Fifth attempt trips the limit.
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: ch.challengeToken, code: '000000' }, depsFor(db)),
    /Too many incorrect codes/,
  );
  assert.equal(row.consumed_at !== null, true, 'the challenge is burned');

  // The CORRECT code must not work afterwards — otherwise the lockout
  // just delays an attacker who already knows the code.
  await assert.rejects(
    () => M.verifyChallenge(
      { challengeToken: ch.challengeToken, code: codeAt(secret, atLaterStep()), atMs: atLaterStep() },
      depsFor(db),
    ),
    /no longer valid/,
  );
});

test('a missing code is a 400, not a verification attempt', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: ch.challengeToken, code: '' }, depsFor(db)),
    /Enter your authentication code/,
  );
});

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

test('a backup code passes the challenge', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  const { backupCodes } = await M.regenerateBackupCodes(USER, depsFor(db));
  const ch = await M.issueChallenge(USER, depsFor(db));

  const out = await M.verifyChallenge({ challengeToken: ch.challengeToken, code: backupCodes[0] }, depsFor(db));
  assert.equal(out.method, 'backup-code');
  assert.equal(out.backupCodesRemaining, 9);
  assert.ok(db.state.audits.some((a) => a.action === 'mfa-challenge-passed'));
});

test('a backup code is single-use', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  const { backupCodes } = await M.regenerateBackupCodes(USER, depsFor(db));

  const first = await M.issueChallenge(USER, depsFor(db));
  await M.verifyChallenge({ challengeToken: first.challengeToken, code: backupCodes[0] }, depsFor(db));

  const second = await M.issueChallenge(USER, depsFor(db));
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: second.challengeToken, code: backupCodes[0] }, depsFor(db)),
    /not valid/,
  );
});

test('a backup code is accepted without the hyphen and in lower case', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  const { backupCodes } = await M.regenerateBackupCodes(USER, depsFor(db));
  const retyped = backupCodes[0].replace('-', '').toLowerCase();

  const ch = await M.issueChallenge(USER, depsFor(db));
  const out = await M.verifyChallenge({ challengeToken: ch.challengeToken, code: retyped }, depsFor(db));
  assert.equal(out.method, 'backup-code');
});

test('regenerating invalidates the previous codes', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  const first = await M.regenerateBackupCodes(USER, depsFor(db));

  await M.regenerateBackupCodes(USER, depsFor(db));
  const ch = await M.issueChallenge(USER, depsFor(db));
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: ch.challengeToken, code: first.backupCodes[0] }, depsFor(db)),
    /not valid/,
  );
});

test('generated codes avoid visually ambiguous characters', () => {
  // No I, O, 0 or 1: codes get read aloud and retyped from paper.
  // generateBackupCodes returns {code, hash} pairs; only `code` is shown.
  const generated = R.generateBackupCodes(50);
  assert.equal(generated.length, 50);
  for (const { code, hash } of generated) {
    assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, code);
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
});

// ---------------------------------------------------------------------------
// Disable
// ---------------------------------------------------------------------------

test('disable clears the secret and every backup code', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  await enrolled(db);
  await M.disable(USER, depsFor(db));

  const row = db.state.users.get(USER.userId);
  assert.equal(row.mfa_enabled, false);
  assert.equal(row.mfa_secret, null);
  assert.equal(row.mfa_last_step, null);
  assert.equal((db.state.codes.get(USER.id) ?? []).length, 0, 'codes are destroyed, not just flagged');
  assert.ok(db.state.audits.some((a) => a.action === 'mfa-disabled'));
});

test('after disabling, a challenge cannot be completed', async () => {
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const secret = await enrolled(db);
  const ch = await M.issueChallenge(USER, depsFor(db));
  await M.disable(USER, depsFor(db));

  await assert.rejects(
    () => M.verifyChallenge(
      { challengeToken: ch.challengeToken, code: codeAt(secret, atLaterStep()), atMs: atLaterStep() },
      depsFor(db),
    ),
    /no longer valid/,
  );
});

test('a challenge issued BEFORE enrolment cannot be completed', async () => {
  // A challenge minted while MFA was off must not become usable once the
  // user enrols: it was issued without a second factor in force, so
  // honouring it would let someone skip enrolment by racing the setup.
  const db = fakeDb(Object.fromEntries([freshUser()]));
  const ch = await M.issueChallenge(USER, depsFor(db));
  const { secret } = await M.startSetup(USER, depsFor(db));
  const at = atLaterStep();
  await M.confirmSetup({ ...USER, code: codeAt(secret, at), atMs: at }, depsFor(db));

  await assert.rejects(
    () => M.verifyChallenge(
      { challengeToken: ch.challengeToken, code: codeAt(secret, at), atMs: at },
      depsFor(db),
    ),
    /no longer valid/,
  );
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('admin and super-admin require MFA when enforcement is on', () => {
  const prev = process.env.AUTH_MFA_ENFORCE;
  process.env.AUTH_MFA_ENFORCE = 'true';
  try {
    assert.equal(M.mfaRequiredForRole('admin'), true);
    assert.equal(M.mfaRequiredForRole('super-admin'), true);
    assert.equal(M.mfaRequiredForRole('ADMIN'), true, 'case-insensitive');
  } finally {
    if (prev === undefined) delete process.env.AUTH_MFA_ENFORCE;
    else process.env.AUTH_MFA_ENFORCE = prev;
  }
});

test('other roles are not required, and nothing is required when enforcement is off', () => {
  const prev = process.env.AUTH_MFA_ENFORCE;
  try {
    process.env.AUTH_MFA_ENFORCE = 'true';
    for (const role of ['sales-manager', 'sales', 'field-executive', 'cpm', 'accounts']) {
      assert.equal(M.mfaRequiredForRole(role), false, role);
    }
    // Off by default so a developer is not locked out of their own admin.
    process.env.AUTH_MFA_ENFORCE = 'false';
    assert.equal(M.mfaRequiredForRole('admin'), false);
    delete process.env.AUTH_MFA_ENFORCE;
    assert.equal(M.mfaRequiredForRole('admin'), false, 'unset is off');
  } finally {
    if (prev === undefined) delete process.env.AUTH_MFA_ENFORCE;
    else process.env.AUTH_MFA_ENFORCE = prev;
  }
});

test('a secret that cannot be decrypted is refused, not guessed', async () => {
  const db = fakeDb([[USER.id, {
    mfa_enabled: true,
    mfa_secret: 'v1:AAAA:BBBB:CCCC', // ciphertext from a different key
    mfa_last_step: null,
  }]]);
  const ch = await M.issueChallenge(USER, depsFor(db));
  await assert.rejects(
    () => M.verifyChallenge({ challengeToken: ch.challengeToken, code: '123456' }, depsFor(db)),
    /no longer valid/,
  );
});
