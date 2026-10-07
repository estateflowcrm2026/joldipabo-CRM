# Teams + projects directories: live pickers backed by real endpoints

`GET /api/v1/teams` and `GET /api/v1/projects` replace the
`{ items: [], placeholder: true }` stubs with real rows from the `teams` and
`projects` tables — no migration was required (every selected column exists in
001-schema.sql, and the app role already holds SELECT on both tables in
`server/scripts/app-role.js`). Neither table has an RLS policy by design —
tenant isolation stays in the SQL predicates, the same posture as the staff
directory (`server/src/repositories/staffRepository.js`).

## Endpoints

Both are read-only, tenant-scoped (`tenant_id = $1` plus
`deleted_at IS NULL`), RLS-posture safe, and paginated on the leads-list
convention (default 25, max 100; the total is unpaginated).

### `GET /api/v1/teams`

- Coarse gate: `staff:view` via `requirePermission` (403 when the matrix
  says `none`). Teams have no own resource in the matrix, so the caller's
  `staff:view` scope shapes the rows (`server/src/repositories/teamsRepository.js`):
  - `all` (super-admin, admin, accounts) → every team in the tenant
  - `team` (sales-manager, channel-partner-manager, telecaller on visits) →
    the caller's own team only (no team → no rows)
  - `project` (site-manager) → teams with at least one member in any of the
    caller's projects (via `user_project_ids`), plus the caller's own team
  - `own` (field-executive, telecaller) → the caller's own team only
  - `none` → no rows (fail-closed; the route gate 403s before this)
- Filters: `q` only (ILIKE over name/region). `teams` has no status column,
  so there is nothing else to filter on — this is schema-driven, not a gap.
- Response: `{ items: [{ id, name, region, leadId, leadName, memberCount,
  activeMemberCount }], pagination: { limit, offset, total } }`, ordered by
  name. `leadName` comes from a JOIN to `users`; counts are
  `COUNT … FILTER` over non-deleted members. Nothing secret exists on this
  table, and the SELECT list names its columns explicitly.

### `GET /api/v1/projects`

- Coarse gate: `projects:view` via `requirePermission` (403 when `none`).
  Row visibility follows the caller's `projects:view` scope
  (`server/src/repositories/projectsRepository.js`):
  - `all` (super-admin, admin, field-executive, telecaller, accounts,
    channel-partner-manager) → every project in the tenant (a catalogue —
    membership is ignored)
  - `team` → projects with at least one member from the caller's team (via
    `team_members`, `users.team_id` + `user_project_ids`/`project_members`),
    plus the caller's own projects
  - `project` (sales-manager, site-manager) / `own` → the caller's own
    projects only (via `user_project_ids`)
  - `none` → no rows (fail-closed)
- Filters: `q` (ILIKE over name/code/city), `city` and `stage` (exact,
  case-insensitive). Unknown city/stage values are **not** enum-checked —
  the schema has no CHECK on either column, so an allow-list would be
  invented policy. `projects` has no status column.
- Response: `{ items: [{ id, name, code, city, stage, type, managerId,
  managerName, availableUnits, totalUnits }], pagination: … }`, ordered by
  name. `managerName` comes from a JOIN to `users`. Amenities, RERA numbers
  and possession dates are deliberately unexposed — picker screens have no
  use for them. Nothing on this table is a credential.

## Frontend

`src/services/teamsApi.js` / `src/services/projectsApi.js` are the API
modules (thin `apiRequest` wrappers; the query allow-lists mirror the
backend). `useTeamsDirectory()` / `useProjectsDirectory()`
(`src/services/teamsProjectsDirectory.js`) are the single seams, following
the `useAssignableStaff()` pattern: demo mode returns the seed roster;
live mode fetches once per mount with loading / error / retry state — on
error the list is `[]`, never seed. Demo mode is unchanged.

Wired pickers (live mode):
- Staff create modal team picker + team filter options (`Staff.jsx`) —
  with Loading / "No teams visible" states; card team names resolve through
  the live directory with the DTO's `teamName` as fallback, never seed.
  The staff card's Projects row renders `—` in live mode (the staff DTO
  carries no project ids, so "None" would be a lie).
- Listing create project picker (`Listings.jsx`) — with Loading /
  error+Retry / empty states; when no projects are visible the listing is
  created without a project. The listing drawer prefers the backend DTO's
  own project name over a seed lookup.
- Mobile listing capture (`MobileModules.jsx`) — attaches the first visible
  project (a real backend id in live mode, seed id in demo); nothing while
  loading/unavailable.

Checked, nothing to rewire:
- Live leads (`ContactWorkspace`) and live visits (`LiveVisits`) have no
  project/team pickers or filters.
- Demo-only surfaces stay seed-backed by design: `DemoLeads`,
  `DemoSiteVisits` (+ `NewVisitModal`), `SitePhotos` (+ `UploadModal`),
  `Reports`, `Dashboard`, mobile `NewLeadSheet` and `MobilePhotos` (both
  dispatch demo-store actions; `MobilePhotos`' payload does not match the
  live photo endpoint's listing-id shape).

## What is real vs not yet real

| Item | Status |
| --- | --- |
| `GET /api/v1/teams` list | Real — tenant-scoped, `staff:view`-filtered, `q` search |
| `GET /api/v1/projects` list | Real — tenant-scoped, `projects:view`-filtered, `q`/`city`/`stage` |
| Live team/project pickers | Real — directory-backed with loading/error/empty/Retry |
| `POST/PATCH /teams`, `POST/PATCH /projects` | Not implemented — still `NotImplemented`, per the phase plan |
| `GET /projects/:id/members`, `POST /projects/:id/members`, `DELETE /projects/:id/members/:uid` | Still `{ items: [], placeholder: true }` / stubs |
| `GET /api/v1/users/:id`, `PATCH/DELETE /users`, `POST /users/:id/restore` | Not implemented — unchanged (see `STAFF_DIRECTORY.md`) |

## Verification

- `server/src/repositories/teamsRepository.test.js` — 14 no-DB unit tests
  over a fake pg client (all/team/own/project/none scopes, tenant scope,
  deleted exclusion, `q` narrowing, pagination slices items but not total).
  The `/* scope:… */` / `/* filter:… */` SQL markers are the stable seams
  the fake interprets instead of parsing SQL.
- `server/src/repositories/projectsRepository.test.js` — 15 no-DB unit
  tests (all/project/own/team/none scopes, tenant scope, `q` over
  name/code/city, case-insensitive city/stage, filter composition,
  pagination).
- `server/src/routes/teams.test.js` / `projects.test.js` — pure validator
  unit tests + no-DB route cases (401, placeholder-403) + read-only
  DB-integration scoping cases (run only when `DATABASE_URL` is set; no
  writes, no cleanup).
- `src/services/teamsProjectsApi.test.mjs` — URL/method/query assertions,
  wired into root `npm test`.
- Full backend `npm test`: 552 pass, 0 fail (52 DB-integration skipped —
  no `DATABASE_URL` in this environment). Full root `npm test`: all pass.
  Server lint: 97 files, 0 failed. `vite build`: succeeds.
- Not yet run: DB-integration route cases, a live HTTP verification
  script, and browser smoke — no `DATABASE_URL`, `DEMO_PASSWORD` or
  `CHROME_PATH` is configured in this environment.

Demo mode is unchanged: the seeded directory views never call these endpoints.
