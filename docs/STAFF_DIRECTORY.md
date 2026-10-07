# Staff directory: who the caller may see

`GET /api/v1/users` is the live staff directory. It replaces the
`{ items: [], placeholder: true }` stub with real rows from the `users`
table — no migration was required, and 012/013/014 were left untouched.

## Endpoint

`GET /api/v1/users` — read-only, tenant-scoped, RLS-posture safe.

- Coarse gate: `staff:view` via `requirePermission` (403 when the matrix
  says `none`).
- Row visibility: the caller's `staff:view` scope, computed inside
  `listStaff` (`server/src/repositories/staffRepository.js`):
  - `all` (super-admin, admin, accounts) → everyone in the tenant
  - `team` (sales-manager, channel-partner-manager, telecaller on visits)
    → same `team_id`, plus self (a manager with no team still sees self)
  - `project` (site-manager) → users sharing any of the caller's projects
    (via `user_project_ids`), plus self
  - `own` (field-executive, telecaller) → self only
  - `none` → no rows (fail-closed; the route gate 403s before this)
- `users` has no RLS policy by design (it is read during auth before a
  tenant context could be established) — tenant isolation stays in the SQL
  predicates, the same posture as the other list endpoints. The app role
  already holds SELECT on `users`, `teams`, `roles` and `user_project_ids`
  (`server/scripts/app-role.js`).
- Filters: `role` (validated against the 8 system roles), `teamId`,
  `status` (defaults to `Active`), `q` (ILIKE over name/email/phone).
  Unknown role/status values are 400 `invalid-enum`. Pagination follows
  the leads-list convention (default 25, max 100).
- Response: `{ items: [{ id, name, email, phone, role, roleName, teamId,
  teamName, status, designation }], pagination: { limit, offset, total } }`,
  ordered by name. `teamName`/`roleName` come from JOINs to the `teams`
  and `roles` tables — see `docs/TEAMS_PROJECTS_DIRECTORY.md` for the live
  teams/projects endpoints.
- The DTO never carries secrets: no `password_hash`, `mfa_secret`,
  invite/reset tokens, or `permission_matrix`. The SELECT list names its
  columns explicitly so a future secret column cannot leak by `SELECT *`.

## Manual staff creation + admin password reset (no email)

`POST /api/v1/users` creates a sign-in-capable user with an admin-typed
initial password; `POST /api/v1/users/:id/reset-password` sets a new one.
No email is sent in either path — the admin shares the password with the
staff member out of band. This is a separate system from the invite flow
(`POST /auth/invite` → emailed single-use link → `POST /auth/accept-invite`);
the two share nothing except the `users` table.

- Coarse gates: `staff:create` for creation, `staff:edit` for reset (403
  when the matrix says `none`).
- Creation body: `name`, `email` (required), `phone`, `roleId` (must be a
  known system role), `teamId` (must exist in the caller's tenant),
  `designation`, `status` (`Active` default; `Inactive`/`Suspended` allowed —
  `Invited` is refused because that state belongs to the email flow),
  `initialPassword` (required).
- The password is validated against the existing policy (min 10 chars) and
  hashed with Argon2id. It is never stored, never returned, and never
  audited. A weak password is 400 `weak-password`; a duplicate
  (tenant_id, email) is 409 `duplicate-email`.
- Creation response: `{ id, email, status }` — a confirmation, not the
  secret.
- Reset body: `{ newPassword }`. The reset updates `password_hash` and
  `password_changed_at`, clears `failed_login_count` / `locked_until`, and
  revokes every session via the existing `refresh_sessions` table, so
  whoever held the old password loses access immediately.
- Reset response: `{ ok: true, userId, sessionsRevoked }` — confirmation
  only.
- Tenant scope: the new user inherits the actor's tenant; a reset target
  outside the actor's tenant is a 404 (not a 403, so the caller learns
  nothing about other tenants).
- Super-admin protection: only a `super-admin` actor may create a
  `super-admin` or reset one's password (403 `super-admin-protected`
  otherwise) — the same rule the roles handler applies to system roles.
- Audit: `created-user` (with `method: 'manual'`) and `admin-password-reset`
  (with `reason: 'admin-reset'`), so an operator can tell manual
  provisioning from the email flows. Neither row carries the password.
- Frontend: the Staff Directory screen in live mode offers "Add staff"
  (with an initial-password field labelled "Password will not be shown
  again") and a per-card "Reset password" action. Success shows a
  confirmation toast naming the account, never the password. Demo mode is
  unchanged (seed roster, toast-only create modal, in-place edit modal).
- Pending: there is no `force_password_change` column in the schema, so
  the flow cannot flag "must change on next login". Documented here rather
  than fixed with a broad migration; if the client wants it, add a new
  numbered migration (001/002 are frozen) plus a login-time check.

## Frontend

`src/services/staffApi.js` is the API module; `useAssignableStaff()`
(`src/services/staffDirectory.js`) is the single seam. Demo mode is
unchanged (seed roster). Live mode fetches the directory once per mount
with loading / error / retry state — on error the staff list is `[]`,
never seed.

Wired pickers (live mode):
- Desktop + mobile listing assignment (assign/reassign modals and sheets)
- Desktop new-listing assignee picker (the project picker is now live too —
  see `docs/TEAMS_PROJECTS_DIRECTORY.md`)
- Assignee display names resolve through the directory first
  (`resolveAssignee` takes the directory as a third argument), so a live
  listing shows the real name rather than a same-id seed user

Already live before this change (no work needed):
- Visit schedule + reassign pickers (`GET /visits/assignees`)
- There is no lead/follow-up owner picker in the UI — nothing to rewire

## What is real vs not yet real

| Item | Status |
| --- | --- |
| `GET /api/v1/users` list | Real — scoped, filtered, paginated |
| Listing assignment in live mode | Real — directory-backed pickers with loading/error/empty states |
| User creation / invite | Real, unchanged — `POST /auth/invite` (`staff:create`) via `onboardingService.inviteUser` |
| Manual staff creation (`POST /users`) | Real — `staff:create`, Argon2id hash, no email; response is `{ id, email, status }` |
| Admin password reset (`POST /users/:id/reset-password`) | Real — `staff:edit`, clears lockout, revokes sessions, tenant 404 for foreign rows |
| `GET /api/v1/users/:id`, `PATCH/DELETE /users`, `POST /users/:id/restore` | Not implemented — still `NotImplemented`, per the auth spec's phase plan |
| `GET /api/v1/teams` | Real — tenant-scoped, `staff:view`-filtered, `q` search (see `docs/TEAMS_PROJECTS_DIRECTORY.md`); the directory takes `teamId` as a free filter and resolves `teamName` via JOIN |
| Phone visibility | Gap — phone is included for every viewer that passes the `staff:view` gate. There is no field-level grant in the matrix to key off, so a phone-hiding rule would be invented policy |
| Test accounts | Dev-only script `server/scripts/seed-staff-test-users.js` (manager + 2 executives on different teams + telecaller; `DEMO_PASSWORD` from the environment, localhost + demo-tenant guards, idempotent). Never run against a shared database |

## Verification

- `server/src/routes/users.test.js` — 5 pure validator unit tests + 7
  no-DB route cases (401/403 gates, 2× 400 invalid-enum, 3× create/reset
  gate checks) + 4 DB-integration scoping cases (all/team/own + filter
  narrowing, read-only over the seed) + 2 DB-integration write cases
  (create → duplicate → weak → reset → unknown-404 round-trip with exact
  cleanup; denial by `staff:create: none`). Passwords travel only in
  request bodies, never in responses.
- `server/src/repositories/staffManagement.test.js` — 17 no-DB unit tests
  over a fake pg client (validation, 403/404/409 codes, tenant scope,
  super-admin guard, audit rows, session revocation, no plaintext in
  responses or storage).
- `src/services/staffApi.test.mjs` — URL/method/body assertions, wired into
  root `npm test`.
- `npm run verify:staff` (with `STAFF_VERIFY_WRITE=1`) — creates three
  synthetic users, asserts all/team/own visibility, filter narrowing,
  400s and 401 over HTTP, then deletes exactly its rows (audit events
  retained). Requires `DATABASE_URL` + `APP_DATABASE_URL`.
- Browser smoke for manager-assigns-executive is not yet run: no
  `CHROME_PATH` / `DEMO_PASSWORD` / live database is configured in this
  environment. The pickers follow the same loading/error/empty/Retry
  pattern as the listings they extend, so layout risk is minimal.

Demo mode is unchanged: the seeded directory views never call this endpoint.
