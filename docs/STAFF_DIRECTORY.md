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
  and `roles` tables — there is still no teams endpoint (see gaps).
- The DTO never carries secrets: no `password_hash`, `mfa_secret`,
  invite/reset tokens, or `permission_matrix`. The SELECT list names its
  columns explicitly so a future secret column cannot leak by `SELECT *`.

## Frontend

`src/services/staffApi.js` is the API module; `useAssignableStaff()`
(`src/services/staffDirectory.js`) is the single seam. Demo mode is
unchanged (seed roster). Live mode fetches the directory once per mount
with loading / error / retry state — on error the staff list is `[]`,
never seed.

Wired pickers (live mode):
- Desktop + mobile listing assignment (assign/reassign modals and sheets)
- Desktop new-listing assignee picker (the project picker stays
  demo-only — seed project ids do not exist in the backend)
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
| User creation / invite | Real, unchanged — `POST /auth/invite` (`staff:create`) via `onboardingService.inviteUser`; no parallel system was built |
| `GET /api/v1/users/:id`, `POST/PATCH/DELETE /users`, `POST /users/:id/restore` | Not implemented — still `NotImplemented`, per the auth spec's phase plan |
| `GET /api/v1/teams` | Still `{ items: [], placeholder: true }` — the directory takes `teamId` as a free filter and resolves `teamName` via JOIN |
| Phone visibility | Gap — phone is included for every viewer that passes the `staff:view` gate. There is no field-level grant in the matrix to key off, so a phone-hiding rule would be invented policy |
| Test accounts | Dev-only script `server/scripts/seed-staff-test-users.js` (manager + 2 executives on different teams + telecaller; `DEMO_PASSWORD` from the environment, localhost + demo-tenant guards, idempotent). Never run against a shared database |

## Verification

- `server/src/routes/users.test.js` — 5 pure validator unit tests + 4
  no-DB route cases (401, 403 placeholder, 2× 400 invalid-enum) + 4
  DB-integration scoping cases (all/team/own + filter narrowing),
  read-only over the seed. No writes, no cleanup.
- `src/services/staffApi.test.mjs` — URL assertions, wired into root
  `npm test`.
- `npm run verify:staff` (with `STAFF_VERIFY_WRITE=1`) — creates three
  synthetic users, asserts all/team/own visibility, filter narrowing,
  400s and 401 over HTTP, then deletes exactly its rows (audit events
  retained). Requires `DATABASE_URL` + `APP_DATABASE_URL`.
- Browser smoke for manager-assigns-executive is not yet run: no
  `CHROME_PATH` / `DEMO_PASSWORD` / live database is configured in this
  environment. The pickers follow the same loading/error/empty/Retry
  pattern as the listings they extend, so layout risk is minimal.

Demo mode is unchanged: the seeded directory views never call this endpoint.
