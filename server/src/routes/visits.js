// /api/v1/visits/* — list, detail, create, update, complete.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function visitRoutes(fastify) {
  const auth = [authMiddleware];
  fastify.get('/visits',                { preHandler: [...auth, requirePermission('visits', 'view')] },   async () => ({ items: [], placeholder: true }));
  fastify.get('/visits/:id',            { preHandler: [...auth, requirePermission('visits', 'view')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/visits',               { preHandler: [...auth, requirePermission('visits', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/visits/:id',          { preHandler: [...auth, requirePermission('visits', 'edit')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/visits/:id/complete',  { preHandler: [...auth, requirePermission('visits', 'approve')] },async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
