# Client timeline: one history per lead

The lead detail view in live/API mode now shows a single chronological
timeline instead of two separate sections. No migration was required —
every source already exists, and 012/013/014 were left untouched.

## Endpoint

`GET /api/v1/leads/:id/timeline` — read-only, tenant-scoped, RLS-safe.

- Coarse gate: `leads:view` via `requirePermission`.
- Row gate: the lead itself is scope-checked exactly like `GET /leads/:id`
  (out-of-scope → 404, never 403, so existence is not leaked).
- Inside the list, out-of-scope rows are skipped silently: visits the
  caller cannot `visits:view` never appear, and a linked contact the
  caller cannot `leads:view` hides its call history too.
- Response: `{ leadId, items: [{ id, type, occurredAt, title, detail,
  actor: { id, name } | null, meta }] }`, oldest-first. Same-timestamp
  ties break in journey order (contact → lead → calls → visit events →
  viewings → follow-up), then by id.

## What is real vs not yet real

| Journey step | Source | Status |
| --- | --- | --- |
| Client first called in | `contacts.created_at` | Real |
| Every logged call | `contact_calls` (outcome, notes, follow-up) | Real |
| Lead created / converted | `leads.created_at` (+ `contact_id` link) | Real |
| Visit scheduled / assigned / status | `visit_events` (with schedule + assignee snapshots) | Real |
| Assigned agent | `visits.assigned_to` + event snapshots | Real |
| Properties shown + feedback | `visit_viewings` + `listings.title` | Real |
| Outstanding follow-up | `leads.next_follow_up` (shown as upcoming) | Real — cleared on completion, so the item leaves the timeline. Full queue workflow in [FOLLOW_UPS.md](FOLLOW_UPS.md) |
| Lead status-transition times | No live table stores them | Gap — timeline shows the CURRENT status via the lead row, not when it changed |
| Bookings / payments | No table exists | Gap — `status = 'Booked'` is the conversion signal |
| Conversations / messages | `communications.js` is placeholder | Gap — nothing rendered |
| Phone / WhatsApp integration | Not built | Gap — the detail view only links `tel:` / `wa.me`, by design |

`audit_log` is deliberately NOT a source: it is tamper-evidence with no
RLS policy by design (010), so it is never read for UI purposes.

## Verification

- `server/src/repositories/leadTimelineRepository.test.js` — 6 pure unit
  tests: journey ordering, tie-breaks, corrupt-timestamp tolerance,
  outcome-label fallback, empty input. No DB required.
- `server/src/routes/leads.test.js` — timeline route cases: 401 without
  auth, RBAC gate with placeholder auth, 200 shape + oldest-first order
  with DB, 404 existence-hiding for an out-of-scope lead.
- `src/services/leadTimelineApi.test.mjs` — URL encoding assertions,
  wired into root `npm test`.
- `npm run verify:timeline` (with `TIMELINE_VERIFY_WRITE=1`) — builds one
  synthetic journey through HTTP (contact → call → convert → schedule →
  viewing), asserts every source merges oldest-first with real titles and
  feedback, asserts 404-hiding for an out-of-scope role and 401 without
  auth, then removes exactly its own rows (audit events retained).
  Requires `DATABASE_URL` + `APP_DATABASE_URL` in the environment.
- Browser smoke for the lead detail timeline is not yet run: no
  `CHROME_PATH` / `DEMO_PASSWORD` / live database is configured in this
  environment. The frontend section follows the same
  loading/error/empty/Retry pattern as the visit history it replaces, and
  reuses the existing `.contact-*` styles, so layout risk is minimal.

Demo mode is unchanged: the seeded Leads views never call this endpoint.
