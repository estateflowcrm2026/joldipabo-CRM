# Joldipabo / EstateFlow CRM — Product Production Roadmap

Date: 2026-09-24
Status: audit complete; Phases 1–3 implemented (2026-09-24) — real auth flow landed
Scope: everything required for a real organisation to run this CRM daily

---

## 0. Executive summary

EstateFlow is a **high-fidelity interactive prototype with a genuine production-grade skeleton underneath**. The product shape is right, the permission model is thoughtful and consistent, the mobile field-staff concept is where the product should lean, and the database schema is far more considered than most MVP-stage code. Several pieces are already close to production quality: the listings write path has real row-level authorisation, existence-hiding 404s, cross-tenant foreign-key validation, transactional audit call sites, and the single best test suite in the repository.

What blocks production today is not the product. It is four specific things, in priority order:

| # | Blocker | Severity | Status |
|---|---------|----------|--------|
| 1 | **Access tokens are unsigned.** A token with an empty signature and a hand-written `sub` is accepted. With a database configured, this is a working impersonation path. | **Critical** | **Closed 2026-09-24** (Phases 2 and 3) — HS256 signing, constant-time verify, `(sub, tid)` identity, real `POST /auth/login`, Argon2id passwords, refresh rotation with reuse detection, account lockout. **Still open:** MFA, user onboarding, notification email |
| 2 | **The role switcher ships to all users.** The desktop and mobile shells render a "Switch role viewer" list of all 13 seeded users including `super-admin`, calling `setCurrentUser` with no gate. | **Critical** | **Fixed 2026-09-24** — gated behind `VITE_ENABLE_DEMO_ROLE_SWITCHER`, default OFF |
| 3 | **Tenant isolation is application-only.** Every table carries `tenant_id` with a proper FK, but the RLS policies are comments, and `set_config('app.tenant_id', ...)` is never called anywhere. | **High** | **Partially fixed 2026-09-24** — identity resolution is now tenant-scoped (`(sub, tid)`), so a cross-tenant *token* is refused. **RLS still not installed**; isolation remains SQL-predicate based |
| 4 | **Offline listing capture silently loses data.** `listing.capture` is missing from the queue's `ALLOWED_TYPES` set, so every offline listing capture throws and is dropped. | **High** | **Fixed 2026-09-24** — type allow-listed, with a regression test |
| 5 | **The pool sets no `ssl`.** Any managed Postgres refuses the connection. | **High** | **Fixed 2026-09-24** — `DB_SSL_MODE` with `verify-full` in production, unsafe modes refused at boot. **Supabase completed 2026-09-27**: private-CA root installed via a fingerprint-pinned `npm run db:fetch-ca` |
| 6 | **Migration drift.** `001-schema` was edited after being applied, so existing and fresh databases have different schemas. No checksums, no advisory lock. | **High** | **Fixed 2026-09-24** — 001/002 frozen, `003-cross-vertical.sql` added, checksums + advisory lock in the runner |

The honest summary: **this is not a demo that needs a backend written from scratch. It is a demo with a real backend that is not yet switched on, plus a frontend that still ships demo affordances.** The path to production is wiring and hardening, not reconstruction.

---

## 1. Product readiness gaps

### 1.1 Demo-only today (cannot be used for real work)

| Flow | Why it is demo-only | Blocker |
|------|---------------------|---------|
| **All business data persistence** | State is in-memory React state built from seed constants. A refresh resets every lead, visit, attendance record, photo, and message. No business data is ever persisted. | No data survives a reload |
| **Authentication** | No login screen exists. `currentUserId` is hardcoded to `'u-admin'` in `store.jsx:51`. There is no session, no token persistence, no logout. | Not an application — an open console |
| **Authorisation** | 100% client-side. `guardedDispatch` checks the same in-memory matrix the user can change with one click. No server call in any mutation path. | Advisory only |
| **Role switching** | Renders in both shells, ungated, over all seeded users. | Impersonation of `super-admin` |
| **Site photo upload** | Photos resolve to a project stock image (`SitePhotos.jsx:195-196`). No file is ever uploaded. | No real media |
| **Listing photo upload** | Metadata only on the backend. No storage, no bytes. | No real media |
| **Attendance GPS** | When GPS is denied, a hardcoded point `12.97, 77.59` is stored and reported as success. The attendance record is indistinguishable from a real one. | Geo-tagging is not trustworthy |
| **Staff invite** | Toast only — "Invite sent to X. They will receive a welcome email." Nothing is sent, no user is created. | Staff cannot onboard |
| **Role creation** | Toast only — the modal's three starting-point options are read by nothing and discarded. | Roles cannot be created |
| **Search box** | Desktop global search is an `<input>` with no `value`, no `onChange`, no handler. The adjacent `⌘K` badge advertises a shortcut that does not exist. | Non-functional |
| **Notification buttons** | No `onClick`. The desktop bell renders a permanent red dot. | Non-functional |
| **Dashboard CTAs** | Six buttons with no `onClick`. | Non-functional |
| **Listing reassignment (mobile)** | `window.prompt` asking the user to type a raw user ID like `u-fe-arjun`. | Unusable |
| **Communication** | In-app threads only. No WhatsApp, SMS, email, or call logging. No templates. | Telecallers have no call record |
| **Reporting** | Placeholder responses. No funnel, no productivity, no conversion. | No management view |

### 1.2 Production-ready enough (build on these)

| Area | Evidence | Note |
|------|----------|------|
| **Database schema** | 25 tables, every `tenant_id` carries `NOT NULL REFERENCES organisations(id)`, 40 indexes with correct composite ordering and soft-delete-aware partial indexes | Genuinely well-designed. Needs RLS + a few columns, not a rewrite |
| **Listings write path** | Transactional, row-level `can()` checks, cross-tenant FK validation, existence-hiding 404s, soft delete | This is the reference implementation for every other vertical |
| **RBAC model** | 8 roles × 11 resources × 7 actions × 5 scopes, `can()` / `scopeOf()` / `filterByScope()`, fail-closed on every miss | Sound. The two matrices have drifted — see §1.4 |
| **Scope SQL** | `scopeFilterFor()` returns `{sql, params}` with `1 = 0` fail-closed and tenant-leading predicates | Reusable as-is for every remaining endpoint |
| **SQL injection posture** | Every query parameterised. Identifiers come from module constants, not request input. | No finding |
| **List API** | Query params, pagination, `toListingDTO` matching the frontend contract verbatim | Reusable pattern |
| **Match scorer** | Pure, deterministic, 16 passing tests, hard filters before scoring | Ready to serve; needs a backend endpoint wrapper |
| **Offline queue core** | Versioned key, safe read/write with memory fallback, idempotency keys, status lifecycle | Solid. Needs blob persistence and the type fix |
| **Health / readiness** | `/health` and `/ready` with a real DB probe | Fine for a container platform |
| **Error envelope** | Standard `HttpError` subclasses rendering a consistent shape | Reusable |
| **PWA manifest** | Valid manifest, icons, two shortcuts | Fine |
| **Empty / restricted states** | `EmptyState` and `RestrictedState` are genuinely good and used consistently | Keep |

### 1.3 Needs backend/database integration

Ranked by how much of daily work each unblocks.

| # | Vertical | Frontend state | Backend | Effort |
|---|----------|----------------|---------|--------|
| 1 | **Leads** | Demo-only | All 6 routes are 501 stubs | Medium — copy the listings pattern |
| 2 | **Site visits** | Demo-only | All 5 routes are 501 stubs | Medium |
| 3 | **Attendance** | Demo-only | All 4 routes are 501 stubs | Medium |
| 4 | **Photos** | Fake URLs | All 8 routes are 501 stubs | High — needs storage first |
| 5 | **Threads / messages** | Demo-only | All 4 routes are 501 stubs | Medium |
| 6 | **Users / teams / projects** | Demo-only | All routes are 501 stubs | Medium |
| 7 | **Roles + matrix** | Demo-only | All 5 routes are 501 stubs | Medium — audit-critical |
| 8 | **Reports** | Placeholder | All 5 routes are 501 stubs | High — needs real queries |
| 9 | **Sync replay** | Queue only, no network | `POST /sync` is 501, and has **no permission gate at all** | High — trust boundary |
| 10 | **Lead ↔ listing matches** | Works in-memory | `listing_matches` table exists, no routes | Low |

Of 74 registered routes: **10 are DB-backed** (all listings except two 501s), 20 return empty arrays, the rest are 501.

### 1.4 Needs stronger UX before daily use

- **Focus management is absent.** `Modal` and `Drawer` handle Escape and render correct ARIA, but neither moves focus into the overlay, traps Tab, nor restores focus on close. A keyboard user opening a modal is left behind it. The only `.focus()` in the codebase is a scroll assignment.
- **`MobileDrawer` has no Escape handler and no dialog semantics** (`MobileShell.jsx:144-153`).
- **Semantic tables are partial.** `role="table"` / `role="row"` are set but `role="cell"` / `role="columnheader"` are not, so the row-cell relationship is incomplete.
- **Tab bar has no `aria-current` / `aria-selected`.**
- **`LoadingState` exists and is never imported by any view.** Correct while there is no async data layer; the moment the API is wired, no view has a loading path.
- **Form validation is toast-only.** No `aria-invalid`, no `required` on inputs, `<Field required>` renders an asterisk and nothing else. Numeric fields have no bounds.
- **The offline queue polls every 4 seconds forever** (`MobileShell.jsx:54`), each poll a full `JSON.parse` of the whole queue — on every mobile tab, even when online and even when empty. The drawer duplicates the same polling.
- **Failed queue items are invisible.** The UI shows a count; there is no surface listing *which* items failed and why.
- **No list virtualization.** Fine at 12 records, a problem at thousands.
- **Dependencies pinned to `"latest"`.** A fresh `npm install` in six months can pull breaking versions. This is a supply-chain and reproducibility risk.

### 1.5 Concrete defects found (not design gaps — actual bugs)

| # | Defect | Location | Impact |
|---|--------|----------|--------|
| 1 | `listing.capture` missing from `ALLOWED_TYPES` — `queueAction` throws | `offlineQueue.js:20-26` vs `offlineActions.js:125` | **Every offline listing capture is silently lost.** Reproduced |
| 2 | Unsigned access tokens accepted | `tokenService.js:80`, `:93-114` | **Impersonation.** Reproduced |
| 3 | `getUserAuthContextById` keys on `sub` only, ignores `tid` | `authRepository.js:92-98` | Forged token crosses tenant boundary |
| 4 | Service worker `CACHE_NAME` is a hardcoded literal `'joldipabo-shell-v1'` while the comment claims it self-versions | `sw.js:33` | Stale bundles served indefinitely |
| 5 | `authMiddleware.test.js` is not in the `npm test` glob | `package/package.json:14` | The most security-relevant test file never runs in CI |
| 6 | `setDevAuth('1','0')` — helper uses truthiness; `'0'` is truthy | `authMiddleware.test.js:41-46,73-75` | That test **fails** when run directly |
| 7 | `DEV_AUTH_OFFLINE_FALLBACK` defaults to `true` | `config/index.js:71` | Flipping only `DEV_AUTH_ENABLED=true` yields full in-code matrices with no DB verification |
| 8 | `authRepository.js:106` login lookup has no tenant predicate and takes `rows[0]` | | Undefined user when an email exists in two tenants |
| 9 | `photos.js:14` registers `'/photos:presign'` (literal colon) | | The documented `/photos/:id/presign` shape is not registered |
| 10 | `GET /security/sessions`, `DELETE /security/sessions/:id`, `POST /sync` have no permission gate | `users.js:24-25`, `sync.js:31` | Currently 501, but the gate is absent, not merely permissive |
| 11 | Pool has no `ssl` option | `client.js:44-50` | **Any managed Postgres (RDS, Neon, Cloud SQL) refuses the connection** |
| 12 | In-place edits to already-shipped `001-schema` | `schema.sql:222-237, 259` | Databases where `001-schema` was already recorded **skip the new columns entirely**. Fresh and existing DBs now have different schemas |
| 13 | No migration checksums, no `down`, no advisory lock | `migrate.js:22-25, 62-68` | Silent permanent drift; concurrent migrations can race |
| 14 | `main.jsx:300` builds a maps URL with `${project ? '' : ''}` — both branches return `''` | | Navigate link is a prose string, not a coordinate; the pin is almost always wrong |
| 15 | `UPDATE_ROLE_MATRIX` rebuilds from `DEFAULT_PERMISSION_MATRIX` | `store.jsx:401-413` | An admin's customisation is silently reverted when the role is re-saved |

---

## 2. Backend / data architecture (target)

```
                      ┌──────────────────────────┐
  Browser / PWA ─────▶│  CDN + WAF (static SPA) │
        │             └──────────────────────────┘
        │  HTTPS /api/v1
        ▼
┌───────────────────────────────────────────────────────────────┐
│  API tier — Fastify (Node 20)                                 │
│                                                               │
│  helmet · rate-limit · CORS allow-list · JSON-Schema validation│
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ authMiddleware  verify JWT sig → load user+role+matrix  │  │
│  │                  → set_config('app.tenant_id')           │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ requirePermission(resource, action)  →  assertCanOnRecord │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ repositories:  listings · leads · visits · attendance   │  │
│  │                photos · comms · users · roles           │  │
│  │                matches · reports · sync                 │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ auditLog — INSERT inside the caller's transaction       │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬───────────────────────────────┘
                                │  TLS, pooled
              ┌─────────────────┴──────────────────┐
              ▼                                    ▼
┌──────────────────────────────┐   ┌─────────────────────────────┐
│  Postgres 16 primary         │   │  S3-compatible object store │
│  RLS enforced on every table │   │  photos · docs · thumbs    │
│  PITR · daily dump           │   │  presigned URLs, short TTL │
└──────────────────────────────┘   └─────────────────────────────┘
              │
              ▼  replication
┌──────────────────────────────┐
│  Read replica (reporting)    │
└──────────────────────────────┘
```

### 2.1 Entity architecture

| Entity | Key design decision | Gaps to close |
|--------|--------------------|---------------|
| **Tenants / organisations** | Already `organisations` with `slug`, `status` CHECK, soft delete | Add RLS. Decide single-tenant-per-deployment vs multi-tenant — this is the single most consequential architectural decision and should be made before more tables ship |
| **Branches** | Exists. Explicitly documented as "not an isolation boundary" | Zero indexes. `manager_id` is an unconstrained `text` |
| **Teams** | Exists with `team_members` junction | `lead_id` is an unconstrained `text` |
| **Users / staff** | Comprehensive: `password_hash`, `mfa_*`, `failed_login_count`, `locked_until`, `invite_token`, `UNIQUE (tenant_id, email)` | Composite FKs missing on all junctions (see §4.4) |
| **Roles / permissions** | Global `roles` + `permission_matrices` + per-user `users.permission_matrix` | No `tenant_id` on `roles` — decide whether roles are global or per-tenant. Frontend and server matrices have **drifted on 5 cells** |
| **Leads** | Full cross-vertical shape: `service_need`, `client_type`, `requirements` jsonb, `rent_min/max`, `desired_property_type`, `purchase_timeline` | No `version` column → last-write-wins. `matched_listing_ids` jsonb is denormalised and unenforced alongside the real `listing_matches` table |
| **Listings / properties** | Best-modelled table in the system | Missing composite index on `(tenant_id, availability_status, verification_status)`. No index on `property_type`, `locality`, `price`, `rent_monthly`, `bedrooms`. No GiST on `geo` |
| **Lead ↔ listing matches** | `listing_matches` exists with `UNIQUE (lead_id, listing_id)` and both-direction indexes | No `updated_at`, no soft delete, no `deleted_at`. The UNIQUE is not tenant-scoped. Status vocabulary differs from the frontend's (`visit_scheduled` vs `visited`) — reconcile |
| **Site visits** | `listing_id` carries the match source | `listing_id` added in-place to the shipped migration (see defect 12) |
| **Attendance** | Geo-tagging columns present; unique partial index enforces one open shift per staff per day | No selfie support. `photos.category` CHECK cannot store one. No `deleted_at` |
| **Photos / documents** | Three parallel tables with duplicated metadata, no shared abstraction | No `size_bytes`, no checksum, no `updated_at` on `photos` / `listing_photos` / `listing_documents`. No content-type validation beyond one `mime_type` |
| **Communication** | `threads`, `thread_participants`, `messages` with a `channel` CHECK covering in-app/email/sms/whatsapp | **No call entity at all** — no duration, disposition, or recording reference, for a product whose `telecaller` role is first-class |
| **Audit logs** | `audit_log` table with actor, action, entity, metadata, `hmac` column | **Nothing is ever inserted.** The `hmac` column is never populated. No signing key exists |
| **Reports** | `export_jobs` table with status lifecycle | `format` has no CHECK. No index supports the `status = 'queued'` claim query |
| **Offline sync** | `POST /sync` validates `Idempotency-Key` and action types | No server-side idempotency store. No permission re-check per item. No gate on the route itself |

### 2.2 Missing tables to add

| Table | Purpose | Priority |
|-------|---------|----------|
| `call_logs` | Call duration, disposition, recording reference, linked lead | High — telecallers have no call record today |
| `notifications` | Per-user notification queue with read state | Medium |
| `message_templates` | WhatsApp/SMS templates per tenant | Medium |
| `idempotency_keys` | Server-side replay protection for `POST /sync` | High |
| `sync_queue_server` | Optional: server-side view of offline-origin mutations for reconciliation | Low |
| `assets` | Shared file metadata base, with `photos` / `listing_photos` / `listing_documents` referencing it | Medium — removes triplication |
| `attendance_selfies` | Optional selfie proof on check-in | Low — decide with HR first |
| `documents` | Owner documents (title deeds, KYC) | Deferred — not in current scope |

---

## 3. Auth and security

### 3.1 Login

- **Password (primary).** Argon2id via `argon2`. `users.password_hash` column exists and is annotated for it. Migration path: all seeded users have `password_hash IS NULL`, so first login forces a password set.
- **OTP (field staff, optional).** Phone OTP for field executives who share devices. `otp_codes` table exists with `code_hash`, `attempts`, `expires_at`, and a `channel` CHECK covering `sms`/`whatsapp`/`totp`. Needs a provider (SMS gateway) and a TOTP implementation.
- **MFA (admin/super-admin, required).** `mfa_enabled` and `mfa_secret` columns exist. TOTP is dependency-free and should be the first implementation.
- **Invite flow.** `invite_token` / `invite_expires_at` columns exist; `/auth/invite` and `/auth/accept-invite` are 501 stubs.

### 3.2 Token strategy

| Property | Decision |
|----------|----------|
| Access token | HS256 JWT, 15 min TTL, **signed and verified with `JWT_SECRET`**. Replace the placeholder signer. |
| Refresh token | Opaque 32-byte random, SHA-256 hashed at rest. `refresh_sessions` table already correct. |
| Rotation | Rotate on every refresh. |
| Reuse detection | Reusing a revoked refresh token revokes the entire session family and forces re-login. |
| Revocation | `refresh_sessions.revoked_at`. Access tokens carry `jti`; add a short-lived revocation list for logout-everywhere. |
| Storage (client) | Refresh token in an `HttpOnly` + `Secure` + `SameSite=Strict` cookie. Access token in memory only. **Never `localStorage`** — XSS then steals a 7-day credential. |
| `JWT_SECRET` | Required in production. Fail startup if absent when `NODE_ENV=production`. Rotate via KMS with a key-id in the header. |

### 3.3 Session management

- `GET /security/sessions` — list the user's own sessions (device label, last used, IP). **This route currently has no permission gate.**
- `DELETE /security/sessions/:id` — revoke one. **Also ungated.**
- `POST /security/users/:id/unlock` — admin clears `locked_until`.
- `POST /security/users/:id/revoke-sessions` — admin kills all of a user's sessions.
- Account lockout after N failed logins using the existing `failed_login_count` / `locked_until` columns.
- Suspension takes effect on the next request: `users.status = 'Suspended'` → `401 user-suspended`.

### 3.4 Backend-enforced RBAC

- Every route gets `authMiddleware` + `requirePermission(resource, action)`.
- Every record read/write additionally runs `assertCanOnRecord` (already exported at `requirePermission.js:58-68`, currently unused — `listings.js` inlines `can()` instead; unify).
- **Reconcile the two matrices.** The server file claims exact parity with the frontend and is wrong on 5 cells; two of them make the *server* wider than the frontend:

  | Role | Resource | Action | Frontend | Server | Effect |
  |------|----------|--------|----------|--------|--------|
  | admin | staff | approve | `team` | `all` | server wider |
  | telecaller | listings | export | `none` | `own` | server wider |
  | channel-partner-manager | listings | create | `team` | `all` | server wider |
  | channel-partner-manager | listings | approve | `team` | `none` | server narrower |
  | channel-partner-manager | listings | delete | `team` | `none` | server narrower |

  Add a test that diffs the two matrices and fails on any divergence. This is cheap now and expensive to discover later.
- `POST /sync` needs a per-item permission re-check, not just a route-level gate.

### 3.5 Tenant isolation — defence in depth

Three layers, all required:

1. **Derived, never client-supplied.** Already correct on the listings path: tenant comes from the auth context and is bound as `$1`. Body-supplied `tenantId` is rejected. Keep this invariant on every new repository.
2. **Composite foreign keys.** No `FOREIGN KEY (x, tenant_id)` exists anywhere. Without them, `visits` can be stamped `tenant_id = 'org_acme'` while `lead_id` points at an `org_globex` lead. Fix: add `UNIQUE (id, tenant_id)` to each parent, then composite FKs on `visits`, `listing_matches`, `listing_photos`, `listing_documents`, `refresh_sessions`, `otp_codes`, and all four junction tables.
3. **Row-level security.** Enable RLS on all 18 tenant-owned tables with a `tenant_id = current_setting('app.tenant_id')` policy, and call `set_config('app.tenant_id', $1, true)` at the top of every request. This is defence in depth, not the primary control — the primary control remains the application-level predicate, which is already right.

### 3.6 Audit logs

- Wire the `INSERT`. It must run **inside the caller's transaction** so a mutation cannot commit without its audit row.
- Extend coverage beyond listings. Currently no audit on login, logout, logout-all, role creation, **matrix edits**, user changes, session revocation, or unlock. Role and matrix edits are the highest-value mutation targets in the product.
- Populate the `hmac` column with a KMS-backed HMAC over the row so tampering is detectable.
- Enforce append-only at the DB role level: `REVOKE UPDATE, DELETE ON audit_log FROM app`.
- Retention: archive to cold storage after N years, keep queryable.

### 3.7 Dev auth must be off in production

- `DEV_AUTH_ENABLED` **must** be `false`. It defaults to `false` today — keep it that way.
- `DEV_AUTH_OFFLINE_FALLBACK` defaults to **`true`**, which is the actual hazard: setting only `DEV_AUTH_ENABLED=true` hands out full in-code permission matrices with no database row to back them. **Change the default to `false`.**
- Add a startup guard: if `NODE_ENV=production` and `DEV_AUTH_ENABLED=true`, **refuse to boot**. Do not merely warn.
- Add the same guard for `VITE_DEV_AUTH_TOKEN` in the frontend build.

### 3.8 Export restrictions

- `export` is already a first-class permission axis in both matrices. Enforce it server-side.
- Single-record export: synchronous, rate-limited, watermarked with `__exported_at` / `__exported_by`.
- Tenant-wide export: async via the existing `export_jobs` table, `202 Accepted`, notify on completion.
- Strip PII outside the caller's scope from every export body.
- Audit every bulk export with row count and filters.

### 3.9 File access control

- `GET /photos/:id` returns **metadata only**. The URL field is `null`.
- `GET /photos/:id/url` returns a presigned URL with a **≤ 900 s** expiry, and every issuance is audited.
- Pre-approval visibility: uploader, uploader's manager, and the project's site manager only. After approval, normal scope rules apply.
- Never return a public object URL.
- Soft delete hides the row; the object is removed after a retention window.

---

## 4. Database

### 4.1 What already exists

25 tables, 40 indexes, ~60 declared foreign keys. Reviewed in full in [server/src/db/schema.sql](../server/src/db/schema.sql) and [server/src/db/indexes.sql](../server/src/db/indexes.sql).

The schema is genuinely good. `tenant_id` is on 18 tables, every instance `NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT`. CHECK constraints are thorough on enums. Soft-delete columns are present on 14 tables. The unique partial index `idx_attendance_open_shift` on `(staff_id, date) WHERE check_out IS NULL` correctly enforces one open shift per staff per day.

### 4.2 Missing tables

See §2.2. The ones that matter before launch: `idempotency_keys`, `call_logs`, `notifications`.

### 4.3 Indexes needed

The listings browse path is the main gap. `availability_status` and `verification_status` each get a single-column index, but the canonical query filters on both — and **Postgres cannot combine two single-column indexes to satisfy a multi-column equality predicate on both columns.** It picks one and filters.

| Index | Serves |
|-------|--------|
| `listings (tenant_id, availability_status, verification_status)` | The browse-and-filter path — **highest-value index in the system** |
| `listings (tenant_id, property_type)` | Primary catalogue facet, currently unindexed |
| `listings (tenant_id, locality)` | The granularity most search UIs actually filter on (city is indexed, locality is not) |
| `listings (tenant_id, price)` / `(tenant_id, rent_monthly)` | Any price-range sort is currently a full scan of the tenant's listings |
| `users (tenant_id, email)` | The auth lookup filters on this; it is unindexed |
| `leads (tenant_id, phone)` | Phone-based dedup on intake is a sequential scan |
| `branches (tenant_id)` | Zero indexes of any kind exist on `branches` |
| `export_jobs (status) WHERE status = 'queued'` | The worker's claim query scans every tenant's history |
| `listing_matches (tenant_id, match_score)` | "Top N matches" is currently a sort |

**At scale, all of these must be built with `CREATE INDEX CONCURRENTLY`.** That cannot run inside the implicit transaction a multi-statement `db.query` creates, so it is a real refactor of the migration runner, not a one-word change.

### 4.4 Foreign keys needed

Three unconstrained `text` columns pointing at `users(id)` with no constraint: `branches.manager_id`, `teams.lead_id`, `projects.manager_id`. (The seed's insert ordering suggests the FKs were omitted *because* `projects.manager_id` is set before its user row exists.)

The systemic gap is the absence of **composite** tenant-scoped foreign keys. Every child-parent pairing that carries its own `tenant_id` is a cross-tenant write vector. See §3.5.

Also: `listing_matches` has `UNIQUE (lead_id, listing_id)` which is not tenant-scoped, and `leads.matched_listing_ids` is a denormalised jsonb array with no referential enforcement — deleting a listing leaves dangling ids.

### 4.5 Row-level / tenant safety strategy

Layered as described in §3.5. Application predicates (already correct on listings) → composite FKs → RLS with `set_config`.

The schema header at `schema.sql:4-6` currently claims *"the connection pool sets `app.tenant_id` per request and a RLS policy enforces isolation."* **Neither is true.** Correct this comment as part of Phase 1 — a security claim in a schema header that isn't implemented is worse than an acknowledged gap.

### 4.6 Migration tooling — fix before any real data

**This is the most urgent database item.** The runner tracks migrations by name only:

```js
const MIGRATIONS = [
  { name: '001-schema', file: 'schema.sql' },
  { name: '002-indexes', file: 'indexes.sql' },
];
```

and skips on name match (`migrate.js:62-68`). There is no checksum. The cross-vertical columns were added by editing `schema.sql` **in place** — eleven `ALTER TABLE leads ADD COLUMN IF NOT EXISTS` statements at `schema.sql:222-237`, and `visits.listing_id` at `:259`.

**Consequence: on any database where `001-schema` was already recorded, `migrate()` skips the file entirely and those columns are never created.** A fresh database and an existing one now have different schemas. This has already happened.

Required before real data:

1. Freeze `001-schema` and `002-indexes` permanently.
2. Add `003-cross-vertical.sql` containing the columns currently stranded in `001-schema`, as idempotent statements.
3. Add a `checksum` column to `schema_migrations`; refuse to run if an applied file's hash has changed.
4. Add `pg_advisory_lock` around the runner so two concurrent migrations cannot race.
5. Add a documented `down` path, or state explicitly that rollback is `db:reset` (dev only) + restore-from-backup (production).
6. Plan `CREATE INDEX CONCURRENTLY` support for large tables.

**Partial-failure behaviour is currently good** and should be preserved: the whole file is sent as one parameterless `db.query`, which uses the simple query protocol, which Postgres wraps in an implicit transaction. Statement 40 failing rolls back 1–39 and the migration is not recorded. The weak link is the gap *after* the DDL — a crash between the SQL and the tracking-row insert leaves the schema applied but unrecorded. Idempotency rescues this at the cost of a full re-run.

### 4.7 Connection handling

| Item | Current | Required |
|------|---------|----------|
| SSL | **absent** | `ssl` object or `sslmode=require` in the URL. **Managed Postgres providers refuse connections without it** — this blocks every hosted deployment |
| `statement_timeout` | absent | 10–30 s. Without it a runaway query blocks indefinitely; with `max: 10` the pool exhausts and every request fails on `connectionTimeoutMillis` after 5 s |
| `lock_timeout` | absent | Prevents a migration from deadlocking against live traffic |
| Retry on `40001` / `40P01` | absent | Serialization failure and deadlock are routine under concurrent lead updates |
| `application_name` | absent | Connection attribution in `pg_stat_activity` |
| `closeDb()` race | `pool = null` before `await p.end()` | A concurrent `getDb()` constructs a second pool; the first is never drained |
| Readiness with no `DATABASE_URL` | returns **200** `not-configured` | A deployment that forgot to inject the variable passes readiness forever. Return 503 in production |

### 4.8 Backup / restore

**Nothing exists.** No dump script, no restore script, no cron, no PITR configuration, no reference in `package.json`. Required before real data:

- Managed Postgres with **PITR** (point-in-time recovery, ≤ 5 min RPO) as the primary mechanism.
- Nightly `pg_dump` to versioned, encrypted, off-site storage as the secondary.
- **A restore drill.** An untested backup is not a backup. Quarterly, restore to a scratch database and verify row counts.
- Tenant-scoped restore capability.
- Document RPO and RTO and confirm the business accepts them.

---

## 5. File storage

### 5.1 Architecture

S3-compatible object storage (AWS S3, MinIO self-hosted, Cloudflare R2, or Backblaze B2). The application never proxies file bytes — it issues presigned URLs and the client talks to storage directly.

```
Client                          API                              Object store
  │                              │                                     │
  ├── POST /photos:presign ─────▶│                                     │
  │   {filename, mime, bytes}    │  check photos:create + row scope    │
  │◀── {uploadUrl, objectKey} ───┤  check extension + declared size   │
  │                              │  write metadata row (approved=false)
  ├── PUT <uploadUrl> ─────────────────────────────────────────────▶│
  │                              │                                     │
  ├── POST /photos ─────────────▶│  confirm object exists              │
  │                              │  enqueue thumbnail job              │
  │                              │  strip EXIF                         │
  │                              │                                     │
  ├── GET /photos/:id/url ──────▶│                                     │
  │◀── presigned GET (≤900s) ────┤  audit `photo-url-issued`           │
```

### 5.2 Bucket layout

```
{tenantId}/                      ← tenant prefix on every object key
  site/{projectId}/{yyyy}/{mm}/{photoId}.{ext}
  listing/{listingId}/{photoId}.{ext}
  listing/{listingId}/docs/{documentId}.{ext}
  attendance/{staffId}/{yyyy}-{mm}-{dd}/{attendanceId}.jpg
  audit-archive/{yyyy}/{mm}/
```

Tenant prefix on the key means a bucket policy or a lifecycle rule can enforce isolation and expiry per tenant.

### 5.3 Presigned upload / download

- **Upload**: presigned `PUT`, 15 min expiry, `Content-Type` bound in the signature, server-declared max size enforced by the bucket policy (not the client). The API issues an `objectKey`; the client never chooses one.
- **Download**: presigned `GET`, **≤ 900 s** expiry, issued only after a `photos.view` + row-scope check. Every issuance audited.
- **Never** return a public URL. `photos.public_url` exists in the schema and should stay `null` in production.

### 5.4 Thumbnails and processing

- On upload confirmation, queue a job: strip EXIF → generate a 480 px WebP thumbnail → optionally a 1600 px display version → update `thumbnail_url` / `processed_at`.
- **EXIF stripping is mandatory**, not optional — it removes the GPS tags that would otherwise leak staff and owner locations. The security checklist already requires this (§3.8 of [SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md)).
- Enforce `approved = false` on arrival; approval is a separate RBAC-gated action.
- Strip or rewrite GPS EXIF on attendance selfies too.

### 5.5 Retention policy

| Asset | Retention | Rationale |
|-------|-----------|-----------|
| Listing photos | Life of listing + 2 years after soft delete | Legal/transactional record |
| Site photos | 3 years | Project record |
| Attendance selfies | 1 year, or shorter if HR prefers | Employment sensitivity — shortest |
| Owner documents | Life of listing + 7 years | Statutory |
| Audit archive | 7 years, then cold storage | Compliance |
| Soft-deleted objects | 30 days, then purged | Recovery window |
| Orphaned uploads (metadata never confirmed) | 7 days, then purged | Aborted upload cleanup |

Deletion must be a lifecycle rule plus a scheduled purge job, not a manual step.

### 5.6 Attendance selfie (decide first)

The user asked whether this is needed. **Recommendation: decide with HR/legal before building it.** Selfie check-in is a meaningful privacy commitment — it changes the employment relationship and creates a biometric-adjacent data category. The schema supports it cheaply: add `attendance_selfies` or extend `photos.category` beyond its current CHECK. Do not build it as a silent default.

---

## 6. Mobile / PWA / offline

### 6.1 Installable PWA

| Item | Status | Action |
|------|--------|--------|
| `manifest.webmanifest` | valid | Keep. Add `screenshots` for richer install UI |
| Service worker | exists, **cache-busts incorrectly** | Fix `CACHE_NAME` to embed a build hash; precache the hashed asset manifest, not just `/` |
| Install prompt | absent | Add `beforeinstallprompt` capture + a user-facing install CTA |
| Offline shell | `/` precached | Must be regenerated per build, not captured once at install |
| `sync` / `push` / `periodicsync` events | all stubs | Implement `sync` for queue flush |
| Safe-area insets | absent | Add `env(safe-area-inset-*)` for notched devices |
| Offline data | none | Decide: server-cached shell only, or cached recent records for read-only offline use |

**Fix this first:** `CACHE_NAME = 'joldipabo-shell-v1'` is a hardcoded literal while the comment above it claims the name "includes the package version" and busts automatically. It does not. `activate` deletes every cache except that one fixed name, so it can never rotate. A returning user can be served a stale bundle indefinitely — including a bundle with a known security fix.

### 6.2 Offline capability required

| Action | Current | Required |
|--------|---------|----------|
| Check-in / check-out | Queued correctly | Wire to `POST /sync`. Re-validate permission at replay |
| Listing capture | **BROKEN** — `listing.capture` not in `ALLOWED_TYPES` | Add to the set. Then wire to `POST /api/v1/listings` |
| Visit notes | Queued correctly | Wire to `PATCH /api/v1/visits/:id` |
| Photo upload | Metadata only, **blob not persisted** | IndexedDB blob store |
| Messages | Queued correctly | Wire to `POST /threads/:id/messages` |

### 6.3 Photo blob persistence — the real design

Today `photo.upload` items carry `blobPersistence: 'deferred'` and `blobKey: null`. The file is never stored; the sync handler hard-fails with `photo-repick-required`. Every offline photo is lost.

Required:

1. **IndexedDB store** for blobs, keyed by queue item id. `localStorage` cannot hold binary data.
2. On capture: write the `File` to IndexedDB, store the key in the queue item, mark `blobPersistence: 'indexeddb'`.
3. On sync: read the blob, request a presigned URL, `PUT` the bytes, confirm, then **delete the IndexedDB record**.
4. On permanent failure: keep the blob and surface a retry affordance. Never silently drop.
5. Quota handling: `navigator.storage.persist()` to request durable storage; degrade with a visible warning if the browser refuses.

### 6.4 Sync conflict handling

There is **none** today. No versioning, no ETag, no merge — every write is last-write-wins, and the database has no `version` column to support anything else.

Required:

- Add `version integer NOT NULL DEFAULT 1` to `leads`, `listings`, `visits`.
- Client sends `If-Match: <version>`. Server returns `409 conflict` with the current row on mismatch.
- Client resolves: for most fields, prompt the user; for attendance, prefer the device timestamp; for status transitions, prefer whichever is further along the lifecycle.
- Never silently discard. A dropped field-visit note is a lost business event.

### 6.5 Background sync limits

- The Background Sync API is **Chromium-only**. iOS Safari does not support it. Do not depend on it.
- Treat background sync as an *optimisation*. The user-visible manual "Sync pending actions" button remains the guaranteed path.
- On app launch and on `online` event, flush the queue. Today `startAutoSync()` is exported but **never called** — field staff close the app, and nothing flushes on reload or reconnect.
- Cap batch size (e.g. 20 items per flush) so a returning user with 400 queued items does not time out.

### 6.6 User-visible sync status

Today: a count chip polled every 4 seconds, with no way to see *what* failed. Required:

- Persistent status: last successful sync time (persist it — it is currently module memory only, so it is blank after every reload), pending count, failed count.
- A **failed-items list** showing each item's type, when it failed, and the reason, with per-item retry and discard.
- Distinguish "offline", "syncing", "all synced", "N failed" as explicit states.
- Stop the 4-second poll. Drive updates from queue mutations plus a slow background reconciliation.

---

## 7. Communication

### 7.1 Phase order

1. **Internal messages** — the `threads` / `messages` tables exist. Just needs routes. This is the foundation everything else logs against.
2. **Lead follow-up log** — every call, WhatsApp message, and meeting recorded against a lead, as a timeline. This is the single highest-value reporting input and it is entirely absent. The frontend currently infers "Recent Conversations" by grepping message text for the lead's name (`Leads.jsx:283`) — a placeholder, not a relation.
3. **Call logs** — a `call_logs` table with duration, disposition, and notes. `telecaller` is a seeded first-class role with no way to record a call. This is the most obviously missing piece.
4. **WhatsApp deep links (current)** — `wa.me` with a prefilled message. Already implemented in the UI. No API, no cost, no integration risk. Keep as the default.
5. **WhatsApp Business API (future)** — only after templates are approved and a business account exists. Requires template pre-approval, a webhook for delivery status, and a per-message cost model. Do not start before phases 1–4.
6. **Email / SMS** — transactional only (visit reminders, export-ready notifications). Via a transactional provider.

### 7.2 Templates

Per-tenant message templates with a `{{lead.name}}`-style placeholder syntax, scoped to channel. Required before any WhatsApp Business API work, because that API mandates pre-approved templates and ad-hoc text will be rejected.

### 7.3 Notification strategy

| Type | Delivery | Rationale |
|------|----------|-----------|
| Overdue follow-up | In-app + digest email, once daily | Not urgent enough for push |
| Site visit tomorrow | Push + in-app | Time-critical, field staff |
| New lead assigned | Push + in-app | Time-critical |
| Listing verified / rejected | In-app | Office staff |
| Sync failure | In-app, persistent until resolved | Silent data loss is the worst outcome |
| Export ready | Email | Async, no user waiting |

Push requires the VAPID keys, a service-worker `push` handler, and — for iOS — the app must be **installed to the home screen**. Do not promise iOS push before that is understood.

---

## 8. Reporting

All of these are placeholders today. `GET /reports/pipeline` and `GET /reports/attendance` return `{placeholder: true}`; the rest are 501.

| Report | Definition | Notes |
|--------|-----------|-------|
| **Lead funnel** | Count by status, with stage-to-stage conversion and time-in-stage | Needs `leads.status` + `updated_at` history. Current schema overwrites status — a status *history* table is needed for real conversion |
| **Inventory by category** | Count and value by `service_category` × `availability_status` | Trivial; index from §4.3 makes it fast |
| **Field staff productivity** | Visits completed, leads touched, photos captured, per staff per period | Joins visits + leads + photos on staff and date |
| **Attendance punctuality** | On-time rate against shift start; late count; hours worked | `attendance` has all fields |
| **Site visit conversion** | Visits completed → leads advanced → bookings | Requires the lead status history from above |
| **Listing collection performance** | Listings captured by staff, verified rate, time-to-verify | `created_by`, `verified_at` exist |
| **Match-to-visit conversion** | Matches → visits scheduled → visits completed | `listing_matches.status` + `visits.listing_id` — **this is the metric that justifies the matching feature** |
| **Overdue follow-ups** | `next_follow_up < now()` and status not terminal | `idx_leads_tenant_followup` already exists |

**Operational requirements:**

- Every report respects RBAC scope. A field executive's "productivity" report is about themselves; a sales manager's is team-scoped; an admin's is tenant-scoped. The scope must be applied in SQL via `scopeFilterFor`, not in the client.
- Heavy reports run against a **read replica** so they cannot degrade transactional performance.
- Exports go through `export_jobs` (async) with the rate limits in §3.8.
- Every export audited with row count and filters.

---

## 9. Deployment and operations

### 9.1 Topology

| Component | Recommendation | Rationale |
|-----------|----------------|-----------|
| Frontend | Static SPA on a CDN (Cloudflare Pages / Netlify / S3+CloudFront) behind a WAF | No server needed; global edge; cache-bust by content hash |
| Backend | Container on Fly.io / Render / Railway / ECS | Fastify is stateless; container keeps the runtime pinned |
| Database | Managed Postgres with PITR (RDS / Cloud SQL / Neon) | Managed backups and PITR are the single highest-leverage operational decision |
| Object storage | S3-compatible with versioning + lifecycle rules | Retention becomes a bucket policy, not app code |
| Secrets | Platform secrets manager (AWS/GCP/Vercel) | Never `.env` files in the image |
| TLS | Terminated at the edge | App-to-DB over TLS (`ssl` is currently missing) |

### 9.2 Environment variables

See **[docs/ENVIRONMENT.md](ENVIRONMENT.md)** for the full matrix, the dev/staging/prod table, and the `DEV_AUTH_ENABLED=false` production requirement. Summarised:

| Layer | Vars | Prod requirement |
|-------|------|------------------|
| Frontend | `VITE_API_BASE_URL`, `VITE_USE_API_REPOSITORY`, `VITE_DEV_AUTH_TOKEN` | `VITE_DEV_AUTH_TOKEN` **must be unset** — Vite inlines it into the public bundle |
| Backend | `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, `DEV_AUTH_ENABLED`, `DEV_AUTH_OFFLINE_FALLBACK`, `NODE_ENV`, `LOG_LEVEL`, `PORT` | `DEV_AUTH_ENABLED=false`, `DEV_AUTH_OFFLINE_FALLBACK=false`, `JWT_SECRET` set, `CORS_ORIGINS` exact-match to the real frontend origin |

**Two traps in the current setup:**
1. Nothing loads a `.env` file. `config/index.js` reads `process.env` only; there is no `dotenv` and no `--env-file`. Copying `.env.example` to `.env` is silently ignored. Use `node --env-file=.env` or the platform's env injection.
2. `CORS_ORIGINS=*` **disables** CORS rather than opening it — `list()` yields `['*']` and `Array.includes` is an exact match. Enumerate origins explicitly.

### 9.3 CI/CD

No CI exists. Minimum viable pipeline:

**On every PR:**
- `npm ci && npm run build` (frontend)
- `npm run lint && npm test` (backend) — **with the auth test glob fixed**
- `npm audit --audit-level=high`
- A matrix-drift test: diff the frontend and server permission matrices, fail on divergence
- The `matchListings` pure test

**On merge to main:**
- Build and push a backend image; deploy to staging
- Run migrations against staging
- Run `smoke:listings` against staging with `SMOKE_WRITE=1`
- Deploy the frontend to the CDN preview
- Manual approval gate before production

**Migrations must be a separate, explicit step** — never run automatically as part of an app deploy, and never concurrently across replicas. Take the advisory lock.

### 9.4 Observability

| Signal | Tool | Alert on |
|--------|------|----------|
| Errors | Sentry (frontend + backend) | Any 5xx; new error type; error rate > 1% |
| Logs | Structured JSON → Loki / CloudWatch / Datadog | Ship and retain 90 days |
| Uptime | External prober on `/health` and `/ready` | 2 consecutive failures, 5 min |
| Database | `pg_stat_activity`, connection count, slow queries | Pool saturation; queries > `statement_timeout` |
| Sync health | Server-side count of failed replays | Any sustained failures |
| Frontend | Web Vitals (LCP, INP, CLS) via `web-vitals` | Regression vs. previous release |

**Health endpoints exist and are adequate** — but `/ready` currently returns 200 when `DATABASE_URL` is unset, so a misconfigured deployment passes readiness forever. Fix in Phase 1.

### 9.5 Operational runbook

Must exist before the first real user:

- Deploy / rollback procedure
- Migration procedure and its rollback path
- **Restore drill** procedure
- Incident response: severity levels, on-call, escalation
- Credential rotation (JWT secret, DB password, storage keys)
- User offboarding: revoke sessions, deactivate account, retain or purge data per policy
- Data export on tenant offboarding

### 9.6 Staging vs production

Separate everything: separate database, separate storage bucket, separate domain, separate secrets. Staging uses seed-derived data with a **clearly synthetic marker** so it is never mistaken for real customer data. Staging never receives production backups without redaction.

---

## 10. Phased execution plan

### Phase 1 — Foundation (no behaviour change to the demo)

**Goal:** remove the exploitable and data-losing defects, and make the deployment surface explicit.

| # | Task | Files |
|---|------|-------|
| 1.1 | Add `src/auth/*.test.js` and `src/config/*.test.js` to the `npm test` glob; fix the `setDevAuth` truthiness helper | `server/package.json`, `server/src/auth/authMiddleware.test.js` |
| 1.2 | **Refuse to boot when `NODE_ENV=production` and `DEV_AUTH_ENABLED=true`.** Fail closed, not warn | `server/src/config/index.js`, `server/src/server.js` |
| 1.3 | Change `DEV_AUTH_OFFLINE_FALLBACK` default to `false` | `server/src/config/index.js`, `server/.env.example` |
| 1.4 | Gate the role switcher behind a build-time flag so it cannot ship | `src/layout/DesktopShell.jsx`, `src/main.jsx`, `src/services/demoFlags.js` |
| 1.5 | Add `listing.capture` to `ALLOWED_TYPES` | `src/services/offlineQueue.js` |
| 1.6 | Fix `CACHE_NAME` to embed a build hash; precache the hashed asset manifest | `public/sw.js` |
| 1.7 | Add SSL, `statement_timeout`, `lock_timeout` to the pool | `server/src/db/client.js`, `server/src/db/sslConfig.js` |
| 1.8 | Make `/ready` return 503 when `DATABASE_URL` is unset and `NODE_ENV=production` | `server/src/db/health.js` |
| 1.9 | Freeze `001-schema` / `002-indexes`; add `003-cross-vertical.sql`; add migration checksums + advisory lock | `server/src/db/*.sql`, `server/src/db/migrate.js` |
| 1.10 | Correct the schema header's RLS claim to reflect reality | `server/src/db/schema.sql` |
| 1.11 | Add permission gates to `/security/sessions`, `/security/sessions/:id`, `/sync` | `server/src/routes/users.js`, `server/src/routes/sync.js` |
| 1.12 | Add a matrix-drift test between the two permission files | `server/src/rbac/permissions.test.js` |
| 1.13 | Add `.gitignore`, root `.env.example`, `docs/ENVIRONMENT.md` | repo root |
| 1.14 | Pin dependencies to exact versions (drop `"latest"`) | `package.json`, `server/package.json` |

**Status as of 2026-09-24.** Complete: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.9, 1.10, 1.13. Remaining: 1.6, 1.8, 1.11, 1.12, 1.14.

**Acceptance criteria**
- [x] `npm test` in `server/` runs the auth and config suites and is green — 149 tests, 0 failures.
- [x] A production-mode boot with `DEV_AUTH_ENABLED=true` exits non-zero with a clear message.
- [x] `DEV_AUTH_ENABLED=true` alone (with no DB) no longer grants permissions.
- [x] No role switcher in a production build; present and working when `VITE_ENABLE_DEMO_ROLE_SWITCHER=true`.
- [x] Offline listing capture enqueues successfully, with a regression test that fails if the type is removed.
- [x] The pool connects to a Postgres with `sslmode=verify-full`, and refuses `require` or `rejectUnauthorized=false` in production.
- [x] `verify-full` works against Supabase in production: the private root is installed via a fingerprint-pinned `npm run db:fetch-ca`, `DB_SSL_CA_FILE` supplies it, and the direct (non-pooler) host is used. Verified against a live project on 2026-09-27 — connects with the CA, fails clearly without it.
- [x] Migrating a database that already recorded `001-schema` applies `003-cross-vertical.sql` and reaches the same schema as a fresh one.
- [x] CI exercises the database: `REQUIRE_DB=1` makes a would-be skip a failure, and an ephemeral Postgres service runs the migrations, auth smoke, listings write smoke and audit check on every push. Completed 2026-09-27 — see docs/SUPABASE_VERIFICATION.md §9.
- [x] MFA (TOTP) for `admin` / `super-admin`, enforced by `AUTH_MFA_ENFORCE`, with a production boot that **fails** when it is off. Completed 2026-09-27 — see docs/AUTH_TENANT_SECURITY_PLAN.md §26.
- [ ] **RLS rollout — started 2026-09-28.** Tenant context (`withTenant`) built and used; policies installed for `listings`, `leads`, `visits`, `listing_photos` behind `DB_RLS_MODE`; `probe` mode passes unchanged. **Phase 8B: the `estateflow_app` role exists and is granted** (non-owner, `NOBYPASSRLS`, DML only, nothing on `schema_migrations`), and a production boot now **refuses** a `postgres` or absent `APP_DATABASE_URL`. `npm run rls:check` passes 8/8. **Remaining: set `APP_DATABASE_URL` in production.** [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md) §7.
- [x] Editing an applied migration aborts the run with the offending file named.
- [x] Two concurrent `db:migrate` invocations cannot both apply.
- [ ] The service worker cache name changes between builds.
- [ ] `/ready` returns 503 in production with no `DATABASE_URL`.
- [ ] The matrix-drift test passes.
- [x] `npm run build` and `npm run lint` pass.

**Risks**
- Changing `DEV_AUTH_OFFLINE_FALLBACK`'s default breaks any local setup relying on it. Mitigated by documenting the new default and updating `.env.example`.
- Gating the role switcher changes the demo build. Mitigated by a flag that is on in the template `.env.example` and off by default in code, so a developer copying the template keeps the demo and a CI build without it does not.
- Checksum enforcement refuses to run on a database whose frozen file was edited. Mitigated by shipping `003-cross-vertical.sql` in the same change and a repair guide ([docs/MIGRATIONS.md](MIGRATIONS.md) §3).

---

### Phase 2 — Auth and tenant isolation

**Goal:** a real, signed, tenant-isolated authentication system.

**Status 2026-09-24: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.9, 2.13 and 2.14 are done, plus the production boot guards. 2.8, 2.10, 2.11, 2.12 and 2.15 remain.**

| # | Task | Files | Status |
|---|------|-------|--------|
| 2.1 | Sign and verify HS256 with `JWT_SECRET`; require the secret at boot in production | `auth/tokenService.js` | ✅ **Done** — signed with `node:crypto` rather than adding `@fastify/jwt`, so there is no new dependency. Constant-time signature compare, `iss`/`aud`/`exp`/`iat` verified. 28 tests |
| 2.2 | Add `argon2`; implement `hashPassword` / `verifyPassword` / reuse check | `auth/passwordPolicy.js` | ✅ **Done** — Argon2id via the `argon2` native module, verified to build here first (installed from source in ~5 s, ~29 ms/hash). OWASP-minimum parameters in self-describing PHC format; `needsPasswordRehash` upgrades on next login. 18 tests
| 2.3 | Implement `POST /auth/login` — verify credentials, load user + merged matrix, create a `refresh_sessions` row, issue a token pair | `routes/auth.js`, `repositories/authRepository.js` | ✅ **Done** — tenant + email + password, one indistinguishable 401 for every failure, session created, token pair issued. 24-assertion flow smoke (`npm run smoke:auth`)
| 2.4 | Implement `POST /auth/refresh` with rotation and reuse detection | `routes/auth.js` | ✅ **Done** — rotation with per-family reuse detection; a replayed token revokes the whole family and stamps `compromised_at`. 16 tests
| 2.5 | Implement `POST /auth/logout`, `/auth/logout-all` (both require auth) | `routes/auth.js` | ✅ **Done** — logout revokes the presented session and is idempotent; logout-all revokes every session for the caller. Logout needs no access token (an expired client must still be able to end its session); logout-all does
| 2.6 | Make the user lookup require `sub` **and** `tid` | `repositories/authRepository.js` | ✅ **Done** — plus fail-closed account and tenant state, and a tenant-scoped email lookup. 19 tests |
| 2.7 | Fix the tenant-less login lookup and the `rows[0]` pick | `repositories/authRepository.js` | ✅ **Done** — `getUserAuthContextByEmail` now requires `tenantId` |
| 2.8 | Add `UNIQUE (id, tenant_id)` to parents; add composite tenant FKs | `db/004-composite-fk.sql` | ✅ **Done** — 5 failures lock a known account for 15 min, 10 lock an identifier for the tenant; both clear on success. Identifiers hashed, never stored in the clear. `429` carries `Retry-After`
| 2.9 | Set `app.tenant_id` per request | `db/client.js` | ✅ **Done** — `withTenant(ctx, fn)`, transaction-scoped so it cannot leak across pooled connections. **Not a security control until RLS lands** |
| 2.10 | Enable RLS on all tenant-owned tables with tenant policies | `db/005-rls.sql` | ⬜ **Deliberately deferred.** See the rollout proposal in [AUTH_TENANT_SECURITY_PLAN.md §23](AUTH_TENANT_SECURITY_PLAN.md) |
| 2.11 | Reconcile the 5 drifting permission cells; decide each deliberately | both `permissions.js` files | ⬜ Open — the drift test is still unwritten |
| 2.12 | Build a frontend login screen; store the refresh token in an `HttpOnly` cookie | `src/main.jsx`, new `src/auth/` | ⬜ Open |
| 2.13 | Gate every route on auth; remove the "no auth on logout" path | `auth/authMiddleware.js`, `routes/auth.js` | ✅ **Done** — the dev path refuses itself in production independently of the boot guard |
| 2.14 | Account lockout via `failed_login_count` / `locked_until` | `repositories/sessionRepository.js` | ✅ **Done** — 5 failures lock a known account for 15 min, 10 lock an identifier for the tenant; both clear on success. Identifiers hashed, never stored in the clear. `429` carries `Retry-After` |
| 2.15 | Sign-out-everywhere and session list UI | new | ⬜ Open |

Also landed beyond the original list: production now refuses a **weak** (under 32 chars) or **placeholder** `JWT_SECRET`, not merely a missing one; `iss` and `aud` are enforced with stable defaults; and `rid` and `sid` are carried in the claims so a role change or session revocation can be detected without a second round trip.

**Acceptance criteria**
- [x] A forged unsigned token is refused
- [x] A forged token with a valid signature but a mismatched `tid` matches no user row
- [x] A token signed with the wrong key is refused
- [x] An expired token is refused; a not-yet-valid token beyond 60 s skew is refused
- [x] Wrong-issuer and wrong-audience tokens are refused
- [x] A rotated secret invalidates previously issued tokens
- [x] A production boot refuses dev auth, a missing secret, a short secret, or a placeholder secret
- [x] A user in another tenant cannot be resolved from a token claim
- [x] Inactive, suspended, invited and soft-deleted users are refused, and unrecognised statuses fail closed
- [x] 47 new tests across `tokenService.test.js` and `authRepository.test.js`; 204 backend tests, 0 failures
- [ ] Login with correct credentials returns a token pair and writes a `refresh_sessions` row — **blocked on 2.2 and 2.3**
- [ ] Refresh rotates; replaying a consumed token revokes the whole family
- [ ] Password change invalidates every session
- [ ] Direct SQL as the app role cannot insert a cross-tenant `visits` row — **blocked on 2.8**
- [ ] The app role has no `BYPASSRLS`
- [ ] The matrix-drift test passes with the 5 cells reconciled

**Risks**
- This is the highest-risk phase: an auth bug is worse than no auth. The fail-closed placeholder is retained, so a database outage cannot produce an authenticated identity.
- **RLS is deliberately not switched on here.** Enabling broad policies against untested queries fails closed and would take down the listings path — the only vertical that currently works. The proposal in `AUTH_TENANT_SECURITY_PLAN.md §23` runs the whole test suite a second time under a parallel RLS-enforced database role; any divergence is a query that was reading across tenants. Only parity permits enabling.
- Adding `argon2` introduces a native module. Pin the version and build it in CI.
- Cookie auth introduces CSRF surface. It lands with 2.12, with `SameSite=Strict` plus an origin check.
- The permission matrix is re-read on every request rather than carried in the token. That costs one query per request and is also the only way a role change takes effect inside the 15-minute window. Do not "optimise" it into the token.

**Order:** 2.2 → 2.3 → 2.4, 2.5 → 2.12, 2.14, 2.15 → 2.8 → 2.10 → 2.11. 2.8 and 2.10 can proceed on a separate branch from the login work.

---


---

### Phase 3 — Core workflow API integration

**Goal:** leads, visits, attendance, users, teams, projects, roles, messages served from Postgres.

| # | Task | Notes |
|---|------|-------|
| 3.1 | `leadsRepository` + all 6 lead routes | Copy the listings pattern exactly |
| 3.2 | `visitsRepository` + all 5 visit routes | Include `listing_id` for match provenance |
| 3.3 | `attendanceRepository` + all 4 attendance routes | Enforce one open shift per staff per day |
| 3.4 | `usersRepository` + all 6 user routes | |
| 3.5 | `teamsRepository`, `projectsRepository` | |
| 3.6 | `rolesRepository` + matrix routes | **Audit every mutation** |
| 3.7 | `commsRepository` + all 4 thread/message routes | |
| 3.8 | `matchesRepository` + lead/listing match routes | Port `matchListings.js` to a server endpoint |
| 3.9 | Wire the `audit_log` INSERT inside every transaction | Before roles go live |
| 3.10 | Move the store off direct seed imports onto the repository | The structural change that makes everything else possible |
| 3.11 | Add a `matches` adapter to `apiRepository` (currently listings-only) | |
| 3.12 | Add loading and error states to every view | `LoadingState` exists and is unused |
| 3.13 | Add `version` columns for optimistic concurrency | |
| 3.14 | Persist `currentUser` from the session; delete the hardcoded `'u-admin'` | |

**Acceptance criteria**
- Every route in §1.3 is DB-backed; no 501s on the daily-use path.
- Every mutation writes exactly one audit row, in the same transaction.
- Every route has both a matrix gate and a row-level check.
- Every vertical passes the same cross-tenant and existence-hiding tests the listings suite has.
- The app runs on a real backend with the demo seed as its data — same UI, real persistence.
- A reload does not lose data.

**Risks**
- Step 3.10 is a large refactor with a real chance of regression. Mitigation: keep `demoRepository` selectable; ship behind a flag; run both in parallel during the transition.
- Audit coverage gaps in 3.6 (roles) are high-severity. Do 3.9 before 3.6.
- No loading states means the UI will look broken during the transition. Do 3.12 with 3.1, not after.

**Order:** 3.9 (audit infra) → 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 3.8 → 3.10 → 3.11 → 3.12 → 3.13 → 3.14.

---

### Phase 4 — File storage and offline sync

**Goal:** real media, real blobs, real sync.

| # | Task | Notes |
|---|------|-------|
| 4.1 | Provision the bucket; set lifecycle and tenant-prefix policies | |
| 4.2 | `presign` endpoints for site + listing photos | Metadata-only today |
| 4.3 | Thumbnail + EXIF-strip worker | EXIF stripping is a security requirement |
| 4.4 | `GET /photos/:id/url` — presigned GET, ≤ 900 s, audited | |
| 4.5 | Implement `POST /sync` with per-item permission re-check and a server-side idempotency store | The trust boundary |
| 4.6 | Route every sync worker handler at the real API | Currently validation only, no network |
| 4.7 | IndexedDB blob store for offline photos | |
| 4.8 | Conflict resolution using `version` / `If-Match` | |
| 4.9 | Wire `startAutoSync()`; add a failed-items list with retry | |
| 4.10 | Fix `/photos:presign` route path | |
| 4.11 | Decide and implement (or explicitly decline) attendance selfies | Decide with HR first |
| 4.12 | Service-worker Background Sync as an optimisation only | Not a dependency — iOS lacks it |

**Acceptance criteria**
- A photo uploaded offline survives an app restart and syncs later.
- EXIF GPS tags are absent from stored objects.
- A presigned URL expires within 900 s and its issuance is audited.
- A queued action whose permission was revoked is refused and marked failed, with no server mutation.
- Replaying a queue item twice creates exactly one server-side row.
- A concurrent edit returns `409` rather than silently overwriting.
- Sync status survives a reload and lists failures.

**Risks**
- Presigned URL lifetime is a direct security control. Too long = a shared link is effectively permanent.
- Blob persistence hits device storage limits. Mitigation: `navigator.storage.persist()`, visible quota warnings, and a graceful degrade to "re-pick on sync".
- Conflict resolution is easy to get subtly wrong. Mitigation: prefer prompting the user over auto-merging.
- Background Sync is Chromium-only; the manual path must remain the guarantee.

**Order:** 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 → 4.9 → 4.10 → 4.11 → 4.12.

---

### Phase 5 — Reporting and notifications

**Goal:** management visibility and push.

| # | Task | Notes |
|---|------|-------|
| 5.1 | Lead status history table | Required for real conversion reporting |
| 5.2 | Pipeline / funnel report | |
| 5.3 | Inventory-by-category report | Cheapest; index from §4.3 first |
| 5.4 | Field productivity + attendance punctuality | |
| 5.5 | Visit conversion + match-to-visit conversion | The metric that justifies the matching feature |
| 5.6 | Overdue follow-ups | |
| 5.7 | Read replica routing for reports | |
| 5.8 | `export_jobs` worker + CSV generation | Async, rate-limited, audited |
| 5.9 | `notifications` table + in-app notification centre | |
| 5.10 | Transactional email (visit reminders, export-ready) | |
| 5.11 | Web Push + service-worker `push` handler | After iOS install requirements are understood |
| 5.12 | `call_logs` + call logging UI | |
| 5.13 | Message templates | Prerequisite for WhatsApp Business API |
| 5.14 | Report UX: date ranges, saved filters, export affordances | |

**Acceptance criteria**
- Every report respects RBAC scope in SQL, not in the client.
- A field executive's productivity report contains only their own data.
- Exports are async, rate-limited, scoped, and audited.
- A user can see why they were notified, from a persistent in-app list.

**Risks**
- Reports on the primary database will degrade the product for everyone. Read replica is not optional at scale.
- Lead status history is a schema change that must land *before* real data accumulates, or conversion reporting is permanently wrong for existing leads.

**Order:** 5.1 → 5.3 → 5.2 → 5.4 → 5.5 → 5.6 → 5.7 → 5.8 → 5.9 → 5.10 → 5.12 → 5.11 → 5.13 → 5.14.

---

### Phase 6 — Hardening and launch

**Goal:** the product is safe to run daily with real money and real people involved.

| # | Task | Notes |
|---|------|-------|
| 6.1 | Full pass of [SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) — 10 sections, sign-off matrix | This document is the launch gate |
| 6.2 | `@fastify/rate-limit` keyed on user id; wire the existing `RATE_LIMIT_*` config | Currently dead config |
| 6.3 | `@fastify/helmet`; HSTS, CSP, `X-Content-Type-Options` | |
| 6.4 | JSON-Schema validation on every route; expose OpenAPI | Ajv already ships inside Fastify |
| 6.5 | Field-level response stripping (e.g. accounts must not see GPS) | Designed, not implemented |
| 6.6 | Fix the `scopeFilterFor` unescaped table interpolation | Safe today (single literal caller); a trap for the next caller |
| 6.7 | Replace `Math.random()` request ids with `crypto.randomUUID()` | Low entropy, written into audit metadata |
| 6.8 | Audit-log HMAC signing + append-only DB grants | |
| 6.9 | RLS + composite FK verification in staging with a second tenant | |
| 6.10 | Focus management, ARIA, keyboard nav across all drawers/modals | |
| 6.11 | List virtualization | At thousands of records |
| 6.12 | Bundle splitting; pin dependencies; resolve `npm audit` highs | |
| 6.13 | CI/CD pipeline with the deploy gates from §9.3 | |
| 6.14 | Backup, restore drill, runbook | Untested backup is not a backup |
| 6.15 | Observability: Sentry, structured logs, uptime probe, DB alerts | |
| 6.16 | Load test at realistic volume (2 000 leads, 500 listings, 50 concurrent) | |
| 6.17 | Data export / tenant offboarding path | Legally required in most jurisdictions |
| 6.18 | Pilot with 3–5 real users for 2 weeks before broad rollout | |

**Acceptance criteria**
- Every section of the security checklist passes with a documented test.
- A second tenant exists in staging and no cross-tenant read is possible through any route, any parameter, or a forged token.
- Restore from backup verified end-to-end.
- Load test meets the agreed latency target at 2× expected peak.
- A 2-week pilot with real users produces no P0 or P1 defect.

**Risks**
- This phase is where real-world problems surface. Do not compress it to hit a date.
- The pilot is the single highest-value item here and the easiest to skip. Do not skip it.

**Order:** 6.2, 6.3, 6.4, 6.6, 6.7 → 6.1 (partial, re-run after each) → 6.5 → 6.8 → 6.9 → 6.13, 6.14, 6.15 → 6.16 → 6.10, 6.11, 6.12 → 6.17 → 6.18 → final 6.1 pass and sign-off.

---

## 11. What this roadmap does not include

- **Payments or billing.** Out of scope. The `Booking` and `Token Paid` lead statuses are workflow labels, not money movement.
- **WhatsApp Business API integration.** Deferred past Phase 5; requires approved templates and a business account.
- **A public MLS / external feed ingestion.** Deferred.
- **A native mobile app.** The PWA is the target. Re-evaluate only if field staff need background location or offline video.
- **An ML match model.** The deterministic scorer is documented as such and works. Revisit with real data.
- **Multi-language / i18n.** Not required for the initial market.

---

## 12. Cross-references

| Document | Covers |
|----------|--------|
| [docs/BACKEND_SCAFFOLD_STATUS.md](BACKEND_SCAFFOLD_STATUS.md) | What is wired in `server/` today |
| [docs/DATA_MODEL.md](DATA_MODEL.md) | Field-level data shapes |
| [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md) | Auth and tenant design |
| [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) | Middleware and per-role examples |
| [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md) | Auth endpoint contract |
| [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) | The launch gate — 10 test sections |
| [docs/ENVIRONMENT.md](ENVIRONMENT.md) | Env var matrix per environment |
| [docs/PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md) | Operational go-live checklist |
| [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md) | Queue API contract |
| [docs/PWA_OFFLINE_PLAN.md](PWA_OFFLINE_PLAN.md) | Offline design |
| [docs/SYNC_WORKER_PLAN.md](SYNC_WORKER_PLAN.md) | Sync worker design |
| [docs/LISTINGS_MODULE.md](LISTINGS_MODULE.md) | The reference vertical implementation |
| [docs/LEAD_LISTING_MATCHING.md](LEAD_LISTING_MATCHING.md) | Lead ↔ listing matching |
| [server/README.md](../server/README.md) | Backend runbook |
