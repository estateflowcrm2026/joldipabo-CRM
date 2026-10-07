// /api/v1/teams/* — list, create, update.
//
// Documented in docs/BACKEND_INTEGRATION_PLAN.md §7 "Teams & Projects".

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';
import {
  listTeams,
  validateTeamFilters,
} from '../repositories/teamsRepository.js';

const NOT_IMPLEMENTED = 'Not implemented yet — see docs/BACKEND_INTEGRATION_PLAN.md §7.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function teamRoutes(fastify) {
  const auth = [authMiddleware];
  // Teams management falls under staff.edit; the route handler will
  // additionally restrict mutating endpoints to admin/sales-manager.
  //
  // GET /teams is the live teams directory: tenant-scoped, filtered by the
  // caller's `staff:view` scope inside listTeams (all / own-team /
  // project-member-teams+own / own-team / none-fail-closed). The DTO carries
  // member counts and the lead's name — nothing secret exists on this table.
  fastify.get('/teams',          { preHandler: [...auth, requirePermission('staff', 'view')] }, async (req) => listTeams(req.user, { ...validateTeamFilters(req.query), limit: req.query?.limit, offset: req.query?.offset }));
  fastify.post('/teams',         { preHandler: [...auth, requirePermission('staff', 'edit')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/teams/:id',    { preHandler: [...auth, requirePermission('staff', 'edit')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
