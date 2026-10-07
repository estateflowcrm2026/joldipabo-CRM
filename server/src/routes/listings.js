// /api/v1/listings/* — list, detail, create, update, photos, verify, assign, delete, export.
//
// All routes are wired against Postgres:
//
//   GET    /listings                       list, RBAC-scoped
//   GET    /listings/:id                   detail (404 for out-of-scope)
//   GET    /listings/:id/interested-leads  saved matches, score-desc (404 for out-of-scope)
//   POST   /listings                       create  (listings:create)
//   PATCH  /listings/:id                   update  (listings:edit)
//   DELETE /listings/:id                   soft delete (listings:delete)
//   POST   /listings/:id/assign            reassign (listings:assign)
//   POST   /listings/:id/verify            set verification_status (listings:approve)
//   POST   /listings/:id/photos            add photo metadata (listings:edit)
//   POST   /listings/:id/documents         metadata-only document stub (listings:edit)
//   GET    /listings/:id/export.csv        not-implemented placeholder
//
// RBAC behaviour:
//   * The coarse-grained `listings:<action>` check runs in requirePermission.
//   * Row-level filtering happens at SQL via scopeFilterFor(user, 'listings', 'view').
//   * Mutation routes additionally call can() on the loaded record to
//     refuse out-of-scope rows (e.g. a field-executive attempting to
//     edit another team's listing).
//   * Out-of-scope rows return 404 to avoid leaking existence.
//
// All mutations run in transactions; the audit row commits with the
// data row so an audit failure rolls back the mutation.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { can } from '../rbac/permissions.js';
import { BadRequest, NotFound, NotImplemented } from '../utils/errors.js';
import {
  addListingPhoto,
  assignListing,
  createListing,
  getListingById,
  listListings,
  softDeleteListing,
  updateListing,
  validateAddListingPhoto,
  validateAssignListing,
  validateCreateListing,
  validateUpdateListing,
  validateVerifyListing,
  verifyListing,
} from '../repositories/listingsRepository.js';
import {
  listInterestedLeads,
  validateInterestedLeadsOptions,
} from '../repositories/leadMatchesRepository.js';
import { DB_NOT_CONFIGURED } from '../db/client.js';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function listingRoutes(fastify) {
  const auth = [authMiddleware];

  // ---- READ (wired) ----------------------------------------------------------

  fastify.get(
    '/listings',
    { preHandler: [...auth, requirePermission('listings', 'view')] },
    async (req) => {
      const items = await listListings({
        user: req.user,
        filters: extractFilters(req.query),
        pagination: { limit: req.query.limit, offset: req.query.offset },
      });
      return items;
    },
  );

  fastify.get(
    '/listings/:id',
    { preHandler: [...auth, requirePermission('listings', 'view')] },
    async (req) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');

      const dto = await getListingById({ user: req.user, listingId });
      // Hide existence across tenant boundaries and for soft-deleted rows.
      if (!dto) throw new NotFound('not-found', 'Listing not found.');

      // Row-level RBAC: a user with a coarse 'view' scope might still be
      // limited to own / team / project, and can() encodes that. We
      // synthesise the row-shape `can()` expects from the DTO.
      const record = {
        ownerId: null,
        assignedTo: dto.assignedTo ? dto.assignedTo.id : null,
        teamId: dto.teamId ?? null,
        projectId: dto.project ? dto.project.id : null,
      };
      if (!can(req.user, 'listings', 'view', record)) {
        // Fail-closed: same response shape as a true not-found so we don't
        // leak that the row exists but is out of scope.
        throw new NotFound('not-found', 'Listing not found.');
      }
      return dto;
    },
  );

  // ---- READ (matches pivot) --------------------------------------------------

  // GET /listings/:id/interested-leads — saved matches for one listing,
  // score-desc (the listing-side pivot of GET /leads/:id/matches).
  //
  // Same scope contract as the lead-side list, mirrored: the listing
  // itself is scope-checked exactly like GET /listings/:id (out-of-scope
  // → 404, never 403), and out-of-scope leads are skipped silently inside
  // the list by the repository — never leaked as 404s. Consumes persisted
  // `listing_matches` rows only; no scoring happens here.
  fastify.get(
    '/listings/:id/interested-leads',
    { preHandler: [...auth, requirePermission('listings', 'view')] },
    async (req) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');
      const options = validateInterestedLeadsOptions(req.query);
      return listInterestedLeads(req.user, listingId, options);
    },
  );

  // ---- WRITE (wired) ---------------------------------------------------------

  // POST /listings — create a listing under the caller's tenant.
  fastify.post(
    '/listings',
    { preHandler: [...auth, requirePermission('listings', 'create')] },
    async (req, reply) => {
      // The request body may be null when Content-Length is 0 or when the
      // caller forgets the body — coerce to {} so validation has a shape.
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const input = validateCreateListing(body);

      // If the caller tries to assign to someone else, the coarse RBAC
      // already says they can create; whether they can also pick the
      // assignee is encoded in the matrix's `assign` scope. To keep the
      // scaffold simple: a caller can only assign to themselves. Any
      // explicit `assignedUserId` from a non-admin caller is rejected.
      if (input.assignedUserId && input.assignedUserId !== req.user.id) {
        const assignScope = req.user.permissionMatrix?.listings?.assign ?? 'none';
        if (assignScope === 'none') {
          throw new BadRequest(
            'forbidden-field',
            'Cannot assign a listing to another user without listings:assign permission.',
          );
        }
      }

      const dto = await createListing({ user: req.user, input, req });
      return reply.code(201).send(dto);
    },
  );

  // PATCH /listings/:id — partial update.
  fastify.patch(
    '/listings/:id',
    { preHandler: [...auth, requirePermission('listings', 'edit')] },
    async (req) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const changes = validateUpdateListing(body);

      // Load the existing row for row-level RBAC + FK validation.
      const existing = await getListingById({ user: req.user, listingId });
      if (!existing) throw new NotFound('not-found', 'Listing not found.');

      const record = {
        ownerId: null,
        assignedTo: existing.assignedTo ? existing.assignedTo.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      // Fail-closed with the same response shape as a true not-found so
      // we don't leak that the row exists but is out of scope.
      if (!can(req.user, 'listings', 'edit', record)) {
        throw new NotFound('not-found', 'Listing not found.');
      }

      return updateListing({ user: req.user, listingId, changes, req });
    },
  );

  // POST /listings/:id/assign — reassign the field executive.
  fastify.post(
    '/listings/:id/assign',
    { preHandler: [...auth, requirePermission('listings', 'assign')] },
    async (req) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { assignedUserId, reason } = validateAssignListing(body);

      // Row-level RBAC: confirm the listing is in scope before mutating.
      const existing = await getListingById({ user: req.user, listingId });
      if (!existing) throw new NotFound('not-found', 'Listing not found.');

      const record = {
        ownerId: null,
        assignedTo: existing.assignedTo ? existing.assignedTo.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'listings', 'assign', record)) {
        throw new NotFound('not-found', 'Listing not found.');
      }

      return assignListing({ user: req.user, listingId, assignedUserId, reason, req });
    },
  );

  // POST /listings/:id/verify — set verification_status.
  fastify.post(
    '/listings/:id/verify',
    { preHandler: [...auth, requirePermission('listings', 'approve')] },
    async (req) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { status, reason } = validateVerifyListing(body);

      const existing = await getListingById({ user: req.user, listingId });
      if (!existing) throw new NotFound('not-found', 'Listing not found.');

      const record = {
        ownerId: null,
        assignedTo: existing.assignedTo ? existing.assignedTo.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'listings', 'approve', record)) {
        throw new NotFound('not-found', 'Listing not found.');
      }

      return verifyListing({ user: req.user, listingId, status, reason, req });
    },
  );

  // POST /listings/:id/photos — metadata-only.
  fastify.post(
    '/listings/:id/photos',
    { preHandler: [...auth, requirePermission('listings', 'edit')] },
    async (req, reply) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const input = validateAddListingPhoto(body);

      const existing = await getListingById({ user: req.user, listingId });
      if (!existing) throw new NotFound('not-found', 'Listing not found.');

      const record = {
        ownerId: null,
        assignedTo: existing.assignedTo ? existing.assignedTo.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'listings', 'edit', record)) {
        throw new NotFound('not-found', 'Listing not found.');
      }

      const dto = await addListingPhoto({ user: req.user, listingId, input, req });
      return reply.code(201).send(dto);
    },
  );

  // DELETE /listings/:id — soft delete only.
  fastify.delete(
    '/listings/:id',
    { preHandler: [...auth, requirePermission('listings', 'delete')] },
    async (req) => {
      const listingId = (req.params && req.params.id) || null;
      if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');

      const existing = await getListingById({ user: req.user, listingId });
      if (!existing) throw new NotFound('not-found', 'Listing not found.');

      const record = {
        ownerId: null,
        assignedTo: existing.assignedTo ? existing.assignedTo.id : null,
        teamId: existing.teamId ?? null,
        projectId: existing.project ? existing.project.id : null,
      };
      if (!can(req.user, 'listings', 'delete', record)) {
        throw new NotFound('not-found', 'Listing not found.');
      }

      return softDeleteListing({ user: req.user, listingId, req });
    },
  );

  // ---- WRITE (still placeholders) -------------------------------------------

  fastify.post(
    '/listings/:id/documents',
    { preHandler: [...auth, requirePermission('listings', 'edit')] },
    async () => {
      throw new NotImplemented(
        'not-implemented',
        'POST /listings/:id/documents is metadata-only and not wired in this scaffold.',
      );
    },
  );
  fastify.get(
    '/listings/:id/export.csv',
    { preHandler: [...auth, requirePermission('listings', 'export')] },
    async () => {
      throw new NotImplemented(
        'not-implemented',
        'GET /listings/:id/export.csv is not wired in this scaffold.',
      );
    },
  );
}

/**
 * Extract the documented query-string filters. Unknown keys are ignored;
 * empty strings are treated as missing.
 *
 * @param {Record<string, unknown>=} query
 */
function extractFilters(query = {}) {
  if (!query || typeof query !== 'object') return {};
  const pickString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    serviceCategory:    pickString(query.serviceCategory),
    propertyType:       pickString(query.propertyType),
    listingIntent:      pickString(query.listingIntent),
    availabilityStatus: pickString(query.availabilityStatus),
    verificationStatus: pickString(query.verificationStatus),
    assignedUserId:     pickString(query.assignedUserId),
    city:               pickString(query.city),
    search:             pickString(query.search),
  };
}

export { DB_NOT_CONFIGURED };
