// /api/v1/reports/* — pipeline, attendance, async export jobs.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function reportRoutes(fastify) {
  const auth = [authMiddleware];
  fastify.get('/reports/pipeline',          { preHandler: [...auth, requirePermission('reports', 'view')] },   async () => ({ placeholder: true }));
  fastify.get('/reports/attendance',        { preHandler: [...auth, requirePermission('attendance', 'view')] },async () => ({ placeholder: true }));
  fastify.post('/reports/leads/export',     { preHandler: [...auth, requirePermission('reports', 'export')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.get('/reports/jobs/:id',          { preHandler: [...auth, requirePermission('reports', 'view')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.get('/activity',                  { preHandler: [...auth, requirePermission('reports', 'view')] },   async () => ({ items: [], placeholder: true }));
  fastify.get('/activity/export',           { preHandler: [...auth, requirePermission('reports', 'export')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
