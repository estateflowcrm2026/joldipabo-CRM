import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { BadRequest } from '../utils/errors.js';
import {
  addVisitViewing, createVisit, getVisit, listVisitAssignees, listVisits,
  reassignVisit, updateVisitStatus,
} from '../repositories/visitsRepository.js';
import {
  validateScheduleVisit, validateVisitAssignment, validateVisitList, validateVisitStatus, validateVisitViewing,
} from '../repositories/visitValidation.js';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function visitRoutes(fastify) {
  const gate = (action) => ({ preHandler: [authMiddleware, requirePermission('visits', action)] });
  const id = (req) => {
    if (!req.params?.id) throw new BadRequest('invalid-id', 'Visit id is required.');
    return req.params.id;
  };

  fastify.get('/visits', gate('view'), async (req) => listVisits(req.user, validateVisitList(req.query)));
  fastify.get('/visits/assignees', gate('create'), async (req) => listVisitAssignees(req.user));
  fastify.get('/visits/:id', gate('view'), async (req) => getVisit(req.user, id(req)));
  fastify.post('/visits', gate('create'), async (req, reply) =>
    reply.code(201).send(await createVisit(req.user, validateScheduleVisit(req.body), req)));
  fastify.post('/visits/:id/status', gate('edit'), async (req) =>
    updateVisitStatus(req.user, id(req), (previous) => validateVisitStatus(req.body, previous), req));
  fastify.post('/visits/:id/assign', gate('assign'), async (req) =>
    reassignVisit(req.user, id(req), validateVisitAssignment(req.body), req));
  fastify.post('/visits/:id/viewings', gate('edit'), async (req, reply) =>
    reply.code(201).send(await addVisitViewing(req.user, id(req), validateVisitViewing(req.body), req)));
  fastify.post('/visits/:id/complete', gate('edit'), async (req) =>
    updateVisitStatus(req.user, id(req), (previous) => validateVisitStatus({ status: 'Completed', note: req.body?.note }, previous), req));
}
