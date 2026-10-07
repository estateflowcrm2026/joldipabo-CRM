// /api/v1/projects/* — list, create, update, member management.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';
import {
  listProjects,
  validateProjectFilters,
} from '../repositories/projectsRepository.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function projectRoutes(fastify) {
  const auth = [authMiddleware];
  // GET /projects is the live projects directory: tenant-scoped, filtered
  // by the caller's `projects:view` scope inside listProjects (all /
  // team-member-projects+own / own / own / none-fail-closed). The DTO carries
  // the manager's name and unit counts — amenities, RERA numbers and
  // possession dates are not exposed.
  fastify.get('/projects',                          { preHandler: [...auth, requirePermission('projects', 'view')] },   async (req) => listProjects(req.user, { ...validateProjectFilters(req.query), limit: req.query?.limit, offset: req.query?.offset }));
  fastify.post('/projects',                         { preHandler: [...auth, requirePermission('projects', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/projects/:id',                    { preHandler: [...auth, requirePermission('projects', 'edit')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.get('/projects/:id/members',              { preHandler: [...auth, requirePermission('staff', 'view')] },     async () => ({ items: [], placeholder: true }));
  fastify.post('/projects/:id/members',             { preHandler: [...auth, requirePermission('staff', 'edit')] },     async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.delete('/projects/:id/members/:userId',   { preHandler: [...auth, requirePermission('staff', 'edit')] },     async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
