# Follow-up management: the daily queue

Telecallers and managers work from a due-list, not from search: overdue
follow-ups first, then today, then upcoming. No migration was required —
both due columns already existed (`leads.next_follow_up`,
`contact_calls.next_follow_up`), the partial index
`idx_leads_tenant_followup` backs the lead range, and 012/013/014 were
left untouched.

## Schema decision

`contacts` has deliberately NO follow-up column. The queue filters on the
effective follow-up — `MAX(next_follow_up)` over the contact's calls, the
same MAX semantics `convertContactToLead` already uses to seed the lead's
due time. This keeps one write path per record type: a contact's due time
moves only when a new outcome call is logged, never by silent overwrite.

## Backend

Shared validator `server/src/repositories/followUpValidation.js` — pure,
no I/O — normalises three query keys accepted by both `GET /leads` and
`GET /contacts`:

- `followUpFrom` — ISO datetime, inclusive lower bound on the due time.
- `followUpTo` — ISO datetime, exclusive upper bound.
- `followUpSet` — `set` (has an outstanding follow-up) | `unset` (none).

A from/to window implies "set": NULL dues never satisfy a comparison, so
`followUpSet=unset` combined with a window is rejected with 400 instead of
silently returning zero rows. Bad enums/dates are 400s; unknown keys are
ignored (each route owns its allow-list). Filtered lists order
oldest-due-first; a pure `unset` list keeps newest-first (no due time to
sort by). Scope and RLS are unchanged — an own-scoped caller passing
another owner's id gets zero rows, never someone else's records.

Completion is also existing writes, not new endpoints:

- Lead: `PATCH /leads/:id` with `nextFollowUp: null` clears the due time
  (or sets the next one). The outstanding follow-up then leaves the
  timeline; the status/notes history is untouched.
- Contact: `POST /contacts/:id/calls` with the outcome and the next
  `nextFollowUp`. The effective MAX moves forward and every prior call
  stays in history.

## Frontend

In live/API mode the Lead Management workspace gains a **Follow-ups** tab:
source toggle (Leads / Contacts), window tabs (Overdue / Today / Upcoming /
All), search, overdue badges in red, due timestamps, and click-through
into the existing contact/lead detail — where the outcome is logged and
the next follow-up is set. The queue itself is read-only. Demo mode is
unchanged: the seeded Leads views never call these filters.

## Client timeline

An outstanding follow-up appears in `GET /leads/:id/timeline` as a
`follow_up` item at the due time; completing it removes the item (there is
no longer anything outstanding). Contact outcome calls already appear as
`call` items with their notes and follow-up times.

## What is real vs not yet real

| Need | Status |
| --- | --- |
| Due today / overdue / upcoming windows | Real — both list endpoints + UI queue |
| By owner / assigned user | Real — `ownerId` filter + row scope (a caller only ever sees their own scope) |
| Overdue emphasis | Real — red badge + Overdue-first default tab |
| Complete + set next, history preserved | Real — lead PATCH / contact outcome call |
| Timeline reflects outstanding follow-up | Real — `follow_up` item while set, gone when cleared |
| Reminder notifications (push/SMS/email) | Gap — no scheduler or messaging integration exists |
| Recurring follow-up cadences | Gap — each next due is set manually per outcome |
| Phone / WhatsApp integration | Gap — detail view only links `tel:` / `wa.me`, by design |

## Verification

- `server/src/repositories/followUpValidation.test.js` — 6 pure unit
  tests: empty/ignore-unrelated, ISO normalisation, set/unset + window
  combos, loud rejections, predicate/sort helpers. No DB required.
- `server/src/routes/followUps.test.js` — 6 no-DB 400 cases (bad enum,
  bad date, contradictory combo × both routes); DB-integration leads
  windows (overdue/upcoming isolation, oldest-due-first, own-scope
  hiding) with sacrificial fixtures cleaned via `DELETE /leads/:id`;
  read-only contacts `unset` shape check. Contacts write-window coverage
  lives in the verify script instead — contacts have no DELETE endpoint
  and the app role is revoked DELETE, so fixture cleanup needs the admin
  role, which tests must not assume.
- `src/services/contactIntakeApi.test.mjs` — filter params reach the URL
  (`followUpTo` on leads, `followUpSet` on contacts).
- `npm run verify:followups` (with `FOLLOWUP_VERIFY_WRITE=1`) — 26 live
  checks: overdue/upcoming/due-today/set windows, oldest-due-first,
  owner-scope hiding, timeline carries the outstanding follow-up,
  lead completion via PATCH (item leaves the timeline), contact
  completion via a new outcome call (MAX moves, both calls retained),
  exact-row cleanup with audit retained. Requires `DATABASE_URL` +
  `APP_DATABASE_URL` in the environment.
- Browser smoke for the queue is not yet run: no `CHROME_PATH` /
  `DEMO_PASSWORD` / live database is configured in this environment. The
  panel reuses the existing `usePagedList` fetch pattern, `.tabs`,
  `.contact-directory-*` styles and the existing detail forms, so layout
  risk is minimal.
