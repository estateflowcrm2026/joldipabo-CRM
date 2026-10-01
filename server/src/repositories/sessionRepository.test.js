// Refresh-session and login-attempt tests.
//
// Driven by a small in-memory fake of the `pg` client rather than a
// live database, so rotation and reuse detection — the two places where
// an off-by-one silently weakens security — are covered on every
// `npm test`, not only when DATABASE_URL is set.
//
// The fake models exactly the three shapes these queries produce: a
// row (possibly none), a count, and an INSERT … RETURNING. Anything
// richer belongs in a DB-integration test.
//
// Run with `npm test` (src/repositories/*.test.js is in the glob).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashRefreshToken } from '../auth/tokenService.js';
import {
  identifierHash,
  LOCKOUT_POLICY,
} from './sessionRepository.js';

// ---------------------------------------------------------------------------
// A tiny in-memory stand-in for a `pg` client
// ---------------------------------------------------------------------------

/**
 * Build a fake client whose `query` understands the statements
 * sessionRepository issues.
 *
 * @param {object} opts
 * @param {Map<string, object>} [opts.sessions] keyed by token hash
 * @param {Map<string, object>} [opts.attempts] keyed by "tenant|identifier"
 * @param {object} [opts.users] keyed by user id
 */
function fakeClient(opts = {}) {
  const state = {
    sessions: new Map(opts.sessions || []),
    attempts: new Map(opts.attempts || []),
    users: new Map(Object.entries(opts.users || {})),
    nextId: 1,
    log: [],
  };

  const client = {
    state,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      state.log.push({ sql, params });

      // --- refresh_sessions: lookup by token hash (rotate) ---
      if (/^SELECT id, user_id, tenant_id, family_id/.test(sql)) {
        const row = state.sessions.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // --- revoke family (reuse detection) ---
      if (/UPDATE refresh_sessions SET revoked_at = COALESCE/.test(sql)) {
        let n = 0;
        for (const [hash, row] of state.sessions) {
          if (row.family_id === params[0] && !row.revoked_at) {
            row.revoked_at = new Date();
            row.compromised_at = row.compromised_at || new Date();
            state.sessions.set(hash, row);
            n += 1;
          }
        }
        return { rows: [], rowCount: n };
      }

      // --- revoke one, by row id (the rotate path) ---
      if (/UPDATE refresh_sessions SET revoked_at = now\(\), last_used_at/.test(sql)) {
        for (const [hash, row] of state.sessions) {
          if (row.id === params[0]) {
            row.revoked_at = new Date();
            state.sessions.set(hash, row);
            return { rows: [], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // --- revoke one, by token hash ---
      // Returns the revoked row, because the statement carries a RETURNING
      // clause: `revokeSessionByTokenDetailed` reads `rows` to get the
      // tenant for the logout audit row, and `audit_log.tenant_id` is NOT
      // NULL. A fake that returned `rows: []` here would let the audit
      // INSERT fail and mask the real regression.
      if (/UPDATE refresh_sessions SET revoked_at = now\(\) WHERE token_hash/.test(sql)) {
        const row = state.sessions.get(params[0]);
        if (row && !row.revoked_at) {
          row.revoked_at = new Date();
          state.sessions.set(params[0], row);
          return {
            rows: [{ id: row.id, user_id: row.user_id, tenant_id: row.tenant_id }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // --- revoke all for a user ---
      if (/UPDATE refresh_sessions SET revoked_at = now\(\) WHERE user_id/.test(sql)) {
        let n = 0;
        for (const [hash, row] of state.sessions) {
          if (row.user_id === params[0] && !row.revoked_at) {
            row.revoked_at = new Date();
            state.sessions.set(hash, row);
            n += 1;
          }
        }
        return { rows: [], rowCount: n };
      }

      // --- list live sessions for a user ---
      if (/SELECT id, family_id, device_label/.test(sql)) {
        return {
          rows: [...state.sessions.values()].filter(
            (r) => r.user_id === params[0] && !r.revoked_at,
          ),
          rowCount: 1,
        };
      }

      // --- insert successor, SELECT ... FROM refresh_sessions WHERE id ---
      if (/^INSERT INTO refresh_sessions/.test(sql) && /SELECT \$1, user_id/.test(sql)) {
        const [nextId, nextHash, expiresAt, sourceId] = params;
        const src = [...state.sessions.values()].find((r) => r.id === sourceId);
        if (!src) return { rows: [], rowCount: 0 };
        const row = {
          id: nextId,
          token_hash: nextHash,
          user_id: src.user_id,
          tenant_id: src.tenant_id,
          family_id: src.family_id || src.id,
          parent_id: src.id,
          rotation_count: (src.rotation_count || 0) + 1,
          revoked_at: null,
          compromised_at: null,
          expires_at: expiresAt,
        };
        state.sessions.set(nextHash, row);
        return { rows: [], rowCount: 1 };
      }

      // --- create the first session ---
      if (/^INSERT INTO refresh_sessions/.test(sql)) {
        const [id, userId, tenantId, hash, , , , , familyId, expiresAt] = params;
        state.sessions.set(hash, {
          id,
          user_id: userId,
          tenant_id: tenantId,
          token_hash: hash,
          family_id: familyId,
          parent_id: null,
          rotation_count: 0,
          revoked_at: null,
          compromised_at: null,
          expires_at: expiresAt,
        });
        return { rows: [], rowCount: 1 };
      }

      // --- read user lockout ---
      if (/SELECT failed_login_count, locked_until FROM users/.test(sql)) {
        const u = state.users.get(params[0]);
        return {
          rows: u
            ? [{ failed_login_count: u.failed_login_count || 0, locked_until: u.locked_until || null }]
            : [],
          rowCount: 1,
        };
      }

      // --- read identifier lockout ---
      if (/SELECT failure_count, locked_until FROM login_attempts/.test(sql)) {
        const row = state.attempts.get(`${params[0]}|${params[1]}`);
        return {
          rows: row
            ? [{ failure_count: row.failure_count, locked_until: row.locked_until }]
            : [],
          rowCount: 1,
        };
      }

      // --- clear on success ---
      if (/UPDATE users SET failed_login_count = 0/.test(sql)) {
        const u = state.users.get(params[0]);
        if (u) {
          u.failed_login_count = 0;
          u.locked_until = null;
          state.users.set(params[0], u);
        }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM login_attempts/.test(sql)) {
        state.attempts.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }

      // Anything unmodelled is a test-authoring bug, not a silent pass.
      throw new Error(`fakeClient: unmodelled query — ${sql.slice(0, 90)}`);
    },
  };
  return client;
}

const makeSession = (over = {}) => ({
  id: 'rs_1',
  user_id: 'u-asha',
  tenant_id: 'org_acme',
  family_id: 'fam_1',
  parent_id: null,
  rotation_count: 0,
  revoked_at: null,
  compromised_at: null,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  device_label: 'Chrome on Windows',
  ip: '127.0.0.1',
  trusted: false,
  ...over,
});

// Imported lazily so the module under test is registered before these
// helpers reference it.
const repo = await import('./sessionRepository.js');

// ---------------------------------------------------------------------------
// 1. Identifier hashing
// ---------------------------------------------------------------------------

test('identifierHash normalises before hashing', () => {
  assert.equal(identifierHash('Asha@Acme.Example'), identifierHash('  asha@acme.example  '));
  assert.notEqual(identifierHash('a@x.com'), identifierHash('b@x.com'));
  assert.match(identifierHash('a@x.com'), /^[0-9a-f]{64}$/);
});

test('identifierHash never stores the address in the clear', () => {
  assert.ok(!identifierHash('secret@example.com').includes('example'));
});

// ---------------------------------------------------------------------------
// 2. Create
// ---------------------------------------------------------------------------

test('createSession issues a token, stores only its hash, and seeds a family', async () => {
  const client = fakeClient();
  const out = await repo.createSession(client, {
    userId: 'u-asha',
    tenantId: 'org_acme',
    roleId: 'field-executive',
    ip: '10.0.0.5',
  });

  assert.ok(out.sessionId.startsWith('rs_'));
  assert.ok(out.familyId.startsWith('fam_'));
  assert.equal(out.refreshTokenHash, hashRefreshToken(out.refreshToken));
  assert.ok(!out.refreshTokenHash.includes(out.refreshToken), 'hash is not the token');

  const stored = client.state.sessions.get(out.refreshTokenHash);
  assert.ok(stored, 'the hash is what gets stored');
  assert.equal(stored.user_id, 'u-asha');
  assert.equal(stored.family_id, out.familyId);
  assert.equal(stored.rotation_count, 0);
  assert.equal(stored.revoked_at, null);
});

test('createSession issues a different token every time', async () => {
  const client = fakeClient();
  const a = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const b = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  assert.notEqual(a.refreshToken, b.refreshToken);
  assert.notEqual(a.familyId, b.familyId, 'each login is its own family');
});

// ---------------------------------------------------------------------------
// 3. Rotation
// ---------------------------------------------------------------------------

test('rotation issues a new token and revokes the old one', async () => {
  const client = fakeClient();
  const created = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });

  const rotated = await repo.rotateSession(client, created.refreshToken);
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.refreshToken, created.refreshToken);
  assert.equal(rotated.session.familyId, created.familyId, 'family is preserved');
  assert.equal(rotated.session.rotationCount, 1);

  const old = client.state.sessions.get(hashRefreshToken(created.refreshToken));
  assert.ok(old.revoked_at, 'the presented token is now dead');
  const next = client.state.sessions.get(rotated.refreshTokenHash);
  assert.equal(next.revoked_at, null);
  assert.equal(next.parent_id, created.sessionId);
});

test('rotation can be chained, incrementing the counter', async () => {
  const client = fakeClient();
  const s1 = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const s2 = await repo.rotateSession(client, s1.refreshToken);
  const s3 = await repo.rotateSession(client, s2.refreshToken);

  assert.equal(s3.ok, true);
  assert.equal(s3.session.rotationCount, 2);
  assert.equal(s3.session.familyId, s1.familyId);
});

test('rotating an unknown token is not-found, not a crash', async () => {
  const client = fakeClient();
  const out = await repo.rotateSession(client, 'never-issued');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'not-found');
});

test('an expired token is refused', async () => {
  const expired = makeSession({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const client = fakeClient({
    sessions: new Map([[hashRefreshToken('tok'), expired]]),
  });
  const out = await repo.rotateSession(client, 'tok');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'expired');
});

// ---------------------------------------------------------------------------
// 4. Reuse detection — the important one
// ---------------------------------------------------------------------------

test('replaying a rotated token is detected as a compromise', async () => {
  const client = fakeClient();
  const s1 = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const s2 = await repo.rotateSession(client, s1.refreshToken);

  // The legitimate client has the new token. Someone else still has the
  // old one and presents it.
  const replay = await repo.rotateSession(client, s1.refreshToken);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'compromise-detected');

  // The whole family is now dead, including the token the legitimate
  // client is holding. That is deliberate: once a stolen token has been
  // replayed we cannot tell which copy is real.
  const current = client.state.sessions.get(hashRefreshToken(s2.refreshToken));
  assert.ok(current.revoked_at, 'the successor is revoked too');
  assert.ok(current.compromised_at, 'and marked compromised');

  // And the family cannot be used again.
  const again = await repo.rotateSession(client, s2.refreshToken);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'compromise-detected');
});

test('replay only kills its own family', async () => {
  const client = fakeClient();
  const phone = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const laptop = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });

  const rotated = await repo.rotateSession(client, phone.refreshToken);
  await repo.rotateSession(client, phone.refreshToken); // the replay

  assert.notEqual(phone.familyId, laptop.familyId);
  const onLaptop = client.state.sessions.get(hashRefreshToken(laptop.refreshToken));
  assert.equal(onLaptop.revoked_at, null, 'an unrelated device is unaffected');
  assert.equal(client.state.sessions.get(rotated.refreshTokenHash).revoked_at !== null, true);
});

test('logging out then presenting the token reads as a compromise', async () => {
  // Also correct: a revoked token is revoked, whoever presents it.
  const client = fakeClient();
  const s1 = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  assert.equal(await repo.revokeSessionByToken(client, s1.refreshToken), true);

  const out = await repo.rotateSession(client, s1.refreshToken);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'compromise-detected');
});

// ---------------------------------------------------------------------------
// 5. Revoke
// ---------------------------------------------------------------------------

test('revokeSessionByToken is idempotent', async () => {
  const client = fakeClient();
  const s = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  assert.equal(await repo.revokeSessionByToken(client, s.refreshToken), true);
  assert.equal(await repo.revokeSessionByToken(client, s.refreshToken), false);
});

test('revokeSessionByToken on an unknown token is a no-op', async () => {
  const client = fakeClient();
  assert.equal(await repo.revokeSessionByToken(client, 'nope'), false);
});

test('revokeAllSessions kills every live session for the user only', async () => {
  const client = fakeClient();
  const a = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const b = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const other = await repo.createSession(client, { userId: 'u-raj', tenantId: 'org_acme' });

  assert.equal(await repo.revokeAllSessions(client, 'u-asha'), 2);

  assert.ok(client.state.sessions.get(hashRefreshToken(a.refreshToken)).revoked_at);
  assert.ok(client.state.sessions.get(hashRefreshToken(b.refreshToken)).revoked_at);
  assert.equal(
    client.state.sessions.get(hashRefreshToken(other.refreshToken)).revoked_at,
    null,
    "another user's session is untouched",
  );
});

test('listLiveSessions returns only unrevoked rows', async () => {
  const client = fakeClient();
  const a = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  const b = await repo.createSession(client, { userId: 'u-asha', tenantId: 'org_acme' });
  await repo.revokeSessionByToken(client, a.refreshToken);

  const live = await repo.listLiveSessions(client, 'u-asha');
  assert.equal(live.length, 1);
  assert.equal(live[0].id, b.sessionId);
});

// ---------------------------------------------------------------------------
// 6. Lockout policy constants
// ---------------------------------------------------------------------------

test('the default lockout policy is documented and sane', () => {
  assert.equal(LOCKOUT_POLICY.userThreshold, 5);
  assert.equal(LOCKOUT_POLICY.tenantThreshold, 10);
  assert.equal(LOCKOUT_POLICY.lockMs, 15 * 60 * 1000);
  assert.ok(
    LOCKOUT_POLICY.tenantThreshold > LOCKOUT_POLICY.userThreshold,
    'the per-identifier ceiling must be looser than the per-user one, or spraying one address locks the tenant',
  );
});
