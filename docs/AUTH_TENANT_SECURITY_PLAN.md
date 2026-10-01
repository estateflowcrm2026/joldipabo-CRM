# EstateFlow CRM — Auth, Tenant & Security Plan

Date: 2026-09-24 (Phase 3: password hashing, login, sessions, lockout implemented)

Status: **auth flow implemented.** Passwords are hashed with Argon2id, `POST /auth/login` issues a real token pair, refresh tokens rotate with reuse detection, and accounts lock out after repeated failures. **Still open:** MFA, invite/password-reset/OTP flows, notification emails, composite tenant FKs, and RLS. Read alongside [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md), [docs/DATA_MODEL.md](DATA_MODEL.md), [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md), [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md), and [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md).

> ## What is implemented (as of 2026-09-24)
>
> - **Argon2id password hashing** at OWASP-minimum parameters, stored in self-describing PHC format. Malformed hashes fail closed; every failure path spends the same verification cost so response timing leaks nothing.
> - **`POST /auth/login`** — tenant + email + password, one indistinguishable 401 for every failure mode, session created, access and refresh tokens issued.
> - **Refresh rotation with reuse detection** — one `family_id` per login chain; replaying a rotated token revokes the whole family and stamps `compromised_at`.
> - **`POST /auth/logout`, `/auth/logout-all`, `GET /security/sessions`** and an admin unlock endpoint.
> - **Account lockout** — 5 failures locks a known account for 15 minutes; 10 locks an identifier for the tenant; both counters clear on success.
>
> ## What is NOT implemented
>
> - **MFA / TOTP.** Required for admin and super-admin before launch; not started.
> - **Invite, accept-invite, forgot/reset password, OTP.** All still 501. This means there is no way to onboard a real user yet — a real blocker for onboarding anyone outside the seed.
> - **Notification emails.** `compromised_at` is recorded but nothing sends mail, so a user whose session family was revoked for reuse is not told.
> - **Password breach-list and reuse checks.** `isBreachSafe` and `isReuseAllowed` return `true` unconditionally.
> - **Gateway rate limiting.** The per-account lockout is in-app; there is no per-IP limit. See the deployment requirement in the roadmap.
> - **Composite tenant FKs and RLS.** See §23 — RLS is still not installed.
> - **Audit rows for auth events.** Login, refresh, logout and lockout are not yet written to `audit_log`.

The current demo ([src/data/seed.js](../src/data/seed.js), [src/state/store.jsx](../src/state/store.jsx)) assumes a single-tenant world. The role switcher that simulated roles is now gated behind `VITE_ENABLE_DEMO_ROLE_SWITCHER` and is absent from production builds.

---

## 1. Multi-tenant model

EstateFlow is a multi-tenant SaaS CRM. Each tenant is an estate / developer organisation; users belong to exactly one tenant at a time. Tenant boundaries are enforced **server-side, in every query, on every endpoint** — never via a `tenantId` field in the request body that the client could forge.

### Tenancy strategy: shared schema, `tenantId` column on every row

For v1 we use a **shared schema with a `tenantId` foreign key** on every domain table (users, roles, teams, projects, leads, visits, attendance, photos, threads, messages, audit log). The rationale:

- The data model is already relational and joins-heavy (lead → visit → attendance → photo all pivot on `projectId`, `ownerId`, `teamId`). A row-level isolation strategy plays well with Postgres RLS and is operationally simpler than schema-per-tenant.
- Schema-per-tenant would force per-tenant migrations and per-tenant connection pools; the team size doesn't justify that.
- Tenant isolation is enforced by a Postgres Row-Level Security policy that requires `current_setting('app.tenant_id')` to equal the row's `tenant_id`, set by the connection pool at the start of every request.

### What gets a `tenantId`

Every domain row carries `tenantId`. The `users` table is the join anchor: a user's `tenantId` is the tenant they belong to. Roles, teams, and projects are tenant-scoped.

### What does NOT get a `tenantId`

- Global lookup tables (none today; if we add `currencies` or `countries` later they will be tenant-less).
- The audit log is tenant-scoped — super-admin cross-tenant audit queries go through a separate, gated `/api/v1/admin/audit` endpoint that uses a privileged role.

### Tenant resolution

The client never picks a tenant. Resolution order:

1. The access token's `tid` claim identifies the tenant.
2. If the access token is missing or expired, the user is on the login screen — the request URL has a tenant slug (`/t/acme/login`) that scopes the login form to that tenant.
3. If the URL has no tenant slug and the user's email matches a single tenant, redirect to `/t/<slug>/login`. If it matches multiple tenants (rare; e.g. super-admin), the user picks from a tenant chooser.

### Subdomain vs path slug

`acme.estateflow.app` vs `app.estateflow.app/t/acme`. v1 ships **path-based tenancy** (`/t/:slug/...`) because:

- It works on localhost and on preview deployments without DNS work.
- It is unambiguous in logs (one URL = one tenant).
- Wildcard SSL certificates are not always available to early customers.

Subdomain tenancy is a v2 option and is documented here so the URL shape doesn't lock us out of it.

---

## 2. Company / organisation / branch structure

A tenant is an **organisation** (the legal entity — the developer). Inside an organisation:

| Concept | Role | Notes |
| --- | --- | --- |
| **Organisation** | The tenant itself. Owns billing, SSO config, audit log retention, the org-level security policy. | Exactly one per tenant. |
| **Branch** | A regional / project-cluster subdivision. Sales teams and field staff are usually attached to a branch. | 1..N per organisation. Branches are not a primary isolation boundary — same tenant, same data — but they are useful for regional reporting and routing. |
| **Team** | A working unit inside a branch (sales team, marketing team, accounts team). Drives the `team` scope check. | 1..N per branch. |
| **Project** | A development site. Drives the `project` scope check. | 1..N per organisation. Cross-branch: a project belongs to the org, not a branch. |
| **Role** | A bundle of permissions (`permissionMatrix`). Eight seeded roles today ([src/data/permissions.js](../src/data/permissions.js)). | 1..N per organisation; `super-admin` and `admin` are system-defined and cannot be deleted. |

### Field additions to the data model

```text
organisation
  id              string  primary key
  slug            string  unique, URL-safe, lowercase  (e.g. 'acme')
  name            string
  status          enum    Active | Suspended | Trial
  billing_plan    string
  created_at      timestamptz

branch
  id              string  primary key
  tenant_id       string  foreign key -> organisation
  name            string
  region          string
  manager_id      string  foreign key -> users (nullable)
  created_at      timestamptz

user (additions to docs/DATA_MODEL.md Users)
  tenant_id       string  foreign key -> organisation
  branch_id       string  foreign key -> branch (nullable)
  status          enum    Active | Inactive | On Leave | Invited | Suspended
  invited_at      timestamptz (nullable)
  invite_token    string  (nullable; see §4)
  invite_expires_at timestamptz (nullable)
  password_hash   string  (Argon2id; see §6)
  password_changed_at timestamptz
  failed_login_count integer default 0
  locked_until    timestamptz (nullable)
  mfa_enabled     boolean default false
  mfa_secret      string  (encrypted at rest; see §7)
  last_login_at   timestamptz (nullable)
  deleted_at      timestamptz (soft delete; see §18)
```

Branches and organisations are **not** in the frontend seed today. The data-model doc grows them in the next revision; this design treats them as the right granularity even before the UI surfaces them.

---

## 3. User identity model

A user is identified by:

1. **`email`** — primary login identifier. Unique within a tenant (`UNIQUE (tenant_id, email)`).
2. **`phone`** (optional, E.164) — used for OTP login and SMS notifications.
3. **`user.id`** — server-generated ULID, opaque to the client, used as the foreign key everywhere.

The user has:

- Exactly one **role** at a time (`roleId`). Roles live in `permission_matrices` and are read on every request.
- Exactly one **team** at a time (`teamId`). Reassignment is via `PATCH /api/v1/users/:id`.
- Zero, one, or many **project** memberships (`project_members` join table).
- Exactly one **branch** (`branchId`), used for region scoping (does not enforce isolation).

`permissionMatrix` may live on the role (default), the user (override), or both (user overrides win). Server reads the user's effective matrix as `merge(role.matrix, user.matrix)` using the same `mergeMatrix` helper in [src/data/permissions.js](../src/data/permissions.js).

### Status transitions

```
Invited ─► Active ─► Inactive ─► Active
   │           │                      
   ▼           ▼                      
 Expired     On Leave ─► Active       
             Suspended ─► Active (admin only)
             Deleted (soft delete, see §18)
```

- **Invited** — the user has a valid `invite_token` but has never accepted. No login possible.
- **Active** — fully operational.
- **On Leave** — login disabled; data visible per scope (manager still sees their team).
- **Inactive** — same as On Leave; can be flipped to Active by an admin.
- **Suspended** — login disabled; data hidden from non-admin viewers; appears in the staff list with a "Suspended" badge.
- **Deleted** — soft delete (`deleted_at` set); excluded from every query; see §18.

---

## 4. Staff invitation flow

Admins invite staff via `POST /api/v1/auth/invite`. The flow:

1. Admin submits `{ email, roleId, teamId, branchId, projectIds, designation, phone }`.
2. Server creates the user row in `Invited` status with a random `invite_token` (32 bytes, base64url).
3. Server queues a transactional email with a link: `https://app.estateflow.app/t/<slug>/accept-invite?token=<token>`.
4. The user clicks the link. The frontend POSTs to `/api/v1/auth/accept-invite` with `{ token, password, displayName }`.
5. Server validates the token (not expired, not used, status is `Invited`), sets `password_hash`, `password_changed_at`, flips status to `Active`, clears `invite_token`.
6. User is logged in (see §7).

### Token rules

- `invite_token` is single-use. Once consumed, the user row's `invite_token` is set to `NULL`.
- `invite_expires_at` defaults to **7 days** after issue.
- Resend: admins can re-invite an existing `Invited` user; this rotates the token and extends `invite_expires_at`.
- For a user who was Active and is being re-inited to a new role/team: not done via invite — the admin updates via `PATCH /api/v1/users/:id`. Invites are only for new accounts.

### What the user sees before accepting

- A login form for the tenant slug; the user types the email; the form reveals "We sent you an invite — check your inbox" if the email is in `Invited` status.
- A "Resend invite" link if the original invite is older than 24 hours (rate-limited to 1/hour/email).

---

## 5. Login methods

v1 supports three login methods:

| Method | Who uses it | Requires |
| --- | --- | --- |
| **Email + password** | All roles. Default for desktop users. | `password_hash` set. |
| **Email + password + TOTP MFA** | Optional for everyone; **required** for `super-admin` and `admin`. | `mfa_enabled = true`. |
| **Phone + OTP** | Field executives and telecallers who frequently switch devices. | `phone` set; OTP via SMS or WhatsApp. |

Email + password is the canonical login; the other two are layered on top. A user with MFA enabled must complete the second factor after the password is verified, before the access token is issued.

A single endpoint family covers all three: `POST /api/v1/auth/login` always validates email + password first; if MFA is enabled, the response is `{ status: 'mfa_required', mfaToken }` and the client calls `POST /api/v1/auth/verify-otp` (with method `totp`) to complete. Phone + OTP uses `POST /api/v1/auth/request-otp` followed by `POST /api/v1/auth/verify-otp` (with method `sms`).

### "Login as user" is **not** supported in v1

The frontend's `setCurrentUser` viewer-switcher exists for the demo only. Production removes it. The super-admin can still impersonate a user via `POST /api/v1/auth/impersonate` (see §14), but the demo's free-for-all role switcher is gone the day auth lands.

---

## 6. Password policy

Argon2id is the only allowed password hash. Parameters:

- Memory: **64 MiB** minimum.
- Iterations: **3** minimum.
- Parallelism: **1**.
- Hash output: 32 bytes.

### Policy

- Minimum **10 characters**, no maximum.
- No composition rules (no "must contain a number"); length + breach-list check is enough.
- Check against the **HIBP top-100k common passwords** list at registration and on every password change. Hash the candidate with SHA-1 client-side and check the **k-anonymity** API (`/range/{first5}`) — never send the full password to a third party.
- Re-use check: refuse if the new password matches the last **5** password hashes for the user.
- Forced rotation: **none**. NIST 800-63B removed rotation; we follow.

### Storage

- Password hash lives in `users.password_hash`. No plaintext, no reversible encryption.
- The hash is **never** returned by any endpoint, including `GET /api/v1/users/:id` for admins. Admins see "password set at <timestamp>" but never the hash.

### Forgotten passwords

See §5's `POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password`. The flow:

1. User submits `{ email }`.
2. Server always responds `200 OK` (regardless of whether the email exists) — this prevents email enumeration. Internally, if the user exists, it queues a reset email with a single-use `reset_token` (1-hour expiry).
3. The reset link is `https://app.estateflow.app/t/<slug>/reset-password?token=<token>`.
4. The user submits `{ token, newPassword }`; server validates the token, sets the new hash, increments `password_changed_at`, **invalidates all refresh tokens** for that user, and notifies the user by email.

---

## 7. Optional OTP login for field staff

Field executives and telecallers work in environments where typing a long password on a phone is friction. We support **phone + OTP** as an alternative first factor.

### Request OTP

`POST /api/v1/auth/request-otp`:

- Body: `{ phone, tenantSlug }`.
- Server: looks up the user by `(tenant_id, phone)`; if found and not locked, generates a **6-digit numeric OTP**, stores it in `otp_codes(phone, code_hash, expires_at, attempts, ttl=300)` (5-minute TTL), and sends via the user's preferred channel (SMS by default; WhatsApp if the user's `phone` is registered with the WhatsApp Business API).
- Rate limits: **1 OTP per 60 s per phone**, **5 OTPs per phone per day**.

### Verify OTP

`POST /api/v1/auth/verify-otp`:

- Body: `{ phone, code, tenantSlug }`.
- Server: validates the OTP hash, increments `attempts`, returns either:
  - 200 with `{ accessToken, refreshToken, user }` on success, OR
  - 401 on invalid/expired/exhausted code.
- **5 wrong attempts** within the 5-minute window locks the OTP slot for 30 minutes and triggers an email to the user ("Someone tried to log in to your account").

### TOTP MFA (separate flow)

When a user has `mfa_enabled = true`, the verify-otp endpoint with `method: 'totp'` accepts a TOTP code (RFC 6238, 30-second window, SHA-1, 6 digits). The `mfa_secret` is generated at MFA enrolment and shown to the user exactly once with QR + recovery codes.

### Recovery codes

On MFA enrolment, the user receives **8 single-use recovery codes** (8 bytes each, base32). These bypass MFA when TOTP is unavailable. Each code is hashed and stored; one is consumed per use. The user is prompted to regenerate when fewer than 3 remain.

---

## 8. Session model

A "session" is the lifetime of a refresh token issued at login. The client holds:

- **Access token** — short-lived (15 min default), JWT, sent as `Authorization: Bearer <jwt>` on every API call. Holds the claims the server needs to authorize without a DB hit per request.
- **Refresh token** — long-lived (7 days default for desktop, 30 days for mobile PWA), opaque random string (32 bytes, base64url), stored server-side in `refresh_tokens` with a hashed representation. Used to mint new access tokens.

The pair is **rotated**: every refresh issues a new access token **and** a new refresh token, retiring the previous one. This limits the blast radius of a stolen refresh token.

### Storage

| Token | Browser localStorage | Mobile PWA IndexedDB |
| --- | --- | --- |
| Access token | yes (in memory + a `sessionStorage` mirror so a tab refresh keeps it) | in memory only |
| Refresh token | **HttpOnly, Secure, SameSite=Strict** cookie set by the backend | **IndexedDB** (encrypted at rest with a per-device key derived at install; see [docs/PWA_OFFLINE_PLAN.md §9](PWA_OFFLINE_PLAN.md)) |

The browser cookie path keeps the refresh token out of JS reach (XSS-resistant). The IndexedDB path is required because the mobile PWA cannot rely on cookies when the app is installed standalone.

### Single-session vs multi-session

A user may have multiple sessions (desktop + mobile + tablet). Every login creates a new `refresh_tokens` row; the user can list and revoke them at `GET /api/v1/security/sessions` and `DELETE /api/v1/security/sessions/:id`. "Sign out everywhere" is `POST /api/v1/auth/logout-all`.

---

## 9. JWT + refresh token flow

### Access token shape (JWT, HS256 → RS256 in v1.1)

```json
{
  "sub": "u_01HX...",
  "tid": "org_acme",
  "bid": "br_bangalore",
  "role": "sales-manager",
  "iat": 1737000000,
  "exp": 1737000900,
  "jti": "at_01HX..."
}
```

- `sub` — user id.
- `tid` — tenant id; required.
- `bid` — branch id; optional.
- `role` — current role id; **advisory**. The server re-reads the role from the database on every request to honor permission-matrix edits immediately (see [docs/BACKEND_INTEGRATION_PLAN.md §3](BACKEND_INTEGRATION_PLAN.md)).
- `iat`, `exp` — issued/expiry (15-minute lifetime).
- `jti` — unique access-token id; logged for audit but not otherwise used (the access token is verified by signature + `tid` claim).

### Refresh token shape

```json
{
  "id": "rt_01HX...",
  "user_id": "u_01HX...",
  "tenant_id": "org_acme",
  "device_fingerprint": "...",
  "created_at": "...",
  "expires_at": "...",
  "last_used_at": "...",
  "revoked_at": null
}
```

Stored hashed (SHA-256) in `refresh_tokens.token_hash`. The plaintext token is only ever held by the client.

### Endpoints

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /api/v1/auth/login` | `{ email, password, tenantSlug }` | On success: `{ accessToken, refreshToken, user, requiresMfa? }`. On MFA: `{ status: 'mfa_required', mfaToken }`. |
| `POST /api/v1/auth/refresh` | `{ refreshToken }` | `{ accessToken, refreshToken }` (rotated). |
| `POST /api/v1/auth/logout` | `{ refreshToken }` | Revokes the supplied refresh token. 204. |
| `POST /api/v1/auth/logout-all` | (auth required) | Revokes every refresh token for the user. 204. |
| `GET /api/v1/auth/me` | (auth required) | `{ user, role, permissionMatrix, tenant, branch }`. |

### Refresh rotation security

When a refresh token is presented:

1. Look up the token by hash.
2. If not found, **revoke all refresh tokens for that user** (the token was either tampered with or stolen-and-revoked; treat it as a credential leak).
3. If found and `revoked_at` is not null, this is a **replay attack**: revoke all tokens for the user and notify by email.
4. If found and not expired, mark `revoked_at = now()`, issue new pair.

Step 2 + 3 makes refresh-token theft detectable: a legitimate client never sees a revoked token, so any replay is an attack.

### Clock skew tolerance

Allow ±2 minutes of clock skew on `exp` validation. Larger skews cause false-expired tokens; smaller skews cause stale tokens to be accepted. Document in the API spec.

---

## 10. Device trust model

A "device" is a single browser or installed PWA instance. We track devices so the user can see "Where you're signed in" and so an admin can revoke a lost phone.

### Device fingerprint

A device fingerprint is a salted SHA-256 of:

- `User-Agent`
- `Accept-Language`
- `Sec-CH-UA` (where available)
- Screen size + pixel ratio
- Installed-PWA flag (`navigator.standalone` or `display-mode: standalone`)

The fingerprint is **advisory**, not authoritative. We don't block logins on fingerprint mismatch — devices change (browser updates). We use it to flag "unusual device" emails.

### Trusted device

A device becomes "trusted" when the user explicitly opts in (checkbox on the MFA verify screen). Trusted devices skip OTP for 30 days. Untrusted devices always require OTP.

### Lost device

The user reports a lost device in `GET /api/v1/security/sessions` → click "Revoke". The server revokes the session row and emails the user. The user can also click "Sign out everywhere" to revoke everything.

---

## 11. Role and permission enforcement

Two layers. **Server-side is authoritative**; **client-side is advisory**.

### Server side

The middleware reads `req.user` (set by the auth middleware after JWT verification), looks up the role's matrix, and exposes a `req.can(resource, action, record)` helper that mirrors the frontend's [src/data/permissions.js `can()`](../src/data/permissions.js) function. The middleware refuses the request with `403 Forbidden` if `can()` returns false.

Every endpoint declares its `(resource, action)` pair explicitly via route metadata. The middleware does **not** infer it from the URL — a single endpoint can serve multiple actions (e.g. `GET /api/v1/leads/:id` is `leads.view`; `PATCH /api/v1/leads/:id` is `leads.edit`).

The SQL helper `filter_by_scope(user, resource, action, base_query)` injects a `WHERE` clause that limits the rows to what the user can see. See [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) §3 for the exact predicate.

### Client side

The frontend continues to gate UI with [src/data/permissions.js](../src/data/permissions.js). The gating is now **advisory**: it hides buttons, but every action still goes through the API and the server re-checks. This is defence in depth, not the security boundary.

The frontend should not be able to call mutating endpoints the user doesn't have permission for. If a button exists, the action will succeed server-side; if it doesn't, the button is hidden.

---

## 12. Server-side scope checks

The scope resolver runs on every request, before the handler. Pseudocode:

```js
// load user with role + matrix once per request
const user = await loadUserWithRole(req.user.id, req.user.tid);

// resolve action from route metadata
const { resource, action } = routeMeta(req.route);

// coarse check
if (scopeOf(user, resource, action) === 'none') return forbid();

// record-level check (if the handler is operating on a specific row)
if (req.record) {
  if (!can(user, resource, action, req.record)) return forbid();
}

// list-level: inject SQL
if (req.listQuery) {
  req.listQuery.where = andWhere(req.listQuery.where, scopeFilter(user, resource, action));
}
```

The `scopeFilter` SQL helper is documented in detail in [docs/RBAC_SERVER_ENFORCEMENT.md §3](RBAC_SERVER_ENFORCEMENT.md).

---

## 13. Audit logging

Every mutating endpoint writes one row to `audit_log` in the **same transaction** as the mutation. The frontend's `ACTIVITY` collection ([src/data/seed.js](../src/data/seed.js)) becomes the read-side view of this log.

### What gets audited

- All `POST`, `PATCH`, `DELETE` on `/api/v1/*` (except `auth/login` failures — those go to a separate security log; see §15).
- All `auth/logout`, `auth/logout-all`, `auth/invite`, `auth/accept-invite`, `auth/reset-password`, `auth/impersonate`.
- All `security/sessions` revocations.
- Read access to **photo URLs** (the signed-URL endpoint writes a row when the URL is opened, so we know who looked at which photo when).
- Read access to **lead phone numbers** is **not** audited at row level; it would be too noisy. Admin impersonation events are audited.

### Audit row shape

```json
{
  "id": "au_01HX...",
  "tenant_id": "org_acme",
  "user_id": "u_01HX...",
  "action": "approved-photo",
  "entity": "photo",
  "entity_id": "ph_01HX...",
  "metadata": {
    "before": { "approved": false },
    "after": { "approved": true },
    "ip": "203.0.113.42",
    "user_agent": "...",
    "request_id": "req_01HX...",
    "permission_path": "photos.approve"
  },
  "timestamp": "2026-09-19T12:34:56Z"
}
```

### Tamper evidence

Per [docs/BACKEND_INTEGRATION_PLAN.md §6](BACKEND_INTEGRATION_PLAN.md), the audit log is append-only with database-role-level enforcement. v1 also stores an HMAC of `(tenant_id, user_id, action, entity, entity_id, timestamp, metadata)` using a key in KMS (not the application). The HMAC is computed inside the same transaction; an HMAC mismatch indicates a tampered row.

### Retention

- Financial / booking events: **7 years** (RERA requirement in India; GDPR retention principle for EU).
- Operational events: **2 years**.
- A nightly job archives older rows to cold storage (S3 Glacier).

---

## 14. Location privacy

GPS data is captured for attendance and visits. The data is sensitive because it can leak home addresses, family patterns, and movement outside work hours.

### What is captured

- `checkInLocation`, `checkOutLocation` on attendance records: `{ label, lat, lng, accuracy }`.
- `geo` on photos: `{ lat, lng }` (set by the client at capture time; server may strip EXIF GPS to fail safe).
- `geo` on leads: optional home/office location (the customer's, not the staff's).

### Who can see it

| Audience | What they see |
| --- | --- |
| The staff member themselves | Always. |
| The staff member's direct manager (`team` scope on `staff`) | Always. |
| The site manager of the project (`project` scope on `staff` if they have staff.view) | Only when the staff was on-site at one of their projects. |
| `super-admin`, `admin` | Always. |
| `accounts` | Never. Accounts have `attendance.view: 'all'` but the response payload strips `*Location` for accounts unless the row's `staffId === accounts.id`. |
| All others | Never. |

### Storage

- Stored at full precision (6 decimal places ≈ 11 cm) on the source row.
- The audit log records the **rounded** location (3 decimal places ≈ 110 m) so the audit log itself isn't a tracking database.
- The audit log never stores the IP-derived geo (it can be wrong + it's an unnecessary linkage).

### Server-side enforcement

The middleware checks `permCan(user, 'attendance', 'view', record)` AND a separate `locationVisibility(user, record)` predicate before returning a `*Location` field. The frontend never sees a location field it doesn't have permission for — the response is shaped server-side, not client-side.

### "Low GPS confidence" rule

If `accuracy > 100 m`, the row is created but a `metadata.lowGpsConfidence: true` flag is set. The frontend shows a "Low GPS confidence" badge. The data is still stored; admins can override.

---

## 15. Photo privacy

Photos are larger than other data and often contain identifying details (faces, license plates, interiors). They are stored in S3-compatible object storage; the row in `photos` holds only metadata + a key.

### Access model

| Action | Who can do it |
| --- | --- |
| Upload (`photos.create`) | Anyone with `photos.create: 'own'` or higher. The uploader is always `staffId = currentUser.id`. |
| View the photo (signed URL) | `photos.view` with scope check on the photo's project. The signed URL is short-lived (15 min default). |
| Approve / reject | `photos.approve` with scope check. |
| Delete | `photos.delete` with scope check. Soft delete; row kept, object removed from S3 after 30 days. |

### Server-side enforcement

The endpoint `GET /api/v1/photos/:id/url` (returns the signed URL) runs:

1. Load the photo.
2. `permCan(user, 'photos', 'view', photo)` → 403 if false.
3. Generate a presigned URL with `expires=15min`.
4. Write a `photo-url-issued` audit row.
5. Return the URL.

### EXIF stripping

The client strips EXIF before upload (per [docs/PWA_OFFLINE_PLAN.md §9](PWA_OFFLINE_PLAN.md)). The server also strips EXIF as a defence in depth — Lambda/worker triggered by S3 events removes any EXIF that slipped through, then re-uploads the object.

### Photo visibility flags

`photo.approved` is a flag (not a permission). It is set by a reviewer after upload. Until approved, the photo is visible to:

- The uploader.
- The uploader's manager.
- Site managers of the photo's project.

After approval, the photo becomes visible per the normal scope rules. **Photos are never public** — every read is a signed URL.

### Bulk download

There is no bulk-download endpoint. Photos must be requested one at a time. Admin tools for "download all photos for a project" exist in a separate, gated admin console and are audited as `bulk-photo-export`.

---

## 16. Data export restrictions

Data export is a sensitive operation. Three classes:

| Class | Endpoint | Who can use it |
| --- | --- | --- |
| Single-record CSV download (e.g. one lead) | `GET /api/v1/leads/:id/export.csv` | Anyone with `leads.export` permission (scoped). |
| Tenant-wide CSV (e.g. all leads) | `POST /api/v1/reports/leads/export` | Anyone with `leads.export: 'all'`. Async job; result is emailed. |
| Bulk raw data dump | `POST /api/v1/admin/export` | `super-admin` only. Async job. Result is delivered via signed URL that expires in 24 h. |

### Audit

Every export writes an audit row with `action: 'exported-<entity>'` and `metadata: { format, rowCount, filters }`. The bulk raw-data export adds `metadata: { ip, signedUrlExpiresAt }` and emails the tenant owner.

### Watermarking

Single-record CSV downloads add a `__exported_at` and `__exported_by` column. Bulk exports add a CSV trailer row with the same. There is no per-cell watermark in v1 (deferred — requires per-row HMAC and is expensive at scale).

### Rate limits

- Single-record: 30 / minute / user.
- Tenant-wide: 5 / hour / user.
- Bulk: 1 / day / tenant.

---

## 17. Admin impersonation policy

`super-admin` (and only `super-admin`) can impersonate another user via `POST /api/v1/auth/impersonate { userId, reason }`. The flow:

1. Server validates the requester's role is `super-admin`.
2. Server validates the reason is non-empty (free text; logged).
3. Server creates a short-lived (1-hour) impersonation session: a new access token + refresh token whose `sub` is the impersonated user, but a `impersonated_by: <super-admin-id>` claim is added.
4. The impersonator's UI shows a red persistent banner: "You are impersonating <name>. Reason: <reason>. [End impersonation]" (see the in-app banner from [docs/PWA_OFFLINE_PLAN.md §8](PWA_OFFLINE_PLAN.md)).
5. **Every API call during impersonation writes an audit row with `metadata.impersonatedBy: <super-admin-id>`** in addition to the normal audit row.
6. "End impersonation" calls `POST /api/v1/auth/end-impersonate` (returns to the original session).
7. **Impersonation cannot impersonate another `super-admin`** (prevents privilege escalation across super-admins).
8. **MFA is required** to start impersonation, even on a session that already passed MFA.

### Why explicit impersonation, not role-switching

The frontend's role-switcher ([src/state/store.jsx](../src/state/store.jsx) `SET_CURRENT_USER`) is a viewer convenience for the demo. The moment a real tenant has two admins, role-switching becomes a compliance problem: an admin who "switches to a sales rep" can edit leads without an audit trail tying the action to the admin. Real impersonation requires `reason`, MFA, banner, and audit; the role-switcher has none of these and is removed.

---

## 18. Account lockout policy

Failed-login tracking lives on the user row:

- `users.failed_login_count` — incremented on each bad password / bad OTP / bad TOTP.
- `users.locked_until` — set when the threshold is crossed.

### Thresholds

- **5** failed login attempts in a row → lock for **15 minutes**.
- **10** failed attempts in a row → lock for **24 hours** and email the user.
- **20** failed attempts in 24 hours → account suspended (`status = 'Suspended'`); admin must reactivate.

The counter resets to 0 on a successful login. The lock is **per-user**, not per-IP — an attacker rotating IPs still gets locked out.

### OTP-specific lockout

OTP attempts have their own counter in `otp_codes.attempts`. **5 wrong OTPs in 5 minutes** → OTP slot locked for 30 minutes + email the user.

### Admin override

An admin can unlock a user via `POST /api/v1/security/users/:id/unlock`. The action is audited as `unlocked-user`.

---

## 19. Secure logout

### Single-device logout

`POST /api/v1/auth/logout` with the current refresh token:

1. Server hashes the supplied refresh token.
2. Server finds the matching row and sets `revoked_at = now()`.
3. Server audits `logged-out`.
4. Client deletes the local access token (memory + sessionStorage) and the refresh-token IndexedDB entry (mobile) or relies on the cookie being expired (web — server can't actually expire an HttpOnly cookie; the client nukes its own copy).

### Sign-out everywhere

`POST /api/v1/auth/logout-all`:

1. Server sets `revoked_at = now()` on **every** `refresh_tokens` row where `user_id = req.user.id` AND `revoked_at IS NULL`.
2. Server audits `logged-out-all`.
3. Client behaves the same as single logout.

### Tab close / browser exit

The access token expires in 15 minutes anyway. The refresh token cookie expires when the cookie's `Max-Age` is reached (30 days for mobile, 7 days for web). Closing a tab doesn't invalidate the refresh token — the user must explicitly log out or click "Sign out everywhere".

### Server-side session timeout

If `refresh_tokens.last_used_at` is older than **30 days**, the row is marked expired and the user must re-authenticate. The "Remember me" checkbox on the login form extends this to 90 days; without it, the default is 30 days.

---

## 20. Token revocation

### Immediate revocation

- `POST /api/v1/auth/logout` — revokes a single refresh token.
- `POST /api/v1/auth/logout-all` — revokes all refresh tokens for the user.
- Admin `POST /api/v1/security/users/:id/revoke-sessions` — revokes all refresh tokens for the target user.
- Password change / reset — invalidates all refresh tokens for the user (per §6).
- Role change — does **not** invalidate refresh tokens; the new role takes effect on the next access-token refresh (15 min worst case). For immediate effect, the user or admin can call `logout-all`.
- Account suspension (`status = 'Suspended'`) — invalidates all refresh tokens; the user is forced to re-authenticate.

### Access token revocation

Access tokens are stateless JWTs and can't be revoked individually. The server checks `tid` + signature on every request, and a per-request DB load re-reads the user's `status`. If the user is `Suspended` or `Inactive`, the middleware refuses the request even if the JWT is valid. So the worst case is "15 minutes of access after suspension" — acceptable.

For tighter revocation (e.g. suspected credential leak), the server can maintain a `revoked_jti` set in Redis with the `jti` claim; the middleware checks the set on every request. This is not on by default (it kills the cache-friendly nature of JWT verification) but the design supports it.

---

## 21. Inactive staff handling

### What "Inactive" means

A user with `status = 'Inactive'` (or `On Leave`) cannot log in. Their data is **still visible** to managers and admins under the normal scope rules. They appear in the staff list with an "Inactive" badge.

### What they can and can't do

- Cannot log in (login middleware refuses).
- Cannot refresh tokens (refresh middleware refuses).
- Their open attendance records continue to be visible to their manager.
- Their leads continue to be visible to their team / project / all (per scope).
- An admin can flip them back to `Active` without losing data.

### Auto-inactivation

A nightly job flips users to `Inactive` if:

- `last_login_at` is older than **90 days**, AND
- The user has not been marked as a system account.

The user is emailed 7 days before the flip. Admins can opt out per-user ("Keep this user Active").

---

## 22. Deleted staff handling

### Soft delete

`DELETE /api/v1/users/:id` sets `deleted_at = now()`. The row is excluded from every read query (via a partial index + the `WHERE deleted_at IS NULL` clause that the `filter_by_scope` helper adds).

### What is preserved

- The user's audit log rows (we never delete history).
- Lead `createdBy`, photo `staffId`, attendance `staffId`, etc. — the user's id remains as a foreign key, but the row is hidden.
- Their assigned leads: on soft-delete, leads are **not** reassigned automatically. An admin must run "Reassign this user's leads" as a separate step.

### What is purged

- 30 days after `deleted_at`, a daily job:
  - Anonymises PII (replaces `name` with `Deleted user <id>`, blanks `email`/`phone`).
  - Hard-deletes the user's `refresh_tokens`, `password_reset_tokens`, `invite_tokens`, `otp_codes`, `mfa_recovery_codes`.
  - Keeps `audit_log` rows but with `user_id` pointing to a tombstone.

### Restore

Within 30 days, an admin can `POST /api/v1/users/:id/restore` to undo the soft delete and clear `deleted_at`. After 30 days, the user is gone; restore is not possible.

---

## 23. Tenant data isolation

> ### ⚠️ Current state: RLS is NOT installed
>
> Everything in this section describes the **design target**, not what the code does today. As of 2026-09-24:
>
> - No `CREATE POLICY` statement exists anywhere. The RLS block in [server/src/db/schema.sql](../server/src/db/schema.sql) is commented out.
> - `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is not executed.
> - `app.tenant_id` is **not** read by any policy, so setting it currently changes nothing.
>
> What *is* real: the application binds `tenant_id` from the authenticated user context on every query and passes it as a bound parameter (`scopeFilterFor` in [server/src/rbac/scopeFilters.js](../server/src/rbac/scopeFilters.js)). This is correct on the implemented listings path and absent on the verticals still returning 501.
>
> [server/src/db/client.js](../server/src/db/client.js) exposes `withTenant(ctx, fn)`, which issues `set_config('app.tenant_id', …, true)` inside a transaction so the value cannot leak across pooled connections. It is in place so that installing RLS is a migration-only change rather than a rewrite of every call site. **It is not a security control yet** — with no policy installed, it is a no-op.
>
> **Do not describe the system as RLS-protected until the migration below has run and its tests pass.**

### Rollout proposal (not yet executed)

RLS was deliberately **not** added silently, because a broad `ENABLE ROW LEVEL SECURITY` against untested queries fails closed and would take down the one vertical that currently works. The proposed sequence:

1. **Write the policies first, applied to nothing.** A `005-rls.sql` that creates the policies but does not enable RLS is a no-op and can ship safely.
2. **Add a second database role** (`app_rls`) that connects with RLS *enforced* for a parallel test run, so the same query suite runs twice — once as today, once under policy.
3. **Prove parity.** Every existing test must pass identically under both roles. Any divergence is a query that was relying on reading across tenants.
4. **Enable one table at a time**, starting with `listings` (the only vertical with a passing write suite).
5. **Add `CREATE INDEX CONCURRENTLY` support** to the runner before enabling policies on large tables, since policy creation takes locks.
6. Only then switch `DATABASE_URL` to the RLS-enforced role and delete the application-level `tenant_id` predicates, keeping `scopeFilterFor` for row-level (own/team/project) scoping, which RLS does not model.

Steps 2–3 are the ones that make this safe. A tenant-isolation boundary that has never been executed against a passing test suite is a claim, not a control.

### Design target

Every domain table has a row-level security policy:

```sql
CREATE POLICY tenant_isolation ON photos
  USING (tenant_id = current_setting('app.tenant_id')::text);
```

The middleware sets `app.tenant_id` at the start of every request:

```sql
SELECT set_config('app.tenant_id', $1, true);  -- true = local to transaction
```

This means **no query can leak across tenants**, even if the application code has a bug.

> The sentence above describes the design target. It is **not** true today — see the callout at the top of §23.

### Cross-tenant admin

A `super-admin` from tenant A can read tenant B's audit log only via the gated `/api/v1/admin/audit` endpoint, which uses a **separate database role** (`app_admin`) with RLS bypass. The application role never has the bypass; only the admin role does. Both roles are database users; the application selects which to use per request.

### Backup isolation

Backups are full-database (no per-tenant dumps in v1). Restores are full-tenant or whole-cluster. v2 will add per-tenant logical backups if customer requirements demand it.

---

## 24. Production security checklist

A pre-launch checklist of the most consequential items. Each item has a verification step.

### TLS

- [ ] TLS 1.3 enforced at the load balancer. TLS 1.2 disabled.
- [ ] HSTS header with `max-age=31536000; includeSubDomains; preload`.
- [ ] HTTPS-only cookies (`Secure` flag set).
- [ ] Certificate transparency monitoring enabled.

### Headers

- [ ] `Content-Security-Policy` set with a strict default-src. No `unsafe-inline`. No `unsafe-eval`. Strict nonce on every script tag.
- [ ] `X-Frame-Options: DENY`.
- [ ] `X-Content-Type-Options: nosniff`.
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`.
- [ ] `Permissions-Policy` disables camera, geolocation, microphone, payment, USB on pages that don't need them.
- [ ] `Strict-Transport-Security` set.

### CORS

- [ ] Allow-list of trusted origins. No wildcard.
- [ ] Preflight cache: `Access-Control-Max-Age: 600`.
- [ ] Credentials allowed only on the auth endpoints.

### Rate limits

- [ ] Login: 5 / 15 min / IP, 10 / 15 min / user, **hard cap** of 30 / hour / IP.
- [ ] Refresh: 30 / minute / user.
- [ ] OTP request: 1 / minute / phone, 5 / day / phone.
- [ ] OTP verify: 5 / 5 min / phone (then lock).
- [ ] Export: see §16.
- [ ] General API: 100 / minute / user for reads, 30 / minute / user for writes.

### Input validation

- [ ] Every endpoint has a JSON Schema (Fastify) or Pydantic (FastAPI) validator.
- [ ] Reject unknown fields (`additionalProperties: false` on JSON Schemas).
- [ ] All string inputs max-length-validated.
- [ ] Email format validated with a proper library, not a regex.
- [ ] Phone format validated against E.164.

### Output sanitisation

- [ ] HTML responses: server-side templating, not string concatenation.
- [ ] User-supplied text shown in the UI: stored as-is, rendered with React's default escaping (no `dangerouslySetInnerHTML`).
- [ ] User-supplied filenames in photo uploads: server validates against `^[a-zA-Z0-9._-]{1,255}$`.

### Logging

- [ ] No request bodies or response bodies in logs.
- [ ] No refresh tokens, password hashes, MFA secrets in logs (log scrubber at the logger level).
- [ ] PII (email, phone) redacted in logs by default; opt-in to include.
- [ ] Log shipping to a centralised store with retention matching the audit-log retention rules.

### Dependencies

- [ ] `npm audit` (or equivalent) clean before each release.
- [ ] Dependabot / Renovate enabled with weekly PR cadence.
- [ ] All backend deps pinned to a specific version in lockfile.
- [ ] No `latest` floating versions in production `package.json` (the demo uses `latest` for development convenience; release builds use exact pins).

### Backups

- [ ] Daily full backup, hourly incremental.
- [ ] Backup encryption at rest (KMS-managed key).
- [ ] Restore drill quarterly.
- [ ] Backup retention: 30 days hot, 1 year cold.

### Incident response

- [ ] On-call rotation defined.
- [ ] Runbook for credential leak (rotate signing keys, force password reset for affected tenant, notify users).
- [ ] Runbook for tenant data breach (notify within 72 h per GDPR; preserve audit log; legal/comms involvement).

### Compliance

- [ ] Data Processing Agreement in place for every customer.
- [ ] Privacy policy reflects actual data handling.
- [ ] Sub-processor list published.
- [ ] GDPR data-export endpoint (`GET /api/v1/admin/users/:id/data-export`) returns the user's full data set as a tarball.
- [ ] GDPR data-delete endpoint (`DELETE /api/v1/admin/users/:id/data`) deletes everything except financial records (legal retention).

---

## 25. Files referenced

- [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md) — stack, schema, endpoint list, migration path.
- [docs/DATA_MODEL.md](DATA_MODEL.md) — entities + fields.
- [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) — middleware, scope SQL, role-by-role examples.
- [docs/AUTH_API_SPEC.md](AUTH_API_SPEC.md) — endpoint-level auth contract.
- [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) — pre-launch tests.
- [docs/PWA_OFFLINE_PLAN.md](PWA_OFFLINE_PLAN.md) §9 — security & privacy for the mobile field-staff experience.
- [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md) §5 — public queue API (which the auth layer is built on top of).
- [docs/SYNC_WORKER_PLAN.md](SYNC_WORKER_PLAN.md) §3 — future `apiRepository` worker, including the Idempotency-Key header that the auth layer must support.
- [src/data/permissions.js](../src/data/permissions.js) — frontend permission model the backend mirrors.
- [src/state/store.jsx](../src/state/store.jsx) — frontend store; the auth layer replaces its current role-switcher with real impersonation.

---

## 26. Multi-factor authentication

Implemented 2026-09-27. TOTP (RFC 6238) with single-use hashed backup codes.

### Why a second factor is required rather than optional

`admin` and `super-admin` hold tenant-wide authority: every listing, every
user, every permission matrix. A password is a knowledge factor, and a
knowledge factor is exactly what credential-stuffing lists and phishing
campaigns supply in bulk. For those two roles the password is the only
thing standing between an attacker and every tenant on the platform.

`AUTH_MFA_ENFORCE=true` makes a production boot **fail** without it. That
is a hard stop rather than a warning because this codebase has twice
shipped a security control that looked configured and was not: a
transaction rollback that silently discarded a stolen-token revocation,
and an `ON DELETE SET NULL` cascade that made 38 of 42 audit rows report
as tampered. Both were green in the deploy log.

### Algorithm

Standards-compatible so ordinary authenticator apps work: HMAC-SHA1,
6 digits, 30-second step, issuer `Joldipabo CRM`, ±1 step of clock
drift. Implemented on `node:crypto` rather than a dependency — the
algorithm is about 30 lines of RFC 4226/6238 arithmetic and every TOTP
package would need `node:crypto` underneath anyway. Pinned against the
RFC test vectors in `server/src/auth/totp.test.js`:

- RFC 4226 Appendix D — ten HOTP values
- RFC 6238 Appendix B — six TOTP values at eight digits

A hand-rolled primitive is only defensible against the specification's own
numbers, not against itself.

### Secret storage

`users.mfa_secret` holds **AES-256-GCM ciphertext**, never the base32
secret. GCM rather than a bare cipher because a modified ciphertext must
fail to decrypt rather than yield garbage that would then be verified
against attacker-chosen codes.

The key is HKDF-SHA256 derived from `JWT_SECRET` with an `audit-log:`-style
domain separator, so there is one secret to manage and the derived key is
not itself usable for anything else.

> **Operational coupling.** Rotating `JWT_SECRET` invalidates every stored
> TOTP secret, which locks out every MFA user. There is no recovery path
> except `POST /auth/mfa/disable` with database access. Moving the MFA key
> to a KMS with independent rotation is a P1
> ([roadmap](PRODUCT_PRODUCTION_ROADMAP.md) §2.1), not something this
> design pretends to solve.

### Replay defence

TOTP codes are valid for their whole 30-second window plus one step either
side, so a shoulder-surfed code is usable for up to 90 seconds — and both
the attacker and the legitimate user can present it. `users.mfa_last_step`
records the highest counter accepted; `consumeTotpStep` advances it with a
`WHERE mfa_last_step < $2` predicate, so two concurrent requests
presenting the same code cannot both win. Most TOTP implementations skip
this entirely.

### The login challenge

A correct password is only the first factor. When MFA is in force, `login`
mints a **challenge** and issues no session:

```
POST /api/v1/auth/login
→ 200 { mfaRequired: true, mfaReason: "enabled"|"required", challengeToken, expiresIn: 300 }

POST /api/v1/auth/mfa/challenge { challengeToken, code }
→ 200 { accessToken, refreshToken, user }
```

The challenge is deliberately **not** a refresh session. It lives five
minutes, is single-use, is destroyed on success or on the final failed
attempt, and carries no privilege of its own. Granting the first factor
the same lifetime as the second would mean a stolen password alone gets a
long-lived credential.

Five wrong codes burn the challenge, so an attacker who exhausts the
attempts cannot then follow them with the correct code.

### Transaction rule

Every security-relevant write commits **before** the error that follows
it. `transaction()` rolls back on throw, which is right for a mutation
that should not persist and wrong for a revocation that must. The same
trap cost a real bug twice in this codebase — see
[authService.js](../server/src/repositories/authService.js) and
`refresh()`, which rolled back a stolen token's family revocation because
it threw from inside the transaction.

### Backup codes

Ten single-use codes, `XXXXX-XXXXX`, from a 32-character alphabet with
the visually ambiguous `I O 0 1` removed. Stored as SHA-256 of the
**normalised** code, so a user who retypes from paper without the hyphen
or in lower case still matches. Consumption is a conditional UPDATE
(`WHERE used_at IS NULL`), so two concurrent uses of one code cannot both
succeed. Regenerating invalidates the previous set.

Codes are displayed exactly once, at generation. Only hashes are stored.

> Rolling `JWT_SECRET` does **not** affect backup codes — they are
> independent. But a `db:reset` does, and there is no operator tool to
> re-issue them; that user must be disabled and re-enabled.

### Dev and demo behaviour

`DEV_AUTH_ENABLED=true` short-circuits in `authMiddleware.js` and never
reaches MFA. A `Bearer dev-<role>` token needs no second factor, in any
environment where dev auth is permitted.

This is why `assertProductionSafety` exists and why
`AUTH_MFA_ENFORCE` is a boot failure rather than a default: production
refuses to start with dev auth on, and now also refuses to start with MFA
enforcement off. Two mutually exclusive configurations, both checked at
boot.

The *demo tenant* is the exception that proves the rule useful: with
`AUTH_MFA_ENFORCE=true` and `NODE_ENV=development`, `dev-super` still
works unauthenticated, while the same `NODE_ENV` with
`NODE_ENV=production` refuses to boot at all.

### Recovery

1. The user presents a backup code at `/auth/mfa/challenge` — no operator
   involvement, audited as `mfa-challenge-passed` with
   `backupCodesRemaining`.
2. If all codes are spent, an operator disables MFA for the account
   (`UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE
   id = …`, audited) and the user re-enrols. This is deliberately a
   database action: it is not exposed as an endpoint, because an endpoint
   that turns MFA off is an endpoint an attacker wants.
3. Losing the authenticator **and** the codes with no operator is
   unrecoverable by design. Account is disabled and re-invited.

### Files

| | |
|---|---|
| [server/src/auth/totp.js](../server/src/auth/totp.js) | RFC 6238 implementation |
| [server/src/auth/totp.test.js](../server/src/auth/totp.test.js) | RFC test vectors |
| [server/src/auth/mfaCrypto.js](../server/src/auth/mfaCrypto.js) | AES-256-GCM at rest |
| [server/src/auth/mfaService.js](../server/src/auth/mfaService.js) | enrolment, challenge, recovery |
| [server/src/repositories/mfaRepository.js](../server/src/repositories/mfaRepository.js) | persistence |
| [server/src/db/008-mfa.sql](../server/src/db/008-mfa.sql) | schema |
| [server/src/db/009-mfa-challenge-revocation.sql](../server/src/db/009-mfa-challenge-revocation.sql) | challenge invalidation trigger |

---

## 27. Row-level security

Added 2026-09-28 as a staged rollout. Full plan, readiness audit and
sequence: [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md).

### The current state, plainly

Tenant isolation is still **entirely** predicate-based in the default
configuration. RLS policies exist for four tables and a non-owner
`estateflow_app` role now exists and is granted, but RLS only enforces
when the server connects as that role — which needs `APP_DATABASE_URL`.
Until it does, the policies are **inert**:

```
current_user: postgres
rolbypassrls: true
```

Demonstrated on the verification database — with a policy installed, RLS
enabled and `app.tenant_id` set to `tenantA`, a `SELECT` returned both
tenants' rows.

The role was added on 2026-09-28 (`npm run db:app-role -- --create`),
so this is now a configuration question rather than a build one. Until
`APP_DATABASE_URL` is set in production, this section describes work in
progress, not a protection in force — and that sentence is worth
restating at every security review, because a policy that is present,
correct and inert is indistinguishable from one that works until
something tries to bypass it.

### What is in place

- `withTenant()` sets `app.tenant_id` transaction-scoped, as the first
  statement, and refuses to run without a tenant.
- `withoutTenant()` exists for the pre-auth paths, and clears the setting
  explicitly rather than relying on its absence.
- Migration 010 installs a `tenant_isolation` policy on `listings`,
  `leads`, `visits`, `listing_photos`, with both `USING` and
  `WITH CHECK`, gated behind `DB_RLS_MODE`.
- `DB_RLS_MODE=probe` enables RLS and asserts the application behaves
  **identically**. CI runs it. That is how a policy is proved correct
  before it is allowed to deny anything.

Verified: with RLS enabled, 368 tests pass unchanged, both smokes pass,
and the full listings write lifecycle works. The rollback is
`DB_RLS_MODE=off` + `npm run db:migrate`.

### The tables not yet protected

`organisations`, `refresh_sessions` and `login_attempts` are read during
authentication, **before** a tenant is established — a policy on them
breaks the login flow that establishes the tenant. That is the hard part
of the rollout and is §4 of the rollout plan.

`audit_log` is last: it has its own tenant-column history (migration 007),
and the integrity job reads every row across tenants by design, so it
needs a deliberate exemption rather than an accident.

`roles` and `permission_matrices` are global and read by every tenant. A
policy would break login outright. They get no RLS, and that is recorded
rather than defended.

### The six junction tables

`mfa_backup_codes`, `password_reset_tokens`, `project_members`,
`team_members`, `thread_participants`, `user_project_ids` have no
`tenant_id` of their own and reach a tenant through a foreign key. An
`EXISTS` policy would work but depends on the FK never being dropped, so
the plan adds a denormalised `tenant_id` to each.

### Does not change

Every `tenant_id = $1` predicate stays. RLS is a second, independent
check, not a replacement: `scopeFilterFor()` still returns `1 = 0` for a
user with no tenant, and a bug that slips past it would still be caught
by the database — and vice versa. Two mechanisms that fail differently
are worth more than one.

---

## 26. Real sign-in flow

The frontend signs in against the real backend. Two accounts exist for
testing, both throwaway and both created by
[scripts/seed-auth-test-users.js](../server/scripts/seed-auth-test-users.js):
`mfa-off@acme.example` (no second factor) and `mfa-on@acme.example`
(enrolled). The password comes from `DEMO_PASSWORD` in `.env`; no
credential is in the repository.

### Where the tokens live

**As of Phase 9B, split.** The refresh token is an `httpOnly` cookie; the
access token is still in memory.

- `jrp_refresh` — `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`,
  absolute `Expires`. Unreadable by `document.cookie`, so a script on
  the origin cannot lift it. Narrow path, so it is not attached to every
  API call.
- `jrp_csrf` — deliberately **not** `HttpOnly`, because the client
  must read it to echo it in `X-CSRF-Token`. `Path=/`, so the page can
  actually see it. It is not a credential on its own.
- Access token — module scope in `src/services/authSession.js`. Short-lived
  and never persisted.

A reload now restores the session: the browser still holds the cookie, so
startup calls `POST /auth/refresh`, the token rotates, and a new access
token comes back. Verified in a real browser on desktop and phone.

### The CSRF problem a cookie creates

A cookie is attached by the browser, not by JavaScript, so a page on
another origin can make the browser POST `/auth/refresh` and read the
access token that comes back. Three defences, all required:

1. `SameSite=Lax` — blocks the cross-site POST, which is the case that
   matters. `Strict` is not used: it also drops the cookie on a normal
   navigation back into the app, signing users out whenever they click a
   link from their email.
2. **Double-submit.** The `X-CSRF-Token` header must match the
   `jrp_csrf` cookie, compared with `timingSafeEqual`, against a
   server-side set of issued tokens. A cross-origin attacker can make the
   browser send the cookie but cannot read it, so cannot produce the
   header.
3. **Explicit `Origin` check** on cookie-authenticated requests. A forged
   request carries the attacker's origin. This is the check that still
   works when SameSite cannot: a `None` deployment — needed for a
   genuinely cross-site split — is protected by nothing else.

A request with **no** `Origin` is refused on a cookie route. A cross-site
form post from a browser always carries one, so its absence means a
non-browser client, which has no business using a cookie.

### Body tokens still work

A request with no `Origin` gets the refresh token in the **body** and no
cookie. That keeps scripts, the CLI and the test harnesses working, and
a browser always sends an `Origin` on a cross-origin fetch — so this
cannot be used to downgrade the browser path into returning a readable
token.

### Configuration, and the trap in it

| Variable | Dev | Production |
|---|---|---|
| `AUTH_COOKIE_SECURE` | `false` | `true` (**required**) |
| `AUTH_COOKIE_SAME_SITE` | `Lax` | `Lax`, or `None` if cross-site |

`AUTH_COOKIE_SECURE` must be **false** locally: a `Secure` cookie is
not sent over plain HTTP, so refresh fails with no visible cause and
every session appears to expire. `assertCookieSettingsSafe()` refuses a
production boot with it off, and refuses `SameSite=None` without
`Secure`, which browsers reject outright.

Dev is `Lax` because `localhost:5173` and `localhost:4000` are the
same SITE on different ports. A cross-site production deployment needs
`None`, which browsers only accept with `Secure`.

> **Hostnames must match.** The browser smoke browses
> `http://localhost:5173`, not `127.0.0.1:5173`. A cookie is scoped to
> a SITE, and `127.0.0.1` and `localhost` are different sites, so the
> session cookie is silently discarded and the reload check fails for a
> reason that has nothing to do with the code.

### What the client must handle

The backend issues **nothing** on the first factor when MFA is in force.
A client that looks only for `accessToken` reports a correct password as
a failed sign-in. `signIn()` returns one of three shapes —
`authenticated`, `mfa-required`, or `error` — and the UI branches on
all three. `mfaReason` distinguishes `enabled` (a code is expected) from
`required` (an unenrolled admin who must enrol first), which are different
screens.

### Refresh is single-use, so it is serialised

The backend revokes the family on replay. Two concurrent `refresh()` calls
would spend the token twice and the second would be treated as an
attack. `refreshSession()` therefore shares one in-flight promise across
callers, and `AuthGate` refreshes on a 60-second timer with a 60-second
margin so a token is never used in its final minute.

### The demo flag still gates the demo

`isDemoMode()` follows `VITE_ENABLE_DEMO_ROLE_SWITCHER`. When it is on,
the app renders with the seeded identity and no sign-in screen — that is
what a demo build is for. When it is off, `AuthGate` requires a session
from the backend, and the role switcher is not rendered at all. A missed
flag cannot leave a real deployment on a demo identity, because the gate
refuses to render the app without a session.

### Two bugs this found

- **`CORS_ORIGINS` was missing `127.0.0.1:5173`.** It listed
  `localhost:5173` and `127.0.0.1:5180` but not the loopback form of
  the default dev port, so a browser on that origin got `Failed to fetch`
  on every request. The unit tests passed; only a real browser showed it.
- **The MFA backup-code path rewound `mfa_last_step`.** Regeneration
  wrote the step read *before* the current code was verified, undoing the
  advance, so the user's next authenticator code was rejected as a replay.
  Fixed in [mfaRepository.js](../server/src/repositories/mfaRepository.js)
  with `replaceBackupCodesOnly`, which does not touch the TOTP counter.
  `mfa_last_step` is also a `bigint`, which `pg` returns as a **string** —
  `lastStep + 1` concatenated rather than incremented. Coerced at the
  boundary in `getMfaState`.
