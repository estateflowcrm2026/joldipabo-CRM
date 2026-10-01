// /api/v1/auth/* — login, refresh, logout, MFA, invite, accept-invite,
// OTP request/verify, forgot/reset password, impersonation, /me.
//
// Implemented: login (with MFA challenge), MFA challenge/verify,
// MFA setup/verify-setup/disable/backup-codes/status, refresh, logout,
// logout-all, me.
// Still stubs: OTP, impersonation. See docs/AUTH_API_SPEC.md for the full
// contract.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { BadRequest, Forbidden, NotImplemented } from '../utils/errors.js';
import { transaction, getDb } from '../db/client.js';
import {
  authorizeCookieRequest,
  clearSessionCookies,
  readRefreshToken,
  sessionCookies,
  withoutRefreshToken,
} from '../auth/sessionCookie.js';
import { getOutbox, clearOutbox } from '../auth/mailer.js';
import { secondsRemaining } from '../auth/totp.js';
import {
  login,
  refresh,
  logout,
  logoutAll,
  resolveTenantId,
  completeMfaLogin,
} from '../repositories/authService.js';
import {
  startSetup as startMfaSetup,
  confirmSetup as confirmMfaSetup,
  disable as disableMfa,
  regenerateBackupCodes,
  issueChallenge,
  verifyChallenge,
  mfaRequiredForRole,
} from '../auth/mfaService.js';
import { countUnusedBackupCodes } from '../repositories/mfaRepository.js';
import {
  inviteUser,
  acceptInvite,
  forgotPassword,
  resetPassword,
} from '../repositories/onboardingService.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/AUTH_API_SPEC.md.';

/** Deployment kill-switches. Off means the flow is unavailable. */
const invitesEnabled = () => process.env.AUTH_INVITES_ENABLED !== 'false';
const resetsEnabled = () => process.env.AUTH_RESETS_ENABLED !== 'false';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function authRoutes(fastify) {
  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  fastify.post('/auth/login', async (req, reply) => {
    const { tenantSlug, email, password, deviceLabel } = req.body || {};
    if (!email || !password) {
      throw new BadRequest('invalid-payload', 'email and password are required.');
    }
    const result = await login(
      {
        email,
        password,
        tenantSlug: tenantSlug ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        deviceLabel: deviceLabel ?? null,
        req,
      },
    );

    // A challenge issues no session, so there is no cookie to set.
    if (result.mfaRequired) return result;

    // A body token is also returned when the caller cannot hold the
    // cookie. Setting the cookie AND returning the token would give a
    // browser two copies of the same credential, one of them readable by
    // whatever script can reach the response — which is what the cookie
    // exists to prevent.
    //
    // `Accept: application/json` with NO Origin is the non-browser
    // client: a script, a CLI, a test harness. Those keep the token in the
    // body, and the `Set-Cookie` header is simply ignored. A browser
    // always sends an Origin on a cross-origin fetch, so this cannot
    // downgrade the browser path.
    const cookieCapable = Boolean(req.headers.origin);
    if (cookieCapable) {
      for (const cookie of sessionCookies({
        refreshToken: result.refreshToken,
        expiresAt: new Date(result.refreshExpiresAt),
      })) {
        reply.header('set-cookie', cookie);
      }
      return withoutRefreshToken(result);
    }
    return result;
  });

  fastify.post('/auth/refresh', async (req, reply) => {
    const found = readRefreshToken(req);
    if (!found) {
      throw new BadRequest('invalid-payload', 'No session cookie or refreshToken was supplied.');
    }
    const auth = authorizeCookieRequest(req);
    if (!auth.ok) {
      // A cookie was present but the request failed CSRF: that is a
      // forged or stale request, and it must not be answered with a
      // token. 403 rather than 401, so a client can tell "you are not
      // signed in" from "this request will not be served".
      throw new Forbidden('csrf-rejected', `Session request refused: ${auth.reason}.`);
    }

    const result = await refresh({
      refreshToken: found.token,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (found.source === 'cookie') {
      // Rotation: the old token is spent, so the cookie must be replaced
      // with the new one or the next refresh presents a spent token and
      // the whole family is revoked as a replay.
      for (const cookie of sessionCookies({
        refreshToken: result.refreshToken,
        expiresAt: new Date(result.refreshExpiresAt),
      })) {
        reply.header('set-cookie', cookie);
      }
    }
    return found.source === 'cookie' ? withoutRefreshToken(result) : result;
  });

  // Logout is intentionally unauthenticated: a client whose access
  // token has already expired must still be able to end the session.
  // The refresh token in the body is the only credential needed, and it
  // is the thing being revoked. Idempotent — logging out twice is not
  // an error.
  fastify.post('/auth/logout', async (req, reply) => {
    const found = readRefreshToken(req);
    if (!found) {
      throw new BadRequest('invalid-payload', 'No session cookie or refreshToken was supplied.');
    }
    // Logout is deliberately not CSRF-gated. A cross-site forced logout
    // is an annoyance; refusing it would leave a user unable to end a
    // session from a page that failed the CSRF check, and the session
    // expires on its own regardless. The token is still verified, so a
    // forged request can only end the caller's own session.
    const result = await logout(found.token, undefined, req);
    for (const cookie of clearSessionCookies()) {
      reply.header('set-cookie', cookie);
    }
    return result;
  });

  // -------------------------------------------------------------------------
  // Account lifecycle
  // -------------------------------------------------------------------------

  /** Resolve the tenant from the request, or fail with 400. */
  async function requireTenant(req) {
    const { tenantSlug, email } = req.body || {};
    const tenantId = await resolveTenantId(tenantSlug ?? null, email ?? '');
    if (!tenantId) {
      throw new BadRequest(
        'invalid-payload',
        'tenantSlug is required, or the deployment must have exactly one organisation.',
      );
    }
    return tenantId;
  }

  // Invite: admin-only. `staff:create` is the permission that already
  // governs adding a person to the staff list.
  fastify.post(
    '/auth/invite',
    { preHandler: [authMiddleware, requirePermission('staff', 'create')] },
    async (req) => {
      const tenantId = await requireTenant(req);
      const { email, name, phone, roleId, teamId, branchId, designation, permissionMatrix } =
        req.body || {};

      return transaction((client) =>
        inviteUser({
          client,
          actor: req.user,
          tenantId,
          email,
          name,
          phone,
          roleId,
          teamId,
          branchId,
          designation,
          permissionMatrix,
          invitesEnabled: invitesEnabled(),
          req,
        }),
      );
    },
  );

  // Accept: public. The token is the credential; the user cannot log in
  // until this succeeds, so no prior auth is possible.
  fastify.post('/auth/accept-invite', async (req) => {
    const { token, password } = req.body || {};
    if (!token || !password) {
      throw new BadRequest('invalid-payload', 'token and password are required.');
    }
    return transaction((client) => acceptInvite({ client, token, password, req }));
  });

  // Forgot: public, and deliberately uninformative. A known address and
  // an unknown one produce the same 202.
  fastify.post('/auth/forgot-password', async (req) => {
    const tenantId = await requireTenant(req);
    const { email } = req.body || {};
    if (!email) {
      throw new BadRequest('invalid-payload', 'email is required.');
    }
    return transaction((client) =>
      forgotPassword({ client, email, tenantId, resetsEnabled: resetsEnabled(), req }),
    );
  });

  // Reset: public. Consumes the token and revokes every session, so a
  // password change takes effect immediately for whoever held the old one.
  fastify.post('/auth/reset-password', async (req) => {
    const { token, password } = req.body || {};
    if (!token || !password) {
      throw new BadRequest('invalid-payload', 'token and password are required.');
    }
    return transaction((client) => resetPassword({ client, token, password, req }));
  });

  // -------------------------------------------------------------------------
  // MFA
  //
  // Two phases, deliberately separate.
  //
  //   /auth/mfa/challenge   public. Completes the second step of a login
  //                         that returned `mfaRequired`. Possession of the
  //                         challenge token is what authorises it — that
  //                         token is only ever issued after a correct
  //                         password, so it stands in for the first factor.
  //
  //   /auth/mfa/*           authenticated. Enrolment and management. These
  //                         already have a session, so they need no
  //                         challenge.
  //
  // The one exception is disabling MFA, which requires the caller to
  // re-present a current code even though they are authenticated. A
  // stolen access token must not be enough to strip the second factor —
  // that would turn a partial compromise into a full one.
  // -------------------------------------------------------------------------

  fastify.post('/auth/mfa/challenge', async (req, reply) => {
    const { challengeToken, code } = req.body || {};
    if (!challengeToken || !code) {
      throw new BadRequest('invalid-payload', 'challengeToken and code are required.');
    }
    // The MFA login issues a session exactly like /auth/login, so it must
    // set the same cookie pair — otherwise the MFA path ends up with a
    // token the client has to keep in memory and the two paths disagree
    // about what survives a reload.
    const result = await completeMfaLogin({
      challengeToken,
      code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      req,
    });

    // Same rule as /auth/login: a browser (which always sends an Origin on
    // a cross-origin fetch) gets the cookie and NO refresh token in the
    // body; a non-browser client gets the body token and no cookie.
    // Returning both to a browser would put a second, readable copy of a
    // credential next to the HttpOnly one.
    if (!req.headers.origin) return result;
    for (const cookie of sessionCookies({
      refreshToken: result.refreshToken,
      expiresAt: new Date(result.refreshExpiresAt),
    })) {
      reply.header('set-cookie', cookie);
    }
    return withoutRefreshToken(result);
  });

  fastify.post('/auth/mfa/setup', { preHandler: authMiddleware }, async (req) => {
    const out = await startMfaSetup({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      email: req.user.email,
      req,
    });
    // `secret` is returned so a client without QR rendering can display
    // it for manual entry. It is NOT logged and NOT in the audit row.
    return { ...out, secondsRemaining: secondsRemaining() };
  });

  fastify.post('/auth/mfa/verify-setup', { preHandler: authMiddleware }, async (req) => {
    const { code } = req.body || {};
    if (!code) throw new BadRequest('invalid-payload', 'code is required.');
    const out = await confirmMfaSetup({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      code,
      req,
    });
    return { ...out, warning: 'These codes are shown once. Store them now.' };
  });

  fastify.post('/auth/mfa/disable', { preHandler: authMiddleware }, async (req) => {
    const { code, reason } = req.body || {};
    if (!code) {
      throw new BadRequest(
        'invalid-payload',
        'A current authentication code is required to disable MFA.',
      );
    }
    // Verified through a throwaway challenge so the same code path,
    // rate limiting and audit trail apply as a normal login challenge.
    const challenge = await issueChallenge({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await verifyChallenge({
      challengeToken: challenge.challengeToken,
      code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      req,
    });
    await disableMfa({ userId: req.user.id, tenantId: req.user.tenantId, reason, req });
    return { mfaEnabled: false };
  });

  fastify.post('/auth/mfa/backup-codes', { preHandler: authMiddleware }, async (req) => {
    const { code } = req.body || {};
    if (!code) {
      throw new BadRequest(
        'invalid-payload',
        'A current authentication code is required to regenerate backup codes.',
      );
    }
    const challenge = await issueChallenge({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await verifyChallenge({
      challengeToken: challenge.challengeToken,
      code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      req,
    });
    const out = await regenerateBackupCodes({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      req,
    });
    return { ...out, warning: 'The previous codes no longer work. Store these now.' };
  });

  fastify.get('/auth/mfa/status', { preHandler: authMiddleware }, async (req) => {
    const db = getDb();
    const { rows } = await db.query(
      'SELECT mfa_enabled, mfa_enabled_at FROM users WHERE id = $1',
      [req.user.id],
    );
    const remaining = rows[0]?.mfa_enabled
      ? await countUnusedBackupCodes(db, req.user.id)
      : null;
    return {
      mfaEnabled: Boolean(rows[0]?.mfa_enabled),
      mfaEnabledAt: rows[0]?.mfa_enabled_at ?? null,
      backupCodesRemaining: remaining,
      required: mfaRequiredForRole(req.user.role),
    };
  });

  // -------------------------------------------------------------------------
  // Dev-only outbox
  // -------------------------------------------------------------------------

  // Captured mail, for a developer with no SMTP server. Refused in
  // production without exception: an unauthenticated endpoint that
  // returns live reset and invite tokens is a password-takeover primitive.
  fastify.get('/auth/dev/outbox', async (req, reply) => {
    if (process.env.NODE_ENV === 'production') {
      throw new NotImplemented('not-implemented', 'The dev outbox is disabled in production.');
    }
    if (!req.query.clear) return { messages: getOutbox() };
    clearOutbox();
    reply.code(204);
    return null;
  });

  // -------------------------------------------------------------------------
  // Authenticated
  // -------------------------------------------------------------------------

  fastify.get('/auth/me', { preHandler: authMiddleware }, async (req) => {
    return {
      user: {
        id: req.user.id,
        tenantId: req.user.tenantId,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        teamId: req.user.teamId,
        projectIds: req.user.projectIds,
        permissionMatrix: req.user.permissionMatrix,
        status: req.user.status,
      },
      session: req.auth
        ? { source: req.auth.source, sessionId: req.auth.sessionId }
        : null,
    };
  });

  // `GET /security/sessions` and `DELETE /security/sessions/:id` are
  // registered in routes/users.js, which owns that path prefix. They
  // are implemented there rather than duplicated here.
  fastify.post('/auth/logout-all', { preHandler: authMiddleware }, async (req) => {
    return logoutAll(req.user.id);
  });

  // -------------------------------------------------------------------------
  // Still stubs
  // -------------------------------------------------------------------------

  const stubs = [
    ['post',   '/auth/request-otp'],
    ['post',   '/auth/verify-otp'],
    ['post',   '/auth/impersonate'],
    ['post',   '/auth/end-impersonate'],
  ];
  for (const [method, path] of stubs) {
    fastify[method](path, async () => {
      throw new NotImplemented('not-implemented', NOT_IMPLEMENTED);
    });
  }
}
