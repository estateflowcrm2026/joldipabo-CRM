// /api/v1/roles/* — list, create, update, delete, and matrix patches.
//
// System-role protection lives in the handler: even when an admin has
// roles.edit = 'all', the handler refuses mutations on rows where
// roles.is_system = true unless the actor is super-admin.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/RBAC_SERVER_ENFORCEMENT.md §5.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function roleRoutes(fastify) {
  const auth = [authMiddleware];
  fastify.get('/roles',                  { preHandler: [...auth, requirePermission('roles', 'view')] },   async () => ({ items: [], placeholder: true }));
  fastify.post('/roles',                 { preHandler: [...auth, requirePermission('roles', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/roles/:id',            { preHandler: [...auth, requirePermission('roles', 'edit')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/roles/:id/matrix',     { preHandler: [...auth, requirePermission('roles', 'edit')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.delete('/roles/:id',           { preHandler: [...auth, requirePermission('roles', 'delete')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
