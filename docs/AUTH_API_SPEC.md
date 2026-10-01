# EstateFlow CRM — Auth API Spec

Date: 2026-09-24 (token contract section added; endpoints still design-only)

Status: **login, refresh, logout, logout-all and /me are implemented** (2026-09-24). Password hashing, refresh rotation with reuse detection, and account lockout are live. Still stubs: invite, accept-invite, OTP, forgot/reset password, impersonation, MFA. Read alongside [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md), [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md), and [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md).

All endpoints live under `/api/v1/`. All responses are `application/json; charset=utf-8` unless noted. All errors use the standard error envelope (see §1). All times are ISO 8601 UTC. All ids are ULIDs prefixed by entity type (`u_`, `org_`, `br_`, `rt_`, `mfa_`, `otp_`, `inv_`, `rst_`, `req_`, `au_`, etc.).

---

## 0. Access-token contract (implemented)

Implemented in [server/src/auth/tokenService.js](../server/src/auth/tokenService.js). Covered by `tokenService.test.js` (28 tests).

### Format

Standard compact JWS, three Base64URL segments: `header.payload.signature`. Algorithm **HS256**. There is no `alg: none` path — the verifier checks the header and the signature separately, and a token with an empty third segment is refused before any key is resolved.

### Claim set

| Claim | Type | Meaning |
|---|---|---|
| `sub` | string | User id. |
| `tid` | string | Tenant id. **Authoritative** — the user is loaded by `u.id = sub AND u.tenant_id = tid`, so a token naming a user in one tenant and another tenant matches no row. |
| `rid` | string \| null | Role id, carried so a role change can be detected without a second lookup. |
| `sid` | string \| null | The `refresh_sessions.id` this token descends from, for revocation correlation. |
| `jti` | string | Unique token id, `at_<24 hex>`. |
| `iat` | number | Issued-at, seconds. |
| `exp` | number | Expiry, seconds. `iat + JWT_ACCESS_TTL_SECONDS` (default 900). |
| `iss` | string | Issuer. `JWT_ISSUER`, default `estateflow-api`. |
| `aud` | string | Audience. `JWT_AUDIENCE`, default `estateflow-clients`. |

**The permission matrix is deliberately not in the token.** A token lives 15 minutes; a role change has to take effect inside that window, so the matrix is re-read from Postgres on every request. Carrying it in the token would let a revoked permission survive until expiry.

### Verification order

Signature first, then structure, then issuer/audience, then expiry, then `iat` sanity. A forged token's shape leaks nothing because the signature is checked before the payload is read for anything.

| Check | Refusal message |
|---|---|
| Third segment empty | `Token signature is missing.` |
| Signature mismatch (constant-time compare) | `Token signature is invalid.` |
| Payload not JSON / not an object | `Token payload is not valid JSON.` |
| Missing or non-string `sub`/`tid` | `Token payload is missing sub or tid.` |
| `iss` mismatch | `Token issuer is not accepted.` |
| `aud` mismatch | `Token audience is not accepted.` |
| `exp <= now` | `Token has expired.` |
| `iat > now + 60` | `Token is not yet valid.` (tolerates 60 s skew) |

### Signing key

`JWT_SECRET` is required. A dev-only fallback exists so the `dev-<role>` flow and the test suite work on a machine with no secret configured, and it is gated three ways: `NODE_ENV=production` refuses it, the boot guard refuses to start without a real secret, and `resolveSigningKey()` independently refuses it in production.

In production the secret must also be **at least 32 characters** (`JWT_MIN_SECRET_LENGTH`) and must not be a recognised placeholder. Padding `changeme` to 40 characters does not pass.

### Refresh tokens

Opaque: 32 random bytes, returned to the client once, stored as a SHA-256 hash in `refresh_sessions.token_hash`. They are not JWTs, so they cannot be forged, and they are revocable by setting `revoked_at`. Rotation and reuse detection are implemented; see §3.

---

## 0a. Password hashing (implemented)

**Argon2id**, via the `argon2` native module. Stored format is the standard PHC string, which is self-describing — algorithm, version and cost parameters travel with the hash:

```
$argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<hash-b64>
```

| Parameter | Default | Env override |
|---|---|---|
| `m` (memory) | 19456 KiB — the OWASP minimum | `PASSWORD_MEMORY_COST` |
| `t` (iterations) | 2 | `PASSWORD_TIME_COST` |
| `p` (parallelism) | 1 | `PASSWORD_PARALLELISM` |

**Why Argon2id and not the `node:crypto` scrypt fallback.** Both are memory-hard and both are acceptable; scrypt is listed as an alternative, not a peer. Argon2id is OWASP's first recommendation, it won the Password Hashing Competition, and it is *hybrid* — resisting both side-channel and GPU/parallel cracking, where scrypt only does the latter. The native module was verified to build and run in this environment (installed from source in ~5 s, ~29 ms per hash at production parameters) before the decision was made, so this was an empirical choice rather than a preference. The fallback exists only for a deployment target that cannot build native modules.

**Migration.** `needsPasswordRehash(hash)` returns true when the stored parameters are below the current policy or the algorithm differs. Login re-hashes opportunistically and writes the upgrade back, so raising the policy costs no migration — see the `login` step in [server/src/repositories/authService.js](../server/src/repositories/authService.js).

**Malformed hashes fail closed.** `verifyPassword` returns `false` — never throws — for an empty, truncated, corrupted, or wrong-algorithm value. A different outcome for "no such hash" versus "wrong password" is a user-enumeration oracle.

**Timing.** Every failure path in `login` performs a real Argon2id verification against a dummy hash, so an unknown address, a wrong password, a suspended account and a locked account all cost the same. A short-circuit on account state before the comparison would leak that state through response time.

Covered by [server/src/auth/passwordPolicy.test.js](../server/src/auth/passwordPolicy.test.js) (18 tests).

---

## 1. Common conventions

### Authentication header

`Authorization: Bearer <accessToken>` for all authenticated endpoints. The access token is a JWT (HS256 in v1; RS256 in v1.1) with the claim set defined in [AUTH_API_SPEC §0](#0-access-token-contract-implemented) and [AUTH_TENANT_SECURITY_PLAN §8](AUTH_TENANT_SECURITY_PLAN.md).

### Identity resolution (implemented)

On every authenticated request the middleware:

1. Verifies the token per §0.
2. Loads the user by **`(sub, tid)`** — both columns, not `sub` alone.
3. Refuses if the user is not `Active`, or the tenant is not `Active`/`Trial`. Any unrecognised status fails closed.
4. Merges the effective permission matrix: in-code role default → `permission_matrices.matrix` → `users.permission_matrix`.
5. Attaches the result as `req.user`, and `req.auth = { source, jti, sessionId }`.

If Postgres is unreachable the request proceeds with an **empty** matrix, so `requirePermission` refuses every route. The client never receives an identity the server cannot back with a row.

Refusal codes: `user-suspended`, `tenant-suspended`, `tenant-not-found`. A cross-tenant token — correct signature, `sub` from tenant A, `tid` from tenant B — is reported as a generic `unauthorized`, deliberately indistinguishable from "no such user", so the endpoint is not a user-enumeration oracle.

### Tenant header (advisory)

`X-Tenant-Slug: <slug>` is sent by the client and verified against the JWT's `tid` claim. If they disagree, the server returns `403 Forbidden` with `code: 'tenant-mismatch'`. The header is advisory because the JWT `tid` is authoritative; the header helps debugging.

### Idempotency-Key header (mutating endpoints)

`Idempotency-Key: <key>` on every `POST`, `PATCH`, `DELETE`. The key is a ULID; clients should generate one per logical mutation. The server caches the response by `(user_id, idempotency_key)` for 24 hours. Re-sending the same key returns the cached response without re-running the mutation.

This is how the offline-queue worker ([docs/SYNC_WORKER_PLAN.md §3](SYNC_WORKER_PLAN.md)) replays queued actions safely.

### Standard error envelope

```json
{
  "error": {
    "code": "invalid-payload",
    "message": "Password must be at least 10 characters.",
    "detail": { "field": "password", "min": 10 }
  }
}
```

| HTTP status | When | Common `code` values |
| --- | --- | --- |
| 400 | Request body / query invalid | `invalid-payload`, `missing-field`, `unknown-field` |
| 401 | Auth missing or invalid | `unauthorized`, `token-expired`, `token-revoked`, `mfa-required`, `invalid-otp` |
| 403 | Authenticated but forbidden | `forbidden`, `tenant-mismatch`, `cannot-modify-system-role` |
| 404 | Resource not found (also used for "you can't see this") | `not-found` |
| 409 | Conflict with current state | `email-taken`, `phone-taken`, `lead-reassigned`, `cannot-modify-system-role`, `user-locked` |
| 422 | Semantic validation failed | `password-too-weak`, `password-reused`, `phone-invalid` |
| 429 | Rate limit | `rate-limited` (with `Retry-After` header) |
| 500 | Server error | `internal-error` |

Errors are intentionally **not** specific — a `POST /auth/login` with a wrong password returns the same envelope as a non-existent email, to prevent user enumeration.

### Rate limit headers

Every response carries:

```
X-RateLimit-Limit: <int>
X-RateLimit-Remaining: <int>
X-RateLimit-Reset: <epoch seconds>
```

`429` responses also carry `Retry-After: <seconds>`.

---

## 2. `POST /api/v1/auth/login`

Authenticate with email + password.

### Purpose

Primary login path. Returns an access token + refresh token (and the user profile), or — when MFA is enabled — an `mfa_required` envelope that the client resolves with `POST /auth/verify-otp`.

### Required permission

None (public endpoint).

### Request body

```json
{
  "tenantSlug": "acme",
  "email": "asha@acme.example",
  "password": "<plaintext>",
  "rememberDevice": true,
  "deviceFingerprint": "<sha256>"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tenantSlug` | string | no | URL-safe slug or tenant id. **Optional in a single-tenant deployment** — when omitted, the sole active organisation is used. With two or more organisations the value is required, so an address alone never picks a tenant. |
| `email` | string | yes | Case-insensitive. |
| `password` | string | yes | Plaintext; TLS-protected in transit. Verified with Argon2id. |
| `deviceLabel` | string | no | Human-readable, shown on the "active devices" screen. |

**Omitted from the implementation for now:** `rememberDevice` and `deviceFingerprint`. The `refresh_sessions` columns exist (`trusted`, `device_fingerprint`) but nothing populates them; the trusted-device skip is Phase 3 follow-up.

### Response 200

```json
{
  "status": "ok",
  "accessToken": "<jwt>",
  "refreshToken": "<opaque>",
  "sessionId": "rs_...",
  "refreshExpiresAt": "2026-10-01T12:00:00.000Z",
  "user": {
    "id": "u_01HX...",
    "name": "Asha Rao",
    "email": "asha@acme.example",
    "phone": "+919876543210",
    "role": "field-executive",
    "roleId": "role_field_executive",
    "branchId": "br_bangalore",
    "teamId": "t_north",
    "projectIds": ["p_skyline"]
  },
  "tenant": {
    "id": "org_acme",
    "slug": "acme",
    "name": "Acme Developers"
  },
  "expiresIn": 900
}
```

`expiresIn` is the access-token lifetime in seconds (default 900 = 15 min).

### Response 200 (MFA required)

```json
{
  "status": "mfa_required",
  "mfaToken": "<opaque; 5-min TTL>",
  "methods": ["totp", "recovery-code"]
}
```

The client then calls `POST /auth/verify-otp` with `mfaToken` + chosen `method`.

### Response 401

Wrong email/password, locked account, suspended account. The error envelope is identical in all three cases to prevent enumeration:

```json
{ "error": { "code": "invalid-credentials", "message": "Email or password is incorrect." } }
```

The server-side still increments `users.failed_login_count` and applies the lockout policy from AUTH_TENANT_SECURITY_PLAN §18.

### Response 429

Rate-limited. `Retry-After` header set.

### Audit event

- On success: `logged-in` with `metadata: { deviceFingerprint, ip, userAgent, trustedDevice }`.
- On failure: `failed-login` with `metadata: { reason: 'bad-password' | 'account-locked' | 'account-suspended' | 'mfa-required-but-not-provided' }`.

### Rate limits

- 5 / 15 min / IP.
- 10 / 15 min / user.
- 30 / hour / IP hard cap.

### Security notes

- Always responds in the same time (constant-time password verification) regardless of whether the user exists.
- Never reflects back whether the account is locked or whether MFA is enabled in the failure message.
- The `mfaToken` is single-use and short-lived (5 minutes).

---

## 3. `POST /api/v1/auth/refresh`

Trade a refresh token for a new pair (rotated).

### Purpose

Renew the access token without re-authenticating. The old refresh token is revoked; a new pair is issued. See AUTH_TENANT_SECURITY_PLAN §9.

### Required permission

None (the refresh token is the credential).

### Request body

```json
{ "refreshToken": "<opaque>" }
```

### Response 200

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<opaque; new>",
  "expiresIn": 900,
  "sessionId": "rs_...",
  "refreshExpiresAt": "2026-10-01T12:00:00.000Z",
  "user": { "id": "u_01HX...", "role": "field-executive", "permissionMatrix": {} }
}
```

### Response 401

Every failure returns **one** code and one message, whatever the reason:

```json
{ "error": { "code": "invalid-refresh-token", "message": "Session is no longer valid. Sign in again." } }
```

| Underlying cause | Why the caller is not told |
|---|---|
| No such token | Probing for real tokens |
| `expires_at` passed | Distinguishing a live-but-old token from a dead one helps an attacker |
| Already rotated away (replay) | Confirms the token was once valid |
| Revoked by logout | Confirms which tokens existed |

### Reuse detection (implemented)

Rotation is transactional and **always** issues a new token. Each token carries a `family_id` shared by the whole chain, plus `rotation_count` and a `parent_id` pointing at its predecessor.

Presenting an already-rotated token is treated as a credential leak: the **entire family** is revoked in the same transaction and `compromised_at` is stamped, so an operator can tell a theft from an ordinary logout in the audit trail. The successor token the legitimate client holds dies with it — by the time a stolen token has been replayed there is no way to tell the two copies apart, so both are revoked and a fresh login is required.

Reuse is detected per family: another device logged in separately keeps working.

The user-notification email described below is **not implemented** — `compromised_at` is recorded but nothing sends mail yet.

### Audit event

`refreshed-token` with `metadata: { ip, userAgent }`. Not yet written to `audit_log`; see the roadmap.

### Rate limits

30 / minute / user. Not implemented — the per-identifier lockout covers login, not refresh. See the roadmap's deployment requirement for gateway-level limits.

### Security notes

- Token rotation is mandatory; the server never returns the same refresh token twice.
- A refresh-token replay is treated as a credential leak; the user is signed out everywhere.

---

## 4. `POST /api/v1/auth/logout`

Revoke the supplied refresh token.

### Purpose

Single-device logout. The client should also delete its local access token.

### Required permission

None (the refresh token is the credential).

### Request body

```json
{ "refreshToken": "<opaque>" }
```

### Response 204

No content.

### Audit event

`logged-out` with `metadata: { sessionId, ip }`.

### Rate limits

10 / minute / user.

### Security notes

- Server-side `Set-Cookie` (if used) is set to expire the cookie. The HttpOnly cookie is the primary mechanism on web; on the PWA the client clears its own IndexedDB entry.
- The access token is **not** revoked server-side; it expires naturally in ≤15 minutes. For tight revocation, see AUTH_TENANT_SECURITY_PLAN §20.

---

## 5. `POST /api/v1/auth/logout-all`

Revoke every refresh token for the authenticated user.

### Purpose

"Sign out everywhere". Used when the user suspects credential compromise or after a forced password reset.

### Required permission

Authenticated user (the user themselves).

### Request body

Empty.

### Response 204

No content.

### Audit event

`logged-out-all` with `metadata: { sessionCount, ip }`.

### Rate limits

5 / hour / user.

### Security notes

- Idempotent — if the user has no sessions, still returns 204.
- The next API call from any device will return 401 with `code: 'token-revoked'`.

---

## 6. `GET /api/v1/auth/me`

Return the current user, role, and effective permission matrix.

### Purpose

Bootstraps the frontend after login. Replaces the frontend's `currentUser` derivation from [src/state/store.jsx](../src/state/store.jsx) with a server-sourced value.

### Required permission

Authenticated user.

### Request body

None.

### Response 200

```json
{
  "user": {
    "id": "u_01HX...",
    "name": "Asha Rao",
    "email": "asha@acme.example",
    "phone": "+919876543210",
    "designation": "Sales Executive",
    "status": "Active",
    "branchId": "br_bangalore",
    "teamId": "t_north",
    "projectIds": ["p_skyline"],
    "roleId": "role_field_executive",
    "roleName": "field-executive",
    "mfaEnabled": false,
    "lastLoginAt": "2026-09-19T12:00:00Z"
  },
  "tenant": {
    "id": "org_acme",
    "slug": "acme",
    "name": "Acme Developers",
    "status": "Active"
  },
  "branch": { "id": "br_bangalore", "name": "Bangalore" },
  "permissionMatrix": {
    "leads": { "view": "own", "create": "own", "edit": "own", "assign": "none", "approve": "none", "export": "none", "delete": "none" },
    "attendance": { "view": "own", "create": "own", "edit": "own", "assign": "none", "approve": "none", "export": "none", "delete": "none" },
    "visits": { "view": "own", "create": "own", "edit": "own", "assign": "none", "approve": "none", "export": "none", "delete": "none" },
    "photos": { "view": "own", "create": "own", "edit": "none", "assign": "none", "approve": "none", "export": "none", "delete": "none" },
    "communications": { "view": "own", "create": "own", "edit": "own", "assign": "none", "approve": "none", "export": "none", "delete": "none" }
  }
}
```

### Response 401

`unauthorized` or `token-expired`.

### Audit event

None — this is a read, not a mutation. Repeated calls do not write to the audit log.

### Rate limits

30 / minute / user.

### Security notes

- The `permissionMatrix` field is the **resolved** matrix (role matrix merged with user overrides). The frontend uses this directly to gate UI, mirroring [src/data/permissions.js `mergeMatrix`](../src/data/permissions.js).
- The matrix is included in full — the user needs to see what they can do, even if they can't read other users' matrices.

---

## 7. `POST /api/v1/auth/invite`

Invite a new staff member. Sends an email with an `accept-invite` link.

### Purpose

The admin-driven path to onboard a new user. The user is created in `Invited` status; they accept by setting a password.

### Required permission

`(staff, create)` — typically `admin`, `sales-manager` (for their own team), or `super-admin`.

### Request body

```json
{
  "email": "newperson@acme.example",
  "name": "New Person",
  "roleId": "role_field_executive",
  "branchId": "br_bangalore",
  "teamId": "t_north",
  "projectIds": ["p_skyline"],
  "designation": "Sales Executive",
  "phone": "+919876543210"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Must be unique within the tenant. |
| `name` | string | yes | Display name. |
| `roleId` | ULID | yes | Must exist in the tenant. |
| `branchId` | ULID | no | |
| `teamId` | ULID | no | |
| `projectIds` | ULID[] | no | |
| `designation` | string | no | |
| `phone` | string | no | E.164; required if the user will use OTP login. |

### Response 201

```json
{
  "user": {
    "id": "u_01HX...",
    "email": "newperson@acme.example",
    "status": "Invited",
    "invitedAt": "2026-09-19T12:00:00Z",
    "inviteExpiresAt": "2026-09-26T12:00:00Z"
  }
}
```

The response **does not** include the `inviteToken`; that lives only in the email sent to the user.

### Response 409

`email-taken` if the email already exists in the tenant.

### Audit event

`invited-user` with `metadata: { invitedEmail, roleId, teamId, projectIds }`.

### Rate limits

50 / day / inviter. 200 / day / tenant.

### Security notes

- The invite email goes to the supplied email address; the server does **not** verify that the inviter actually controls the address. Admins are trusted; if a malicious admin invites `ceo@competitor.com`, the email goes out. Mitigations: log the invite at the security log level; add a "did you intend to invite this email?" confirmation step in the UI when the email domain differs from the tenant's primary domain.
- Resending an invite rotates the token and resets `invite_expires_at`.

---

## 8. `POST /api/v1/auth/accept-invite`

Accept an invitation: set a password and flip status to `Active`.

### Purpose

Completes the invitation flow.

### Required permission

None (the invite token is the credential).

### Request body

```json
{
  "token": "<opaque>",
  "displayName": "New Person",
  "password": "<plaintext>"
}
```

### Response 200

```json
{
  "status": "ok",
  "accessToken": "<jwt>",
  "refreshToken": "<opaque>",
  "user": { "...": "..." },
  "expiresIn": 900
}
```

The user is logged in immediately.

### Response 422

- `password-too-weak` — fails the password policy.
- `password-reused` — matches a previous password hash.
- `invite-expired` — past `invite_expires_at`.
- `invite-consumed` — token already used.

### Audit event

`accepted-invite` with `metadata: { ip, userAgent }`.

### Rate limits

10 / hour / IP.

### Security notes

- The `inviteToken` is single-use; the row's `invite_token` is set to `NULL` on success.
- The new password is checked against the breach-list and the user's last 5 password hashes. There are no prior passwords at invite-accept time, so the reuse check is a no-op here.

---

## 9. `POST /api/v1/auth/request-otp`

Send a one-time code via SMS or WhatsApp to the user's phone.

### Purpose

First-factor login for field staff (phone + OTP).

### Required permission

None (public).

### Request body

```json
{
  "tenantSlug": "acme",
  "phone": "+919876543210",
  "channel": "sms"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tenantSlug` | string | yes | |
| `phone` | string | yes | E.164. |
| `channel` | enum | yes | `sms` or `whatsapp`. |

### Response 200

```json
{ "status": "ok", "expiresIn": 300 }
```

The response is identical whether or not the user exists (constant-time, no enumeration).

### Response 429

Rate-limited. `Retry-After` header set.

### Audit event

`otp-requested` with `metadata: { phone (last 4), channel, success }`. The full phone is not logged.

### Rate limits

- 1 / minute / phone.
- 5 / day / phone.

### Security notes

- The OTP is 6 digits, generated from a CSPRNG.
- The OTP is stored as a SHA-256 hash with a 5-minute TTL and an `attempts` counter.
- Sending the OTP incurs an SMS cost; a malicious user could burn quota. The rate limits above are the defence.
- The response is the same in both cases to prevent phone enumeration.

---

## 10. `POST /api/v1/auth/verify-otp`

Verify a one-time code (OTP or TOTP).

### Purpose

Second-factor verification (when called with `method: 'totp'` after a login that returned `mfa_required`) **or** first-factor verification (when called with `method: 'sms'` after a `request-otp`).

### Required permission

None (the OTP / mfaToken is the credential).

### Request body (TOTP, second factor)

```json
{
  "method": "totp",
  "mfaToken": "<from /login response>",
  "code": "123456"
}
```

### Request body (SMS, first factor)

```json
{
  "method": "sms",
  "tenantSlug": "acme",
  "phone": "+919876543210",
  "code": "123456",
  "rememberDevice": true,
  "deviceFingerprint": "<sha256>"
}
```

### Response 200

```json
{
  "status": "ok",
  "accessToken": "<jwt>",
  "refreshToken": "<opaque>",
  "user": { "...": "..." },
  "expiresIn": 900
}
```

### Response 401

- `invalid-otp` — wrong code, or wrong TOTP.
- `otp-expired` — past TTL.
- `otp-locked` — too many attempts; slot locked for 30 min.

### Audit event

- TOTP success: `mfa-verified`.
- SMS success: `logged-in`.
- Failure (any method): `failed-mfa` or `failed-otp` with `metadata: { method, attempts, ip }`.

### Rate limits

- 5 attempts / 5 min / phone-or-user; then lock 30 min.
- 20 / day / user.

### Security notes

- The `mfaToken` is single-use.
- The verify endpoint is the only place where the OTP hash is checked; it is never returned to the client.
- TOTP validation accepts ±1 window (90-second total) for clock skew.

---

## 11. `POST /api/v1/auth/forgot-password`

Request a password-reset email.

### Purpose

User-driven recovery when they forget their password.

### Required permission

None (public).

### Request body

```json
{
  "tenantSlug": "acme",
  "email": "asha@acme.example"
}
```

### Response 200

```json
{ "status": "ok" }
```

The response is identical whether or not the email exists. If the email exists, a `reset_password` email is queued.

### Audit event

`password-reset-requested` with `metadata: { email (if user exists), ip }`. The full email is hashed for the audit row; only the domain is stored plain.

### Rate limits

- 3 / hour / IP.
- 1 / 15 min / email.

### Security notes

- The reset token is single-use, 1-hour TTL, base64url-encoded 32 bytes.
- Sending the email incurs an SES cost; the rate limits are the defence against enumeration-based burn.

---

## 12. `POST /api/v1/auth/reset-password`

Consume a reset token and set a new password.

### Purpose

Complete the forgot-password flow.

### Required permission

None (the reset token is the credential).

### Request body

```json
{
  "token": "<opaque>",
  "newPassword": "<plaintext>"
}
```

### Response 200

```json
{ "status": "ok" }
```

The user is **not** logged in by this endpoint. They must `POST /auth/login` with the new password. This is intentional — the password-reset flow proves control of the email but not of the device.

### Response 422

- `password-too-weak`.
- `password-reused`.
- `token-expired`.
- `token-consumed`.

### Side effect

All refresh tokens for the user are revoked. Audit event `password-reset-completed` includes `metadata: { invalidatedSessionCount, ip }`.

### Rate limits

10 / hour / IP.

### Security notes

- The reset token is bound to the user and the timestamp of issue. A token issued 2 hours ago is invalid even if it was never used.
- The user is notified by email when their password is reset, so they learn of a successful attack within minutes.

---

## 13. `GET /api/v1/security/sessions`

List the active sessions for the authenticated user.

### Purpose

"Signed-in devices" page in the UI. The user sees where they're logged in and can revoke individually or all.

### Required permission

Authenticated user (only their own sessions).

### Request body

None.

### Query parameters

| Param | Type | Notes |
| --- | --- | --- |
| `status` | enum | `active`, `revoked`, `expired`. Default `active`. |
| `limit` | int | 1..100, default 50. |
| `cursor` | ULID | Pagination. |

### Response 200

```json
{
  "sessions": [
    {
      "id": "sess_01HX...",
      "deviceLabel": "Chrome on macOS",
      "deviceFingerprint": "<sha256>",
      "ip": "203.0.113.42",
      "userAgent": "Mozilla/5.0 ...",
      "trusted": true,
      "createdAt": "2026-09-12T12:00:00Z",
      "lastUsedAt": "2026-09-19T12:00:00Z",
      "expiresAt": "2026-10-12T12:00:00Z",
      "currentSession": true
    }
  ],
  "nextCursor": null
}
```

`currentSession: true` identifies the session belonging to the request's access token (so the UI can highlight "this device").

### Audit event

None.

### Rate limits

30 / minute / user.

### Security notes

- The IP and User-Agent shown to the user are the values from the **most recent** use of the session, not the original login.
- A `trusted: true` session is one where the user opted in on the MFA verify screen and is still inside the 30-day trusted window.

---

## 14. `DELETE /api/v1/security/sessions/:id`

Revoke a single session.

### Purpose

The "Sign out this device" button on the sessions page.

### Required permission

Authenticated user (the session must belong to them — `:id` not matching the user returns 404).

### Request body

Empty.

### Response 204

No content.

### Audit event

`revoked-session` with `metadata: { sessionId, ip }`.

### Rate limits

30 / minute / user.

### Security notes

- Revoking the current session is fine; the client will see the next API call return 401 and route to the login page.
- The session row's `revoked_at` is set; subsequent `POST /auth/refresh` with the corresponding refresh token returns 401 `token-revoked`.

---

## 15. Auxiliary endpoints (referenced, not defined in detail here)

These are the admin-side endpoints referenced by [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) and [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md). They follow the same conventions.

### `POST /api/v1/auth/impersonate`

`super-admin` only. See AUTH_TENANT_SECURITY_PLAN §17.

- Body: `{ userId, reason }`.
- Returns: `{ accessToken, refreshToken, expiresIn, impersonatedBy: '<super-admin-id>' }`.

### `POST /api/v1/auth/end-impersonate`

Ends the impersonation session, restores the original session.

- Body: empty.
- Returns: `{ accessToken, refreshToken, expiresIn }` (the original super-admin's session).

### `POST /api/v1/security/users/:id/unlock`

Admin unlocks a locked user.

- Body: empty.
- Returns: `{ user: { id, status, lockedUntil: null } }`.

### `POST /api/v1/security/users/:id/revoke-sessions`

Admin revokes all sessions for a user (e.g. after a confirmed compromise).

- Body: empty.
- Returns: `{ revokedCount }`.

### `POST /api/v1/users/:id/restore`

Restores a soft-deleted user within the 30-day window. See AUTH_TENANT_SECURITY_PLAN §22.

- Body: empty.
- Returns: `{ user }`.

---

## 16. Files referenced

- [docs/AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md) — design.
- [docs/RBAC_SERVER_ENFORCEMENT.md](RBAC_SERVER_ENFORCEMENT.md) — middleware + audit verbs.
- [docs/DATA_MODEL.md](DATA_MODEL.md) — entities.
- [docs/BACKEND_INTEGRATION_PLAN.md](BACKEND_INTEGRATION_PLAN.md) — stack + endpoint conventions.
- [docs/PWA_OFFLINE_PLAN.md](PWA_OFFLINE_PLAN.md) §9 — Idempotency-Key + permission re-check on sync.
- [docs/OFFLINE_QUEUE_CONTRACT.md](OFFLINE_QUEUE_CONTRACT.md) §5 — queue API the auth layer is built on.
- [docs/SYNC_WORKER_PLAN.md](SYNC_WORKER_PLAN.md) §3 — future `apiRepository` worker; uses `Idempotency-Key` from these endpoints.
- [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) — pre-launch tests.

---

## 17. MFA endpoints

Implemented 2026-09-27. Design rationale: [AUTH_TENANT_SECURITY_PLAN.md §26](AUTH_TENANT_SECURITY_PLAN.md#26-multi-factor-authentication).

### 17.1 `POST /api/v1/auth/login` (changed)

When MFA is in force, the response is a **challenge**, not a session:

```json
200 {
  "mfaRequired": true,
  "mfaReason": "enabled",
  "challengeToken": "…",
  "expiresIn": 300,
  "expiresAt": "2026-09-27T18:00:00.000Z"
}
```

`mfaReason` distinguishes two states the client renders differently:

| `mfaReason` | Meaning | Client shows |
|---|---|---|
| `enabled` | the user has enrolled | the code entry screen |
| `required` | admin/super-admin with no MFA | a forced-enrolment screen |

No `accessToken` or `refreshToken` is present in either case. Clients
that ignore the new fields will see an object with no tokens and must be
updated — see [§17.7](#17-7-client-impact).

Without MFA the response is unchanged, including `accessToken`,
`refreshToken`, `sessionId` and `user`.

### 17.2 `POST /api/v1/auth/mfa/challenge`

Public. Completes the second step. Possession of `challengeToken` is the
authorisation: it is only ever issued after a correct password.

```json
// request
{ "challengeToken": "…", "code": "123456" }

// 200 — same body as a non-MFA login
{ "accessToken": "…", "refreshToken": "…", "sessionId": "…", "user": { … } }
```

`code` is a 6-digit TOTP code **or** a backup code (`XXXXX-XXXXX`, case
and separator insensitive).

| Status | Code | When |
|---|---|---|
| 401 | `invalid-challenge` | unknown, expired, consumed, or a parallel request completed it |
| 400 | `mfa-code-required` | `code` missing or empty |
| 401 | `mfa-invalid-code` | no code matched |
| 401 | `mfa-code-replayed` | a valid code whose TOTP step was already spent |
| 429 | `mfa-attempts-exhausted` | five wrong codes; the challenge is burned |
| 401 | `invalid-credentials` | the account is no longer usable |

All are audited. `mfa-code-replayed` is worth distinguishing in logs: it
means a real code was presented twice, which is either a client bug or a
genuine capture-and-replay.

### 17.3 `POST /api/v1/auth/mfa/setup` (authenticated)

Begins enrolment. Returns the secret and the `otpauth://` URI.

```json
200 {
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauthUri": "otpauth://totp/Joldipabo%20CRM:admin@acme.example?…",
  "issuer": "Joldipabo CRM",
  "secondsRemaining": 17
}
```

`mfa_enabled` stays **false** until a code is confirmed, so an abandoned
setup cannot lock anyone out. The secret is stored encrypted and is not
in the audit row.

### 17.4 `POST /api/v1/auth/mfa/verify-setup` (authenticated)

```json
// request
{ "code": "123456" }

// 200
{ "backupCodes": ["A1B2C-D3E4F", …], "warning": "These codes are shown once. Store them now." }
```

| Status | Code | When |
|---|---|---|
| 400 | `mfa-already-enabled` | MFA is already on |
| 400 | `mfa-setup-not-started` | `setup` was never called |
| 400 | `mfa-secret-unreadable` | the stored secret cannot be decrypted — disable and re-enrol |
| 400 | `mfa-invalid-code` | wrong code |

Backup codes are shown **once**. Only hashes are stored.

### 17.5 `POST /api/v1/auth/mfa/disable` (authenticated)

```json
{ "code": "123456", "reason": "lost-phone" }
```

Requires a **current** second factor even though the caller is
authenticated: a stolen access token must not be enough to strip the
control meant to stop one. The code is verified through a throwaway
challenge, so the same rate limiting and audit trail apply.

Destroys the secret and every backup code. There is no password-only
variant and no operator bypass endpoint.

### 17.6 `POST /api/v1/auth/mfa/backup-codes` and `GET /api/v1/auth/mfa/status`

`backup-codes` takes a current code and returns a fresh set,
invalidating the previous. `status` is read-only:

```json
{ "mfaEnabled": true, "mfaEnabledAt": "2026-09-27T18:06:11.495Z",
  "backupCodesRemaining": 9, "required": true }
```

`required` is whether the caller's role must have MFA under
`AUTH_MFA_ENFORCE`.

### 17.7 Client impact

`POST /auth/login` has a new response shape. A client that reads
`.accessToken` without checking `mfaRequired` will treat a successful
first factor as a failed login — the user sees "invalid credentials" with
a correct password. Update the login handler before deploying the server
change. The other endpoints are additive.

### 17.8 Files

| | |
|---|---|
| [server/src/routes/auth.js](../server/src/routes/auth.js) | the endpoints above |
| [server/src/auth/mfaService.js](../server/src/auth/mfaService.js) | orchestration |
| [server/src/auth/totp.js](../server/src/auth/totp.js) | RFC 6238 |
| [server/src/auth/mfaCrypto.js](../server/src/auth/mfaCrypto.js) | encryption at rest |
| [server/src/repositories/mfaRepository.js](../server/src/repositories/mfaRepository.js) | persistence |
| [server/scripts/check-mfa-enforcement.js](../server/scripts/check-mfa-enforcement.js) | live policy check |

---

## 18. Session cookies (Phase 9B)

The refresh token is delivered as a cookie. The **access token stays in the
response body** and is held in memory by the client.

### 18.1 Cookies

| Cookie | Attributes | Readable by JS |
|---|---|---|
| `jrp_refresh` | `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`, absolute `Expires` | **no** |
| `jrp_csrf` | `SameSite=Lax`, `Path=/`, absolute `Expires` | yes, deliberately |

`Path=/api/v1/auth` on the refresh cookie keeps a days-long credential off
every other API call. The CSRF cookie is `Path=/` because `document.cookie`
only exposes a cookie whose path is a prefix of the current page — scoping it
to the API made it invisible to the frontend, and every cookie refresh was
then refused as `csrf-rejected`.

### 18.2 How a client chooses a path

| Request | `Origin` present | Response |
|---|---|---|
| browser (cross-origin fetch) | yes | cookie set, **no** `refreshToken` in the body |
| script / CLI / test harness | no | `refreshToken` in the body, no cookie |

A browser always sends `Origin` on a cross-origin fetch, so it cannot land
on the body-token path. Returning both to a browser would put a second,
script-readable copy of the credential beside the `HttpOnly` one.

Applies to `POST /auth/login`, `POST /auth/mfa/challenge`,
`POST /auth/refresh` and `POST /auth/logout`.

### 18.3 Cookie-authenticated requests

`POST /auth/refresh` reads the token from the cookie, or from the body
when there is no cookie. A request that presents a cookie must also:

1. carry an `Origin` in `CORS_ORIGINS` — a **missing** Origin is refused;
2. echo the `jrp_csrf` cookie in `X-CSRF-Token`;
3. present a CSRF token the server issued and has not expired.

| Failure | Status | Code |
|---|---|---|
| missing/unknown Origin | 403 | `csrf-rejected` |
| header absent or mismatched | 403 | `csrf-rejected` |
| token not issued, or expired | 403 | `csrf-rejected` |
| token valid, credential invalid | 401 | `invalid-refresh-token` |

403 rather than 401 so a client can tell "you are not signed in" from
"this request will not be served".

`POST /auth/logout` is **not** CSRF-gated. A forced logout is an
annoyance; refusing it would strand a user in a session they cannot end,
and the token is still verified so a forged request can only end the
caller's own session.

### 18.4 Rotation

The refresh token is single-use and rotates on every successful refresh.
Presenting a spent one is treated as a replay and revokes the whole family.
The cookie is replaced on every response, so a client that ignores the
`Set-Cookie` header will present a spent token on its next refresh and be
signed out — correctly.

### 18.5 Configuration

| Variable | Default | Dev | Production |
|---|---|---|---|
| `AUTH_COOKIE_SECURE` | `true` | `false` | `true` — **required** |
| `AUTH_COOKIE_SAME_SITE` | `Lax` | `Lax` | `Lax`, or `None` if cross-site |

`assertCookieSettingsSafe()` refuses a production boot when
`AUTH_COOKIE_SECURE` is off, when `SameSite=None` is set without
`Secure` (which browsers reject outright), or when the value is not one of
the three known modes.

`AUTH_COOKIE_SECURE=false` is required for local HTTP development: a
`Secure` cookie is not sent over plain HTTP, so refresh fails with no
visible cause and every session appears to expire.

> **Hostnames must match.** A cookie is scoped to a **site**, and
> `127.0.0.1` and `localhost` are different sites even on the same port.
> Browsing via the loopback form while the API is on `localhost`
> discards the session cookie silently.
