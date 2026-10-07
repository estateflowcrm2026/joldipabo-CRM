# Contact intake: first live workflow slice

This is the first live manual telecaller workflow slice. It does not connect a phone number, receive provider webhooks, or change the public demo.

## Data and API

Migration `012-contact-intake.sql` adds `contacts` and `contact_calls`. Both carry tenant RLS, and all repository queries also use explicit tenant predicates and a transaction-scoped tenant context. Call rows are insert-only for the application role; contacts cannot be hard-deleted by that role. Each call records the staff member, direction, actual call time, duration (when known), outcome, notes, and optional next follow-up. Provider fields are reserved for a later integration and are not accepted from clients.

Authenticated routes under `/api/v1`:

| Route | Permission | Purpose |
| --- | --- | --- |
| `GET /contacts?q=&limit=&offset=` | `leads:view` | Page through visible contacts; search by name or phone |
| `GET /contacts?q=&ownerId=&followUpFrom=&followUpTo=&followUpSet=&limit=&offset=` | `leads:view` | Daily follow-up queue: overdue / today / upcoming windows, optional owner filter, oldest-due-first. See [FOLLOW_UPS.md](FOLLOW_UPS.md) |
| `GET /contacts/:id` | `leads:view` plus row scope | Contact details |
| `GET /contacts/:id/calls?limit=&offset=` | `leads:view` plus row scope | Full, pageable call history |
| `POST /contacts` | `leads:create` | Create a contact from a phone call |
| `POST /contacts/:id/calls` | `leads:edit` plus row scope | Log an actual call |
| `POST /contacts/:id/convert` | `leads:create` and `leads:edit` plus row scope | Create a linked lead, once |

Conversion copies the contact's current details, requirements, and latest call follow-up into a new lead inside one transaction. Repeating it returns the existing lead id. It does not invent a call event or a follow-up; staff must log what happened. Calls remain on the contact and the lead link is retained, so history survives conversion.

Project-scoped lead creators are refused until intake accepts and validates a project assignment. This prevents creating contacts that the same user cannot read. Other scopes use the contact's owner and team, derived from the authenticated user, never supplied by the browser.

## Deployment status

On 2026-10-02, migration `012` was applied to the development Supabase project. RLS was then restored for listings, leads, visits, and listing_photos with `DB_RLS_MODE=enforce`; all six protected tables were verified as enabled while connected as `estateflow_app`. The existing RLS and listings checks passed. `npm run verify:contact-intake` passed nine HTTP checks covering intake, call history, conversion, repeat conversion, and denied access. Its synthetic contact, call, and lead rows were removed and verified absent; their audit events remain by design.

In API mode, the desktop and mobile Leads views now show the same contact and lead workspace. Staff can search and page through contacts and leads, create a contact, record a call, convert it once to a lead, edit the lead's status and follow-up, and return to the linked call history. API errors are shown without displaying demo records. The seeded Leads views remain unchanged in demo mode. A real-browser run against the development app role covered the desktop create/call/convert/update journey and mobile contact view; its synthetic rows were removed, while audit events remain.

This slice is **not deployed or staff-ready**: the public Vercel build remains a demo, and no production backend or production `APP_DATABASE_URL` was verified here. `server/.env` is local and gitignored; other deployments must explicitly choose and verify their RLS mode. Live visit scheduling and property viewing history are now covered in [VISIT_WORKFLOW.md](VISIT_WORKFLOW.md). Agent performance reports and paid telephony remain separate work.
