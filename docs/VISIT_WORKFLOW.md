# Site visit and property viewing workflow

This is the live API-mode workflow for the client's `Lead -> Visit -> Agent -> Properties shown -> Follow-up` process. Demo mode keeps its seeded visit screens and never calls these endpoints.

## Records

Migrations `013-visit-viewings.sql` and `014-visit-event-snapshots.sql` add:

- Optional `visits.project_id`, plus `team_id` and `created_by`, so a property tour need not be tied to a project.
- `visit_events`: append-only status history with actor, timestamp, schedule and assignee snapshots. Rescheduling and reassignment do not erase prior values.
- `visit_viewings`: append-only rows for each property shown, with listing, visit, executive, actual time, assistance status and client feedback.

Both new tables enforce tenant RLS and have tenant-composite foreign keys to the visit; viewings also have a tenant-composite FK to the listing. The app role can insert and read history, not update or delete it. The existing `visits` policy and explicit tenant predicates remain in force. Live writes are transactional and audited.

## API and permissions

| Route | Permission | Behavior |
| --- | --- | --- |
| `GET /visits?leadId=&status=&assignedTo=&from=&to=&order=&limit=&offset=` | `visits:view` | Scoped, paged visit list with assisted-property count; `from`/`to` bound the schedule window, `order` is `asc`/`desc` (default `desc`) |
| `GET /visits/assignees` | `visits:create` | Active, eligible field executives only |
| `GET /visits/:id` | `visits:view` and row scope | Visit, events, and property viewings |
| `POST /visits` | `visits:create` and row scope | Schedule for a visible lead and eligible executive |
| `POST /visits/:id/status` | `visits:edit` and row scope | Append a valid status transition; reschedule needs a new time |
| `POST /visits/:id/assign` | `visits:assign` and row scope | Reassign an open visit, preserving history |
| `POST /visits/:id/viewings` | `visits:edit` and row scope | Record a visible property after reaching the client |

The telecaller can coordinate visits within their team but cannot claim on-site progress or add viewings. A field executive sees and updates only visits assigned to them; the server, not the browser, records their identity on each viewing. A completed visit must have at least one assisted property. Out-of-scope detail and mutation requests return 404.

The lead's `visit_status` is a summary derived from all non-deleted visits. An active visit keeps it `visit_planned` even if another visit was completed or cancelled. The visit and viewing rows remain the source of truth.

## Status meanings and reschedule history

The nine statuses form one lifecycle (see `VISIT_STATUSES` / `NEXT` in
`server/src/repositories/visitValidation.js`):

- `Assigned` — scheduled and handed to a field executive. Every visit
  starts here; the creation event snapshots the first schedule and assignee.
- `Accepted` → `On the way` → `Reached` — the executive's on-site progress.
  Only the assigned executive (or a manager/admin in scope) records these;
  the telecaller is refused with `agent-update-required`.
- `Client assisted` — the client met the executive; properties can now be
  recorded. `Client did not attend` closes the visit without viewings.
- `Completed` — requires at least one `assisted` viewing. Closed alongside
  `Visit cancelled` / `Client did not attend`: closed visits cannot be
  reassigned, and no further transitions leave them.
- `Visit rescheduled` — pauses the flow with a **new** `scheduledAt`
  (required). The next step is `Assigned` again, so the visit re-enters the
  lifecycle at the new time instead of forking a duplicate row.

Rescheduling never overwrites history. `POST /visits/:id/status` with
`{ status: 'Visit rescheduled', scheduledAt }` updates `visits.scheduled_at`
**and** appends a `visit_events` row carrying the new schedule snapshot; the
prior schedule stays on the earlier events. The visit detail "Status history"
section renders every event with its own `Visit time:` snapshot, so the
current schedule (visit header) and all previous schedules (event list)
remain visible side by side. The lead timeline (`GET /leads/:id/timeline`)
merges the same events oldest-first, so a reschedule appears in the client
history as a first-class entry, not a silent edit.

## Manager tracking board

The live Site Visits view (`src/views/LiveVisits.jsx`, shared by desktop
`SiteVisits.jsx` and mobile `MobileVisits`) is the manager/admin tracking
board. Each row shows lead/client, scheduled date/time, assigned executive,
current status, properties-shown count (`viewingCount`) and last update
(`updatedAt`, rendered as relative time). Filters:

- Window tabs: **Upcoming** (now → +7 days), **Today** (local midnight to
  midnight), **All**. Upcoming is the default; the list is oldest-first
  within a window so the next visit is on top.
- Status dropdown: all nine lifecycle statuses.
- Executive dropdown: visible only when the assignment picker returns more
  than one executive (managers/admins/telecallers with `visits:create`);
  field-executives see only their own visits by scope, so no picker is shown.

Executives see the same view scoped to `assigned_to = self` — their assigned
visits, status flow, and viewing capture are unchanged. Demo mode keeps its
seeded visit screens and never calls these endpoints.

## Development verification

The additive migrations were applied to the development Supabase project on 2026-10-02. With development credentials already in the gitignored `server/.env`:

```powershell
cd server
$env:VISIT_VERIFY_WRITE='1'; npm run verify:visits
$env:VISIT_BROWSER_WRITE='1'; npm run smoke:visits-browser
```

The first command checked RLS, telecaller/manager/agent scope, scheduling, transitions, viewing capture, lead history counts and repeat-visit summary (24 checks). The second used a real Chrome phone viewport to update an assigned visit, record a viewing, then find its feedback on the linked lead. Both scripts create uniquely named synthetic records and remove them in a `finally` block; audit events remain.

These changes are **not deployed to the public Vercel demo or production**. Production still needs an authenticated API host, `APP_DATABASE_URL` using the non-bypass app role, HTTPS cookie configuration, real staff invitations, and go-live verification. Phone-provider integration and derived agent performance reports are subsequent work.
