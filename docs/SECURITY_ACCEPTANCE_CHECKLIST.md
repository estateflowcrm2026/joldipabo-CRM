# EstateFlow CRM — Security Acceptance Checklist

Date: 2026-09-19

Status: pre-launch checklist. Every item must be **passing with a documented test** before the production tenant goes live. This document is the launch gate.

It is read alongside [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md), [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md), and [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md).

---

## How to use this document

Each section is a test area. Every numbered item has:

- **What** — the behaviour being verified.
- **How** — the test recipe (curl, click-through, SQL query).
- **Pass criteria** — the assertion that must hold.

A pre-launch reviewer walks every item and records:

- ✓ Pass
- ✗ Fail — fix and re-test before launch.
- ⚠ Deferred — explicitly tracked; not a pass.

---

## 1. Tenant isolation tests

These tests verify that no endpoint, query, or background job can read or write across tenants. RLS and middleware enforcement are the two layers under test.

### 1.1 RLS is enabled on every domain table

- **What**: `pg_class.relrowsecurity = true` for every domain table.
- **How**:
  ```sql
  SELECT relname, relrowsecurity
  FROM pg_class
  WHERE relnamespace = 'public'::regnamespace
    AND relkind = 'r'
  ORDER BY relname;
  ```
- **Pass**: every row returned has `relrowsecurity = true`. Domain tables: `users`, `roles`, `teams`, `projects`, `leads`, `visits`, `attendance`, `photos`, `threads`, `messages`, `audit_log`, `refresh_tokens`, `otp_codes`, `invite_tokens`, `password_reset_tokens`.

### 1.2 RLS policy exists and references `app.tenant_id`

- **What**: every domain table has a policy whose `USING` clause compares `tenant_id` to `current_setting('app.tenant_id')`.
- **How**:
  ```sql
  SELECT schemaname, tablename, policyname, qual
  FROM pg_policies
  WHERE schemaname = 'public';
  ```
- **Pass**: every domain table has at least one policy with the tenant-id clause.

### 1.3 Middleware sets `app.tenant_id` on every request

- **What**: the auth middleware runs `SELECT set_config('app.tenant_id', $1, true)` before any handler query.
- **How**: enable `log_min_duration_statement = 0` in a staging environment; sign in as `u-asha@acme`; call `GET /leads`. Inspect the query log: every query against a tenant-scoped table should be preceded by the `set_config` call.
- **Pass**: every request begins with the `set_config` call.

### 1.4 Cross-tenant GET returns 404

- **What**: a user from tenant A cannot read a resource that belongs to tenant B, even with a valid id.
- **How**:
  1. Sign in as `u-asha@acme`.
  2. From the database, find a lead id that belongs to tenant B (e.g. `lead-99` in `org_beta`).
  3. `curl -H "Authorization: Bearer <acme-token>" https://api.estateflow.app/api/v1/leads/lead-99`.
- **Pass**: response is `404 not-found`. Body does not contain the lead's fields.

### 1.5 Cross-tenant list returns only own-tenant rows

- **What**: a list endpoint never returns rows from another tenant.
- **How**:
  1. As above, with a tenant A token.
  2. Insert 100 rows in tenant B with a known marker.
  3. `GET /leads?status=New` from tenant A.
- **Pass**: response count matches tenant A's actual count; no marker rows leak.

### 1.6 Cross-tenant write is refused

- **What**: a user cannot write a row attributed to another tenant by including a foreign-key id from another tenant.
- **How**:
  1. Tenant A user attempts to create a visit on a project in tenant B (`projectId: p-beta-1`).
- **Pass**: `404 not-found` on `projectId` lookup (the project is invisible). Even with a forged `tenantId` field in the body, RLS rejects the insert.

### 1.7 Refresh token from another tenant is refused

- **What**: a refresh token issued by tenant A is useless on tenant B.
- **How**:
  1. Sign in on tenant A; capture the refresh token.
  2. `POST /auth/refresh` with the token, but with `X-Tenant-Slug: beta`.
- **Pass**: `401 unauthorized` or `403 tenant-mismatch`.

### 1.8 Background jobs are tenant-aware

- **What**: cron / queue jobs that iterate over rows do so per-tenant with the `app.tenant_id` set.
- **How**: insert a test row in tenant B with a future-due timestamp; the nightly job in tenant A should not touch it.
- **Pass**: the row is unchanged after the job runs.

### 1.9 Backup restore is whole-tenant

- **What**: restoring a tenant's data does not affect another tenant.
- **How**: restore a 7-day-old backup of tenant A; tenant B's data is untouched.
- **Pass**: row counts in tenant B match the pre-restore snapshot.

### 1.10 Super-admin cannot bypass RLS via the application role

- **What**: the application DB user (`app`) never has the `BYPASSRLS` attribute.
- **How**:
  ```sql
  SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'app';
  ```
- **Pass**: `rolbypassrls = false`. The `app_admin` role (used only by `/api/v1/admin/*`) has `rolbypassrls = true`.

---

## 2. RBAC tests

For each role, the tests in [docs/RBAC_SERVER_ENFORCEMENT.md §8](RBAC_SERVER_ENFORCEMENT.md) must pass. The full matrix is 8 roles × 10 resources × 7 actions = 560 tests; the high-priority subset is below.

### 2.1 Field Executive — own scope

- **Pass criteria**: As `u-asha` (field-executive):
  - `GET /leads/lead-1` (own lead) → 200.
  - `GET /leads/lead-2` (another user's lead) → 403.
  - `POST /leads` (new lead) → 201, `ownerId = u-asha`.
  - `PATCH /leads/lead-2` → 403.
  - `POST /attendance/check-in` → 201.
  - `POST /visits/visit-2/complete` (another user's visit) → 403.

### 2.2 Sales Manager — team scope

- **Pass criteria**: As `u-raj` (sales-manager, team `t-north`):
  - `GET /leads` (own team) → 200, returns leads where `owner.teamId = t-north`.
  - `GET /leads/lead-2` (lead in `t-south`) → 403.
  - `POST /leads/lead-1/assign { toUserId: u-asha }` (within team) → 200.
  - `POST /leads/lead-1/assign { toUserId: u-vijay }` (different team) → 403.
  - `GET /reports/team-performance` → 200, contains only `t-north` data.
  - `GET /reports/booking-summary` (all-tenant scope) → 403.

### 2.3 Site Manager — project scope

- **Pass criteria**: As `u-priya` (site-manager, projects `p-skyline`, `p-heights`):
  - `GET /photos/photo-1` (project `p-skyline`) → 200.
  - `GET /photos/photo-2` (project `p-greens`) → 403.
  - `GET /photos/photo-2/url` → 403.
  - `POST /photos/photo-1/approve { approved: true }` → 200, audit row written.
  - `POST /leads/lead-1/assign` → 403 (no `leads.assign` permission).

### 2.4 Accounts — reports + no operational edit

- **Pass criteria**: As `u-anil` (accounts):
  - `GET /reports/booking-summary` → 200.
  - `POST /reports/booking-summary/export` → 200, audit row written, email queued.
  - `PATCH /leads/lead-1 { status: 'Closed' }` → 403.
  - `POST /visits/visit-1/complete` → 403.
  - `GET /attendance/att-1` → 200; response **does not** include `checkInLocation` or `checkOutLocation`.

### 2.5 Admin — non-system roles only

- **Pass criteria**: As `u-admin` (admin):
  - `PATCH /roles/role_channel_partner_manager { permissionMatrix: {...} }` → 200.
  - `DELETE /roles/role_telecaller` → 200 (if not system).
  - `PATCH /roles/role_super_admin { name: '...' }` → 409 `cannot-modify-system-role`.
  - `DELETE /roles/role_admin` → 409 `cannot-modify-system-role`.
  - `POST /auth/impersonate { userId: u-asha }` → 403 (admin cannot impersonate).

### 2.6 Super-admin — full + system role protection still requires super-admin

- **Pass criteria**: As `u-super` (super-admin):
  - All admin tests pass.
  - `PATCH /roles/role_admin { permissionMatrix: {...} }` → 200 (super-admin can edit system roles).
  - `POST /auth/impersonate { userId: u-asha, reason: 'support' }` → 200, MFA challenge issued, then 200 with tokens.
  - `POST /auth/impersonate { userId: u-other-super }` → 403 (super-admin cannot impersonate another super-admin).

### 2.7 Channel-Partner Manager — custom scope

- **Pass criteria**: As `u-cpm` (channel-partner-manager, partner `org-partner-1`):
  - `GET /leads/lead-cp-1` (`partnerOrg: org-partner-1`) → 200.
  - `GET /leads/lead-cp-2` (`partnerOrg: org-partner-2`) → 403.
  - `POST /leads { source: 'channel-partner', partnerOrg: org-partner-1 }` → 201.
  - `POST /leads { source: 'direct' }` → 403 (not allowed source).

### 2.8 Telecaller — own + no operational

- **Pass criteria**: As `u-tele` (telecaller):
  - `GET /leads/lead-1` (own) → 200.
  - `PATCH /leads/lead-1 { status: 'Closed' }` → 403 (no `leads.edit` on closed).
  - `POST /communications/threads/thr-2/messages` (not a participant) → 403.
  - `POST /leads` → 201, `ownerId = u-tele`.

### 2.9 Scope SQL helper covers all 5 scopes

- **What**: every (resource, action) pair has a unit test for `none`, `own`, `team`, `project`, `all` scopes.
- **How**: backend test suite covers each. Use a known-fixture tenant with rows pre-seeded.
- **Pass**: 100% green.

### 2.10 Permission matrix change takes effect within 15 minutes

- **What**: an admin's edit to a user's matrix is observed by that user within one access-token TTL.
- **How**:
  1. Admin downgrades `u-asha` from `field-executive` to `telecaller`.
  2. `u-asha` makes a `GET /leads/lead-2` request within 15 minutes.
- **Pass**: response is 403 (the new matrix is consulted).

### 2.11 Field-level stripping

- **What**: the response shaper strips fields the user can't see.
- **How**:
  1. As accounts, `GET /attendance/att-1`.
- **Pass**: response JSON does not include `checkInLocation`, `checkOutLocation`, `staffEmail`, `staffPhone`.

### 2.12 Defence in depth — UI gating matches server gating

- **What**: a button hidden in the UI is also refused by the server.
- **How**: as field-executive, send a hand-crafted `PATCH /leads/lead-2` request from the browser dev tools.
- **Pass**: 403.

---

## 3. GPS privacy tests

Per [docs/AUTH_TENANT_SECURITY_PLAN.md §14](AUTH_TENANT_SECURITY_PLAN.md).

### 3.1 GPS is captured on attendance check-in

- **Pass criteria**: `POST /attendance/check-in` with `location: { lat: 12.97, lng: 77.59, accuracy: 5 }` stores the row with `checkInLocation` populated.

### 3.2 Self sees own GPS

- **Pass criteria**: `u-asha` reading `GET /attendance?staffId=u-asha` receives `checkInLocation`.

### 3.3 Manager sees team GPS

- **Pass criteria**: `u-raj` (sales-manager) reading the same attendance row receives `checkInLocation`.

### 3.4 Site manager sees project GPS

- **Pass criteria**: `u-priya` (site-manager, project `p-skyline`) reading attendance of a staff who checked in at `p-skyline` receives `checkInLocation`.

### 3.5 Accounts does NOT see GPS

- **Pass criteria**: `u-anil` (accounts) reading the same attendance row: response JSON omits `checkInLocation`, `checkOutLocation`.

### 3.6 GPS audit row uses rounded coordinates

- **What**: audit log rows for `checked-in` carry lat/lng rounded to 3 decimal places (≈110 m).
- **How**: `SELECT metadata->'location' FROM audit_log WHERE action = 'checked-in'`.
- **Pass**: `lat` and `lng` have at most 3 decimal digits.

### 3.7 Low GPS confidence flag

- **Pass criteria**: a check-in with `accuracy: 500` stores the row with `metadata.lowGpsConfidence = true`; the row is still stored.

### 3.8 EXIF stripping

- **What**: photo uploads with GPS-bearing EXIF have the EXIF stripped before storage.
- **How**: upload a test photo with GPS EXIF; download the stored object; inspect the bytes.
- **Pass**: no `GPSLatitude` / `GPSLongitude` EXIF tags in the stored object.

---

## 4. Photo access tests

Per [docs/AUTH_TENANT_SECURITY_PLAN.md §15](AUTH_TENANT_SECURITY_PLAN.md).

### 4.1 Signed URL is short-lived

- **Pass criteria**: `GET /photos/:id/url` returns a presigned URL with `expires <= 900s`.

### 4.2 Signed URL issuance is audited

- **Pass criteria**: each `GET /photos/:id/url` writes an audit row `photo-url-issued` with `metadata.userId, metadata.photoId, metadata.projectId`.

### 4.3 Approved-only visibility before approval

- **Pass criteria**: a photo in `approved: false` state is visible only to:
  - The uploader (`u-asha`).
  - The uploader's manager (`u-raj`).
  - The site manager of the photo's project (`u-priya`).

  It is **not** visible to a different team member (`u-tele`) or accounts (`u-anil`).

### 4.4 After approval, scope rules apply

- **Pass criteria**: once `approved = true`, the photo becomes visible to everyone with `photos.view` scope that covers the photo's project.

### 4.5 Soft delete preserves metadata; S3 object removed in 30 days

- **Pass criteria**: `DELETE /photos/:id` sets `deletedAt`; the S3 object is scheduled for removal in 30 days; the row is hidden from list endpoints.

### 4.6 Bulk export is super-admin-only

- **Pass criteria**: `POST /api/v1/admin/photos/bulk-export` is refused for everyone except `super-admin`. The audit row `bulk-photo-export` is written with `metadata.ip, metadata.signedUrlExpiresAt`.

### 4.7 Photo URLs are never returned as public URLs

- **Pass criteria**: `GET /photos/:id` returns metadata only; the URL field is `null` until `GET /photos/:id/url` is called.

---

## 5. Export tests

Per [docs/AUTH_TENANT_SECURITY_PLAN.md §16](AUTH_TENANT_SECURITY_PLAN.md).

### 5.1 Single-record CSV is watermarked

- **Pass criteria**: `GET /leads/lead-1/export.csv` returns a CSV with `__exported_at` and `__exported_by` columns.

### 5.2 Tenant-wide export is async

- **Pass criteria**: `POST /reports/leads/export` returns `202 Accepted` with a job id; the user receives an email when the file is ready.

### 5.3 Export rate limits

- **Pass criteria**:
  - 31st single-record export in a minute → 429.
  - 6th tenant-wide export in an hour → 429.
  - 2nd bulk-raw export in a day → 429.

### 5.4 Bulk export is audited

- **Pass criteria**: every bulk export writes a `bulk-data-export` audit row with `metadata.rowCount, metadata.filters, metadata.signedUrlExpiresAt`. The tenant owner receives an email.

### 5.5 Export without permission is refused

- **Pass criteria**: as field-executive, `POST /reports/leads/export` → 403.

### 5.6 CSV does not contain PII the user can't see

- **Pass criteria**: as sales-manager with `team` scope, the export contains only leads in their team; phone numbers are present (sales-manager has `team` scope so phone is visible) but other PII outside scope is omitted.

---

## 6. Session expiry tests

Per [docs/AUTH_TENANT_SECURITY_PLAN.md §8, §19, §20](AUTH_TENANT_SECURITY_PLAN.md).

### 6.1 Access token expires in 15 minutes

- **Pass criteria**: an access token issued with `expiresIn: 900` returns 401 `token-expired` after 15 minutes (±2 min clock-skew tolerance).

### 6.2 Refresh token rotates

- **Pass criteria**: two successive `POST /auth/refresh` calls with the original token return two different new refresh tokens; the original is `revoked`.

### 6.3 Refresh token replay revokes all

- **Pass criteria**: an attempt to reuse a revoked refresh token returns 401 `token-replay` and revokes every other refresh token for the user.

### 6.4 Password reset invalidates all sessions

- **Pass criteria**: after `POST /auth/reset-password` succeeds, every refresh token for the user returns 401 `token-revoked`.

### 6.5 Logout-all revokes every session

- **Pass criteria**: after `POST /auth/logout-all`, every refresh token for the user returns 401 `token-revoked`. The user is notified by email of "Your password was reset" or "You signed out everywhere".

### 6.6 Suspension takes effect on next request

- **Pass criteria**: after admin flips `status = 'Suspended'`, the user's next request returns 401 with `code: 'user-suspended'`.

### 6.7 Inactive user cannot log in

- **Pass criteria**: as `status = 'Inactive'`, `POST /auth/login` returns 401 with the same envelope as wrong credentials (no enumeration).

### 6.8 Long-idle session is expired

- **Pass criteria**: a refresh token unused for >30 days (or 90 days with `rememberDevice`) returns 401 `token-expired` on next use.

### 6.9 Trusted device skips OTP for 30 days

- **Pass criteria**: as a user with MFA enabled, after `verify-otp` with `rememberDevice: true`, the next 30 days of logins from the same `deviceFingerprint` skip the OTP step (only password is required).

### 6.10 MFA recovery code works once

- **Pass criteria**: each recovery code works once; reusing a consumed code returns 401; recovery codes <3 trigger a UI prompt to regenerate.

---

## 7. Offline queue security tests

Per [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md), [docs/PWA_OFFLINE_PLAN.md §9](PWA_OFFLINE_PLAN.md), and [docs/SYNC_WORKER_PLAN.md §3](SYNC_WORKER_PLAN.md).

### 7.1 Queue item cannot be forged by another tenant

- **What**: a queue item that was queued by tenant A's user cannot be replayed to tenant B's API.
- **How**: in the offline queue, edit a queue item's `payload.staffId` to a staff id from another tenant. Sync.
- **Pass**: the API rejects the payload with 403 or 404; the queue item is marked `failed` with `code: 'cross-tenant-replay'`.

### 7.2 Permission re-check at sync time

- **What**: if a user's permissions are downgraded between enqueue and sync, the sync is refused.
- **How**:
  1. As field-executive, queue a `visit.update` while offline.
  2. While still offline, admin downgrades the user to `telecaller` (no `visits.edit`).
  3. Online → user taps "Sync pending actions".
- **Pass**: the queue item is marked `failed` with `code: 'permission-downgraded'`. No state mutation on the server.

### 7.3 Idempotency-Key prevents duplicates

- **What**: a queued action, replayed twice (e.g. mid-network-flake), does not create two server-side rows.
- **How**: queue the same `attendance.checkIn` twice via `queueAction(..., { metadata: { idempotencyKey: 'same-key' } })`.
- **Pass**: server has one row; the second request returns the cached response (HTTP 200 with `Idempotency-Key: <key>` echoing).

### 7.4 Photo with deferred blob is refused

- **What**: a `photo.upload` queue item with `metadata.blobPersistence = 'deferred'` is marked `failed` with `code: 'photo-repick-required'`. No S3 upload attempt, no row created.
- **Pass**: queue item has `error.code = 'photo-repick-required'`; no row in `photos`; no S3 object.

### 7.5 Refresh-token rotation does not invalidate queued items

- **What**: an offline-queued action can still be replayed after a token rotation.
- **How**: enqueue `attendance.checkIn`; sign out (rotate token); sign in (new pair); online → tap sync.
- **Pass**: the queue item is replayed with the new access token; the action succeeds.

### 7.6 Queue storage is tenant-scoped

- **What**: the `localStorage` queue key is namespaced by tenant slug.
- **How**: sign in as tenant A, queue an action. Sign out. Sign in as tenant B. Inspect localStorage.
- **Pass**: tenant A's queue is intact under `estateflow:offline-queue:v1:<tenantSlug>`. Tenant B has its own empty queue.

### 7.7 Audit row is written for replayed action

- **Pass criteria**: each `attendance.checkIn` replayed from the queue writes a `checked-in` audit row with `metadata.replayedFromQueue: true` and `metadata.idempotencyKey: <key>`.

---

## 8. Sync replay / idempotency tests

Per [docs/SYNC_WORKER_PLAN.md §3](SYNC_WORKER_PLAN.md).

### 8.1 Sync handler cannot mutate local store

- **What**: the sync worker only flips queue status; it does not re-apply actions through `actions.checkIn` / `actions.updateVisit` / etc.
- **How**: inspect [src/services/syncWorker.js](../src/services/syncWorker.js) — no calls to `actions.*`.
- **Pass**: code search returns no matches.

### 8.2 Replaying the same item twice does not double-execute

- **What**: a `visit.update` queued once, replayed via the worker's retry path, results in one server-side update.
- **Pass criteria**: server `audit_log` has one `updated-visit` row.

### 8.3 Order is preserved

- **What**: queue items are processed in `createdAt` ascending order.
- **Pass criteria**: assert the handler is called with items in the order returned by `listQueuedActions({ status: 'pending' })`.

### 8.4 In-flight guard

- **Pass criteria**: `Promise.all([syncQueuedActions(), syncQueuedActions()])` resolves to the same result object; the flush ran exactly once.

### 8.5 No-handler failure

- **Pass criteria**: a queue item with no registered handler is marked `failed` with `code: 'no-handler'`.

### 8.6 Invalid-payload failure

- **Pass criteria**: a queue item missing a required field is marked `failed` with `code: 'invalid-payload'`; no server-side mutation.

### 8.7 Photo-repick failure

- **Pass criteria**: a `photo.upload` item with `metadata.blobPersistence = 'deferred'` is marked `failed` with `code: 'photo-repick-required'`; the failure detail includes the caption and source filename.

---

## 9. Audit log tests

Per [docs/AUTH_TENANT_SECURITY_PLAN.md §13](AUTH_TENANT_SECURITY_PLAN.md).

### 9.1 Every mutation writes one audit row

- **What**: `POST`, `PATCH`, `DELETE` on a domain endpoint writes exactly one audit row.
- **How**: count audit rows before and after each mutation.
- **Pass**: `count_after - count_before === 1`.

### 9.2 Audit row is in the same transaction as the mutation

- **What**: a mutation that fails to write the audit row is rolled back.
- **How**: inject a fault into the audit-write path; the mutation is rolled back; no row in the domain table.
- **Pass**: row count in the domain table unchanged.

### 9.3 Audit row is HMAC-signed

- **What**: every audit row has a non-null `hmac` column.
- **How**: `SELECT COUNT(*) FROM audit_log WHERE hmac IS NULL;`.
- **Pass**: count is 0.

### 9.4 HMAC verification rejects tampered rows

- **What**: manually modifying an audit row causes HMAC verification to fail.
- **How**: directly update one audit row's `metadata` JSON; run the HMAC verification job.
- **Pass**: the row is flagged; an alert is raised.

### 9.5 Audit log is append-only at the DB role level

- **What**: the application DB role cannot UPDATE or DELETE `audit_log` rows.
- **How**: as the `app` role, attempt `UPDATE audit_log SET ...` and `DELETE FROM audit_log`.
- **Pass**: both fail with permission errors.

### 9.6 Admin can read audit log

- **Pass criteria**: `GET /admin/audit?userId=u-asha&from=...&to=...` (admin only) returns the rows.

### 9.7 User can read own activity

- **Pass criteria**: `GET /me/activity` (any user) returns only the user's own activity; the response shape matches `ACTIVITY` in [src/data/seed.js](../src/data/seed.js).

### 9.8 Audit retention job archives older rows

- **What**: rows older than the retention threshold are archived to S3 Glacier; the rows remain queryable for compliance.
- **How**: backdate rows to 3 years ago; run the archive job.
- **Pass**: rows are present in the archive bucket and a queryable cold-storage view; not in the hot table.

---

## 10. Admin role mutation tests

Per [docs/RBAC_SERVER_ENFORCEMENT.md §5](RBAC_SERVER_ENFORCEMENT.md) (Example 5).

### 10.1 Admin can edit non-system roles

- **Pass criteria**: `PATCH /roles/role_channel_partner_manager { permissionMatrix: {...} }` as `u-admin` returns 200; the change is observed by affected users.

### 10.2 Admin cannot edit system roles

- **Pass criteria**: `PATCH /roles/role_admin { name: '...' }` as `u-admin` returns 409 `cannot-modify-system-role`. The change is not applied.

### 10.3 Admin cannot delete system roles

- **Pass criteria**: `DELETE /roles/role_super_admin` as `u-admin` returns 409 `cannot-modify-system-role`.

### 10.4 Admin cannot delete a super-admin

- **Pass criteria**: `DELETE /users/u-super` as `u-admin` returns 403.

### 10.5 Super-admin can edit system roles

- **Pass criteria**: `PATCH /roles/role_admin { permissionMatrix: {...} }` as `u-super` returns 200; an audit row `edited-system-role` is written with HMAC signature.

### 10.6 Role change invalidates the user's matrix cache

- **Pass criteria**: an admin reassigns a user to a different role; within 15 minutes, the user's `GET /auth/me` reflects the new matrix; old matrix is no longer consulted.

### 10.7 System role rename is refused

- **Pass criteria**: `PATCH /roles/role_admin { name: 'admin2' }` as `u-super` returns 409 `cannot-modify-system-role`. System roles have locked names.

### 10.8 Role deletion requires no active users

- **Pass criteria**: `DELETE /roles/role_telecaller` while a user has that role returns 409 `role-in-use`; the admin must reassign users first.

---

## 11. Pre-launch sign-off

The launch manager collects sign-off on every section above before the production tenant goes live. Each section requires:

- The test suite green (where automated).
- The manual walkthrough signed off by the responsible engineer.
- Any deferred items tracked in the engineering backlog with a target date.

### Sign-off matrix

| Section | Responsible | Sign-off date |
| --- | --- | --- |
| 1. Tenant isolation | Backend lead | _____ |
| 2. RBAC | Backend lead | _____ |
| 3. GPS privacy | Backend lead + Privacy reviewer | _____ |
| 4. Photo access | Backend lead + Privacy reviewer | _____ |
| 5. Export | Backend lead | _____ |
| 6. Session expiry | Auth lead | _____ |
| 7. Offline queue security | Mobile lead | _____ |
| 8. Sync replay | Mobile lead | _____ |
| 9. Audit log | Backend lead + Compliance | _____ |
| 10. Admin role mutation | Backend lead | _____ |

---

## 12. Files referenced

- [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md) — design.
- [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) — middleware + examples per role.
- [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md) — endpoints.
- [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md) — stack + audit.
- [docs/PWA_OFFLINE_PLAN.md](PWA_OFFLINE_PLAN.md) §9 — offline + sync security.
- [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md) — queue API.
- [docs/SYNC_WORKER_PLAN.md](SYNC_WORKER_PLAN.md) — worker.
- [src/data/permissions.js](../src/data/permissions.js) — frontend permission model.
