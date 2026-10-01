# Joldipabo CRM — Backend Scaffold Status

Date: 2026-09-24 (production-readiness audit appended)

Status: scaffold with the listings CRUD surface wired end-to-end. The frontend still uses `src/services/demoRepository.js` and `src/data/seed.js`. This document tracks what's wired, what's a placeholder, and the order the rest will land in.

> **Production readiness:** the full gap audit and phased execution plan live in [PRODUCT_PRODUCTION_ROADMAP.md](PRODUCT_PRODUCTION_ROADMAP.md); the go-live gate is [PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md); environment variables are in [ENVIRONMENT.md](ENVIRONMENT.md). Section 6.0 below summarises the blockers found in that audit.

The scaffold lives under [`server/`](../server/). It is **not** a finished backend — every route returns either a small shaped JSON or `501 Not Implemented`. What it does do is:

- Match the documented data model in [`docs/DATA_MODEL.md`](DATA_MODEL.md).
- Match the documented permission model in [`src/data/permissions.js`](../src/data/permissions.js) and [`docs/RBAC_SERVER_ENFORCEMENT.md`](RBAC_SERVER_ENFORCEMENT.md).
- Expose the endpoint surface listed in [`docs/BACKEND_INTEGRATION_PLAN.md §7`](BACKEND_INTEGRATION_PLAN.md) and [`docs/AUTH_API_SPEC.md`](AUTH_API_SPEC.md).
- Boot a Fastify instance, log to stdout, expose a health endpoint, and shut down on SIGTERM/SIGINT.

---

## 1. What's wired

| Area | What | File | Notes |
| --- | --- | --- | --- |
| Boot | Fastify app factory + listening, pool drain on SIGTERM/SIGINT | [server/src/app.js](../server/src/app.js), [server/src/server.js](../server/src/server.js) | CORS restricted to the dev origins in [server/src/config/index.js](../server/src/config/index.js). |
| Health | `GET /health`, `GET /ready` (real probe) | [server/src/app.js](../server/src/app.js), [server/src/db/health.js](../server/src/db/health.js) | `/ready`: `not-configured` (200) when unset, `connected` (200) when reachable, `database-unavailable` (503) when down. |
| DB client | `pg` Pool: `getDb()`, `query()`, `transaction()`, `closeDb()`, `isDbConfigured()` | [server/src/db/client.js](../server/src/db/client.js) | Lazy pool; graceful not-configured error (`database-not-configured`); boots fine without `DATABASE_URL`. |
| Migrations | `db:migrate` / `db:seed` / `db:reset` with `schema_migrations` tracking | [server/src/db/migrate.js](../server/src/db/migrate.js) | Idempotent; seed skips when seeded; reset requires `ESTATEFLOW_ALLOW_RESET=yes` + localhost URL. |
| Errors | Standard envelope | [server/src/utils/errors.js](../server/src/utils/errors.js) | Renders `HttpError` subclasses via [docs/AUTH_API_SPEC.md §1](AUTH_API_SPEC.md). |
| Account lifecycle | `inviteUser`, `acceptInvite`, `forgotPassword`, `resetPassword`, `login`, `refresh`, `logout`, `logoutAll` | [server/src/repositories/onboardingService.js](../server/src/repositories/onboardingService.js), [authService.js](../server/src/repositories/authService.js) | **Live.** Tokens stored hashed, single-use, time-boxed. Recovery never reveals whether an account exists. 20 + 24 tests. |
| Mailer | `sendMail`, `sendInviteEmail`, `sendPasswordResetEmail`, `sendSecurityAlertEmail` | [server/src/auth/mailer.js](../server/src/auth/mailer.js) | Pluggable: `log` (default, ring buffer + stdout), `smtp` (node:net, no dependency), `none`. Dev outbox refused in production. |
| Auth middleware | Bearer parsing + tenant-scoped identity + dev-token shortcut | [server/src/auth/authMiddleware.js](../server/src/auth/authMiddleware.js) | Production: parses the JWT and falls back to a zero-permission placeholder (so `requirePermission` returns 403 until §6.2 lands). When `DEV_AUTH_ENABLED=true`, `Bearer dev-<role>` resolves to a seeded user via [server/src/repositories/authRepository.js](../server/src/repositories/authRepository.js); DB-backed when `DATABASE_URL` is set, in-code defaults otherwise (gated by `DEV_AUTH_OFFLINE_FALLBACK`). |
| Token service | `issueAccessToken`, `verifyAccessToken`, `issueRefreshToken`, `hashRefreshToken`, `resolveSigningKey` | [server/src/auth/tokenService.js](../server/src/auth/tokenService.js) | **Live.** HS256-signed, constant-time signature compare, `iss`/`aud`/`exp`/`iat` verified. 28 tests. |
| Password policy | `hashPassword`, `verifyPassword`, `needsPasswordRehash`, `parseHash`, `validatePassword` | [server/src/auth/passwordPolicy.js](../server/src/auth/passwordPolicy.js) | **Live.** Argon2id at the OWASP minimum in self-describing PHC format. Malformed hashes fail closed. 18 tests. Breach-list and reuse checks remain stubs. |
| RBAC | `RESOURCES` (11 — `listings` added 2026-09-23), `ACTIONS`, `SCOPES`, `ROLE_DEFINITIONS`, `DEFAULT_PERMISSION_MATRIX`, `can`, `scopeOf`, `filterByScope`, `mergeMatrix`, `isSystemRole` | [server/src/rbac/permissions.js](../server/src/rbac/permissions.js) | Port of [src/data/permissions.js](../src/data/permissions.js) — both files must change together. |
| RBAC scope SQL | `scopeFilterFor(user, resource, action)`, `andFilters(...)` | [server/src/rbac/scopeFilters.js](../server/src/rbac/scopeFilters.js) | Returns `{ sql, params }`. Per-resource `own`-column map: `listings.assigned_to`, everything else `owner_id`. |
| RBAC middleware | `requirePermission(resource, action)` Fastify hook + `assertCanOnRecord` | [server/src/rbac/requirePermission.js](../server/src/rbac/requirePermission.js) | Fail-closed. Attaches `req.permission = { resource, action, scope }`. |
| Audit | `recordAudit(client, {...})`, `writeAuditRecord`, `buildAuditRecord`, `verifyAuditRow` | [server/src/audit/auditLog.js](../server/src/audit/auditLog.js) | **Live.** Real INSERT inside the caller transaction, HMAC over a sorted-key canonical form. 11 tests. |
| SQL — schema | All tables from [docs/DATA_MODEL.md](DATA_MODEL.md) + `tenant_id`, `refresh_sessions`, `otp_codes`, `export_jobs`, RLS comment placeholders + `listings` + `listing_photos` + `listing_documents` + `listing_matches` + extended `leads` / `visits` columns | [server/src/db/schema.sql](../server/src/db/schema.sql) | Postgres-flavoured. New tables use `IF NOT EXISTS`; existing tables extended with `ADD COLUMN IF NOT EXISTS`. Comments at the bottom list future RLS policies. |
| SQL — indexes | tenant_id, owner_id, team_id, project_id, status, created_at, plus the open-shift uniqueness + 8 new listing indexes + 3 new lead indexes (`service_need`, `client_type`, `visit_status`) + 1 visit-by-listing index | [server/src/db/indexes.sql](../server/src/db/indexes.sql) | Partial indexes exclude `deleted_at IS NOT NULL`. |
| SQL — seed | Tenant, branches, roles, teams, projects, the 9 seeded users from `src/data/seed.js` + 5 sample listings spanning rent / PG / land / office / buy verticals + 4 extended leads + 3 listing_matches | [server/src/db/seed-demo.sql](../server/src/db/seed-demo.sql) | Loaded via `npm run db:seed` (skips when already seeded). |
| Routes | 13 files, 45+ routes under `/api/v1/*` | [server/src/routes/](../server/src/routes/) | Each registered with the correct method, path, and preHandler chain. `GET /api/v1/listings` and `GET /api/v1/listings/:id` (added 2026-09-23) are wired end-to-end via [server/src/repositories/listingsRepository.js](../server/src/repositories/listingsRepository.js). The 6 listing write routes (`POST /listings`, `PATCH /listings/:id`, `POST /listings/:id/assign`, `POST /listings/:id/verify`, `POST /listings/:id/photos`, `DELETE /listings/:id`) are wired against Postgres with raw `pg`, RBAC + row-level scope checks, soft delete, and audit-logged mutations inside the same transaction. Only the document upload and CSV export stubs remain `501 Not Implemented`. |
| Listings repository | `listListings`, `getListingById`, `createListing`, `updateListing`, `assignListing`, `verifyListing`, `addListingPhoto`, `softDeleteListing`, `buildListFilter`, `sanitisePagination`, `toListingDTO`, `toListingPhotoDTO` | [server/src/repositories/listingsRepository.js](../server/src/repositories/listingsRepository.js) | Tenant-scoped at SQL, RBAC-scoped via `scopeFilterFor`. All write functions run inside a `transaction()` and commit the audit row with the data row. `getListingByIdOnClient(client, ...)` exposes a transaction-aware read so reads-after-write inside the same transaction see the uncommitted INSERT. Pure-logic tests in `listingsRepository.test.js`. |
| Listings validation | `validateCreateListing`, `validateUpdateListing`, `validateAssignListing`, `validateVerifyListing`, `validateAddListingPhoto` + enum/coordinate/price helpers | [server/src/repositories/listingValidation.js](../server/src/repositories/listingValidation.js) | Enums match [server/src/db/schema.sql](../server/src/db/schema.sql). Cross-field coherence: `serviceCategory` ↔ `listingIntent`. PATCH forbids `id`, `tenantId`, `createdBy`, `deletedAt`. `verify(rejected)` requires `reason`. |
| Listings write routes | `POST /api/v1/listings`, `PATCH /api/v1/listings/:id`, `POST /:id/assign`, `POST /:id/verify`, `POST /:id/photos`, `DELETE /:id` | [server/src/routes/listings.js](../server/src/routes/listings.js) | Each route loads the row via `getListingById`, runs an explicit `can(user, 'listings', action, record)` row-level check, and fails-closed with `404 not-found` for out-of-scope. `requirePermission('listings', X)` preHandler fires `403 forbidden` when matrix scope is `none`. `assign` to another user without `listings:assign` permission → `400 forbidden-field`. |
| Listings route tests | 401 / 403 / 503 / 404 / 400 paths + dev-token truth table | [server/src/routes/listings.test.js](../server/src/routes/listings.test.js), [server/src/routes/listings.write.test.js](../server/src/routes/listings.write.test.js), [server/src/repositories/listingValidation.test.js](../server/src/repositories/listingValidation.test.js) | `app.inject` against `buildApp()`. With `DEV_AUTH_ENABLED=true` + offline fallback, dev-* tokens reach the data layer (503 when DB is absent; 200/201 against a real DB). Without the dev flag, dev tokens are rejected like malformed JWTs. 21 validation tests + 17 route write tests cover the truth table. |
| Account lifecycle | invite / accept / forgot / reset, with tokens stored hashed and single-use | `src/repositories/onboardingService.js`, `onboardingService.test.js` (20 tests) |
| Audit integrity | Rows are INSERTed inside the caller transaction; the HMAC canonical form is stable and detects tampered fields | `src/audit/auditLog.js`, `auditLog.test.js` (11 tests) |
| Auth flow smoke | Full login/refresh/reuse/logout/lockout flow against an in-memory `pg` stand-in | `npm run smoke:auth` — 24 assertions, no database needed |
| Auth flow smoke (real DB) | The same lifecycle plus the SQL, against a live Postgres | `npm run smoke:auth-db` — needs `DATABASE_URL`; not yet executed here |
| Auth middleware tests | Truth table for DEV_AUTH_ENABLED / DEV_AUTH_OFFLINE_FALLBACK / DATABASE_URL | [server/src/auth/authMiddleware.test.js](../server/src/auth/authMiddleware.test.js) | Covers: dev flag off → 401; flag on + DB + fallback on → 503 (RBAC passed, DB threw); flag on + no DB + fallback off → 401 database-not-configured; unknown dev key → 401; placeholder JWT → 403. |
| Sync endpoint | `POST /api/v1/sync` with `Idempotency-Key` validation + action-type allow-list | [server/src/routes/sync.js](../server/src/routes/sync.js) | Five types match [docs/OFFLINE_QUEUE_CONTRACT.md §3](OFFLINE_QUEUE_CONTRACT.md). |
| Tests | `node --test` for RBAC primitives + scope-filter SQL + DB degraded mode + listings repository + listings routes + auth middleware | [server/src/rbac/permissions.test.js](../server/src/rbac/permissions.test.js), [server/src/rbac/scopeFilters.test.js](../server/src/rbac/scopeFilters.test.js), [server/src/db/client.test.js](../server/src/db/client.test.js), [server/src/repositories/listingsRepository.test.js](../server/src/repositories/listingsRepository.test.js), [server/src/routes/listings.test.js](../server/src/routes/listings.test.js), [server/src/auth/authMiddleware.test.js](../server/src/auth/authMiddleware.test.js) | 48 pass + 1 skip in the default run. The skip is the DB `SELECT 1` smoke test (gated on `DATABASE_URL`). |
| Lint | `node --check` on every `src/*.js` | [server/scripts/lint.js](../server/scripts/lint.js) | Pure syntax check; no ESLint dependency. |
| Smoke harness | `npm run smoke:listings` runs against a live backend + real Postgres | [server/scripts/smoke-listings.js](../server/scripts/smoke-listings.js) | 8 read assertions: `/health`, `/ready`, no-auth → 401, `dev-super` list, two `serviceCategory` filters, detail route, `dev-field` own-scope subset. With `SMOKE_WRITE=1`, the script additionally runs the full write lifecycle (create → PATCH → assign → verify → photo → delete) for 7 more assertions, exercising `201 / 200 / 404` codes. Prints the docker+migrate+seed+start recipe and exits 2 when the backend is unreachable. |
| Local Postgres | Docker Compose with persistent named volume | [server/docker-compose.yml](../server/docker-compose.yml) | `postgres:16`, db `estateflow_dev`, role `estateflow`, port 5432. |
| Docs | Install, run, env vars, limitations, frontend hookup | [server/README.md](../server/README.md) | Includes the one-line `setRepository(apiRepository)` swap and the "Local smoke test" recipe. |

---

## 2. What's still placeholder

| Area | What | Where the real implementation lands |
| --- | --- | --- |
| Route queries | `GET /api/v1/listings` + `GET /api/v1/listings/:id` are wired. The 6 listing write routes are wired (create / patch / assign / verify / photo / delete). The remaining list endpoints (`GET /api/v1/leads`, `visits`, `attendance`, `photos`, etc.) still return `501 Not Implemented`. | Each remaining list/create handler calls `query()` / `transaction()` + `scopeFilterFor()`. Continue with `GET /api/v1/leads`. |
| Listing document upload | `POST /listings/:id/documents` and `GET /listings/:id/export.csv` are still `501 Not Implemented`. | Wire document metadata repository (no file upload yet); export will use the same `export_jobs` table as leads. |
| RLS policies | **Enforcing 2026-09-28 for `listings` + `listing_photos`; `leads`/`visits` have policies but no application code at all; `photos` (legacy duplicate) is RLS-enabled with an always-false policy and zero app privileges (migration 011).** `tenant_isolation` on `listings`, `leads`, `visits`, `listing_photos` ([010-rls-listings-leads.sql](../server/src/db/010-rls-listings-leads.sql)), gated behind `DB_RLS_MODE`. The `estateflow_app` role exists with least-privilege grants. | Enforces when the server connects via `APP_DATABASE_URL`; inert while it runs as `postgres` (which has `BYPASSRLS`). A production boot now refuses that. [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md) |
| JWT signing | `tokenService` returns an unsigned placeholder. | Switch to `@fastify/jwt` once `JWT_SECRET` is required. |
| Password hashing | `hashPassword` returns a placeholder. | Add `argon2` to deps; replace the stub. |
| User loading | `authMiddleware` does not load the user from the DB for normal JWTs. The dev-token shortcut (when `DEV_AUTH_ENABLED=true`) does, and falls back to in-code defaults when `DATABASE_URL` is unset. | Real auth: replace the placeholder JWT path with `loadUser(req)` that re-reads role + matrix on every request. The dev shortcut stays as a developer-only convenience and is documented as such. |
| RBAC scope SQL → data layer | `scopeFilterFor` is now used by `listListings`. | Wire it into the next endpoint (e.g. `GET /api/v1/leads`). |
| Audit DB writes | Listing writes now `INSERT` into `audit_log` inside the route's transaction (see `recordAudit` + the listings repository). Other routes still log to Fastify only. | Replace the remaining `request.log.info` calls with the transactional helper. |
| Rate limiting | Not implemented; `RATE_LIMIT_*` env vars are read but unused. | Add `@fastify/rate-limit` keyed on `req.user.id`. |
| Field-level stripping | `*Location` etc. are documented but not stripped server-side. | Response shaper middleware per [docs/RBAC_SERVER_ENFORCEMENT.md §4](RBAC_SERVER_ENFORCEMENT.md). |
| HMAC on audit_log | Column exists, no signing. | Wire KMS-backed HMAC in the audit helper. |
| Migrations | `schema_migrations` tracking + file-based runner exist. | Add numbered per-change migration files when the schema evolves beyond schema.sql/indexes.sql. |
| Tests | RBAC primitives + DB degraded mode + listings repository + listings route reads + listings route writes + listing validation. | Add `app.inject` tests as each endpoint lands (next: leads). |
| OpenAPI | No `fastify-type-provider` schemas yet. | Switch route bodies to JSON Schema; expose `/documentation`. |

---

## 3. Endpoint surface (placeholders)

All under `/api/v1`. Methods and paths are registered; bodies return `{ ok: true, placeholder: true, ... }` or `501 Not Implemented`. Authentication is `authMiddleware` where required; permission is `requirePermission(resource, action)` where documented.

### Auth (public)

```
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
POST   /auth/logout-all
POST   /auth/invite
POST   /auth/accept-invite
POST   /auth/request-otp
POST   /auth/verify-otp
POST   /auth/forgot-password
POST   /auth/reset-password
POST   /auth/impersonate
POST   /auth/end-impersonate
POST   /auth/mfa/setup
POST   /auth/mfa/verify
GET    /auth/me
```

### Users

```
GET    /users
GET    /users/:id
POST   /users
PATCH  /users/:id
DELETE /users/:id
POST   /users/:id/restore
```

### Security

```
GET    /security/sessions
DELETE /security/sessions/:id
POST   /security/users/:id/unlock
POST   /security/users/:id/revoke-sessions
```

### Roles

```
GET    /roles
POST   /roles
PATCH  /roles/:id
PATCH  /roles/:id/matrix
DELETE /roles/:id
```

### Teams

```
GET    /teams
POST   /teams
PATCH  /teams/:id
```

### Projects

```
GET    /projects
POST   /projects
PATCH  /projects/:id
GET    /projects/:id/members
POST   /projects/:id/members
DELETE /projects/:id/members/:userId
```

### Leads

```
GET    /leads
GET    /leads/:id
POST   /leads
PATCH  /leads/:id
POST   /leads/:id/assign
DELETE /leads/:id
GET    /leads/:id/export.csv
```

### Listings (cross-vertical)

```
GET    /listings             — wired (2026-09-23). Query params: limit, offset,
                               serviceCategory, propertyType, listingIntent,
                               availabilityStatus, verificationStatus,
                               assignedUserId, city (ILIKE), search (title/desc/address).
                               Returns { items, pagination: { limit, offset, total } }.
GET    /listings/:id         — wired (2026-09-23). 404 on missing or out-of-scope.
POST   /listings             — wired (2026-09-23). listings:create. Audits created-listing.
PATCH  /listings/:id         — wired (2026-09-23). listings:edit + row scope. Audits updated-listing
                               (also covers the mobile capture offline-sync path:
                               `POST /api/v1/listings` is what the future
                               `listing.capture` sync worker calls).
                               with { changedKeys, diff }. Rejects id/tenantId/createdBy/deletedAt.
POST   /listings/:id/assign  — wired (2026-09-23). listings:assign + row scope. Audits
                               assigned-listing with { fromUserId, toUserId, reason }.
POST   /listings/:id/verify  — wired (2026-09-23). listings:approve + row scope. Audits
                               verified-listing / rejected-listing / verification-requested-listing.
                               status='rejected' requires reason (400 reason-required).
POST   /listings/:id/photos  — wired (2026-09-23). listings:edit + row scope. Metadata only,
                               approved=false. Audits uploaded-listing-photo.
DELETE /listings/:id         — wired (2026-09-23). listings:delete + row scope. Soft delete.
                               Audits deleted-listing. Returns { ok: true, listingId, deletedAt }.
POST   /listings/:id/documents — placeholder (501). Metadata-only stub.
GET    /listings/:id/export.csv — placeholder (501).
```

### Visits

```
GET    /visits
GET    /visits/:id
POST   /visits
PATCH  /visits/:id
POST   /visits/:id/complete
```

### Attendance

```
GET    /attendance
POST   /attendance/check-in
POST   /attendance/check-out
PATCH  /attendance/:id/approve
```

### Photos

```
GET    /photos
GET    /photos/:id
POST   /photos:presign
POST   /photos
PATCH  /photos/:id
POST   /photos/:id/approve
DELETE /photos/:id
```

### Communications

```
GET    /threads
POST   /threads
GET    /threads/:id/messages
POST   /threads/:id/messages
```

### Reports & audit

```
GET    /reports/pipeline
GET    /reports/attendance
POST   /reports/leads/export
GET    /reports/jobs/:id
GET    /activity
GET    /activity/export
```

### Sync

```
POST   /sync           — Idempotency-Key required; action types:
                          attendance.checkIn, attendance.checkOut,
                          visit.update, photo.upload, message.send.
```

---

## 4. Verification (today)

Run from the project root or from `server/`:

```bash
cd server
npm install
npm run lint        # syntax-check every src/*.js
npm test            # RBAC + db degraded-mode tests (SELECT 1 when DATABASE_URL set)
npm start           # boots on http://0.0.0.0:4000, with or without DATABASE_URL
curl http://127.0.0.1:4000/health    # → { "status": "ok" }
curl http://127.0.0.1:4000/ready     # → not-configured | connected | 503

# With a local Postgres (see server/README.md "Local Postgres"):
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow
npm run db:migrate   # schema + indexes (idempotent)
npm run db:seed      # demo tenant/roles/teams/projects/users (skips if seeded)
```

A working smoke run from this scaffold at time of writing:

- `scripts/lint.js` passes on every file.
- `npm test` (no `DATABASE_URL`): RBAC 13 pass + DB degraded-mode 5 pass / 1 skip (`SELECT 1`).
- `npm test` (with `DATABASE_URL`): 81 pass / 7 skip (offline-fallback paths). 21 validation tests + 17 listings write-route tests + RBAC + DB degraded-mode + listings repository tests.
- `npm run smoke:listings` against a live backend + real Postgres: 8 read assertions pass.
- `SMOKE_WRITE=1 npm run smoke:listings` adds 7 write assertions (create → PATCH → assign → verify → photo → delete → post-delete 404).
- `curl /health` returns `{ "status": "ok" }`.
- `curl /ready` returns `{ "status": "ok", "database": "not-configured" }` without `DATABASE_URL`.
- `curl /api/v1/auth/login -X POST -d '{}' -H 'Content-Type: application/json'` returns the standard `{ error: { code: 'invalid-payload', ... } }` envelope.

The frontend (`npm run build` at the project root) still passes — no `src/` files were touched.

---

## 5. Frontend hookup (future)

The one-line repository swap from [docs/BACKEND_INTEGRATION_PLAN.md §8](BACKEND_INTEGRATION_PLAN.md):

```js
// src/services/index.js (future)
import { apiRepository } from './apiRepository.js';
import { setRepository } from './index.js';
setRepository(apiRepository);
```

`apiRepository.js` will:

1. Implement the typed interface in [src/services/repositoryTypes.js](../src/services/repositoryTypes.js).
2. Hit `http://localhost:4000/api/v1/*` by default.
3. Forward `Authorization: Bearer <accessToken>` from the auth context.
4. Forward `Idempotency-Key` on every mutating call.

The CORS allow-list already covers the Vite dev origins (5173, 5180, 127.0.0.1:5180).

---

## 6.0 Production blockers (from the 2026-09-24 audit)

These are not feature gaps — they are correctness and security defects. Each was verified by reading the code and, where marked ✅, by executing a reproduction.

| # | Blocker | Where | Status |
|---|---------|-------|--------|
| 1 | **Access tokens are unsigned.** `issueAccessToken` returned `header.payload.` with an empty signature; `verifyAccessToken` only base64-decoded the payload. A hand-forged token was accepted. `getUserAuthContextById` also keyed on `sub` alone and ignored `tid`, so a forged token also crossed the tenant boundary. | `auth/tokenService.js`, `repositories/authRepository.js` | ✅ **Fixed 2026-09-24** — HS256 via `node:crypto`, constant-time signature compare, `iss`/`aud`/`exp`/`iat` verified, unsigned and wrong-key tokens refused. User loaded by `(sub, tid)`. 28 + 19 tests. **Still open:** no endpoint issues a token, no password hashing, no refresh rotation |
| 2 | **`DEV_AUTH_OFFLINE_FALLBACK` defaulted to `true`**, so setting only `DEV_AUTH_ENABLED=true` granted full in-code permission matrices with no database row behind them. | `config/index.js` | ✅ **Fixed 2026-09-24** — default is now `false`; 17 tests in `config/index.test.js` |
| 3 | **No production boot guard.** `NODE_ENV=production` with dev auth on, or with no `JWT_SECRET`, would serve with a full privilege bypass. | `config/index.js`, `server.js` | ✅ **Fixed 2026-09-24** — `assertSafeToStart()` refuses to boot; verified on a real boot |
| 4 | **Tenant isolation is application-only (RLS provisioned 2026-09-28).** Every tenant-owned table carries `tenant_id NOT NULL REFERENCES organisations(id)`, but the RLS policies in `schema.sql:477-485` are comments and `set_config('app.tenant_id', …)` is never called anywhere. The schema header claims RLS enforces isolation — **it does not**. | `db/schema.sql:4-6,477-485` | 🟡 **Partially fixed 2026-09-24** (tenant-scoped identity resolution) and **2026-09-28** (`withTenant()` now called; policies installed for 4 tables behind `DB_RLS_MODE`; `probe` mode passes 368 tests unchanged). **Still predicate-based in production**: the app role has `BYPASSRLS`, so the policies are inert. [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md) |
| 5 | **No migration checksums, and `001-schema` was edited in place.** The cross-vertical columns live inside an already-shipped migration, so a database that already recorded `001-schema` skips them. Fresh and existing databases now differ. No `down`, no advisory lock. | `db/migrate.js`, `db/schema.sql` | ✅ **Fixed 2026-09-24** — 001/002 frozen with a header marker, `003-cross-vertical.sql` added, SHA-256 checksums recorded and enforced, `pg_advisory_lock` held for the run. 13 tests in `db/migrate.test.js`; `npm run verify:migrations` for the end-to-end path. Repair guide: [docs/MIGRATIONS.md](MIGRATIONS.md) |
| 6 | **No connection TLS.** The pool sets no `ssl` option, so any managed Postgres (RDS, Cloud SQL, Neon) refuses the connection. No `statement_timeout` or `lock_timeout`. | `db/client.js`, `db/sslConfig.js` | ✅ **Fixed 2026-09-24** — `DB_SSL_MODE` (`auto`/`disable`/`require`/`verify-full`) with `auto` inferring from `DATABASE_URL`'s `sslmode`; `require` and `DB_SSL_REJECT_UNAUTHORIZED=false` are refused at boot in production; `DB_SSL_CA`/`DB_SSL_CA_FILE` for private CAs. Plus `statement_timeout` and `lock_timeout`. 21 tests in `db/sslConfig.test.js` |
| 7 | **No audit DB writes.** `recordAudit` logs to Fastify stdout only; nothing is inserted into `audit_log` and the `hmac` column is never populated. Call sites are already positioned inside their transactions. | `audit/auditLog.js:62-70` | Roadmap Phase 3 |
| 8 | **No backup or restore.** No dump script, no PITR, no restore drill. | — | Roadmap Phase 1 |
| 9 | **No rate limiting, no security headers.** `RATE_LIMIT_READ_PER_MIN` / `RATE_LIMIT_WRITE_PER_MIN` are read into config but no limiter exists; `TooManyRequests` is defined but never thrown. | `config/index.js:51-54`, `utils/errors.js:88-93` | Roadmap Phase 6 |
| 10 | **Three routes lack permission gates** — `GET`/`DELETE /security/sessions`, `POST /sync`. All return 501 today, so there is no live exposure, but the gates are absent rather than merely permissive. | `routes/users.js:24-25`, `routes/sync.js:31` | Roadmap Phase 1 |
| 11 | **The frontend and server permission matrices have drifted on 5 cells**, two of which make the *server* wider. `server/src/rbac/permissions.js:3` claims exact parity. | both `permissions.js` files | Roadmap Phase 2 |
| 12 | **`authMiddleware.test.js` was not in the `npm test` glob** — the most security-relevant suite in the repo never ran in CI. It also failed when run directly, due to a truthiness bug in its own `setDevAuth` helper. | `package.json:14`, `auth/authMiddleware.test.js:41-46` | ✅ **Fixed 2026-09-24** — glob extended; helper fixed; 0 failures |

Test count has moved from 88 to 390 across the config guards, migration safety, SSL resolution, token signing, tenant isolation, password hashing, sessions, MFA, audit-log and RLS suites: **390 tests, 379 pass, 11 skipped (DB-integration, gated on `DATABASE_URL`), 0 fail.** Verified with `DB_RLS_MODE=probe` as `estateflow_app` — RLS enforcing, behaviour unchanged.

`npm test` loads `.env.test` via `node --env-file`, which supplies a throwaway `JWT_SECRET`. The token service refuses to sign or verify without a usable key, and hardcoding one per test file would mean a dozen copies to keep in sync.

### 6.1 Migration manifest

| # | Name | File | Status |
|---|------|------|--------|
| 001 | `001-schema` | `schema.sql` | **FROZEN 2026-09-24.** Do not edit. |
| 002 | `002-indexes` | `indexes.sql` | **FROZEN 2026-09-24.** Do not edit. |
| 003 | `003-cross-vertical` | `003-cross-vertical.sql` | Added 2026-09-24. Repairs the columns stranded by the in-place edit of `001`. Idempotent. |

`003-cross-vertical.sql` re-adds the 11 cross-vertical `leads` columns, `visits.listing_id` and its foreign key, and the 4 associated indexes. Every statement is `IF NOT EXISTS` or a guarded `DO` block, so it is safe on a fresh database (where `001` already created them) and on a drifted one. It only adds; it never drops or rewrites data.

The runner now records a SHA-256 per applied migration and **refuses to migrate when an applied file has changed**, naming the file and giving three repair paths. A `NULL` checksum (a database created before this change) is backfilled on the next run.

Full documentation, including how to repair local drift: [docs/MIGRATIONS.md](MIGRATIONS.md).

---

## 6. Open follow-ups (tracked here, not yet started)

1. ~~**Wire `pg` + a connection pool.**~~ Done — `src/db/client.js` with `getDb()` / `query()` / `transaction()` / `closeDb()`. Routes get DB access by importing these directly.
2. ~~**Implement the listings read + write surface end-to-end.**~~ Done — `GET /api/v1/listings`, `GET /api/v1/listings/:id`, plus 6 write routes (`POST /listings`, `PATCH /:id`, `POST /:id/assign`, `POST /:id/verify`, `POST /:id/photos`, `DELETE /:id`). Mutations audit-log inside the same transaction as the data row.
3. **Implement `authMiddleware` against the DB.** Load the user, role, team, project memberships, and merge role matrix + user overrides on every request. (Dev shortcut already does this; production JWT path still falls back to a zero-permission placeholder.)
4. **Wire the remaining vertical endpoints.** `GET /api/v1/leads` is the smallest one — it exercises auth, scope filtering, audit, and JSON shape — and will validate the pattern for the rest.
5. **Add `@fastify/jwt`** and switch `tokenService` to a real HS256 signer. Rotate `JWT_SECRET` from KMS.
6. **Add `argon2`** and replace `hashPassword` / `verifyPassword`. Wire password history for the reuse check.
7. **Add `@fastify/rate-limit`** keyed on `req.user.id`. Mirror the limits in [docs/AUTH_API_SPEC.md §1](AUTH_API_SPEC.md).
8. **RLS rollout.** Started: `withTenant()` is live and four tables have policies. Next step is a non-BYPASSRLS application role — until that exists the policies do nothing. Sequence in [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md) §7.
9. **OpenAPI.** Switch every route to a JSON Schema body and expose `/documentation`.

Each is a self-contained PR; none blocks the others.
