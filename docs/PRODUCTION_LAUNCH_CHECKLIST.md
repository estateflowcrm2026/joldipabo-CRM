# Joldipabo / EstateFlow CRM — Production Launch Checklist

Date: 2026-09-24

Status: **not ready for launch.** This checklist is the gate. Every item must be **passing with a documented test** before real users are onboarded.

Read alongside [docs/PRODUCT_PRODUCTION_ROADMAP.md](PRODUCT_PRODUCTION_ROADMAP.md), [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md), and [docs/ENVIRONMENT.md](ENVIRONMENT.md).

---

## How to use this document

Each section is a test area. Mark every item:

- ✓ **Pass** — verified, with the evidence recorded in the PR or runbook.
- ✗ **Fail** — fix and re-test. Not a launch.
- ⚠ **Deferred** — explicitly accepted in writing by the launch owner, with a target date. **A deferral is not a pass.**

The four items marked 🛑 are the ones that are *exploitable or lossy today*. They are not "should fix" — they are "do before anyone else touches this system."

---

## 🛑 Section 0 — Stop-the-line items (verified broken as of 2026-09-24)

These were reproduced during the production audit. Each has a verification command.

**All five 🛑 items are closed** (0.1 across Phases 2 and 3). Migration drift was also closed — see [docs/MIGRATIONS.md](MIGRATIONS.md). Remaining P0s are tracked in §5 and §4: MFA, user onboarding, notification email, and RLS.

### 0.1 Unsigned access tokens are accepted 🛑 — ✅ CLOSED 2026-09-24

`issueAccessToken` built `header.payload.` with an **empty signature**, and `verifyAccessToken` never checked the signature. A token forged by hand was accepted — and because the user lookup keyed on `sub` alone while ignoring `tid`, the same forgery crossed tenants.

- [x] Tokens are HS256-signed; the signature is verified with a constant-time compare
- [x] An unsigned `header.payload.` token is refused
- [x] A token signed with the wrong key is refused
- [x] A rotated secret invalidates previously issued tokens
- [x] Expired, not-yet-valid, wrong-issuer and wrong-audience tokens are refused
- [x] `iss` / `aud` verified, with stable defaults (`estateflow-api` / `estateflow-clients`)
- [x] Claims carry `sub`, `tid`, `rid`, `sid`, `jti`, `iat`, `exp`, `iss`, `aud`
- [x] 28 tests in `server/src/auth/tokenService.test.js`
- [x] Verified against a live production-configured server: all eight attack shapes refused
- [x] User is loaded by `(sub, tid)`, so a cross-tenant token matches no row
- [x] Inactive, suspended, invited and soft-deleted users refused; unknown statuses fail closed
- [x] 19 tests in `server/src/repositories/authRepository.test.js`
- [x] `POST /auth/login` issues a real token pair (Phase 3)
- [x] Refresh rotates with reuse detection; replay revokes the whole family
- [x] 18 tests in `server/src/auth/passwordPolicy.test.js`; 16 in `sessionRepository.test.js`
- [x] 24-assertion flow smoke: `npm run smoke:auth`
- [x] **Closed 2026-09-27:** MFA (TOTP) with hashed backup codes, required for admin/super-admin under `AUTH_MFA_ENFORCE`, and a production boot fails without it. See §3a.
- [ ] **Still open:** invite / accept-invite / forgot / reset-password / OTP are 501, so a real user cannot be onboarded
- [ ] **Still open:** no notification email when a family is revoked for reuse
- [ ] **Still open:** `isBreachSafe` and `isReuseAllowed` return `true` unconditionally
- [ ] **Still open:** no gateway rate limiting (see §2.5)
- [ ] **Still open:** no audit rows for login / refresh / logout / lockout

**Verify closed:**

```bash
cd server
npm test         # tokenService, authRepository, passwordPolicy, sessionRepository
npm run smoke:auth   # 24 assertions, no database required
```

Live check against a production-configured server — every shape must be refused:

```bash
NODE_ENV=production DEV_AUTH_ENABLED=false \
JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
npm start &

node --input-type=module -e "
import { createHmac } from 'node:crypto';
const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const n=Math.floor(Date.now()/1000), S=process.env.JWT_SECRET;
const base={sub:'u-super',tid:'org_acme',iat:n,exp:n+900,iss:'estateflow-api',aud:'estateflow-clients'};
const mk=(c,k)=>{const h=b({alg:'HS256',typ:'JWT'}),p=b(c),i=h+'.'+p;return i+'.'+createHmac('sha256',k).update(i,'ascii').digest('base64url');};
const cases=[
  ['unsigned',        b({alg:'HS256',typ:'JWT'})+'.'+b(base)+'.'],
  ['wrong secret',    mk(base,'attacker-key')],
  ['wrong issuer',    mk({...base,iss:'x'},S)],
  ['expired',         mk({...base,iat:n-7200,exp:n-3600},S)],
  ['cross-tenant',    mk({...base,sub:'u-super',tid:'org_globex'},S)],
];
for (const [name,tok] of cases) {
  const r = await fetch('http://127.0.0.1:4000/api/v1/listings',{headers:{Authorization:'Bearer '+tok}});
  console.log(name.padEnd(15),'->',r.status);
}
"

### 0.2 The role switcher ships to all users 🛑 — ✅ CLOSED 2026-09-24

The switcher is gated behind `VITE_ENABLE_DEMO_ROLE_SWITCHER`, default OFF. See [src/services/demoFlags.js](../src/services/demoFlags.js).

- [x] The role switcher does not appear in a default production build
- [x] It is gated behind a build-time flag, default **off**
- [x] Desktop and mobile obey the same flag
- [x] A "Demo mode" badge appears only when the flag is on
- [x] Parsing is strict: only the exact string `'true'` enables it
- [x] 13 assertions in `src/services/demoFlags.test.mjs`, part of `npm test`

**Verify closed:**

```bash
# Default build: the flag resolves false in the bundle.
npm run build
node -e "const fs=require('fs');const f=fs.readdirSync('dist/assets').find(n=>n.endsWith('.js'));\
const s=fs.readFileSync('dist/assets/'+f,'utf8');const i=s.indexOf('VITE_ENABLE_DEMO_ROLE_SWITCHER');\
console.log(s.slice(i-40,i+40))"
# → ... VITE_ENABLE_DEMO_ROLE_SWITCHER:`true`}[e]===`true`  (absent from the object = OFF)
```

Demo build: `VITE_ENABLE_DEMO_ROLE_SWITCHER=true npm run build` → the flag appears as `` `true` `` in the lookup object.

### 0.3 `DEV_AUTH_OFFLINE_FALLBACK` defaults to `true` 🛑 — ✅ CLOSED 2026-09-24

Setting only `DEV_AUTH_ENABLED=true` used to grant full in-code permission matrices with no database row to back them.

- [x] Default changed to `false` in [server/src/config/index.js](../server/src/config/index.js)
- [x] The server **refuses to boot** when `NODE_ENV=production` and `DEV_AUTH_ENABLED=true` (fails closed, not warns)
- [x] `.env.example` sets it to `false`
- [x] 17 tests in `server/src/config/index.test.js`, including both production refusals

**Verify closed:**

```bash
cd server
NODE_ENV=production DEV_AUTH_ENABLED=true node src/server.js
# → Error: Refusing to start: dev authentication is enabled in production.
```

### 0.4 Offline listing capture silently loses data 🛑 — ✅ CLOSED 2026-09-24

`listing.capture` was missing from `ALLOWED_TYPES` in [src/services/offlineQueue.js](../src/services/offlineQueue.js), so `queueAction` threw and every offline listing capture was dropped.

- [x] `listing.capture` added to `ALLOWED_TYPES`
- [x] 18 assertions in `src/services/offlineQueue.test.mjs` assert every sync-worker handler type is queueable, and that an unknown type throws rather than vanishing
- [x] The test fails if the type is removed again (verified by temporarily removing it)
- [ ] The mobile offline capture path has a browser smoke test

**Verify closed:**

```bash
node src/services/offlineQueue.test.mjs
# → 18 passed, 0 failed.
```

### 0.5 No TLS to the database — ✅ CLOSED 2026-09-24

The pool set no `ssl` option, so any managed Postgres (RDS, Cloud SQL, Neon, Supabase) refused the connection.

- [x] `DB_SSL_MODE` supports `auto` / `disable` / `require` / `verify-full`
- [x] `auto` (default) infers from `DATABASE_URL`'s `sslmode`, so local Docker keeps working with no change
- [x] `require` is refused at boot in production
- [x] `DB_SSL_REJECT_UNAUTHORIZED=false` is refused at boot in production
- [x] `DB_SSL_CA` / `DB_SSL_CA_FILE` for private CAs
- [x] Tests in `server/src/db/sslConfig.test.js`
- [x] Local Docker without SSL still works
- [x] `DATABASE_URL` unset still gives the documented degraded readiness
- [x] A missing, unreadable or empty `DB_SSL_CA_FILE` fails with a message naming the setting, not a bare `ENOENT`
- [x] `npm run db:ssl-check[:connect]` resolves and optionally exercises the TLS config without printing secrets
- [x] `npm run db:fetch-ca` installs the Supabase root CA, fingerprint-pinned

**Verify closed:**

```bash
cd server
npm test                                    # includes sslConfig.test.js
npm run db:ssl-check --connect              # against the production env
DB_SSL_MODE=require NODE_ENV=production node -e "import('./src/db/client.js')"   # → throws
```

### 0.6 Supabase production TLS — ✅ CLOSED 2026-09-27

`verify-full` against Supabase failed with `self-signed certificate in certificate chain`: Supabase's root is in no system trust store, and the pooler presents no certificate this client can verify. Both are now handled rather than worked around.

- [x] Supabase's private chain documented — Root 2021 → Intermediate 2021 → `db.<ref>.supabase.co`
- [x] `DB_SSL_CA_FILE` supplies the root; `resolveSsl` reads and reports on it
- [x] Production uses the **direct** host, not the pooler (the pooler cannot reach `verify-full`)
- [x] `npm run db:fetch-ca` retrieves the root and refuses any fingerprint not pinned in the script
- [x] `server/certs/` is gitignored so a stale CA cannot be committed
- [x] Verified against a live project: `verify-full` + CA connects, and fails clearly without the CA

**Verify closed:**

```bash
cd server
npm run db:fetch-ca -- --host db.<project-ref>.supabase.co   # → certs/supabase-root-2021.pem
DB_SSL_CA_FILE="$PWD/certs/supabase-root-2021.pem" \
  npm run db:ssl-check --connect                            # → connected
```

---

## 1. Build and test gates

### 1.1 Frontend
- [ ] `npm run build` passes
- [ ] No new warnings beyond the known lucide-react `"use client"` module-level-directive notices
- [ ] `node src/services/matchListings.test.js` passes
- [ ] `npm audit --audit-level=high` reports no high/critical issues

### 1.2 Backend
- [ ] `npm run lint` passes (all 38 files)
- [ ] `npm test` passes with **0 failures**
- [ ] The auth test suite is **included** in the `npm test` glob — it was silently excluded (`package.json:14` globs `src/rbac`, `src/db`, `src/repositories`, `src/routes` only)
- [ ] The `setDevAuth` helper's truthiness bug is fixed — `setDevAuth('1','0')` writes `'true'` for the fallback because `'0'` is truthy, causing a real failure when the file is run directly
- [ ] Tests run green **with** `DATABASE_URL` set, not only without
- [ ] `npm run db:migrate` is idempotent; running twice is a no-op
- [ ] `npm run smoke:listings` passes against a live backend
- [ ] `SMOKE_WRITE=1 npm run smoke:listings` passes (full write lifecycle)

### 1.2a CI runs the database — ✅ CLOSED 2026-09-27

DB-integration tests used to skip silently without `DATABASE_URL`, so a green run could mean the database was never touched. Two real defects got through because of it.

- [x] `.github/workflows/ci.yml` runs lint, build, tests, migrations, auth smoke, listings smoke (read + write) and an audit-integrity check
- [x] `REQUIRE_DB=1` turns a would-be skip into a **failure** ([server/src/test-support/requireDb.js](../server/src/test-support/requireDb.js))
- [x] An ephemeral `postgres:16` service runs the database job on every push and PR — no secrets, no shared database
- [x] A Supabase job runs the same checks against a test project, from secrets
- [x] `NODE_ENV=production` refused in CI; `VERIFY_ALLOW_REMOTE=1` only for the throwaway targets
- [x] The database URL is printed with the password masked; no `.env` or certificate is uploaded
- [x] `audit:resign:dry` detects a key mismatch and exits 3 instead of reporting every row as tampered
- [x] The `static` job fails if `server/.env` or any certificate is tracked in git

**Verify closed:**

```bash
cd server
# The gate: no database, so this must fail rather than skip.
REQUIRE_DB=1 npm test     # → FAIL
# With a database it passes and the DB tests actually run.
REQUIRE_DB=1 DATABASE_URL=… npm test
```

Setup, secret names and the full command list:
[docs/SUPABASE_VERIFICATION.md §9](SUPABASE_VERIFICATION.md#9-ci).

### 1.3 Dependency hygiene
- [ ] Frontend dependencies pinned to **exact versions**, not `"latest"`
- [ ] Backend dependencies pinned to **exact versions**
- [ ] `package-lock.json` committed and enforced in CI
- [ ] No `devDependency` ends up in a production image

---

## 2. Environment and secrets

Full detail in [docs/ENVIRONMENT.md](ENVIRONMENT.md).

- [ ] `NODE_ENV=production` in production
- [ ] `AUTH_MFA_ENFORCE=true` in production — **the boot fails without it**
- [ ] `DEV_AUTH_ENABLED=false` in production
- [ ] `DEV_AUTH_OFFLINE_FALLBACK=false` in staging and production
- [ ] `JWT_SECRET` set in staging and production, and **different** between them
- [ ] `DATABASE_URL` set, points at production, and includes `sslmode=verify-full`
- [ ] `DB_SSL_MODE=verify-full` (or unset with the `sslmode` in the URL)
- [ ] `DB_SSL_REJECT_UNAUTHORIZED` is not `false`
- [ ] Supabase: `DATABASE_URL` uses the **direct** host `db.<ref>.supabase.co`, not the pooler
- [ ] Supabase: `DB_SSL_CA_FILE` points at the Supabase **root** CA, present and readable inside the container
- [ ] `npm run db:ssl-check --connect` passes against the production environment
- [ ] `CORS_ORIGINS` is an explicit production origin — **not `*`**, which disables CORS rather than opening it
- [ ] `VITE_DEV_AUTH_TOKEN` unset in every production build
- [ ] `VITE_ENABLE_DEMO_ROLE_SWITCHER` unset in every production build
- [ ] `ESTATEFLOW_ALLOW_RESET` unset in staging and production
- [ ] `.gitignore` excludes `.env`, `.env.*`, `node_modules/`, `dist/`
- [ ] No `.env` file is tracked in git
- [ ] No secret appears in any committed file
- [ ] Secrets live in the platform secrets manager, not in the image or the repo
- [ ] Staging and production use **separate** databases, buckets, and secrets

**Verify:**

```bash
git ls-files | grep -E '\.env$' && echo "FAIL: env file tracked" || echo "ok"
```

---

## 3a. Multi-factor authentication — ✅ CLOSED 2026-09-27

TOTP (RFC 6238) with single-use hashed backup codes. Design: [docs/AUTH_TENANT_SECURITY_PLAN.md §26](AUTH_TENANT_SECURITY_PLAN.md#26-multi-factor-authentication). API: [docs/AUTH_API_SPEC.md §17](AUTH_API_SPEC.md#17-mfa-endpoints).

- [x] TOTP verified against the **RFC 4226 Appendix D** and **RFC 6238 Appendix B** test vectors
- [x] `mfa_secret` stored as **AES-256-GCM ciphertext**; a modified ciphertext fails to decrypt
- [x] Replay defence: `mfa_last_step` refuses a TOTP step that was already spent
- [x] `POST /auth/login` issues **no tokens** for an MFA user — only a 5-minute single-use challenge
- [x] Five wrong codes burn the challenge, so a correct code cannot follow the guesses
- [x] Ten hashed backup codes, single-use, invalidated on regeneration, shown once
- [x] Disabling MFA and regenerating codes both require a **current** second factor
- [x] `AUTH_MFA_ENFORCE=true` required for admin/super-admin; **production boot fails without it**
- [x] Dev auth (`Bearer dev-<role>`) is unaffected and never reaches the MFA path
- [x] Migration 009 burns outstanding challenges when enrolment changes — a pre-enrolment challenge cannot be used after it
- [x] Every MFA event audited: `mfa-setup-started`, `mfa-enabled`, `mfa-disabled`, `mfa-challenge-issued`, `mfa-challenge-passed`, `mfa-challenge-failed`, `mfa-backup-codes-regenerated`
- [x] 45 tests: RFC vectors, encryption, enrolment, challenge, lockout, replay, backup codes, policy, boot guard

**Before launch:**

- [ ] Every `admin` and `super-admin` has **enrolled**, verified with `GET /api/v1/auth/mfa/status`
- [ ] Each has their **backup codes** stored somewhere they can reach without this system
- [ ] `AUTH_MFA_ENFORCE=true` in the production environment
- [ ] The login client was updated to branch on `mfaRequired` — otherwise a correct password shows as an error
- [ ] Documented who can perform the operator recovery path (disable MFA with database access), and how it is requested
- [ ] Key-rotation runbook records that rotating `JWT_SECRET` locks out every MFA user

## 3c. Real sign-in flow — ✅ CLOSED 2026-09-27

Staff can sign in with their own account, complete MFA, stay signed in, and sign out. Design: [AUTH_TENANT_SECURITY_PLAN.md §26](AUTH_TENANT_SECURITY_PLAN.md#26-real-sign-in-flow). API: [AUTH_API_SPEC.md §17](AUTH_API_SPEC.md#17-mfa-endpoints).

- [x] Sign-in screen, responsive, with a 44px tap target and no horizontal overflow on a phone
- [x] MFA challenge screen; `inputMode=numeric` and `autocomplete=one-time-code`
- [x] Invalid credentials, expired challenge, network error, loading and sign-out all handled
- [x] Session restored through `POST /auth/refresh` — **nothing persisted to `localStorage` or `sessionStorage`**
- [x] Identity and permissions read from the backend; the demo role switcher is not rendered
- [x] Demo experience unchanged behind `VITE_ENABLE_DEMO_ROLE_SWITCHER`
- [x] 49 frontend unit tests, including an assertion that no token reaches web storage
- [x] 22 browser assertions in real Chrome, desktop 1280x800 and iPhone 13
- [x] `server/scripts/verify-auth-flow.js` — 47 assertions against the live database

**Before launch:**

- [ ] Every real staff account created through invite, not by hand
- [ ] Every `admin` and `super-admin` has enrolled MFA and stored their backup codes
- [ ] The login screen is reachable without the demo flag set
- [ ] A reload re-authenticating has been accepted as the intended behaviour
- [ ] `CORS_ORIGINS` includes every origin the app is served from — `127.0.0.1:5173` was missing and blocked the flow outright

## 3d. Session survives a reload — ✅ CLOSED 2026-09-29

The refresh token is an `httpOnly` cookie; the access token stays in memory. Design: [AUTH_TENANT_SECURITY_PLAN.md §26](AUTH_TENANT_SECURITY_PLAN.md#26-real-sign-in-flow).

- [x] `jrp_refresh` — HttpOnly, SameSite=Lax, `Path=/api/v1/auth`, absolute expiry
- [x] `jrp_csrf` — readable by JS (it must be echoed), `Path=/`; not a credential alone
- [x] Double-submit CSRF, compared with `timingSafeEqual` against a server-side issued set
- [x] Explicit `Origin` check on cookie-authenticated routes; a **missing** Origin is refused
- [x] Refresh rotates the cookie; the spent one is refused (replay detection verified)
- [x] Concurrent refresh shares one request — the token is single-use
- [x] Logout revokes the session server-side and expires both cookies
- [x] Reload keeps the session, desktop and phone
- [x] Reopening a **new tab** is signed out — the session cookie does not persist
- [x] MFA login establishes the same cookie session as password login
- [x] Non-browser clients still get a body token and no cookie
- [x] `assertCookieSettingsSafe()` refuses a production boot with `Secure` off, or `SameSite=None` without it
- [x] 15 cookie unit tests, 28 live cookie assertions, 36 browser assertions

**Before launch:**

- [ ] `AUTH_COOKIE_SECURE=true` and `AUTH_COOKIE_SAME_SITE` set in the production environment
- [ ] If the app and API are on **different sites** in production, `AUTH_COOKIE_SAME_SITE=None` **and** `AUTH_COOKIE_SECURE=true`, behind HTTPS
- [ ] Every served origin is in `CORS_ORIGINS` **and uses the same hostname as the app** — `127.0.0.1` and `localhost` are different sites to a cookie
- [ ] A cookie-configured HTTPS staging run has been observed surviving a reload

## 3b. Row-level security — 🚧 STARTED 2026-09-28, NOT YET A PROTECTION

Plan: [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md). Design: [AUTH_TENANT_SECURITY_PLAN.md §27](AUTH_TENANT_SECURITY_PLAN.md).

> **RLS is ENFORCING for `listings`, `leads`, `visits` and
> `listing_photos`** as of 2026-09-28. `npm run rls:check` passes 7/7 as
> the app role, and the full listings read and write lifecycle passes
> unchanged. Scope is still four tables — the rest are in §2d of
> [RLS_ROLLOUT_PLAN.md](RLS_ROLLOUT_PLAN.md).

Done:

- [x] Readiness audit: 30 tables, 20 with `tenant_id`, 6 inheriting it, 4 global
- [x] `withTenant()` — transaction-scoped, first statement, fails closed; `withoutTenant()` for pre-auth
- [x] `estateflow_app` role created and granted — non-owner, `NOBYPASSRLS`, DML only, nothing on `schema_migrations`
- [x] `APP_DATABASE_URL` support; **production boot refuses** when absent or when the role bypasses RLS
- [x] `npm run db:app-role:check` — 9 assertions on the live role
- [x] Policies on `listings`, `leads`, `visits`, `listing_photos` with `USING` **and** `WITH CHECK`
- [x] `DB_RLS_MODE` = off (default) / probe / enforce, reconciled on every `db:migrate`
- [x] `probe` mode: RLS on, application unchanged — 368 tests and both smokes pass
- [x] Rollback verified: `DB_RLS_MODE=off` + `npm run db:migrate`
- [x] All 68 existing `tenant_id = $1` predicates retained

Before RLS can be called a protection:

- [x] `estateflow_app` role exists — non-owner, `NOBYPASSRLS` — and is granted
- [x] `APP_DATABASE_URL` set — **development verified**; confirm for production
- [x] `npm run rls:check` passes as that role (7/7, 2026-09-28)
- [x] A production boot refuses a `postgres` runtime role (covered by unit tests)
- [x] Full listings read **and** write lifecycle passes as `estateflow_app`
- [x] `withTenant` / `tenantQuery` wired into the listings repository — 6 write paths, 3 read paths
- [x] `listing_photos` verified under RLS — write plus the correlated `photo_count` subquery on both read paths
- [x] `leads` / `visits` — **no application code exists**, so nothing to wire. Both are 501 stubs; a regression test asserts they still contain no SQL and points here when they grow one.
- [x] `photos` (legacy duplicate of `listing_photos`) **neutralized** — 0 rows, always-false RLS policy, 0 app-role grants, `COMMENT ON TABLE` pointing at `listing_photos` (migration `011-photos-deprecated.sql`)
- [x] `GET /api/v1/photos` names the supported table; `routes/photos.js` documents the two rules for anyone implementing it
- [x] `rls:check` asserts the `photos` denial as the app role (8 assertions, 42501)
- [x] Regression test fails if `routes/photos.js` gains SQL without tenant context
- [ ] Every FUTURE repository (`users`, `teams`, `projects`, `attendance`, and the other 24 granted tables) uses `tenantQuery` / `withTenant` from its first query
- [ ] A product decision on project-scoped media: consolidate on `listing_photos`, or bring `photos` under a real policy and grant deliberately
- [ ] `probe` run in CI for a week with no divergence
- [ ] `withTenant` wired into **every** repository touching a protected table
- [ ] `organisations` / `refresh_sessions` / `login_attempts` decided (pre-auth reads)
- [ ] Six junction tables given a `tenant_id`
- [ ] `audit_log` policy, with a deliberate exemption for the integrity job
- [ ] `DB_RLS_MODE=enforce` in production

## 3. Database and migrations

- [x] `001-schema` and `002-indexes` are **frozen** — never edited again
- [x] The cross-vertical columns stranded by earlier in-place edits are in a new `003-cross-vertical.sql`
- [x] `schema_migrations` records a **checksum**; the runner refuses when an applied file's hash changes
- [x] The runner takes a `pg_advisory_lock`; two concurrent `db:migrate` runs do not both apply
- [x] 13 tests in `server/src/db/migrate.test.js` cover checksums, drift detection, ordering, and manifest integrity
- [x] `npm run verify:migrations` exercises fresh / idempotent / drifted / immutability against a real Postgres
- [x] A static idempotency linter: `node scripts/check-migration-sql.js <file>`
- [x] A local-drift repair guide: [docs/MIGRATIONS.md](MIGRATIONS.md) §3
- [x] The schema header's RLS claim is corrected to match reality
- [ ] **Run `npm run verify:migrations` against a real Postgres and record the result** — needs a localhost `DATABASE_URL`
- [ ] A documented rollback path exists (or an explicit statement that production rollback is restore-from-backup)
- [ ] Large-table indexes use `CREATE INDEX CONCURRENTLY` (requires an explicit non-transactional migration mode)
- [ ] Every domain table has `tenant_id NOT NULL REFERENCES organisations(id)` where applicable
- [ ] Composite tenant FKs exist on `visits`, `listing_matches`, `listing_photos`, `listing_documents`, `refresh_sessions`, `otp_codes`, and all four junction tables
- [ ] `branches.manager_id`, `teams.lead_id`, `projects.manager_id` have real FK constraints
- [ ] Every table has `deleted_at` where soft delete is expected (currently missing on `attendance`, `listing_matches`, `export_jobs`)
- [ ] `version integer` exists on `leads`, `listings`, `visits` for optimistic concurrency

### 3.1 Backups
- [ ] Managed Postgres with **PITR** enabled (≤ 5 min RPO)
- [ ] Nightly `pg_dump` to encrypted, off-site, versioned storage
- [ ] **A restore drill has been performed** — an untested backup is not a backup
- [ ] Documented RPO and RTO, accepted by the business
- [ ] Tenant-scoped restore capability verified
- [ ] Backup monitoring alerts on failure

---

## 4. Tenant isolation

> **RLS is not installed.** No `CREATE POLICY` exists; the policies in `schema.sql` are comments and `app.tenant_id` is read by nothing. Isolation today is application-level `tenant_id = $1` predicates — correct on the listings path, absent on the 501 verticals. `withTenant()` sets the config value transaction-locally so installing RLS is a migration-only change, but it is **not** a control yet. Rollout proposal: [docs/AUTH_TENANT_SECURITY_PLAN.md §23](AUTH_TENANT_SECURITY_PLAN.md). Do not tick the RLS items until the migration has run and a parallel role has proved parity.

- [ ] RLS enabled on all 18 tenant-owned tables
- [ ] A tenant policy exists on each, comparing `tenant_id` to `current_setting('app.tenant_id')`
- [ ] `set_config('app.tenant_id', $1, true)` runs at the start of every request
- [ ] The application DB role has `rolbypassrls = false`
- [ ] A second database role proves test-suite parity under enforced RLS
- [ ] Composite tenant FKs exist on `visits`, `listing_matches`, `listing_photos`, `listing_documents`, `refresh_sessions`, `otp_codes`, and all four junction tables
- [x] The user lookup is keyed by `(sub, tid)`, so a cross-tenant token matches no row
- [x] A cross-tenant `GET` by valid id returns `404 not-found` with no field leakage
- [x] Cross-tenant write is refused, **including** a forged `tenantId` in the body
- [x] A refresh token from another tenant is refused
- [ ] A second tenant exists in staging and has been used to verify every one of the above

```sql
-- Every row must be true. Expect all false until the RLS migration runs.
SELECT relname, relrowsecurity FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname;
```

---

## 5. Authentication and sessions

- [x] `POST /auth/login` verifies an Argon2id hash — no placeholder success
- [x] An incorrect password returns the same response as an unknown user (no enumeration)
- [x] `tenantSlug` optional in a single-tenant deployment; required when two or more organisations exist
- [x] `POST /auth/refresh` rotates the refresh token
- [x] Reusing a revoked refresh token revokes the entire session family and stamps `compromised_at`
- [x] Reuse is detected per family — another device's session is unaffected
- [x] `POST /auth/logout` revokes the presented session and is idempotent
- [x] `POST /auth/logout` requires **no** access token — a client whose token expired can still end the session
- [x] `POST /auth/logout-all` **does** require one — the blast radius is every device
- [x] `GET /security/sessions` lists the caller's own live sessions
- [x] `DELETE /security/sessions/:id` is gated and needs the session's own refresh token
- [x] `POST /security/users/:id/unlock` clears a lockout (admin, `staff:edit`)
- [x] `POST /security/users/:id/revoke-sessions` kills another user's sessions (admin)
- [x] A password reset invalidates every existing session — **blocked: reset-password is 501**
- [x] `users.status = 'Suspended'` takes effect on the next request
- [x] `users.status = 'Inactive'` cannot log in
- [x] Account lockout after 5 failures for 15 minutes, cleared on a successful login
- [x] Per-identifier lockout after 10 failures, covering addresses with no user
- [x] Identifiers are hashed in `login_attempts`, never stored in the clear
- [x] `429` carries `Retry-After`
- [x] Access tokens expire in 15 minutes (± 2 min skew)
- [x] An idle refresh token expires after 7 days
- [x] Every failure path spends the same Argon2id cost, so timing leaks no account state
- [x] Malformed password hashes fail closed rather than throwing
- [x] `crypto.randomUUID()` replaces `Math.random()` for request ids
- [x] MFA (TOTP) is available and required for admin / super-admin — see §3a
- [ ] A trusted device skips MFA for 30 days — `refresh_sessions.trusted` is never populated
- [ ] MFA recovery code works once
- [ ] The user is emailed when a family is revoked for reuse
- [ ] `isBreachSafe` checks the HIBP k-anonymity range
- [ ] `isReuseAllowed` checks the last 5 password hashes
- [ ] Every demo user has `password_hash` NULL in any non-local database
- [ ] A gateway rate limit protects login and refresh (deployment requirement — see §2.5)


---

## 6. Authorisation and roles

- [ ] Every route has both a matrix gate (`requirePermission`) and a row-level check (`assertCanOnRecord`)
- [ ] The frontend and server permission matrices are **identical** — a drift test enforces this
- [ ] The 5 currently-drifting cells are reconciled deliberately (see roadmap §3.4)
- [ ] `POST /sync` is permission-gated **and** re-checks permission per item
- [ ] `GET`/`DELETE /security/sessions` are permission-gated
- [ ] A field executive cannot read or write another user's lead (403)
- [ ] A sales manager sees only their team's leads
- [ ] A site manager sees only their assigned projects
- [ ] Accounts can read reports but cannot mutate sales operations
- [ ] Accounts **cannot see** `checkInLocation` / `checkOutLocation` (field-level stripping)
- [ ] System roles cannot be renamed or deleted by a non-super-admin
- [ ] A role in use by an active user cannot be deleted
- [ ] A permission change takes effect within one access-token TTL
- [ ] A UI-hidden button is also refused by the server (test from browser dev tools)

---

## 7. Audit and history

- [ ] Every `POST` / `PATCH` / `DELETE` writes **exactly one** audit row
- [ ] The audit row is written in the **same transaction** as the mutation
- [ ] A failed audit write rolls the mutation back
- [ ] Coverage includes **role creation, permission matrix edits, user changes, session revocation, unlock, login, and logout** — all currently missing
- [ ] Audit rows carry actor, IP, user agent, and request id
- [ ] Update events carry a per-field before/after diff
- [ ] Every row has a non-null `hmac`; tampering is detectable
- [ ] The app DB role cannot `UPDATE` or `DELETE` `audit_log`
- [ ] GPS coordinates in audit metadata are rounded to 3 decimal places (≈ 110 m)
- [ ] Retention policy defined and archiving implemented
- [ ] Admins can read the audit log; users can read their own activity

---

## 8. File storage

- [ ] Objects live under a `{tenantId}/` key prefix
- [ ] Upload URLs are presigned `PUT`, short-lived, with `Content-Type` bound in the signature
- [ ] The client never chooses the `objectKey`
- [ ] Maximum file size enforced by bucket policy, not the client
- [ ] Download URLs are presigned `GET` with **≤ 900 s** expiry
- [ ] Every URL issuance is audited
- [ ] `GET /photos/:id` returns **metadata only**; the URL field is `null`
- [ ] No public object URL is ever returned
- [ ] **EXIF GPS tags are stripped** from every stored object
- [ ] Thumbnails generated automatically on upload
- [ ] New photos default to `approved = false`
- [ ] Unapproved photos are visible only to uploader, uploader's manager, and the project's site manager
- [ ] Soft-deleted objects are purged after the retention window
- [ ] Orphaned uploads (metadata never confirmed) are purged after 7 days
- [ ] Retention policy documented per asset class
- [ ] The `/photos:presign` route path is fixed (currently registered as a literal colon segment)

---

## 9. Offline and mobile

- [ ] `listing.capture` is in `ALLOWED_TYPES`
- [ ] Every sync-worker handler type is in `ALLOWED_TYPES` (enforced by test)
- [ ] Offline photos persist their blob in IndexedDB — **not** metadata only
- [ ] A photo captured offline survives an app restart
- [ ] Blob records are deleted after a successful upload
- [ ] A failed upload keeps the blob and offers a retry
- [ ] `navigator.storage.persist()` is requested; quota failures degrade visibly
- [ ] The sync worker makes real network calls
- [ ] `startAutoSync()` is actually called on launch and on `online`
- [ ] Flush batch size is capped so a large backlog does not time out
- [ ] Sync status **persists across reload** (currently module memory, so blank after every restart)
- [ ] A failed-items list shows type, time, and reason, with retry and discard
- [ ] Explicit states for offline / syncing / all synced / N failed
- [ ] Conflict detection uses `version` / `If-Match`; the server returns `409` rather than silently overwriting
- [ ] Conflict resolution prompts the user rather than auto-merging
- [ ] Background Sync is treated as an optimisation, not a dependency (iOS Safari lacks it)
- [ ] The manual "Sync pending actions" path always works
- [ ] `POST /sync` honours `Idempotency-Key`; a replayed item creates exactly one row
- [ ] A queued item whose permission was revoked is refused, with no server mutation

### 9.1 PWA
- [ ] Service worker `CACHE_NAME` embeds a build hash and changes between builds
- [ ] Hashed JS/CSS assets are precached, not discovered at runtime
- [ ] A new build evicts the previous cache (currently a hardcoded `'joldipabo-shell-v1'` can never rotate)
- [ ] Manifest includes screenshots for richer install UI
- [ ] Install prompt is captured and surfaced to the user
- [ ] Safe-area insets applied for notched devices
- [ ] Offline shell is regenerated per build

---

## 10. Communication and notifications

- [ ] Internal threads and messages persist to Postgres
- [ ] A **lead follow-up log** exists as a real relation (today the UI greps message text for the lead's name)
- [ ] `call_logs` table with duration, disposition, and notes
- [ ] Telecallers can record a call against a lead
- [ ] WhatsApp deep links work and prefill a message
- [ ] Message templates exist per tenant before any Business API work
- [ ] Transactional email configured (visit reminders, export-ready)
- [ ] Push notifications scoped and rate-limited
- [ ] Users can see why they were notified, from a persistent in-app list

---

## 11. Reporting

Every report below must respect RBAC scope **in SQL**, not in the client.

- [ ] Lead funnel with stage-to-stage conversion
- [ ] Inventory by category
- [ ] Field staff productivity
- [ ] Attendance punctuality
- [ ] Site visit conversion
- [ ] Listing collection performance
- [ ] Match-to-visit conversion
- [ ] Overdue follow-ups
- [ ] A field executive's report contains only their own data
- [ ] A sales manager's report contains only their team's data
- [ ] Heavy reports run against a read replica
- [ ] Exports are async via `export_jobs`, rate-limited, and audited
- [ ] Exports omit PII outside the caller's scope
- [ ] Exports carry `__exported_at` / `__exported_by`

---

## 12. Deployment and operations

### 12.1 Infrastructure
- [ ] Frontend on a CDN behind a WAF
- [ ] Backend in a container on a managed platform
- [ ] Postgres managed with PITR
- [ ] Object storage with versioning and lifecycle rules
- [ ] TLS terminated at the edge; app-to-DB over TLS (**`ssl` is currently absent from the pool**)
- [ ] Separate staging and production for every component

### 12.2 Pool and database resilience
- [x] `ssl` resolved per environment via `DB_SSL_MODE`, with production refusing the unsafe modes
- [x] `statement_timeout` set (`DB_STATEMENT_TIMEOUT_MS`)
- [x] `lock_timeout` set (`DB_LOCK_TIMEOUT_MS`)
- [ ] `application_name` set
- [ ] Retry on `40001` / `40P01`
- [ ] `/ready` returns **503** when `DATABASE_URL` is unset in production (currently 200 — a misconfigured deploy passes readiness forever)
- [ ] `closeDb()` race fixed (a concurrent `getDb()` can construct a second pool)

### 12.3 CI/CD
- [ ] PR pipeline: build + lint + test + `npm audit` on both apps
- [ ] Matrix-drift test runs on every PR
- [ ] Migrations run as a **separate explicit step**, never automatically with the app deploy
- [ ] Staging deploy runs the smoke suite automatically
- [ ] Manual approval gate before production
- [ ] Rollback procedure documented and rehearsed

### 12.4 Observability
- [ ] Error monitoring (Sentry) on frontend and backend
- [ ] Structured JSON logs shipped and retained ≥ 90 days
- [ ] External uptime probe on `/health` and `/ready`
- [ ] Database pool saturation and slow-query alerting
- [ ] Frontend Web Vitals collection
- [ ] Alerting on sustained sync failures

### 12.5 Runbook
- [ ] Deploy / rollback procedure
- [ ] Migration procedure and rollback path
- [ ] Restore drill procedure
- [ ] Incident response: severity levels, escalation path
- [ ] Credential rotation (JWT secret, DB password, storage keys)
- [ ] User offboarding: revoke sessions, deactivate, retain or purge
- [ ] Tenant offboarding and data export

### 12.6 Hardening
- [ ] `@fastify/rate-limit` wired to the existing `RATE_LIMIT_*` config
- [ ] `@fastify/helmet` with HSTS, CSP, and `X-Content-Type-Options`
- [ ] JSON-Schema validation on every route
- [ ] OpenAPI exposed
- [ ] `scopeFilterFor` table interpolation escaped (safe today — one literal caller — but a trap for the next)
- [ ] Rate limit on `/auth/login` specifically (brute force)
- [ ] Request body size limit explicit

---

## 13. Accessibility and UX for daily use

- [ ] `Modal` moves focus into the dialog on open
- [ ] `Modal` traps Tab within the dialog
- [ ] `Modal` restores focus to the trigger on close
- [ ] `Drawer` and `MobileDrawer` handle Escape
- [ ] `MobileDrawer` has `role="dialog"` and `aria-modal`
- [ ] Tables use `role="cell"` / `role="columnheader"`, not just `role="row"`
- [ ] Tab bar sets `aria-current` / `aria-selected`
- [ ] Every async view has a loading state (`LoadingState` exists and is currently unused)
- [ ] Every async view has an error state with a retry
- [ ] Form fields set `aria-invalid` and `aria-required` on failure
- [ ] Numeric fields have min/max validation
- [ ] Non-functional affordances removed: the global search box, the `⌘K` badge, notification buttons, dashboard CTAs
- [ ] `window.prompt` / `window.confirm` replaced with real UI
- [ ] Attendance GPS denial is **never** recorded as a successful check-in
- [ ] Navigate links use real coordinates, not prose strings

---

## 14. Performance

- [ ] Lists virtualized (field lists will exceed 1 000 rows)
- [ ] Bundle split by route
- [ ] Queue polling is event-driven, not a 4-second interval
- [ ] N+1 lookups in render paths hoisted
- [ ] Load test at 2 000 leads / 500 listings / 50 concurrent users
- [ ] Latency target met at 2× expected peak

---

## 15. Pilot and rollout

- [ ] Pilot with 3–5 real users for **2 weeks minimum**
- [ ] Zero P0 defects during the pilot
- [ ] P1 defects triaged with a fix-or-accept decision recorded
- [ ] Field staff have used offline mode on real poor-signal connections
- [ ] At least one real photo upload and one real sync round-trip completed
- [ ] Users have read the training material
- [ ] Support contact published
- [ ] Rollback plan communicated to pilot users

### Rollout gates
- [ ] All four 🛑 Section 0 items closed
- [ ] [SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) sections 1–10 all pass or are formally deferred with sign-off
- [ ] A restore drill has been performed and documented
- [ ] A second tenant exists in staging with cross-isolation verified

---

## 16. Sign-off

| Section | Responsible | Date | Result |
|---------|-------------|------|--------|
| 0. Stop-the-line | Engineering lead | _____ | ☐ all 5 closed |
| 1. Build and test | Engineering lead | _____ | ☐ |
| 2. Environment and secrets | Engineering lead | _____ | ☐ |
| 3. Database and migrations | Backend lead | _____ | ☐ |
| 4. Tenant isolation | Backend lead | _____ | ☐ |
| 5. Authentication | Auth lead | _____ | ☐ |
| 6. Authorisation | Backend lead | _____ | ☐ |
| 7. Audit and history | Backend lead + Compliance | _____ | ☐ |
| 8. File storage | Backend lead + Privacy reviewer | _____ | ☐ |
| 9. Offline and mobile | Mobile lead | _____ | ☐ |
| 10. Communication | Product owner | _____ | ☐ |
| 11. Reporting | Product owner | _____ | ☐ |
| 12. Deployment and operations | Engineering lead | _____ | ☐ |
| 13. Accessibility and UX | Design + Engineering | _____ | ☐ |
| 14. Performance | Engineering lead | _____ | ☐ |
| 15. Pilot and rollout | Product owner | _____ | ☐ |

**Launch decision:** ☐ Go  ☐ No-Go

**Signed:** ____________________  **Date:** ____________

---

## 17. Related documents

- [docs/PRODUCT_PRODUCTION_ROADMAP.md](PRODUCT_PRODUCTION_ROADMAP.md) — what to build, in what order
- [docs/ENVIRONMENT.md](ENVIRONMENT.md) — env var matrix per environment
- [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) — the 10-section security gate
- [docs/BACKEND_SCAFFOLD_STATUS.md](BACKEND_SCAFFOLD_STATUS.md) — what is wired in `server/`
- [server/README.md](../server/README.md) — backend runbook
