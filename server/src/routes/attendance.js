// /api/v1/attendance/* — list, check-in, check-out, approve.
//
// Check-in / check-out are the offline-queue endpoints that the sync
// worker replays (see docs/SYNC_WORKER_PLAN.md §3).

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function attendanceRoutes(fastify) {
  const auth = [authMiddleware];
  fastify.get('/attendance',                { preHandler: [...auth, requirePermission('attendance', 'view')] },   async () => ({ items: [], placeholder: true }));
  fastify.post('/attendance/check-in',      { preHandler: [...auth, requirePermission('attendance', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/attendance/check-out',     { preHandler: [...auth, requirePermission('attendance', 'edit')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/attendance/:id/approve',  { preHandler: [...auth, requirePermission('attendance', 'approve')] },async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
