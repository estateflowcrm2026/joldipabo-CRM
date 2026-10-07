// /api/v1/leads/* — list, detail, create, update, assign, soft-delete.
//
// All routes are wired against Postgres. RBAC behaviour mirrors listings:
//
//   * The coarse-grained `leads:<action>` check runs in requirePermission.
//   * Row-level filtering happens at SQL via
//     scopeFilterFor(user, 'leads', 'view').
//   * Mutation routes additionally call can() on the loaded record to
//     refuse out-of-scope rows (e.g. a field-executive attempting to
//     edit another FE's lead).
//   * Out-of-scope rows return 404 — same shape as a true not-found —
//     so the existence of rows in other teams / projects is not leaked.
//   * Owner / team reassignment goes through /assign; PATCH refuses to
//     touch ownerId / teamId directly, so the audit trail has one path.
//
// All mutations run in transactions; the audit row commits with the
// data row so an audit failure rolls back the mutation.
//
// CSV export (GET /leads/:id/export.csv) remains not-implemented:
// nothing in the UI needs it yet, and shipping an untested endpoint
// would be a leak surface we cannot afford.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { can } from '../rbac/permissions.js';
import { BadRequest, NotFound, NotImplemented } from '../utils/errors.js';
import {
  assignLead,
  createLead,
  getLeadById,
  listLeads,
  softDeleteLead,
  updateLead,
  validateAssignLead,
  validateCreateLead,
  validateUpdateLead,
} from '../repositories/leadsRepository.js';
import { getLeadTimeline } from '../repositories/leadTimelineRepository.js';
import { validateFollowUpFilters } from '../repositories/followUpValidation.js';
import { DB_NOT_CONFIGURED } from '../db/client.js';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function leadRoutes(fastify) {
  const auth = [authMiddleware];

  // ---- READ (wired) ----------------------------------------------------------

  fastify.get(
    '/leads',
    { preHandler: [...auth, requirePermission('leads', 'view')] },
    async (req) => {
      const items = await listLeads({
        user: req.user,
        filters: extractFilters(req.query),
        pagination: { limit: req.query.limit, offset: req.query.offset },
      });
      return items;
    },
  );

  fastify.get(
    '/leads/:id',
    { preHandler: [...auth, requirePermission('leads', 'view')] },
    async (req) => {
      const leadId = (req.params && req.params.id) || null;
      if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');

      const dto = await getLeadById({ user: req.user, leadId });
      if (!dto) throw new NotFound('not-found', 'Lead not found.');

      // Row-level RBAC. can() reads `ownerId` and `teamId` directly off
      // the record. The DTO exposes them on `.owner.id` and `.teamId`,
      // so synthesise the shape can() expects.
      const record = {
        ownerId: dto.owner ? dto.owner.id : null,
        teamId: dto.teamId ?? null,
        projectId: dto.project ? dto.project.id : null,
      };
      if (!can(req.user, 'leads', 'view', record)) {
        throw new NotFound('not-found', 'Lead not found.');
      }
      return dto;
    },
  );

  // GET /leads/:id/timeline — one chronological history per lead.
  //
  // Read-only aggregation over contacts/contact_calls, the lead row,
  // visit_events and visit_viewings. The lead itself is scope-checked
  // exactly like GET /leads/:id (out-of-scope → 404, never 403).
  // Everything else is filtered inside the repository: out-of-scope
  // visits and an out-of-scope linked contact are skipped silently,
  // never leaked as 404s inside the list.
  fastify.get(
    '/leads/:id/timeline',
    { preHandler: [...auth, requirePermission('leads', 'view')] },
    async (req) => {
      const leadId = (req.params && req.params.id) || null;
      if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');

      const dto = await getLeadById({ user: req.user, leadId });
      if (!dto) throw new NotFound('not-found', 'Lead not found.');

      const record = {
        ownerId: dto.owner ? dto.owner.id : null,
        teamId: dto.teamId ?? null,
        projectId: dto.project ? dto.project.id : null,
      };
      if (!can(req.user, 'leads', 'view', record)) {
        throw new NotFound('not-found', 'Lead not found.');
      }
      return getLeadTimeline(req.user, dto);
    },
  );

  // ---- WRITE (wired) ---------------------------------------------------------

  // POST /leads — create a lead under the caller's tenant.
  fastify.post(
    '/leads',
    { preHandler: [...auth, requirePermission('leads', 'create')] },
    async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const input = validateCreateLead(body);

      // Permission gate on ownerId / teamId. The coarse RBAC says the
      // caller can create; whether they can also pick the owner is
      // encoded in the matrix's `assign` scope. Without this, a
      // field-executive with leads.create='all' could create a lead
      // owned by anyone in the tenant — a privilege boundary that must
      // be enforced here, not by the repository, because the repository
      // trusts the input and the validation runs first.
      const assignScope = req.user.permissionMatrix?.leads?.assign ?? 'none';
      const settingAnotherOwner =
        (input.ownerId && input.ownerId !== req.user.id) ||
        (input.teamId && input.teamId !== (req.user.teamId ?? null));
      if (settingAnotherOwner && assignScope === 'none') {
        throw new BadRequest(
          'forbidden-field',
          'Cannot assign a lead to another user or team without leads:assign permission.',
        );
      }

      const dto = await createLead({ user: req.user, input, req });
      return reply.code(201).send(dto);
    },
  );

  // PATCH /leads/:id — partial update.
  fastify.patch(
    '/leads/:id',
    { preHandler: [...auth, requirePermission('leads', 'edit')] },
    async (req) => {
      const leadId = (req.params && req.params.id) || null;
      if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const rawChanges = validateUpdateLead(body);

      // Strip ownerId / teamId from PATCH. The only path that changes
      // ownership is /assign, which has its own coarse-grained RBAC.
      // Allowing them here would mean two routes that audit "who owns
      // this lead", which is exactly the duplication this gate exists
      // to prevent.
      const changes = { ...rawChanges };
      if ('ownerId' in changes) {
        throw new BadRequest(
          'forbidden-field',
          'ownerId cannot be modified via PATCH; use POST /leads/:id/assign.',
        );
      }
      if ('teamId' in changes) {
        throw new BadRequest(
          'forbidden-field',
          'teamId cannot be modified via PATCH; use POST /leads/:id/assign.',
        );
      }

      // Load the existing row for row-level RBAC + FK validation.
      const existing = await getLeadById({ user: req.user, leadId });
      if (!existing) throw new NotFound('not-found', 'Lead not found.');

      const record = {
        ownerId: existing.owner ? existing.owner.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'leads', 'edit', record)) {
        throw new NotFound('not-found', 'Lead not found.');
      }

      return updateLead({ user: req.user, leadId, changes, req });
    },
  );

  // POST /leads/:id/assign — reassign ownership.
  fastify.post(
    '/leads/:id/assign',
    { preHandler: [...auth, requirePermission('leads', 'assign')] },
    async (req) => {
      const leadId = (req.params && req.params.id) || null;
      if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { assignedUserId, reason } = validateAssignLead(body);

      const existing = await getLeadById({ user: req.user, leadId });
      if (!existing) throw new NotFound('not-found', 'Lead not found.');

      const record = {
        ownerId: existing.owner ? existing.owner.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'leads', 'assign', record)) {
        throw new NotFound('not-found', 'Lead not found.');
      }

      return assignLead({ user: req.user, leadId, assignedUserId, reason, req });
    },
  );

  // DELETE /leads/:id — soft delete only.
  fastify.delete(
    '/leads/:id',
    { preHandler: [...auth, requirePermission('leads', 'delete')] },
    async (req) => {
      const leadId = (req.params && req.params.id) || null;
      if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');

      const existing = await getLeadById({ user: req.user, leadId });
      if (!existing) throw new NotFound('not-found', 'Lead not found.');

      const record = {
        ownerId: existing.owner ? existing.owner.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'leads', 'delete', record)) {
        throw new NotFound('not-found', 'Lead not found.');
      }

      return softDeleteLead({ user: req.user, leadId, req });
    },
  );

  // ---- WRITE (still placeholders) -------------------------------------------

  // CSV export stays not-implemented. The UI does not surface an export
  // button; this route is registered only so a stray curl call gets a
  // documented 501 instead of 404. The `leads.export` permission is
  // still required, so a future implementation can wire it without
  // re-granting access.
  fastify.get(
    '/leads/:id/export.csv',
    { preHandler: [...auth, requirePermission('leads', 'export')] },
    async () => {
      throw new NotImplemented(
        'not-implemented',
        'GET /leads/:id/export.csv is not wired in this scaffold.',
      );
    },
  );
}

/**
 * Extract the documented query-string filters. Unknown keys are ignored;
 * empty strings are treated as missing.
 *
 * Follow-up windows (followUpFrom/followUpTo/followUpSet) power the
 * daily queue: overdue / today / upcoming. Validated strictly — a bad
 * window or a contradictory set+window combo is a 400, not a silent
 * unfiltered list.
 *
 * @param {Record<string, unknown>=} query
 */
function extractFilters(query = {}) {
  if (!query || typeof query !== 'object') return {};
  const pickString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    status:      pickString(query.status),
    score:       pickString(query.score),
    projectId:   pickString(query.projectId),
    ownerId:     pickString(query.ownerId),
    serviceNeed: pickString(query.serviceNeed),
    clientType:  pickString(query.clientType),
    q:           pickString(query.q),
    ...validateFollowUpFilters(query),
  };
}

export { DB_NOT_CONFIGURED };
