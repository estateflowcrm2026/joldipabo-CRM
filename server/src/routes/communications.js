// /api/v1/threads/* — list, create, list messages, send message.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function commRoutes(fastify) {
  const auth = [authMiddleware];
  fastify.get('/threads',                          { preHandler: [...auth, requirePermission('communications', 'view')] },   async () => ({ items: [], placeholder: true }));
  fastify.post('/threads',                         { preHandler: [...auth, requirePermission('communications', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.get('/threads/:id/messages',             { preHandler: [...auth, requirePermission('communications', 'view')] },   async () => ({ items: [], placeholder: true }));
  fastify.post('/threads/:id/messages',            { preHandler: [...auth, requirePermission('communications', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
