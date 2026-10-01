// /api/v1/teams/* — list, create, update.
//
// Documented in docs/BACKEND_INTEGRATION_PLAN.md §7 "Teams & Projects".

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function teamRoutes(fastify) {
  const auth = [authMiddleware];
  // Teams management falls under staff.edit; the route handler will
  // additionally restrict mutating endpoints to admin/sales-manager.
  fastify.get('/teams',          { preHandler: [...auth, requirePermission('staff', 'view')] }, async () => ({ items: [], placeholder: true }));
  fastify.post('/teams',         { preHandler: [...auth, requirePermission('staff', 'edit')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/teams/:id',    { preHandler: [...auth, requirePermission('staff', 'edit')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
