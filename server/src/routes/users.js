// /api/v1/users/* and /api/v1/security/sessions/*.
//
// Documented in docs/AUTH_API_SPEC.md §6, §7, §13, §14 and
// docs/RBAC_SERVER_ENFORCEMENT.md §2.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented, BadRequest, NotFound } from '../utils/errors.js';
import { query } from '../db/client.js';
import {
  listSessionsForUser,
  logout,
  logoutAll,
} from '../repositories/authService.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/AUTH_API_SPEC.md.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function userRoutes(fastify) {
  const auth = { preHandler: authMiddleware };

  // Staff (users) endpoints
  fastify.get('/users',          { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'view')] }, async () => ({ items: [], placeholder: true }));
  fastify.get('/users/:id',      { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'view')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/users',         { ...auth, preHandler: [authMiddleware, requirePermission('staff', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
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
