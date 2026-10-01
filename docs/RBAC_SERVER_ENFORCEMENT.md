# Joldipabo CRM — RBAC Server Enforcement

Date: 2026-09-23

Status: design only. This is the contract a backend implementation must satisfy. It is read alongside [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md), [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md), [docs/DATA_MODEL.md](DATA_MODEL.md), and the frontend permission vocabulary in [src/data/permissions.js](../src/data/permissions.js).

The goal: every endpoint that touches a domain object must enforce a `(resource, action, scope)` triple, evaluated against the **resolved user** (user record + role + branch + team + projects), against the **target record** (which carries `ownerId`, `teamId`, `projectId`, `tenantId`).

---

## 1. Vocabulary

The server mirrors the frontend exactly. Any change to the frontend vocabulary must be matched here.

### Resources (11)

`dashboard`, `leads`, `listings`, `staff`, `roles`, `attendance`, `visits`, `photos`, `communications`, `reports`, `projects`

`listings` was added on 2026-09-23 to cover every non-new-project vertical: rent, PG / hostel, buy / sell residential, land, office, commercial, and direct owner / landlord listings. The `approve` action doubles as listing verification. The 7 actions × 5 scopes vocabulary is unchanged.

### Actions (7)

`view`, `create`, `edit`, `assign`, `approve`, `export`, `delete`

### Scopes (5)

`none` (0), `own` (1), `team` (2), `project` (3), `all` (4)

`none` denies. `all` allows every record. `own`, `team`, `project` require a predicate against the target record.

### Scope predicates (per resource)

Every record carries a subset of `ownerId`, `teamId`, `projectId` (see [docs/DATA_MODEL.md](DATA_MODEL.md) for which entities have which fields). The predicates are:

| Scope | Predicate |
| --- | --- |
| `own` | `record.ownerId === user.id` |
| `team` | `record.teamId === user.teamId` |
| `project` | `record.projectId IN user.projectIds` |
| `all` | `true` |
| `none` | `false` |

If a record does not carry the field required by the scope (`record.teamId IS NULL` and the user has `team` scope), the predicate fails — the record is hidden. This is **fail-closed**.

### Resource-to-scope-field map

| Resource | own | team | project |
| --- | --- | --- | --- |
| `dashboard` | — (list queries only) | — | — |
| `leads` | `lead.ownerId` | `lead.teamId` (inherits from owner.teamId if null) | `lead.projectId` (inherits from owner's project memberships if null) |
| `staff` | `staff.id === user.id` (the user themselves) | `staff.teamId === user.teamId` | `staff.id IN user.projectStaffIds` (computed from `project_members`) |
| `roles` | — (always `all` or `none`; you either have permission to edit roles or you don't) | — | — |
| `attendance` | `attendance.staffId === user.id` | `attendance.staff.teamId === user.teamId` | `attendance.projectId IN user.projectIds` |
| `visits` | `visit.staffId === user.id` | `visit.staff.teamId === user.teamId` | `visit.projectId IN user.projectIds` |
| `photos` | `photo.staffId === user.id` | `photo.staff.teamId === user.teamId` | `photo.projectId IN user.projectIds` |
| `communications` | `thread.participants IN [user.id]` (own), `thread.teamId === user.teamId` (team), `thread.projectId IN user.projectIds` (project) | — | — |
| `reports` | — (reports query aggregations; scope maps to which dimension rows are visible) | — | — |
| `projects` | `project.staffIds IN [user.id]` (own) — a user is "on" the project | `project.teamId === user.teamId` (team) | — (a user either has the project in `projectIds` or doesn't; project scope on projects is meaningless) |
| `listings` | `listing.assignedTo === user.id` (own) | `listing.teamId === user.teamId` (team) | `listing.projectId IN user.projectIds` (project — only meaningful when the listing is anchored to a project; independent owner listings with `projectId IS NULL` are hidden from project-scoped users) |

`reports` is a special case — see §6.

---

## 2. Endpoint-to-permission map

Every route declares its `(resource, action)` pair. The middleware reads the pair from route metadata; the handler does not re-declare it.

### Leads

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/leads` | `(leads, view)` |
| GET | `/api/v1/leads/:id` | `(leads, view)` |
| POST | `/api/v1/leads` | `(leads, create)` |
| PATCH | `/api/v1/leads/:id` | `(leads, edit)` |
| DELETE | `/api/v1/leads/:id` | `(leads, delete)` |
| POST | `/api/v1/leads/:id/assign` | `(leads, assign)` |
| GET | `/api/v1/leads/:id/export.csv` | `(leads, export)` |

### Listings

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/listings` | `(listings, view)` |
| GET | `/api/v1/listings/:id` | `(listings, view)` |
| POST | `/api/v1/listings` | `(listings, create)` |
| PATCH | `/api/v1/listings/:id` | `(listings, edit)` |
| DELETE | `/api/v1/listings/:id` | `(listings, delete)` |
| POST | `/api/v1/listings/:id/assign` | `(listings, assign)` |
| POST | `/api/v1/listings/:id/photos` | `(listings, edit)` — commits the listing-photo row after the S3 upload |
| POST | `/api/v1/listings/:id/documents` | `(listings, edit)` — internal document upload, no public read |
| POST | `/api/v1/listings/:id/verify` | `(listings, approve)` — sets `verification_status` |
| GET | `/api/v1/listings/:id/export.csv` | `(listings, export)` |

### Staff

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/staff` | `(staff, view)` |
| GET | `/api/v1/staff/:id` | `(staff, view)` |
| POST | `/api/v1/staff/invite` | `(staff, create)` (creates a new user in `Invited` status) |
| PATCH | `/api/v1/staff/:id` | `(staff, edit)` |
| DELETE | `/api/v1/staff/:id` | `(staff, delete)` |
| POST | `/api/v1/staff/:id/role` | `(roles, edit)` |

### Roles

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/roles` | `(roles, view)` |
| POST | `/api/v1/roles` | `(roles, create)` |
| PATCH | `/api/v1/roles/:id` | `(roles, edit)` — refuses if `role.isSystem` |
| DELETE | `/api/v1/roles/:id` | `(roles, delete)` — refuses if `role.isSystem` |

### Attendance / Visits / Photos

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/attendance` | `(attendance, view)` |
| POST | `/api/v1/attendance/check-in` | `(attendance, create)` |
| PATCH | `/api/v1/attendance/:id/check-out` | `(attendance, edit)` |
| GET | `/api/v1/visits` | `(visits, view)` |
| POST | `/api/v1/visits` | `(visits, create)` |
| PATCH | `/api/v1/visits/:id` | `(visits, edit)` |
| POST | `/api/v1/visits/:id/complete` | `(visits, approve)` |
| GET | `/api/v1/photos` | `(photos, view)` |
| POST | `/api/v1/photos/presign` | `(photos, create)` |
| POST | `/api/v1/photos` | `(photos, create)` (creates the row after the S3 upload) |
| GET | `/api/v1/photos/:id/url` | `(photos, view)` |
| PATCH | `/api/v1/photos/:id` | `(photos, edit)` |
| POST | `/api/v1/photos/:id/approve` | `(photos, approve)` |
| DELETE | `/api/v1/photos/:id` | `(photos, delete)` |

### Communications

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/threads` | `(communications, view)` |
| POST | `/api/v1/threads` | `(communications, create)` |
| POST | `/api/v1/threads/:id/messages` | `(communications, create)` |

### Reports

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/reports/:name` | `(reports, view)` |
| POST | `/api/v1/reports/:name/export` | `(reports, export)` |

See §6 for the `reports` scope model.

### Projects

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/projects` | `(projects, view)` |
| POST | `/api/v1/projects` | `(projects, create)` |
| PATCH | `/api/v1/projects/:id` | `(projects, edit)` |

### Auth

| Method | Path | (resource, action) |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | none — public |
| POST | `/api/v1/auth/refresh` | none — public |
| POST | `/api/v1/auth/logout` | none — public-ish (the refresh token is the credential) |
| POST | `/api/v1/auth/logout-all` | none — auth required, but not a domain action |
| GET | `/api/v1/auth/me` | none |
| POST | `/api/v1/auth/invite` | `(staff, create)` |
| POST | `/api/v1/auth/accept-invite` | none |
| POST | `/api/v1/auth/forgot-password` | none |
| POST | `/api/v1/auth/reset-password` | none |
| POST | `/api/v1/auth/request-otp` | none |
| POST | `/api/v1/auth/verify-otp` | none |
| POST | `/api/v1/auth/impersonate` | `(staff, view)` (super-admin only) |
| POST | `/api/v1/auth/end-impersonate` | none |

### Security

| Method | Path | (resource, action) |
| --- | --- | --- |
| GET | `/api/v1/security/sessions` | `(staff, view)` (the user viewing their own) |
| DELETE | `/api/v1/security/sessions/:id` | `(staff, edit)` (the user editing their own) |
| POST | `/api/v1/security/users/:id/unlock` | `(staff, edit)` |

---

## 3. Scope SQL helper

The middleware exposes:

```js
filterByScope(user, resource, action, baseQuery) -> baseQuery.withWhere(...)
```

The helper inspects the user's matrix for `(resource, action)`, gets the scope, and appends a `WHERE` clause:

| User's scope | SQL appended |
| --- | --- |
| `none` | `WHERE FALSE` (or skip the query — handler returns `403`) |
| `own` | `WHERE <table>.owner_id = :user_id` (or `staff_id`, depending on the table; see §1) |
| `team` | `WHERE <table>.team_id = :user_team_id` |
| `project` | `WHERE <table>.project_id = ANY(:user_project_ids)` |
| `all` | no append |

### Joining when the scope field is missing on the row

Some tables don't carry the scope field directly; the join must be explicit. Example for `leads` when the lead has no `teamId`:

```sql
SELECT l.* FROM leads l
JOIN users u ON u.id = l.owner_id
WHERE l.tenant_id = :tenant_id
  AND u.team_id = :user_team_id;
```

### Multi-table joins

When a query joins `leads` + `visits` + `photos`, the scope filter is applied to **each** table individually. The resulting `WHERE` is the AND of each. This is conservative: if any table row falls outside scope, the row is hidden.

### Example: `GET /api/v1/leads?teamId=<team>&status=<status>`

The handler starts with:

```sql
SELECT l.* FROM leads l WHERE l.tenant_id = :tenant_id
```

The scope helper inspects the user's `leads.view` scope. Suppose it is `team`. The helper appends:

```sql
JOIN users u ON u.id = l.owner_id
WHERE ... AND u.team_id = :user_team_id
```

The user's own filters (`?teamId=`, `?status=`) are then AND'd in.

---

## 4. The `can()` function

The server implements the same `can(user, resource, action, record)` function as the frontend. Pseudocode:

```js
function can(user, resource, action, record) {
  const matrix = effectiveMatrix(user);   // role.matrix merged with user.matrix
  const scope = matrix[resource]?.[action] ?? 'none';
  if (scope === 'none') return false;
  if (scope === 'all')  return true;

  if (resource === 'reports') return reportsCan(user, scope, record);   // see §6

  if (scope === 'own') {
    return record && record.ownerId === user.id;
  }
  if (scope === 'team') {
    return record && record.teamId === user.teamId;
  }
  if (scope === 'project') {
    return record && user.projectIds.includes(record.projectId);
  }
  return false;
}
```

This function is used by:

1. The middleware (for record-level checks).
2. The list-query helper (for SQL predicates).
3. The UI shape helper (decides which fields to include in the response; e.g. `*Location` for attendance).

### Effective matrix

`effectiveMatrix(user)` reads the user's role's matrix and applies any user-level overrides via `mergeMatrix(role.matrix, user.matrix)`. The same `mergeMatrix` lives in [src/data/permissions.js](../src/data/permissions.js); the backend ports it 1:1.

The role is re-read from the database on every request, **not** cached in the JWT. A JWT-claim-based role is advisory only. This ensures a permission change by an admin takes effect within 15 minutes (one access-token TTL) at the latest; "Logout-all" forces immediate effect.

### Field-level permissions

Some fields are sensitive regardless of row-level permission:

| Field | Permission required |
| --- | --- |
| `lead.phone` | `leads.view` with scope that resolves to `all` OR `team` (own / project users see phone in some flows, not all) — see §6 of [AUTH_TENANT_SECURITY_PLAN](AUTH_TENANT_SECURITY_PLAN.md) |
| `attendance.*Location` | `attendance.view` + `locationVisibility(user, record)` (see AUTH_TENANT_SECURITY_PLAN §14) |
| `photo.url` (signed URL) | `photos.view` |

The response shaper (a small middleware) strips fields the user can't see, regardless of the row-level result.

---

## 5. Examples by role

Five canonical examples, with the exact `can()` evaluation. These are the tests in [docs/SECURITY_ACCEPTANCE_CHECKLIST.md §2](SECURITY_ACCEPTANCE_CHECKLIST.md).

### Example 1: Field Executive views own leads

- **User**: `u-asha`, role `field-executive`, `teamId: t-north`.
- **Resource**: `leads`.
- **Action**: `view`.
- **Matrix entry**: `field-executive.leads.view = 'own'`.
- **Record**: `lead-1`, `ownerId: u-asha`, `teamId: t-north`, `projectId: p-skyline`.
- **Evaluation**:
  - Scope = `own`. Predicate: `lead.ownerId === u-asha.id` → **true**.
- **Result**: 200 OK. Lead returned.

Same field executive asking for `lead-2` (`ownerId: u-vijay`):
- Scope = `own`. Predicate: `lead.ownerId === u-asha.id` → **false**.
- Result: 403 Forbidden.

### Example 2: Sales Manager views team leads

- **User**: `u-raj`, role `sales-manager`, `teamId: t-north`.
- **Action**: `leads.view`.
- **Matrix entry**: `sales-manager.leads.view = 'team'`.
- **Records**:
  - `lead-1` (`ownerId: u-asha`, `teamId: t-north`) → scope `team` → `lead.teamId === u-raj.teamId` → **true**.
  - `lead-2` (`ownerId: u-vijay`, `teamId: t-south`) → `lead.teamId === u-raj.teamId` → **false**.
  - `lead-3` (`ownerId: u-asha`, `teamId: null`, owner falls back to `u-asha.teamId === t-north`) → **true** (joined fallback).
- **Result**:
  - `GET /leads` returns `lead-1`, `lead-3` but not `lead-2`.
  - `GET /leads/lead-2` returns 403.

### Example 3: Site Manager views project photos

- **User**: `u-priya`, role `site-manager`, `teamId: null`, `projectIds: [p-skyline, p-heights]`.
- **Action**: `photos.view`.
- **Matrix entry**: `site-manager.photos.view = 'project'`.
- **Records**:
  - `photo-1` (`projectId: p-skyline`, `staffId: u-asha`) → `u-priya.projectIds.includes(p-skyline)` → **true**.
  - `photo-2` (`projectId: p-greens`, `staffId: u-asha`) → `u-priya.projectIds.includes(p-greens)` → **false**.
- **Result**:
  - `GET /photos` returns `photo-1` only.
  - `GET /photos/photo-2/url` returns 403 (signed URL not issued).
  - Audit row written for `photo-1` URL issuance: `photo-url-issued` with `metadata.userId: u-priya, photoId: photo-1, projectId: p-skyline`.

### Example 4: Accounts role — views reports but cannot edit operational data

- **User**: `u-anil`, role `accounts`.
- **Action 1**: `reports.view`.
- **Matrix entry**: `accounts.reports.view = 'all'`.
- **Evaluation**: scope `all` → true.
- **Result**: 200 OK on `GET /reports/booking-summary`.

- **Action 2**: `leads.edit`.
- **Matrix entry**: `accounts.leads.edit = 'none'`.
- **Result**: 403 on `PATCH /leads/lead-1`.

- **Action 3**: `attendance.view` to see if a field executive was on-site.
- **Matrix entry**: `accounts.attendance.view = 'all'`.
- **Evaluation**: scope `all` → true.
- **Result**: 200 OK, BUT the response shaper strips `*Location` fields per AUTH_TENANT_SECURITY_PLAN §14. `accounts` cannot see GPS.

- **Action 4**: `photos.view` (for invoicing, e.g. work-done evidence).
- **Matrix entry**: `accounts.photos.view = 'project'`.
- **Evaluation**: scope `project` → predicate.
- **Result**: only photos for projects in `u-anil.projectIds`. Admins put `accounts` on the projects they invoice.

### Example 5: Admin edits non-system roles

- **User**: `u-admin`, role `admin`.
- **Action**: `roles.edit`.
- **Matrix entry**: `admin.roles.edit = 'all'`.
- **Record**: `role-channel-partner-manager` (`isSystem: false`).
- **Evaluation**: scope `all` → true.
- **Result**: 200 OK. Role updated.

Same admin attempting to edit `role-super-admin` (`isSystem: true`):
- **System role protection** kicks in: even though the admin has `roles.edit: 'all'`, the route refuses with 409 Conflict (`cannot-modify-system-role`) because the target role has `isSystem = true`.
- `super-admin` itself can edit system roles (a `super-admin` is the only role with the bypass). The audit row records `edited-system-role` and is HMAC-signed.

### System role protection (the rule)

Any endpoint that operates on a `roles` row rejects the operation if the row's `isSystem` flag is true and the actor is not `super-admin`. The error is `409 Conflict` with code `cannot-modify-system-role` and a free-text detail explaining which role was targeted. The 4 system roles are:

- `super-admin`
- `admin`
- (Future: `tenant-billing-admin`, `tenant-audit-reader`)

Any role with `isSystem: true` is undeletable, unrenamable, and its permission matrix is locked (only `super-admin` can change it). All other roles (`isSystem: false`) are freely editable by anyone with `roles.edit: 'all'`.

---

## 6. The `reports` resource

Reports aggregate across the other resources. The scope model is different: instead of asking "can the user see row X", we ask "which rows may contribute to the report?".

### Rule

`reports.view` with scope `S` → the report query is filtered to the same predicate that `S` would apply to the underlying resource.

| Report | Underlying resource | User with `reports.view: 'team'` sees |
| --- | --- | --- |
| `booking-summary` | `leads` (closed) | Leads in their team. |
| `attendance-register` | `attendance` | Attendance rows in their team. |
| `photo-approval-queue` | `photos` | Photos in their projects. |
| `commission-report` | `leads` (closed + booked) | Same as `booking-summary`. |
| `rentals-pipeline` | `listings` (service_category = `rent`) | Rent listings in their team. |
| `rentals-conversion` | `leads` ∪ `listings` | Same. |
| `pg-availability` | `listings` (service_category = `pg`) | PG beds + rooms in their team. |
| `land-inventory` | `listings` (service_category = `land`) | Land parcels in their team. |
| `office-inventory` | `listings` (service_category = `office` ∪ `commercial`) | Office + commercial units in their team. |
| `executive-collection-performance` | `listings` (grouped by `assigned_to`) | Listings collected by executives in their team. |

### Implementation

```js
function reportsCan(user, scope, report) {
  const underlying = report.underlyingResource;   // 'leads', 'attendance', etc.
  const scopeOfReportView = effectiveMatrix(user)['reports']?.['view'];
  const effectiveScope = maxScope(scopeOfReportView, scope);   // wider wins
  return scopeApplies(user, effectiveScope, underlying);
}
```

In other words: the report's own view scope is the minimum, but the user might have a wider view scope on the underlying resource (e.g. `super-admin` has `reports.view: 'all'` and `leads.view: 'all'`). The wider scope wins for the underlying query.

### Reports with mixed resources

A "team performance" report includes leads, attendance, and photos. The underlying query is the AND of the three filtered sets. The user's `reports.view` scope decides what dimension is enforced:

- `team` → only data in the user's team contributes.
- `all` → all data contributes.

### Reports + `export`

`reports.export` is a separate permission. A user with `reports.view: 'all'` but `reports.export: 'none'` can view the report but cannot export. The export endpoint writes an audit row.

---

## 7. Audit events for permission-sensitive actions

Every mutating endpoint writes one audit row in the same transaction. Permission-sensitive actions get a richer audit row.

### Standard audit (one row per mutation)

```json
{
  "action": "created-lead",
  "entity": "lead",
  "entity_id": "lead-1",
  "metadata": {
    "before": null,
    "after": { "status": "New", "ownerId": "u-asha" },
    "permission_path": "leads.create",
    "scope": "own"
  }
}
```

### Permission-sensitive audit (richer `metadata`)

| Action verb | Trigger | Extra metadata |
| --- | --- | --- |
| `assigned-lead` | `POST /leads/:id/assign` | `{ fromUserId, toUserId, reason? }` |
| `approved-photo` | `POST /photos/:id/approve` | `{ approved: true }` |
| `rejected-photo` | `POST /photos/:id/approve` (with `approved: false`) | `{ reason }` |
| `edited-role` | `PATCH /roles/:id` | full before/after of the matrix |
| `exported-leads` | `POST /reports/leads/export` | `{ format, rowCount, filters, ip }` |
| `impersonated-user` | `POST /auth/impersonate` | `{ impersonatedId, reason, mfaVerified: true }` |
| `ended-impersonation` | `POST /auth/end-impersonate` | — |
| `revoked-session` | `DELETE /security/sessions/:id` | `{ sessionId, targetUserId }` |
| `locked-user` | threshold-triggered | `{ lockDuration, attemptCount }` |
| `unlocked-user` | `POST /security/users/:id/unlock` | `{ targetUserId }` |
| `changed-role` | `POST /staff/:id/role` | `{ fromRoleId, toRoleId }` |
| `reassigned-leads-on-deletion` | when an admin reassigns leads after staff deletion | `{ fromUserId, toUserId, leadCount }` |
| `bulk-photo-export` | admin tool | `{ projectId, photoCount, signedUrlExpiresAt }` |
| `created-listing` | `POST /listings` | `{ serviceCategory, propertyType, listingIntent, ownerContactName, assignedTo, geo }` |
| `updated-listing` | `PATCH /listings/:id` | full before/after diff (large JSON; consider storing only the changed keys) |
| `deleted-listing` | `DELETE /listings/:id` | `{ deletedAt }` |
| `verified-listing` | `POST /listings/:id/verify` | `{ fromStatus, toStatus, reason? }` |
| `assigned-listing` | `POST /listings/:id/assign` | `{ fromUserId, toUserId, reason? }` |
| `uploaded-listing-photo` | `POST /listings/:id/photos` | `{ listingId, category, caption, approved }` |
| `approved-listing-photo` | gallery review | `{ listingId, photoId, approved: true }` |

### Audit row emission rule

The audit row is written by the **route handler**, not by the data layer. The route handler has access to:

- The user's intent (the action verb).
- The before/after diff (from the row's `before` and `after`).
- The permission path (from route metadata).
- The IP, request id, and user-agent (from the request context).

This makes audit rows reliable — a model-layer mutation without a route is impossible in the codebase.

### Audit row read access

Admins (`admin` + `super-admin`) can read all audit rows for their tenant. Users with `reports.view: 'all'` can read a denormalised view of audit rows for their own data (`GET /api/v1/me/activity`). The frontend's `ACTIVITY` collection ([src/data/seed.js](../src/data/seed.js)) is sourced from `GET /me/activity`.

---

## 8. Test cases per role

Every role gets one positive and one negative test per `(resource, action)` pair. The full matrix is 8 roles × 11 resources × 7 actions = 616 test cases; the high-priority subset is below.

### `super-admin`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View any lead in any team / project. | n/a — no negative. |
| `(roles, edit)` | Edit any role, including system roles. | n/a — no negative. |
| `(staff, delete)` | Delete any staff. | n/a — no negative. |
| `(auth, impersonate)` | Impersonate any non-super-admin. | Cannot impersonate another `super-admin`. |

### `admin`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View any lead. | n/a |
| `(roles, edit)` | Edit non-system role. | Edit `super-admin` role → 409 `cannot-modify-system-role`. |
| `(staff, delete)` | Delete any non-super-admin staff. | Delete a `super-admin` → 403. |
| `(auth, impersonate)` | NOT ALLOWED (admin does not have the impersonate endpoint permission). | `POST /auth/impersonate` → 403. |

### `sales-manager`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View leads where `owner.teamId = self.teamId`. | View a lead in another team → 403. |
| `(leads, edit)` | Edit a lead in own team. | Edit a lead in another team → 403. |
| `(leads, assign)` | Reassign a lead within own team. | Reassign a lead to a user in another team → 403. |
| `(staff, view)` | View staff in own team. | View staff in another team → 403. |
| `(attendance, view)` | View attendance of own team. | View attendance of another team → 403. |
| `(photos, view)` | View photos of staff in own team. | View photo of staff in another team → 403. |
| `(reports, export)` | Export team-level reports. | Export all-tenant report → 403. |

### `site-manager`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View leads in own projects. | View lead in another project → 403. |
| `(photos, view)` | View photos in own projects. | View photo in another project → 403. |
| `(photos, approve)` | Approve a photo in own project. | Approve photo in another project → 403. |
| `(attendance, view)` | View attendance of staff who checked in at own projects. | View attendance of staff at another project → 403. |
| `(staff, view)` | View staff assigned to own projects. | View staff in another project → 403. |
| `(reports, view)` | View project-level reports. | View team-level or all-tenant reports → 403. |

### `field-executive`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View own leads. | View another user's lead → 403. |
| `(leads, create)` | Create a lead (assigned to self). | n/a |
| `(leads, edit)` | Edit own lead in `New` status. | Edit another user's lead → 403; edit own lead in `Closed` status → 403 (status transition rule). |
| `(listings, create)` | Create a listing (assigned to self). Field executives are the primary listing collectors. | n/a |
| `(listings, edit)` | Edit own listing while `verification_status = 'unverified'`. | Edit another executive's listing → 403. |
| `(listings, approve)` | n/a — `field-executive.listings.approve = 'none'` | Verify any listing → 403. |
| `(attendance, create)` | Check in. | n/a |
| `(visits, create)` | Log a visit against own lead. | Log a visit against another user's lead → 403. |
| `(photos, create)` | Upload a photo. | n/a |
| `(photos, view)` | View own photos + approved photos in own projects. | View another user's unapproved photo → 403. |
| `(communications, create)` | Send a message on a thread they participate in. | Send on a thread they don't participate in → 403. |

### `telecaller`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View own leads. | View another user's lead → 403. |
| `(leads, create)` | Create a lead (assigned to self). | n/a |
| `(leads, edit)` | Edit own lead. | Edit another user's lead → 403. |
| `(communications, create)` | Send a message in a thread they own. | Send in another thread → 403. |
| `(attendance, view)` | View own attendance only. | View another user's attendance → 403. |

### `channel-partner-manager`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View leads where `lead.source === 'channel-partner'` AND `lead.partnerOrg === self.partnerOrg`. | View a lead from another partner → 403. |
| `(leads, create)` | Create a lead with `source: 'channel-partner'`. | Create a lead with a different source → 403. |
| `(staff, view)` | View own staff (channel-partner reps). | View internal staff → 403. |
| `(communications, view)` | View threads on leads they own. | n/a |

The `channel-partner-manager` scope is a custom one — it filters on a field of the resource, not on `teamId` or `projectId`. The `can()` function takes a custom predicate per resource when needed; the SQL helper accepts the predicate as a column expression.

### `accounts`

| Resource / action | Positive test | Negative test |
| --- | --- | --- |
| `(leads, view)` | View leads in projects they invoice. | View leads in other projects → 403. |
| `(leads, edit)` | n/a — `accounts.leads.edit = 'none'` | Any edit → 403. |
| `(listings, view)` | View all listings for invoicing purposes (rental deposits, lease renewals, sale commissions). | n/a |
| `(listings, edit)` | n/a — `accounts.listings.edit = 'none'` | Edit any listing → 403. |
| `(listings, export)` | Export the listings CSV (commission / deposit reconciliation). | n/a |
| `(attendance, view)` | View attendance for projects they invoice; **but no GPS**. | n/a |
| `(photos, view)` | View approved photos for projects they invoice. | View unapproved photos → 403. |
| `(reports, view)` | View financial reports. | View staff-performance reports → 403 (depends on the report's underlying resource and the user's scope on it). |
| `(reports, export)` | Export financial reports. | n/a |
| `(staff, view)` | View staff they invoice (to attribute work). | View staff on projects they don't invoice → 403. |

---

## 9. Defence in depth — three checks per request

Every request passes through three independent checks:

1. **Auth middleware** — verifies the JWT, loads the user, loads the role, computes the effective matrix. Sets `req.user`, `req.matrix`, `req.scope` (the user's tenant).
2. **Scope middleware** — inspects the route metadata for `(resource, action)`. Looks up `req.matrix[resource][action]`:
   - If `none`, returns 403 immediately.
   - If a record-scoped action (`view`, `edit`, `delete`, `approve`, `assign`), waits for the handler to load the record and re-checks `can()`.
   - If a list action (`view` with no record id), injects the scope SQL.
3. **Handler** — loads the record(s), calls `can()` for record-level actions, performs the mutation, writes the audit row.

If any of the three fails, the request is refused. The user can never bypass the auth middleware (the JWT is signed). The user can never bypass the scope middleware (the route metadata is enforced before the handler runs). The user can never bypass the handler's record check (the handler doesn't proceed without `can()` returning true).

### Field-level stripping

After the handler builds the response, the response shaper strips fields the user shouldn't see. Example for an `attendance` row:

```js
function shapeAttendance(row, user) {
  const visible = { ...row };
  if (!canSeeLocation(user, row)) {
    delete visible.checkInLocation;
    delete visible.checkOutLocation;
  }
  if (!canSeeStaffPii(user, row)) {
    delete visible.staffEmail;
    delete visible.staffPhone;
  }
  return visible;
}
```

The shaper is called **inside** the handler before the response is sent. The frontend never sees a field the user doesn't have permission for.

---

## 10. Open questions

### Multi-role users

Today, a user has one role. v1.1 may need a user to be a `sales-manager` AND a `site-manager` simultaneously (managing both a sales team and a project). The matrix merge rule needs to be specified: today it's `mergeMatrix(role.matrix, user.matrix)` (role wins on conflict). With multi-role, it's `mergeMatrix(role1.matrix, role2.matrix, user.matrix)` — but conflict resolution must be specified.

The current spec assumes single-role. Multi-role is a v1.1 task and will be designed when the first customer asks for it.

### Permission delegation

A `sales-manager` may want to grant a senior `field-executive` temporary `lead.edit` on a specific lead. v1 does not support this. The matrix is the only source of truth. v1.1 may add per-record ACLs (e.g. a `lead.acl` JSONB column with delegated grants). Deferred.

### Field-level permissions beyond location and PII

Today the response shaper handles a small set of fields (`*Location`, `staffEmail`, `staffPhone`). A more general system would let the role's matrix declare `fields` (e.g. `leads.view: { scope: 'team', fields: ['id', 'name', 'status'] }` — hide `phone`, `email`). Deferred; the current spec keeps the field list small.

---

## 11. Files referenced

- [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md) — auth, tenant, and security design.
- [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md) — endpoint-level contract.
- [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) — pre-launch tests.
- [docs/DATA_MODEL.md](DATA_MODEL.md) — entities + ownership fields.
- [src/data/permissions.js](../src/data/permissions.js) — frontend vocabulary the backend mirrors.
- [src/state/store.jsx](../src/state/store.jsx) — frontend store; the `guardedDispatch` pattern motivates the middleware design.
- [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md) — stack + scope SQL + endpoint list.
