// Auth service — the login / refresh / logout flow.
//
// Kept out of the route file so the transaction boundaries are testable
// and so a future background job (session cleanup, forced logout) can
// reuse the same primitives.
//
// Two rules shape everything here:
//
//   1. **Never leak whether an identifier exists.** A wrong password, an
//      unknown address, a suspended account, and a wrong tenant all
//      produce the same 401 body. The only differing signal is
//      `Retry-After` on a lockout, which reveals that the identifier is
//      under attack — that is intentional and does not confirm it
//      exists.
//
//   2. **Verify the password even when the account is not usable.** If a
//      suspended or locked account short-circuits before the hash
//      comparison, response timing distinguishes "user exists but is
//      disabled" from "no such user". A dummy verify is performed
//      against a real hash so both paths cost the same.

import { query as realQuery, transaction as realTransaction } from '../db/client.js';
import { Unauthorized, TooManyRequests } from '../utils/errors.js';
import { verifyPassword, needsPasswordRehash, hashPassword } from '../auth/passwordPolicy.js';
import { issueAccessToken } from '../auth/tokenService.js';
import { recordAudit } from '../audit/auditLog.js';
import {
  getLoginCandidate as realGetLoginCandidate,
  resolveAuthContext as realResolveAuthContext,
} from './authRepository.js';
import {
  createSession,
  rotateSession,
  revokeSessionByToken,
  revokeSessionByTokenDetailed,
  revokeAllSessions,
  listLiveSessions,
  recordFailedLogin,
  clearFailedLogins,
  getUserLockout,
  getIdentifierLockout,
} from './sessionRepository.js';
import { getMfaState } from './mfaRepository.js';
import { issueChallenge, mfaRequiredForRole, verifyChallenge } from '../auth/mfaService.js';

/**
 * Injectable collaborators.
 *
 * Production passes nothing and every call goes to Postgres. The smoke
 * test (`scripts/smoke-auth.js`) and the unit tests pass an in-memory
 * stand-in so the flow can be exercised without a database — an ESM
 * module namespace is read-only, so the alternative was routing
 * production code through a global test hook, which is worse.
 *
 * @typedef {object} AuthDeps
 * @property {Function} query
 * @property {Function} transaction
 * @property {Function} getLoginCandidate
 * @property {Function} resolveAuthContext
 */

const defaultDeps = () => ({
  query: realQuery,
  transaction: realTransaction,
  getLoginCandidate: realGetLoginCandidate,
  resolveAuthContext: realResolveAuthContext,
});

// A real Argon2id hash of a random string, verified against when no
// password needs checking. Keeps the failure path's cost identical to
// the success path, so timing does not disclose whether a user exists.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Y2Fubm5pd3NhbHR2YWx1ZQ$J8Xk2vN7pQ4rT6mB9wZ1cY3dF5gH7jK0lA';

/** The single 401 every authentication failure returns. */
const INVALID_CREDENTIALS = () =>
  new Unauthorized('invalid-credentials', 'Invalid email or password.');

/**
 * Persist a failure side-effect in its OWN transaction.
 *
 * A login failure throws, and `transaction()` rolls back on throw — so
 * recording the attempt inside the failing transaction would discard
 * the counter increment. The lockout would then reset on every attempt
 * and never trigger. This helper runs the write on a fresh connection
 * that commits independently.
 *
 * `deps` is threaded through because the in-memory harness
 * (`scripts/smoke-auth.js`) injects its own `transaction`. Using the
 * real one here would make failure recording untestable — the harness
 * would silently observe a lockout that never happens.
 *
 * @param {object} deps
 * @param {Function} deps.transaction
 * @param {(client: import('pg').PoolClient) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function persistFailureSideEffect(deps, fn) {
  try {
    const { transaction } = { ...defaultDeps(), ...deps };
    await transaction(fn);
  } catch {
    // A failure to record a failed attempt must not replace the 401 the
    // caller is owed. Losing one counter increment is survivable;
    // turning a wrong-password 401 into a 500 is not.
  }
}

/**
 * Resolve a tenant from a slug, or from the email's domain when the
 * caller supplied neither.
 *
 * A single-tenant deployment can pass `tenantSlug: null` and have the
 * only organisation used. A multi-tenant deployment must pass it, or
 * derive it from the address domain.
 *
 * @param {string|null} tenantSlug
 * @param {string} email
 * @returns {Promise<string|null>} tenant id, or null when ambiguous
 */
export async function resolveTenantId(tenantSlug, email, deps = defaultDeps()) {
  const { query } = deps;
  if (tenantSlug) {
    const { rows } = await query(
      `SELECT id FROM organisations
        WHERE (slug = $1 OR id = $1) AND deleted_at IS NULL AND status <> 'Suspended'`,
      [String(tenantSlug).trim()],
    );
    return rows.length > 0 ? rows[0].id : null;
  }

  // No slug given. Accept only when exactly one active organisation
  // exists, which is the single-tenant case. With two or more, the
  // identifier alone must not pick one.
  const { rows } = await query(
    `SELECT id FROM organisations
      WHERE deleted_at IS NULL AND status <> 'Suspended'
      ORDER BY id LIMIT 2`,
  );
  if (rows.length === 1) return rows[0].id;

  // Fall back to the email domain, if it names a tenant.
  const domain = String(email || '').split('@')[1];
  if (domain) {
    const { rows: byDomain } = await query(
      `SELECT id FROM organisations
        WHERE deleted_at IS NULL AND status <> 'Suspended'
          AND (slug = $1 OR lower(name) = $1)`,
      [domain.toLowerCase()],
    );
    if (byDomain.length === 1) return byDomain[0].id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Authenticate an email + password and open a session.
 *
 * @param {object} input
 * @param {string} input.email
 * @param {string} input.password
 * @param {string|null} [input.tenantSlug]
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @param {string} [input.deviceLabel]
 * @returns {Promise<object>} the login response body
 * @throws {Unauthorized|TooManyRequests}
 */
export async function login(input, deps = defaultDeps()) {
  const { transaction, getLoginCandidate, resolveAuthContext } = { ...defaultDeps(), ...deps };
  const email = String(input.email || '').trim();
  const tenantId = await resolveTenantId(input.tenantSlug, email, deps);

  // Unknown tenant. There is no account to count against, so this is a
  // straight 401 — same body as a wrong password.
  if (!tenantId) {
    await verifyPassword(DUMMY_HASH, input.password).catch(() => false);
    throw INVALID_CREDENTIALS();
  }

  return transaction(async (client) => {
    // Per-identifier lockout is checked first and applies whether or not
    // a user exists, so a spray across many addresses is throttled.
    const idLock = await getIdentifierLockout(client, tenantId, email);
    if (idLock.locked) {
      throw new TooManyRequests(
        'rate-limited',
        'Too many failed attempts. Try again later.',
        { retryAfterMs: idLock.retryAfterMs },
      );
    }

    const candidate = await getLoginCandidate(tenantId, email);

    if (!candidate) {
      // Persisted outside the failing transaction — see
      // persistFailureSideEffect.
      await persistFailureSideEffect(deps, (failClient) =>
        recordFailedLogin(failClient, { tenantId, identifier: email }),
      );
      // Still spend the verification cost so an unknown address and a
      // wrong password take the same time.
      await verifyPassword(DUMMY_HASH, input.password).catch(() => false);
      throw INVALID_CREDENTIALS();
    }

    const userLock = await getUserLockout(client, candidate.id);
    if (userLock.locked) {
      await verifyPassword(DUMMY_HASH, input.password).catch(() => false);
      await persistFailureSideEffect(deps, (failClient) =>
        recordAudit(failClient, {
          req: input.req,
          tenantId,
          userId: candidate.id,
          action: 'login-locked-out',
          entity: 'user',
          entityId: candidate.id,
          metadata: { email, failedLoginCount: userLock.failedLoginCount },
        }),
      );
      throw new TooManyRequests(
        'rate-limited',
        'Too many failed attempts. Try again later.',
        { retryAfterMs: userLock.retryAfterMs },
      );
    }

    const passwordOk = await verifyPassword(candidate.passwordHash, input.password);

    if (!passwordOk) {
      // Outside the failing transaction — see persistFailureSideEffect.
      let lock = { userLocked: false, identifierLocked: false };
      await persistFailureSideEffect(deps, async (failClient) => {
        lock = await recordFailedLogin(failClient, {
          tenantId,
          identifier: email,
          userId: candidate.id,
        });
        await recordAudit(failClient, {
          req: input.req,
          tenantId,
          userId: candidate.id,
          action: 'login-failed',
          entity: 'user',
          entityId: candidate.id,
          metadata: { reason: 'bad-password', email, locked: lock.userLocked || lock.identifierLocked },
        });
      });
      throw INVALID_CREDENTIALS();
    }

    // Password is right. Now the account has to be usable. The full
    // context is loaded so the classification rules apply — a Suspended
    // user with a correct password must not get a session.
    const resolved = await resolveAuthContext(candidate.id, tenantId);
    if (!resolved.ok) {
      await persistFailureSideEffect(deps, (failClient) =>
        recordFailedLogin(failClient, {
          tenantId,
          identifier: email,
          userId: candidate.id,
        }),
      );
      // A distinct code here — "this account is suspended" — would
      // confirm the credentials were valid for a disabled account, which
      // is an enumeration signal. Keep the generic 401; the operator
      // learns the account state from the audit log, not the caller.
      throw INVALID_CREDENTIALS();
    }

    // Two independent reasons to demand a second factor:
    //   'enabled'    — the user has enrolled. Always applies.
    //   'required'   — admin/super-admin with no MFA, while
    //                  AUTH_MFA_ENFORCE is on. They get a setup-only
    //                  challenge: enough to enrol, not enough to use the
    //                  account, so a missing enrolment locks an admin out
    //                  rather than leaving them wide open.
    const mfaState = await getMfaState(client, candidate.id);
    const mfaNeeded = mfaState.mfaEnabled
      ? 'enabled'
      : mfaRequiredForRole(candidate.role)
        ? 'required'
        : null;

    await clearFailedLogins(client, candidate.id, tenantId, email);

    // Opportunistic rehash: if the policy has been raised since this
    // password was set, upgrade it now. Failure is not fatal to the
    // login, so it is caught rather than surfaced.
    if (needsPasswordRehash(candidate.passwordHash)) {
      try {
        const upgraded = await hashPassword(input.password);
        await client.query(
          'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1',
          [candidate.id, upgraded],
        );
      } catch {
        /* keep the old hash; the next login will try again */
      }
    }

    // ── MFA GATE ────────────────────────────────────────────────────────
    // A correct password is only the FIRST factor. If the user has MFA
    // enabled, no session is created here: the caller gets a short-lived
    // challenge instead, and `completeMfaLogin` mints the tokens only
    // after the second factor verifies.
    //
    // The `last_login_at` write above is deliberately BEFORE this gate.
    // It records that the password was accepted, which is what an
    // operator reviewing a locked-out admin needs to see; the session
    // itself is what waits.
    await client.query(
      'UPDATE users SET last_login_at = now() WHERE id = $1',
      [candidate.id],
    );

    if (mfaNeeded) {
      const challenge = await issueChallenge({
        userId: candidate.id,
        tenantId,
        ip: input.ip,
        userAgent: input.userAgent,
      });
      await recordAudit(client, {
        req: input.req,
        tenantId,
        userId: candidate.id,
        action: 'mfa-challenge-issued',
        entity: 'user',
        entityId: candidate.id,
        metadata: { email, role: candidate.role, reason: mfaNeeded },
      });
      return {
        mfaRequired: true,
        // Named `mfaReason` rather than a bare boolean so the client can
        // tell "prove your second factor" from "you have not set one up",
        // which need different screens.
        mfaReason: mfaNeeded,
        challengeToken: challenge.challengeToken,
        expiresIn: challenge.expiresIn,
      };
    }

    const session = await createSession(client, {
      userId: candidate.id,
      tenantId,
      roleId: candidate.role,
      ip: input.ip,
      userAgent: input.userAgent,
      deviceLabel: input.deviceLabel,
    });

    const access = issueAccessToken({
      sub: candidate.id,
      tid: tenantId,
      rid: candidate.role,
      sid: session.sessionId,
    });

    await recordAudit(client, {
      req: input.req,
      tenantId,
      userId: candidate.id,
      action: 'login-succeeded',
      entity: 'user',
      entityId: candidate.id,
      metadata: {
        email,
        role: candidate.role,
        sessionId: session.sessionId,
        // Recorded so a security review can tell a normal sign-in from
        // one following a password reset or a compromise.
        passwordRehashed: needsPasswordRehash(candidate.passwordHash),
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
      sessionId: session.sessionId,
      user: {
        id: resolved.context.id,
        tenantId: resolved.context.tenantId,
        name: resolved.context.name,
        email: resolved.context.email,
        role: resolved.context.role,
        teamId: resolved.context.teamId,
        projectIds: resolved.context.projectIds,
        permissionMatrix: resolved.context.permissionMatrix,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// MFA completion
// ---------------------------------------------------------------------------

/**
 * The second step of login: verify the second factor, then mint the
 * session that `login` deliberately withheld.
 *
 * Kept separate from `login` rather than folded into it, because the two
 * steps are separated by user think-time and must not share a token. A
 * single "login with password and code" endpoint would have to hold the
 * pending session somewhere between requests — which is exactly the
 * challenge row, and holding it in memory would not survive a restart.
 *
 * @param {object} input
 * @param {string} input.challengeToken
 * @param {string} input.code
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @returns {Promise<object>} the same shape a non-MFA login returns
 * @throws {Unauthorized|TooManyRequests}
 */
export async function completeMfaLogin(input, deps = defaultDeps()) {
  const { transaction, resolveAuthContext } = { ...defaultDeps(), ...deps };

  // Verify the factor FIRST. Nothing is issued until this passes, so a
  // failed code cannot leave a half-created session behind.
  const result = await verifyChallenge({
    challengeToken: input.challengeToken,
    code: input.code,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  // A role that must have MFA but has not enrolled is issued a SETUP-ONLY
  // challenge: enough to complete enrolment, not enough to use the
  // account. `verifyChallenge` requires a real code, so a user in this
  // state cannot pass it — which is the point. They must call the setup
  // endpoint, which needs an authenticated session, which is granted by
  // the dedicated setup challenge below.
  if (!result) {
    throw new Unauthorized('invalid-challenge', 'This sign-in attempt is no longer valid. Sign in again.');
  }

  return transaction(async (client) => {
    const resolved = await resolveAuthContext(result.userId, result.tenantId);
    if (!resolved.ok) {
      throw new Unauthorized('invalid-credentials', 'Invalid email or password.');
    }

    const session = await createSession(client, {
      userId: result.userId,
      tenantId: result.tenantId,
      roleId: resolved.context.role,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    const access = issueAccessToken({
      sub: result.userId,
      tid: result.tenantId,
      rid: resolved.context.role,
      sid: session.sessionId,
    });

    await recordAudit(client, {
      req: input.req,
      tenantId: result.tenantId,
      userId: result.userId,
      action: 'login-succeeded',
      entity: 'user',
      entityId: result.userId,
      metadata: {
        method: result.method,
        mfa: true,
        role: resolved.context.role,
        sessionId: session.sessionId,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
      sessionId: session.sessionId,
      user: {
        id: resolved.context.id,
        tenantId: resolved.context.tenantId,
        name: resolved.context.name,
        email: resolved.context.email,
        role: resolved.context.role,
        permissionMatrix: resolved.context.permissionMatrix,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for a new access/refresh pair.
 *
 * A replayed token revokes its whole family and forces a fresh login.
 * That is the safe response: by the time a stolen token is presented
 * twice, we cannot tell the attacker from the legitimate client.
 *
 * @param {object} input
 * @param {string} input.refreshToken
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @returns {Promise<object>}
 * @throws {Unauthorized}
 */
export async function refresh(input, deps = defaultDeps()) {
  const { transaction, resolveAuthContext } = { ...defaultDeps(), ...deps };

  // A replayed token must stay revoked even though the caller gets a 401.
  //
  // The obvious shape — throw Unauthorized from inside transaction() —
  // is wrong, and was wrong until 2026-09-27: transaction() rolls back
  // on throw, which un-did the family revocation that rotateSession()
  // had just performed. The security response to a stolen-token replay
  // was silently discarded, and the attacker's successor token stayed
  // live. The old code even had a comment conceding the rollback.
  //
  // So the work is committed first and the error is raised afterwards.
  // The lockout counter in login() has the same constraint; see
  // docs/BACKEND_SCAFFOLD_STATUS.md.
  let failure = null;
  const outcome = await transaction(async (client) => {
    const result = await rotateSession(client, input.refreshToken);

    if (!result.ok) {
      // One message for every reason. Telling a caller their token
      // "expired" versus "revoked" versus "already used" would let them
      // probe which tokens are real.
      //
      // A compromise IS audited loudly, because unlike the response
      // body, the audit row is not visible to the caller and is exactly
      // what an operator needs to see. The family has already been
      // revoked by rotateSession().
      if (result.reason === 'compromise-detected') {
        await recordAudit(client, {
          req: input.req,
          // `audit_log.tenant_id` is NOT NULL, and refresh() is called
          // without a request context in most call paths, so the request
          // is not a reliable source. rotateSession returns the session
          // it found; without this the INSERT failed the constraint and
          // aborted the transaction, rolling back the family revocation
          // — the one thing replay detection exists to do.
          tenantId: input.req?.user?.tenantId ?? result.session?.tenantId ?? null,
          userId: input.req?.user?.id ?? result.session?.userId ?? null,
          action: 'refresh-token-replayed',
          entity: 'refresh_session',
          entityId: result.session?.id ?? null,
          metadata: {
            note: 'Presented token was already rotated. Family revoked.',
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
          },
        }).catch((err) => {
          // An audit failure must not mask the 401. Log it, then make
          // sure the revocation survives: a swallowed rejection here
          // still leaves this transaction in a failed state, which would
          // roll back the family revocation.
          console.error('[auth] failed to audit token replay:', err?.message ?? err);
        });
      }
      failure = new Unauthorized(
        'invalid-refresh-token',
        'Session is no longer valid. Sign in again.',
      );
      // Returning normally is what commits the revocation. The caller
      // still receives `failure` below.
      return null;
    }

    // The user behind the session must still be usable. A role change
    // or a suspension takes effect on the next refresh, not when the
    // access token expires.
    const resolved = await resolveAuthContext(result.session.userId, result.session.tenantId);
    if (!resolved.ok) {
      // Same commit-then-fail shape as above: the sessions revoked here
      // must survive the 401, or a suspended user keeps refreshing.
      await revokeAllSessions(client, result.session.userId);
      failure = new Unauthorized(
        'invalid-refresh-token',
        'Session is no longer valid. Sign in again.',
      );
      return null;
    }

    const access = issueAccessToken({
      sub: result.session.userId,
      tid: result.session.tenantId,
      rid: resolved.context.role,
      sid: result.session.id,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.refreshExpiresAt,
      sessionId: result.session.id,
      user: {
        id: resolved.context.id,
        tenantId: resolved.context.tenantId,
        name: resolved.context.name,
        email: resolved.context.email,
        role: resolved.context.role,
        permissionMatrix: resolved.context.permissionMatrix,
      },
    };
  });

  if (failure) throw failure;
  return outcome;
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Revoke the session addressed by a refresh token.
 *
 * @param {string} refreshToken
 * @param {AuthDeps} [deps]
 * @returns {Promise<{ revoked: boolean }>}
 */
export async function logout(refreshToken, deps = defaultDeps(), req = null) {
  if (!refreshToken) return { revoked: false };
  const { transaction } = { ...defaultDeps(), ...deps };
  return transaction(async (client) => {
    // RETURNING is what makes this audit row writable. `audit_log.
    // tenant_id` is NOT NULL, and logout is routinely called with no
    // request context, so `req.user?.tenantId` was null and the INSERT
    // failed the constraint — which rolled the whole transaction back,
    // so the session was never revoked and the caller got a 500. The
    // tenant is on the row being revoked.
    const session = await revokeSessionByTokenDetailed(client, refreshToken);
    if (session) {
      await recordAudit(client, {
        req,
        tenantId: req?.user?.tenantId ?? session.tenantId,
        userId: req?.user?.id ?? session.userId,
        action: 'logout',
        entity: 'refresh_session',
        entityId: session.id,
        metadata: { revoked: true },
      });
    }
    return { revoked: session !== null };
  });
}

/**
 * Revoke every live session for a user.
 *
 * @param {string} userId
 * @param {AuthDeps} [deps]
 * @returns {Promise<{ revoked: number }>}
 */
export async function logoutAll(userId, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };
  return transaction(async (client) => ({
    revoked: await revokeAllSessions(client, userId),
  }));
}

/**
 * List a user's live sessions, for the "active devices" screen.
 *
 * @param {string} userId
 * @param {AuthDeps} [deps]
 * @returns {Promise<Array<object>>}
 */
export async function listSessionsForUser(userId, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };
  return transaction((client) => listLiveSessions(client, userId));
}

export { INVALID_CREDENTIALS, DUMMY_HASH };
