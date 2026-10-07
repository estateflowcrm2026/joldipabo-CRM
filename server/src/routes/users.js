// /api/v1/users/* and /api/v1/security/sessions/*.
//
// Documented in docs/AUTH_API_SPEC.md §6, §7, §13, §14 and
// docs/RBAC_SERVER_ENFORCEMENT.md §2.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented, BadRequest, NotFound } from '../utils/errors.js';
import { query, transaction } from '../db/client.js';
import {
  listSessionsForUser,
  logout,
  logoutAll,
} from '../repositories/authService.js';
import {
  listStaff,
  validateStaffFilters,
} from '../repositories/staffRepository.js';
import {
  createStaff,
  adminResetPassword,
} from '../repositories/staffManagement.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/AUTH_API_SPEC.md.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function userRoutes(fastify) {
  const auth = { preHandler: authMiddleware };

  // Staff (users) endpoints
  //
  // GET /users is the live staff directory: tenant-scoped, filtered by the
  // caller's `staff:view` scope inside listStaff (all / team+self /
  // project-shared+self / own-self / none-fail-closed). The DTO carries no
  // secrets — password_hash, MFA material, tokens and permission_matrix are
  // never selected.
  //
  // POST /users is manual staff creation: the admin types an initial
  // password (hashed with Argon2id, never stored or returned) and shares
  // it with the new staff member out of band. No email is sent — that is
  // the invite flow (`POST /auth/invite`), which is a separate system.
  fastify.get('/users',          { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'view')] }, async (req) => listStaff(req.user, { ...validateStaffFilters(req.query), limit: req.query?.limit, offset: req.query?.offset }));
  fastify.get('/users/:id',      { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'view')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/users',
    { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'create')] },
    async (req) => transaction((client) => createStaff({
      client,
      actor: req.user,
      name: req.body?.name,
      email: req.body?.email,
      phone: req.body?.phone,
      roleId: req.body?.roleId ?? req.body?.role,
      teamId: req.body?.teamId ?? req.body?.team,
      designation: req.body?.designation,
      status: req.body?.status,
      initialPassword: req.body?.initialPassword,
      req,
    })),
  );
  // Admin password reset: sets a new password directly, clears the lockout
  // counters, and revokes every session. The plaintext is hashed and never
  // returned; the response is a confirmation only.
  fastify.post('/users/:id/reset-password',
    { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'edit')] },
    async (req) => transaction((client) => adminResetPassword({
      client,
      actor: req.user,
      userId: req.params.id,
      newPassword: req.body?.newPassword,
      req,
    })),
  );
  fastify.patch('/users/:id',    { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'edit')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.delete('/users/:id',   { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'delete')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });

  // Security: sessions + unlock + restore
  //
  // These were previously registered with a bare `authMiddleware` and
  // no permission gate — the audit flagged that. A session list is the
  // caller's own data and needs only authentication; the admin
  // actions below require `staff:edit` because they act on someone
  // else's account.
  fastify.get('/security/sessions', auth, async (req) => ({
    sessions: await listSessionsForUser(req.user.id),
  }));

  // Revoking one device. The body's refresh token is the credential,
  // so a row cannot be reached by guessing an id in the path.
  fastify.delete('/security/sessions/:id', auth, async (req) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      throw new BadRequest('invalid-payload', 'refreshToken is required.');
    }
    return logout(refreshToken);
  });

  fastify.post('/security/users/:id/unlock',    { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'edit')] }, async (req) => {
    // Clears the failed-login counter and any active lockout, so an
    // administrator can restore access without a password reset.
    const { rows } = await query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL
        WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (rows.length === 0) throw new NotFound('not-found', 'User not found.');
    return { ok: true, userId: rows[0].id, unlocked: true };
  });

  fastify.post('/security/users/:id/revoke-sessions', { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'edit')] }, async (req) => ({
    revoked: await logoutAll(req.params.id),
  }));
  fastify.post('/users/:id/restore',            { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'edit')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
