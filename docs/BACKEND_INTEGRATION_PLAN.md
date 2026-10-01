# Joldipabo CRM — Backend Integration Plan

Date: 2026-09-23

Status: preparation layer. No backend exists yet. This document is the contract a future backend must satisfy so the frontend demo can be swapped to a real API without UI changes.

The frontend today runs entirely on seeded data ([src/data/seed.js](../src/data/seed.js)) wrapped by an in-memory reducer ([src/state/store.jsx](../src/state/store.jsx)). A repository abstraction layer ([src/services/](../src/services/)) now defines the boundary a real backend will plug into. Until then, the demo repository implementation stands in.

---

## 1. Recommended backend stack

Pick one of the two options below. Both satisfy the contract.

### Option A — Node + TypeScript (recommended)

- **Runtime:** Node.js 20 LTS, TypeScript 5.
- **HTTP:** Fastify (preferred) or Express. Fastify has better default validation, JSON Schema-driven contracts, and a smaller surface area.
- **Database:** PostgreSQL 16. The data model is relational; lead/visit/attendance relationships are join-heavy, which Postgres handles natively. Use Prisma or Drizzle as the ORM — Drizzle is preferred for SQL transparency.
- **Object storage:** S3-compatible (AWS S3, Cloudflare R2, or self-hosted MinIO). Pre-signed URLs for site photo upload.
- **Cache / queue (optional):** Redis for rate limiting and session invalidation. BullMQ for background jobs (photo thumbnail generation, exports).
- **Email / SMS:** Resend or SES for transactional email, MSG91/Twilio for SMS, WhatsApp Business API for messages.
- **Hosting:** Docker containers on a managed Postgres (Neon, Supabase, or RDS).

Why: the team already writes TypeScript-style data shapes (see [docs/DATA_MODEL.md](DATA_MODEL.md)). Node keeps the cognitive overhead to one language. Fastify's JSON Schema validation generates the OpenAPI spec for the API documentation site automatically.

### Option B — Python + FastAPI

- **Runtime:** Python 3.12.
- **HTTP:** FastAPI. Pydantic for request/response schemas.
- **Database:** PostgreSQL 16 with SQLAlchemy 2.0.
- **Object storage:** same as Option A.
- **Hosting:** Docker on Fly.io, Render, or a VPS.

Pick this if the team is Python-fluent and prefers Pydantic's ergonomic validation. The data shapes translate verbatim.

### What to avoid

- **MongoDB / Firestore / DynamoDB-only.** The lead pipeline is inherently relational (lead → visit → attendance → photo all join on `projectId`, `ownerId`, `teamId`). Document stores work but lose the relational clarity.
- **A separate auth service (Auth0, Clerk) for the first iteration.** It is faster to integrate JWTs issued by the same backend and migrate to an external IdP once the user model stabilises.
- **GraphQL.** The current frontend reads collections with simple filters (scope, status, owner). REST with paginated lists is a smaller surface and matches the repository abstraction already defined.

### Vertical coverage

Joldipabo supports every common Indian real estate vertical alongside new-apartment project sales: residential rent, PG / hostel (per bed and per room), residential buy / resale, residential sale, land and plot buy / sell, office lease / sale, commercial lease / sale (shop / warehouse / showroom), and direct owner / landlord listings. The data model encodes this as one `listings` table with `service_category`, `property_type`, and `listing_intent` columns, paired with an extended `leads` table that models tenant / buyer / seller / landlord / investor / business demand. The new-sale project flow (Projects + Leads + Site Visits + Site Photos) is untouched — it is a strict superset, not a migration.

---

## 2. Database tables / entities

Schema is the relational projection of [docs/DATA_MODEL.md](DATA_MODEL.md). All tables have:

- `id text PRIMARY KEY` (use ULIDs, not UUIDv4 — sortable, friendlier to logs).
- `created_at timestamptz NOT NULL DEFAULT now()`.
- `updated_at timestamptz NOT NULL DEFAULT now()`.
- `deleted_at timestamptz` (soft delete; partial indexes should exclude rows where `deleted_at IS NOT NULL`).

Tables:

- `users` — see Users.
- `roles` — see Roles. `is_system boolean NOT NULL`.
- `permission_matrices` — `(role_id text PRIMARY KEY REFERENCES roles(id), matrix jsonb NOT NULL)`. Stores the live matrix per role.
- `teams` — see Teams.
- `projects` — see Projects.
- `team_members` — `(team_id text REFERENCES teams(id), user_id text REFERENCES users(id), PRIMARY KEY (team_id, user_id))`.
- `project_members` — `(project_id text REFERENCES projects(id), user_id text REFERENCES users(id), PRIMARY KEY (project_id, user_id))`.
- `leads` — see Leads. Indexes on `(owner_id)`, `(team_id)`, `(status)`, `(project_id)`, `(next_follow_up)`, plus the cross-vertical indexes `(tenant_id, service_need)` and `(tenant_id, client_type)` for vertical reporting. All columns are nullable so existing seeded data without `serviceNeed` keeps working.
- **`listings`** — the property catalogue for every non-project vertical: rent, PG / hostel, buy residential, sell residential, land, office, commercial. Carries `service_category`, `property_type`, `listing_intent`, geo, price, rent_monthly, deposit, owner contact, assigned_to, team_id, project_id (optional), `availability_status`, `verification_status`, `amenities jsonb`. Indexes on `(tenant_id, service_category)`, `(tenant_id, listing_intent)`, `(tenant_id, city)`, `(tenant_id, assigned_to)`, `(tenant_id, verification_status)`, all partial excluding `deleted_at IS NOT NULL`.
- **`listing_photos`** — separate from `photos`. Indexed on `(tenant_id, listing_id)`.
- **`listing_documents`** — internal storage of legal / proof docs. Indexed on `(tenant_id, listing_id)`. No public read endpoint in v1.
- **`listing_matches`** — junction between leads and listings, populating the cross-suggest flow. Indexed on `(tenant_id, lead_id)`, `(tenant_id, listing_id, status)`.
- `visits` — see Visits. Index on `(assigned_to, scheduled_at)`, `(lead_id)`, plus the optional FK `listing_id` (set when a visit is a rent / PG / resale / commercial / land tour instead of a new-project tour).
- `attendance` — see Attendance. Composite index `(staff_id, date)` for daily queries. Unique partial index `(staff_id, date) WHERE check_out IS NULL` prevents duplicate open shifts.
- `photos` — see Photos. `object_key text NOT NULL` (S3 key); `public_url text` populated after CDN sign.
- `threads` — see Threads.
- `thread_participants` — `(thread_id text REFERENCES threads(id), user_id text REFERENCES users(id), PRIMARY KEY (thread_id, user_id))`. The frontend's `threads[i].participants` is a view of this table.
- `messages` — see Messages. Index `(thread_id, timestamp DESC)` for thread reads.
- `audit_log` — see Audit Activity. Append-only. Consider `pg_audit` or a separate write-only replica for tamper-evidence. New entity values written through this table include `listing`, `listing_photo`, and `listing_document`. New verbs include `created-listing`, `updated-listing`, `deleted-listing`, `verified-listing`, `assigned-listing`, `uploaded-listing-photo`, `approved-listing-photo`.

Use `text` rather than `varchar(n)` for IDs and free-form strings. Postgres handles them equivalently and migrations are less brittle.

---

## 3. Auth model

> **Detailed design:** see [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md) (auth, tenant, security), [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) (server-side permission middleware + scope SQL), [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md) (13 auth + security endpoints), and [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) (pre-launch tests). This section is the short summary.

For the first backend iteration:

- **Auth method:** email + password, with optional TOTP MFA. Password hashing with Argon2id (memory ≥ 64 MiB, iterations ≥ 3).
- **Sessions:** JWT access tokens (short-lived, 15 min) + rotating refresh tokens (7 days, stored server-side, revocable). Refresh tokens are stored hashed (SHA-256) in a `refresh_tokens` table keyed by `(user_id, jti)`.
- **Transport:** HTTPS only. HSTS header. Secure / HttpOnly / SameSite=Strict cookies for the refresh token; access token in `Authorization: Bearer` for the API client.
- **Mobile:** the field-staff mobile shell will eventually run as a PWA. Long-lived refresh tokens are acceptable there because the device is the only holder; bind the refresh token to a device fingerprint on issue and rotate on suspicious activity.

Roles are not part of the token claim set — the backend reads the role from the database on every request. This makes role changes (including permission matrix edits) effective immediately. The token claim set is:

```json
{
  "sub": "user_01HX...",
  "iat": 1737...,
  "exp": 1737...,
  "jti": "..."
}
```

Rate limiting: 100 req/min per user for read endpoints, 30 req/min for write endpoints, 10 req/min for `POST /messages` and `POST /photos`. Backed by Redis with sliding-window counters.

---

## 4. Role / permission enforcement model

The frontend already implements `can(user, resource, action, record)` ([src/data/permissions.js](../src/data/permissions.js)). The backend must implement the same function and apply it on every endpoint.

### How enforcement flows

1. Auth middleware resolves `req.user` from the JWT.
2. The endpoint declares the resource and action it serves (`leads.view`, `leads.create`, etc.) via a route-level decorator or schema annotation.
3. Before hitting the handler, the permission middleware runs `can(req.user, resource, action, record)`:
   - For read endpoints, run after the query has been filtered by `filterByScope(user, resource, action, records)`.
   - For write endpoints, load the target record and check `can(...)` before applying the mutation.
4. Failures return `403 Forbidden` with `{ error: 'forbidden', resource, action }`. Never leak the row's existence to a user without `view` scope.

### Scope semantics (must match frontend)

- `none`: deny.
- `own`: `record.owner_id === user.id`.
- `team`: `record.team_id === user.team_id`.
- `project`: `user.project_ids.includes(record.project_id)`.
- `all`: allow.

Implement this as a single SQL helper that takes the user's `permission_matrix` and injects a `WHERE` clause. For example, `leads.list` resolves to:

```sql
SELECT * FROM leads
WHERE deleted_at IS NULL
  AND (
    $scope = 'all'
    OR ($scope = 'own' AND owner_id = $userId)
    OR ($scope = 'team' AND team_id = $userTeamId)
    OR ($scope = 'project' AND project_id = ANY($userProjectIds))
  )
```

System roles (`super-admin`, `admin`) bypass scope checks on most resources but cannot modify their own `is_system` flag or the permission matrix of `super-admin`. The backend must protect these specifically — see `isSystemRole()` in [src/data/permissions.js](../src/data/permissions.js).

### Permission matrix updates

`PATCH /api/v1/roles/:id/matrix` is admin-only. The matrix is stored as JSONB. On update:

1. Reject if `role.is_system` and the request would change a system role's scope on `roles` resource.
2. Apply the diff in a transaction.
3. Write to `audit_log` with the full before/after matrix.
4. Optionally broadcast an invalidation event so cached clients refresh.

---

## 5. File storage for site photos

- **Storage backend:** S3-compatible bucket. Bucket is private; all reads go through CloudFront / signed URLs.
- **Upload flow (presigned):**
  1. Client `POST /api/v1/photos:presign` with `{ filename, contentType, size }`. Server validates MIME (`image/jpeg`, `image/png`, `image/webp`), size (≤ 15 MB), and returns `{ url, fields, objectKey }`.
  2. Client uploads directly to S3 with `Content-Type` matching the agreed value.
  3. Client `POST /api/v1/photos` with `{ objectKey, projectId, category, caption, geo }`. Server HEADs the object to confirm it exists and the size matches, then inserts the row.
- **Processing:** trigger an S3 event → Lambda / worker that:
  - Generates a thumbnail (max 1024 px on the long edge).
  - Strips EXIF (privacy — GPS coordinates can leak home addresses).
  - Optionally runs a content moderation check (S3 + Rekognition or a self-hosted model).
  - Updates the `photos.thumbnail_url` and `photos.processed_at`.

`Listing Photos` follow the exact same pipeline but write to `listing_photos`. The two tables are kept separate because the access rules differ (`listings.approve` vs `photos.approve`); joining them on a single `photos` table would have mixed the permission verbs. Listing photos also need a `category` covering `Interior`, `Exterior`, `Amenities`, `Floor Plan`, `Document Cover`, `Other` whereas site-photo categories are construction-flavoured.
- **CDN:** CloudFront / equivalent. URLs are short-lived signed URLs for non-public photos; gallery views issue fresh URLs on each page load.
- **Retention:** no automatic deletion in v1. Add lifecycle policies later (move to Glacier after N years).

---

## 6. Audit log requirements

The seed's `ACTIVITY` array is the demo's audit feed ([src/data/seed.js](../src/data/seed.js)). The backend must:

- **Append only.** No `UPDATE` or `DELETE` on `audit_log` from any application code path. Enforce at the database role level.
- **Cover every mutating endpoint.** A single helper `audit(user, action, entity, entityId, metadata)` runs after every successful mutation and inside the same transaction (so a failed write doesn't leave an audit row).
- **Tamper-evidence:** for compliance (RERA in India, GDPR for EU prospects), enable `pg_audit` or sign rows with an HMAC over `(id, user_id, action, entity, entity_id, timestamp, metadata)` using a key that lives in HSM / KMS, not the application.
- **Retention:** 7 years minimum for financial / booking events, 2 years for operational events. A nightly job archives older rows to cold storage.
- **Read access:** super-admin only via `GET /api/v1/activity`. Filterable by `userId`, `entity`, `action`, date range. Export as CSV.

---

## 7. API endpoint list

All endpoints are versioned under `/api/v1/`. All return JSON. All write endpoints require auth. All endpoints return RFC 7807 problem-detail errors on failure (`{ type, title, status, detail, instance }`).

### Auth

| Method | Path                          | Description                                |
| ------ | ----------------------------- | ------------------------------------------ |
| POST   | `/auth/login`                 | Email + password → JWT access + refresh.   |
| POST   | `/auth/refresh`               | Exchange refresh for new access.            |
| POST   | `/auth/logout`                | Revoke refresh token.                      |
| POST   | `/auth/mfa/setup`             | Begin TOTP enrolment.                      |
| POST   | `/auth/mfa/verify`            | Verify TOTP code.                          |
| GET    | `/auth/me`                    | Current user + role + permission matrix.   |

### Users & Roles

| Method | Path                                  | Description                                |
| ------ | ------------------------------------- | ------------------------------------------ |
| GET    | `/users`                              | List users (scoped by `staff.view`).       |
| GET    | `/users/:id`                          | Single user (scoped).                      |
| POST   | `/users`                              | Invite new user (sends email).             |
| PATCH  | `/users/:id`                          | Update user (status, designation, role).   |
| DELETE | `/users/:id`                          | Soft-delete user.                          |
| GET    | `/roles`                              | List roles + matrix.                       |
| POST   | `/roles`                              | Create custom role.                        |
| PATCH  | `/roles/:id`                          | Update role display fields.                |
| PATCH  | `/roles/:id/matrix`                   | Update permission matrix (admin only).     |
| DELETE | `/roles/:id`                          | Delete custom role (system roles refused). |

### Teams & Projects

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/teams`                      | List teams in viewer's scope.                |
| POST   | `/teams`                      | Create team.                                 |
| PATCH  | `/teams/:id`                  | Update team.                                 |
| GET    | `/projects`                   | List projects in viewer's scope.             |
| POST   | `/projects`                   | Create project.                              |
| PATCH  | `/projects/:id`               | Update project.                              |
| GET    | `/projects/:id/members`       | List users assigned to project.              |
| POST   | `/projects/:id/members`       | Assign user to project.                      |
| DELETE | `/projects/:id/members/:uid`  | Remove user from project.                    |

### Leads

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/leads`                      | List leads (scoped). Supports `?status=`, `?ownerId=`, `?score=`, `?projectId=`, `?q=`. |
| GET    | `/leads/:id`                  | Lead detail.                                 |
| POST   | `/leads`                      | Create lead.                                 |
| PATCH  | `/leads/:id`                  | Update lead.                                 |
| POST   | `/leads/:id/assign`           | Assign lead to user (and team).              |
| DELETE | `/leads/:id`                  | Soft-delete lead.                            |

### Visits

| Method | Path                          | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/visits`                     | List visits (scoped).                        |
| GET    | `/visits/:id`                 | Visit detail.                                |
| POST   | `/visits`                     | Schedule visit.                              |
| PATCH  | `/visits/:id`                 | Update visit (reschedule, notes, status).    |
| POST   | `/visits/:id/complete`        | Mark complete (rating + feedback).           |

### Attendance

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/attendance`                   | List attendance (scoped).                    |
| POST   | `/attendance/check-in`          | Check in. Body: `{ location, siteId }`.      |
| POST   | `/attendance/check-out`         | Check out. Body: `{ location, siteId }`.     |
| PATCH  | `/attendance/:id/approve`       | Approve / clear a record.                    |

### Photos

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/photos`                       | List photos (scoped).                        |
| GET    | `/photos/:id`                   | Photo detail + signed URL.                   |
| POST   | `/photos:presign`               | Get a presigned upload URL.                  |
| POST   | `/photos`                       | Commit uploaded photo record.                |
| PATCH  | `/photos/:id/approve`           | Approve / reject a photo.                    |
| DELETE | `/photos/:id`                   | Soft-delete photo.                           |

### Communication

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/threads`                      | List threads for current user.               |
| POST   | `/threads`                      | Start a thread with another user.            |
| GET    | `/threads/:id/messages`         | List messages in a thread (paginated).       |
| POST   | `/threads/:id/messages`         | Send a message.                              |

### Reports & Export

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/reports/pipeline`             | Pipeline funnel for current viewer.          |
| GET    | `/reports/attendance`           | Attendance summary for current viewer.        |
| POST   | `/reports/leads/export`         | Trigger CSV export; returns job id.          |
| GET    | `/reports/jobs/:id`             | Poll export job status.                      |

### Audit

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/activity`                     | Super-admin only. List audit events.         |
| GET    | `/activity/export`              | CSV stream.                                  |

### Listings

Covers the **rent, PG / hostel, buy / sell residential, land, office / commercial** verticals plus **owner / landlord direct listings**. Each listing has photos (`/api/v1/listings/:id/photos`), documents (internal storage, no public endpoint in v1), and an approval lifecycle driven by the `listings.approve` action. Scope is enforced exactly like `leads`: `own` matches `assigned_to = user.id`, `team` matches `team_id = user.team_id`, `project` matches `project_id = user.project_ids[]`, `all` is unscoped within the tenant.

| Method | Path                              | Description                                                       | Permission             |
| ------ | --------------------------------- | ----------------------------------------------------------------- | ---------------------- |
| GET    | `/listings`                       | List listings. Supports `?serviceCategory=`, `?intent=`, `?city=`, `?projectId=`, `?q=`. | `listings.view`        |
| GET    | `/listings/:id`                   | Listing detail + recent photos.                                   | `listings.view`        |
| POST   | `/listings`                       | Create listing.                                                  | `listings.create`      |
| PATCH  | `/listings/:id`                   | Update listing fields.                                            | `listings.edit`        |
| POST   | `/listings/:id/photos`            | Commit a presigned photo upload against the listing.              | `listings.edit`        |
| POST   | `/listings/:id/documents`         | Commit a presigned document upload against the listing.           | `listings.edit`        |
| POST   | `/listings/:id/verify`            | Verify / approve a listing (sets `verification_status`).          | `listings.approve`     |
| POST   | `/listings/:id/assign`            | Reassign the listing to a different field executive / team.       | `listings.assign`      |
| DELETE | `/listings/:id`                   | Soft-delete a listing.                                            | `listings.delete`      |
| GET    | `/listings/:id/export.csv`        | Stream listing details + photos as CSV.                           | `listings.export`      |

### Leads (extended)

Leads now accept `serviceNeed`, `clientType`, `requirements`, `rentMin/Max`, `preferredLocation`, `desiredPropertyType`, `moveInDate`, `purchaseTimeline`, `matchedListingIds`, `visitStatus`. Existing project-buy leads keep the legacy shape; the new fields are nullable. Filters added to `GET /leads`: `?serviceNeed=`, `?clientType=`. Nothing changes on the wire shape for previously-set fields.

---

## 8. Migration path from demo to real backend

The repository abstraction in [src/services/](../src/services/) makes this a one-line change.

Today:

```js
// src/services/index.js
import { demoRepository } from './demoRepository.js';
let repository = demoRepository;
export const getRepository = () => repository;
export const setRepository = (next) => { repository = next; };
```

When the backend exists:

```js
import { apiRepository } from './apiRepository.js';
import { setRepository } from './index.js';
setRepository(apiRepository);
```

`apiRepository.js` implements the same interface as `demoRepository.js` (typed in [src/services/repositoryTypes.js](../src/services/repositoryTypes.js)) but resolves each method with `fetch('/api/v1/...')`. The store reducer continues to work; only the data origin changes.

Phased rollout:

1. **Phase 1 (current):** demo repository only. The store hydrates from `seed.js`.
2. **Phase 2:** add `apiRepository.js` behind a feature flag. Toggle it on for one role (e.g. super-admin) and verify reads + writes round-trip correctly. Keep the demo repository as the fallback.
3. **Phase 3:** swap repositories globally. Remove `seed.js` from the production bundle. The store hydrates from `apiRepository.list('users')` etc.
4. **Phase 4:** remove the in-memory reducer; the store becomes a thin cache around the repository. Permissions continue to be enforced server-side; the frontend's `can()` becomes advisory (used for UI hiding, not as a security boundary).

The first three phases preserve the demo: the seed remains the source of truth until Phase 3.
