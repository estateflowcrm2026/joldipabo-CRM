// /api/v1/photos/* — list, detail, presign upload, commit, approve, delete.
//
// THESE ROUTES ARE STUBS, AND MUST STAY STUBS. Read this before adding a
// handler.
//
// WHY
// ---
// There are two media tables. `listing_photos` is listing-scoped, carries
// the `tenant_isolation` RLS policy, and is what the application uses.
// `photos` is project-scoped, holds 0 rows, has no application code, and
// as of 2026-09-28 (migration `011-photos-deprecated.sql`) holds an
// always-false RLS policy and NO privileges for `estateflow_app`.
//
// So implementing anything here against the `photos` table cannot work —
// every statement fails with `42501 permission denied` — which is the
// point. It is a table nobody can accidentally read or write, rather
// than one that merely has no code pointing at it today.
//
// WHAT TO DO INSTEAD
// ------------------
// Media for a listing goes through `listing_photos` via
// `addListingPhoto()` in [repositories/listingsRepository.js],
// reached by `POST /api/v1/listings/:id/photos`. That path is live,
// tenant-wired and RLS-checked.
//
// If project-scoped media is a genuine requirement, it needs a
// deliberate decision and a migration: pick one model, and if the `photos`
// table survives, give it a real `tenant_isolation` policy and grant the
// application role. Do not drop the deny policy to make a query work.
//
// If these routes are ever implemented, two things are non-negotiable:
//
//   1. Every statement runs inside `withTenant({ tenantId: user.tenantId }, …)`
//      or `tenantQuery(user, …)`. A bare pool query has no transaction,
//      so there is nowhere to put `app.tenant_id`, and under RLS it sees
//      zero rows and every INSERT is rejected — which looks exactly like
//      an empty database rather than like a bug.
//   2. It targets `listing_photos`, or a table with a policy.
//
// A regression test in [src/rls/rls.test.js] fails if this file gains SQL
// without tenant context.

import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { NotImplemented } from '../utils/errors.js';

const NOT_IMPLEMENTED =
  'Not implemented. Media lives on `listing_photos` — see ' +
  'docs/RLS_ROLLOUT_PLAN.md §8 and the note at the top of this file.';

/** @param {import('fastify').FastifyInstance} fastify */
export default async function photoRoutes(fastify) {
  const auth = [authMiddleware];
  fastify.get('/photos',                  { preHandler: [...auth, requirePermission('photos', 'view')] },   async () => ({ items: [], placeholder: true, deprecatedTable: 'photos', use: 'listing_photos' }));
  fastify.get('/photos/:id',              { preHandler: [...auth, requirePermission('photos', 'view')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/photos:presign',         { preHandler: [...auth, requirePermission('photos', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/photos',                 { preHandler: [...auth, requirePermission('photos', 'create')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.patch('/photos/:id',            { preHandler: [...auth, requirePermission('photos', 'edit')] },   async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.post('/photos/:id/approve',     { preHandler: [...auth, requirePermission('photos', 'approve')] },async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
  fastify.delete('/photos/:id',           { preHandler: [...auth, requirePermission('photos', 'delete')] }, async () => { throw new NotImplemented('not-implemented', NOT_IMPLEMENTED); });
}
