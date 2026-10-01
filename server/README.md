# Joldipabo CRM — Backend Scaffold

> **Status:** scaffold only. Not production-ready. See `docs/BACKEND_SCAFFOLD_STATUS.md` for what is wired and what is still placeholder.

This folder is the future backend for Joldipabo CRM. It mirrors the data model in [`docs/DATA_MODEL.md`](../docs/DATA_MODEL.md), the permission model in [`src/data/permissions.js`](../src/data/permissions.js), and the endpoint contract in [`docs/BACKEND_INTEGRATION_PLAN.md §7`](../docs/BACKEND_INTEGRATION_PLAN.md). The frontend (`/src`) does not talk to it yet — that switchover is documented in [`docs/BACKEND_INTEGRATION_PLAN.md §8`](../docs/BACKEND_INTEGRATION_PLAN.md).

---

## Install

```bash
cd server
npm install
```

Runtime dependencies are **Fastify 4** and **`pg`** (raw Postgres driver, no ORM). The app boots with or without a database: when `DATABASE_URL` is unset, `GET /ready` reports `not-configured` and any DB query fails with a clear error instead of crashing. SQL files in `src/db/` are applied by the migration runner below.

If you do not have Node 20+ on the path, install it via `nvm`, `fnm`, or your platform package manager before running `npm install`. The `engines` field in `package.json` will fail `npm install` on older versions.

## Run

```bash
# from the server/ folder
npm start
# or, with auto-reload (Node 20+):
npm run dev
```

The server listens on `http://HOST:PORT` from the environment, defaulting to `http://0.0.0.0:4000`.

A health endpoint is exposed at `GET /health` and returns `{ status: 'ok' }` with a 200. A readiness endpoint at `GET /ready` probes Postgres:

| `DATABASE_URL` | DB state | `GET /ready` |
| --- | --- | --- |
| unset | — | `200 { status: 'ok', database: 'not-configured' }` |
| set | reachable | `200 { status: 'ok', database: 'connected' }` |
| set | down | `503 { error: { code: 'database-unavailable', ... } }` |

## Local Postgres

Any Postgres 16 works. The fastest local option is Docker:

```bash
docker run -d --name estateflow-pg \
  -e POSTGRES_USER=estateflow \
  -e POSTGRES_PASSWORD=estateflow \
  -e POSTGRES_DB=estateflow \
  -p 5432:5432 \
  postgres:16

export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow
```

Or install Postgres natively and create the role/database by hand:

```bash
createdb estateflow
export DATABASE_URL=postgres://estateflow@localhost:5432/estateflow
```

## Database commands

```bash
npm run db:migrate        # apply pending migrations (idempotent, checksummed)
npm run db:seed           # migrate, then load seed-demo.sql (skips if already seeded)
npm run db:reset          # DROP schema + re-migrate. Guarded: requires
                          # ESTATEFLOW_ALLOW_RESET=yes AND a localhost DATABASE_URL.
npm run verify:migrations # end-to-end migration checks against a local Postgres
```

Examples:

```bash
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow
npm run db:migrate
npm run db:seed      # loads the demo tenant, roles, teams, projects, users
ESTATEFLOW_ALLOW_RESET=yes npm run db:reset   # local dev only
```

### Migrations are checksummed and locked

`schema_migrations` records `(name, checksum, applied_at)`. On every run the runner re-hashes each applied file and **refuses to migrate if one has changed**, naming the file. Editing a shipped migration is a loud error, not silent drift — which is exactly what happened on 2026-09-23, when `001-schema` was edited in place after being applied and existing databases silently missed the new columns.

The runner also holds a `pg_advisory_lock` for the duration, so two concurrent deploys cannot both migrate.

**`001-schema.sql` and `002-indexes.sql` are FROZEN.** Put new schema changes in a new numbered file and append it to `MIGRATIONS` in [src/db/migrate.js](src/db/migrate.js). `003-cross-vertical.sql` is the repair migration for the in-place edit; it is idempotent and only adds.

Repair procedures for local drift, the rules for adding a migration, and the `CREATE INDEX CONCURRENTLY` caveat: [docs/MIGRATIONS.md](../docs/MIGRATIONS.md).

`seed-demo.sql` uses plain `INSERT`s and is not re-runnable — `db:seed` skips when `organisations` already has rows.

## Postgres TLS

Managed Postgres providers (RDS, Cloud SQL, Neon, Supabase) refuse cleartext connections. `DB_SSL_MODE` decides what the pool asks for:

| `DB_SSL_MODE` | Encrypted? | Peer verified? | Use for |
|---|---|---|---|
| unset (`auto`) | Inferred from `DATABASE_URL`'s `sslmode` | Inferred | Default; local Docker needs no change |
| `disable` | No | n/a | Loopback only |
| `require` | Yes | **No** | Staging on a trusted network |
| `verify-full` | Yes | Yes | **Production** |

```bash
# Local Docker — no configuration needed, auto resolves to disable
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev

# Production
export DATABASE_URL='postgres://…@db.example.com:5432/estateflow?sslmode=verify-full'
export DB_SSL_MODE=verify-full
```

Two settings are **refused at boot when `NODE_ENV=production`**, because both silently drop the guarantee they appear to provide: `DB_SSL_MODE=require` (encrypted, but nothing proves the peer is the database you meant) and `DB_SSL_REJECT_UNAUTHORIZED=false` (verification off entirely). For a private CA, use `DB_SSL_CA_FILE` rather than disabling verification.

### Supabase

Supabase uses a private CA, so `verify-full` needs `DB_SSL_CA_FILE` to point at
the root. It also has to be the **direct** host in production — the pooler
terminates the Postgres protocol before TLS and presents no certificate this
client can verify.

```bash
# Dev / testing — Session Pooler, encrypted, unverified. No CA needed.
export DATABASE_URL='postgresql://postgres.REF:PASS@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require'
export DB_SSL_MODE=require

# Production — direct host, fully verified.
npm run db:fetch-ca -- --host db.REF.supabase.co     # → certs/supabase-root-2021.pem
export DATABASE_URL='postgresql://postgres:PASS@db.REF.supabase.co:5432/postgres'
export DB_SSL_MODE=verify-full
export DB_SSL_CA_FILE="$PWD/certs/supabase-root-2021.pem"
export DB_SSL_REJECT_UNAUTHORIZED=true

npm run db:ssl-check:connect                          # verify before deploying
```

`db:fetch-ca` is fingerprint-pinned and refuses to write a root it does not
expect. `db:ssl-check` resolves the TLS settings and prints the target with the
password masked; `--connect` also opens a real connection. Neither reads
`JWT_SECRET`. Full procedure: [docs/SUPABASE_VERIFICATION.md §5](../docs/SUPABASE_VERIFICATION.md).

Resolution lives in [src/db/sslConfig.js](src/db/sslConfig.js); tests in `src/db/sslConfig.test.js` cover it.

## Verification scripts

| Command | What it does |
|---|---|
| `npm run verify:migrations` | fresh / idempotent / drifted / immutable migration scenarios in throwaway targets |
| `npm run smoke:auth-db` | invite, accept, login, refresh+reuse, logout, reset, lockout, audit — against a real database |
| `npm run smoke:listings` | HTTP read lifecycle; add `SMOKE_WRITE=1` for the full CRUD lifecycle |
| `npm run db:ssl-check` | resolve TLS settings and print the masked target; add `--connect` to actually connect |
| `npm run db:fetch-ca` | download the Supabase root CA (fingerprint-pinned) |
| `npm run audit:resign:dry` | report audit rows whose signature does not verify |

The two writing scripts refuse any non-localhost host unless `VERIFY_ALLOW_REMOTE=1` is set, and refuse `NODE_ENV=production` outright. See [docs/SUPABASE_VERIFICATION.md](../docs/SUPABASE_VERIFICATION.md).

## Sign-in

Sign in with a real account at `/` when the demo flag is off:

```bash
VITE_ENABLE_DEMO_ROLE_SWITCHER=false npm run dev
```

The screen is responsive — a 44px tap target, no horizontal overflow, and
the MFA field asks for a numeric keypad with
`autocomplete="one-time-code"`.

```bash
# the two throwaway accounts the flow is tested with
node --env-file=.env scripts/seed-auth-test-users.js   # or --fresh to re-enrol MFA
node --env-file=.env scripts/verify-auth-flow.js        # 47 assertions, live
node --env-file=.env ../scripts/browser-smoke-auth.mjs  # 22 assertions, real Chrome
```

`mfa-off@acme.example` has no second factor; `mfa-on@acme.example`
does. The password is `DEMO_PASSWORD` from `.env`. The seed script
writes the TOTP secret to an ACL-restricted temp file and every consumer
deletes it in a `finally`.

**The session survives a reload.** The refresh token is an `httpOnly`
cookie, so the browser still holds it after a reload and startup restores
through `POST /auth/refresh`, which rotates it. The **access token stays
in memory** in [src/services/authSession.js](../src/services/authSession.js)
and is never persisted — not to `localStorage`, `sessionStorage` or
IndexedDB.

```bash
npm run verify:cookie-session    # 28 assertions: attributes, CSRF, rotation, logout
```

Cookie-authenticated requests must carry `X-CSRF-Token` (read from the
readable `jrp_csrf` cookie) and a recognised `Origin`. A request with a
cookie and no Origin is refused — a cross-site form post always carries
one, so its absence means a non-browser client.

| Variable | Dev | Production |
|---|---|---|
| `AUTH_COOKIE_SECURE` | `false` | `true` — **required**, or boot fails |
| `AUTH_COOKIE_SAME_SITE` | `Lax` | `Lax`, or `None` if cross-site |

> **The hostname must match.** `127.0.0.1:5173` and `localhost:5173`
> are different **sites** to a cookie, so browsing via the loopback form
> while the API is on `localhost` silently discards the session cookie
> and every reload signs you out. The browser smoke uses `localhost`
> for this reason.


The demo build is unaffected: with `VITE_ENABLE_DEMO_ROLE_SWITCHER=true`
there is no sign-in screen and the seeded identity is used, as before.

## Row-level security (in progress)

Tenant isolation is enforced by `tenant_id = $1` predicates in the
repositories, and now by database policies on `listings`, `leads`,
`visits` and `listing_photos` — **when the server connects as a
non-owner role**. Postgres exempts the table owner from RLS, and exempts
any role with `BYPASSRLS` twice over, so a role that owns the tables
makes every policy inert. Plan:
[docs/RLS_ROLLOUT_PLAN.md](../docs/RLS_ROLLOUT_PLAN.md).

### Two connection strings

| Variable | Used by | Role |
|---|---|---|
| `DATABASE_URL` | `db:migrate`, `db:seed`, `db:reset`, admin scripts | owner |
| `APP_DATABASE_URL` | **the running server** | `estateflow_app` |

`APP_DATABASE_URL` is optional — when unset the server falls back to
`DATABASE_URL`, so local development is unchanged. A **production boot
fails** without it, or with a `postgres` / `supabase_admin` /
`service_role` username, because those roles would make the policies
enforce nothing.

```bash
npm run db:app-role -- --create                    # role + least-privilege grants
npm run db:app-role:check                          # verify; safe in CI
npm run db:app-role -- --rotate-password --write-env   # writes APP_DATABASE_URL
```

The role gets DML on 29 application tables and nothing else: no
`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, no ownership, and nothing on
`schema_migrations`. A compromised process cannot change its own schema,
so it cannot turn RLS off.

On Supabase, `ALTER ROLE` is refused for a non-`supabase_admin` session
by a `supautils` hook; attribute changes need the SQL editor. The script
detects and reports that rather than failing silently.

### Proving it

```bash
npm run rls:check        # connects as APP_DATABASE_URL and asks six questions
```

It asks whether tenant A can read tenant B, whether A can update or
insert into B, whether anything is visible with no tenant set — and
whether A can still read its OWN rows, which is the check a too-strict
policy fails. It writes nothing: every statement is rolled back.

### What a repository has to do

A policy reads `current_setting('app.tenant_id')`, which is
transaction-scoped. A repository that issues a single statement through
the pool has **no transaction of its own**, so it has nowhere to put the
context — and with RLS enabled it silently sees zero rows and every
INSERT is rejected. That presents as an empty database, which is the most
misleading symptom available.

```js
// one statement
const rows = await tenantQuery(user, sql, params);

// or a block, for anything multi-statement
return withTenant({ tenantId: user.tenantId }, async (client) => {
  await client.query(...);
  await client.query(...);
});
```

`listingsRepository` is the reference implementation. `leads` and
`visits` carry RLS policies but have no application code yet, so nothing
exercises them until they are built — at which point they must use these
helpers from the first query. See
[docs/RLS_ROLLOUT_PLAN.md](../docs/RLS_ROLLOUT_PLAN.md) §1.

`DB_RLS_MODE` controls the gate, and `npm run db:migrate` reconciles it
every run — so the rollback is one variable plus one command:

| Mode | Effect |
|---|---|
| `off` (default) | no RLS. Exactly the previous behaviour. |
| `probe` | RLS on, application must behave identically. CI runs this. |
| `enforce` | RLS live. Needs a non-owner, non-BYPASSRLS role first. |

```bash
npm run db:migrate                      # apply the current mode
DB_RLS_MODE=probe npm run db:migrate    # enable and assert nothing changes
npm run test:rls                        # policy + mode unit tests
npm run rls:check                       # live proof: needs RLS_CHECK_ALLOW_ROLE_CREATE=1
```

`rls:check` creates a throwaway non-owner role, proves tenant A cannot read,
update or insert into tenant B, and drops it. It is opt-in and refuses
`NODE_ENV=production`.

`withTenant({ tenantId }, fn)` sets `app.tenant_id` transaction-scoped as
the first statement, and refuses to run without a tenant. `withoutTenant(fn)`
is for the pre-auth paths, which genuinely have no tenant yet.

## Multi-factor authentication

TOTP (RFC 6238, SHA-1, 6 digits, 30s, issuer `Joldipabo CRM`) with single-use hashed backup codes. Full design: [docs/AUTH_TENANT_SECURITY_PLAN.md §26](../docs/AUTH_TENANT_SECURITY_PLAN.md).

`mfa_secret` is AES-256-GCM ciphertext, with the key derived from `JWT_SECRET`. **Rotating `JWT_SECRET` invalidates every stored TOTP secret and locks out every MFA user** — there is no re-issue path short of `POST /auth/mfa/disable` with database access.

```bash
# Start enrolment — returns the otpauth:// URI and the base32 secret
curl -X POST localhost:4000/api/v1/auth/mfa/setup -H "authorization: Bearer $TOKEN"

# Confirm a code from the authenticator; returns the backup codes ONCE
curl -X POST localhost:4000/api/v1/auth/mfa/verify-setup -H "authorization: Bearer $TOKEN"   -H 'content-type: application/json' -d '{"code":"123456"}'
```

Once enabled, `POST /auth/login` returns `{ mfaRequired: true, challengeToken }` and **no tokens**. Complete it at `POST /auth/mfa/challenge`. Clients that read `.accessToken` without checking `mfaRequired` will show a correct password as an error — see [docs/AUTH_API_SPEC.md §17.7](../docs/AUTH_API_SPEC.md).

`AUTH_MFA_ENFORCE=true` requires MFA for `admin` and `super-admin`, and **a production boot fails without it**. Other roles may enrol but are not required.

`DEV_AUTH_ENABLED=true` bypasses MFA entirely — it short-circuits in `authMiddleware.js` and never reaches the MFA code. Production refuses to boot with dev auth on, so the two cannot both be active.

Check the policy against a real database (reads only; the probe user is rolled back):

```bash
AUTH_MFA_ENFORCE=true DEMO_PASSWORD=… node --env-file=.env scripts/check-mfa-enforcement.js
```

### Verification

```bash
npm run seed:auth-test-users -- --fresh   # the two test accounts
npm run verify:auth-flow                 # 47 assertions, live
npm run verify:cookie-session            # 28 assertions, live
node --env-file=server/.env scripts/browser-smoke-auth.mjs   # 36, real Chrome
```

### CI

`.github/workflows/ci.yml` runs lint, build, tests, migrations, both smokes and an audit-integrity check on every push. The database job uses an ephemeral `postgres:16` service, so it needs no secrets and cannot touch a shared database. A Supabase job runs the same checks — including production `verify-full` TLS — from repository secrets.

The DB-integration tests skip when `DATABASE_URL` is absent. `REQUIRE_DB=1` turns that into a **failure**, so a green CI run cannot mean the database was untested:

```bash
REQUIRE_DB=1 DATABASE_URL=… npm test    # in CI
REQUIRE_DB=1 npm test                     # locally, with no DB: must FAIL
```

`JWT_SECRET` must be stable across runs. The audit signing key is derived from it, so changing it makes every pre-existing row unverifiable; the CI job therefore checks only the rows it wrote, using `npm run audit:resign:dry -- --since <timestamp>`.

Setup and the full secret list: [docs/SUPABASE_VERIFICATION.md §9](../docs/SUPABASE_VERIFICATION.md).

## Environment variables

All variables are read once at startup. Anything missing uses the default in parentheses.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `4000` | HTTP port. |
| `LOG_LEVEL` | `info` | Fastify logger level. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `DATABASE_URL` | *(unset)* | Postgres connection string. Not required to boot the scaffold today — logging a warning is enough. |
| `JWT_SECRET` | *(unset)* | HS256 signing key. **Required in production**, minimum 32 characters, must not be a placeholder. `src/server.js` refuses to boot otherwise. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `JWT_ISSUER` | `estateflow-api` | `iss` claim. Verified on every token; changing it invalidates existing tokens. |
| `JWT_AUDIENCE` | `estateflow-clients` | `aud` claim. Verified on every token. |
| `JWT_MIN_SECRET_LENGTH` | `32` | Minimum production key length. Set `0` only for a throwaway staging box. |
| `JWT_DEV_FALLBACK_SECRET` | *(built-in dev value)* | Used only when `DEV_AUTH_ENABLED=true` and no `JWT_SECRET` is set, and never in production. |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access-token lifetime, in seconds. |
| `REFRESH_TTL_SECONDS` | `604800` | Refresh-token lifetime, in seconds. |
| `RATE_LIMIT_READ_PER_MIN` | `100` | Read rate limit per user. |
| `RATE_LIMIT_WRITE_PER_MIN` | `30` | Write rate limit per user. |
| `DB_SSL_MODE` | `auto` | Postgres TLS: `auto` \| `disable` \| `require` \| `verify-full` | `auto` infers from `DATABASE_URL`'s `sslmode`. **`require` is refused in production.** See "Postgres TLS" above. |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Verify the server certificate | Self-signed staging escape hatch. **Refused in production.** |
| `DB_SSL_CA` | *(unset)* | Inline CA bundle (PEM) | For private CAs. |
| `DB_SSL_CA_FILE` | *(unset)* | Path to a CA bundle on disk | Required for Supabase production. Preferred over `DB_SSL_CA`. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout | Prevents a runaway query pinning a pool slot. |
| `DB_LOCK_TIMEOUT_MS` | `10000` | Lock acquisition timeout | Stops a migration deadlocking against live traffic. |
| `DB_POOL_MAX` | `10` | Maximum pool connections | |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5180,http://127.0.0.1:5180` | Comma-separated allowed origins. |
| `DEV_AUTH_ENABLED` | `false` | Enables the `Bearer dev-<role>` shortcut. **Production must keep this off** — the server refuses to boot with it on. |
| `DEV_AUTH_OFFLINE_FALLBACK` | `false` | When dev auth is on but `DATABASE_URL` is unset, fall back to in-code matrix defaults so RBAC still passes. **Default flipped from `true` to `false` on 2026-09-24**: a `true` default meant setting only `DEV_AUTH_ENABLED=true` granted full permission matrices with no database row behind them. Opt in explicitly if you want it. |
| `DEV_AUTH_TENANT_ID` | `org_acme` | Tenant that dev users resolve into when the DB is offline. |
| `SMOKE_BASE_URL` | `http://127.0.0.1:4000` | Override the target used by `npm run smoke:listings`. |

A `.env.example` is provided at the project root of this folder. **Do not commit real secrets.**

> **Nothing loads a `.env` file.** There is no `dotenv` dependency and the npm scripts do not pass `--env-file`, so copying `.env.example` to `.env` and running `npm start` will **silently ignore it**. Use `node --env-file=.env src/server.js`, `export $(grep -v '^#' .env | xargs)`, or your platform's environment injection.

### 🛑 Production boot guards

`src/server.js` calls `assertSafeToStart()` before binding a port. With `NODE_ENV=production` the server **refuses to boot** when:

- `DEV_AUTH_ENABLED=true` — the `Bearer dev-<role>` shortcut is a full privilege bypass, and the valid role keys are published in this README.
- `JWT_SECRET` is unset or whitespace — without a signing key the server cannot verify access tokens.
- `JWT_SECRET` is shorter than 32 characters — HS256 is a MAC, so the key is the whole security boundary; a short key is brute-forceable offline. Override with `JWT_MIN_SECRET_LENGTH` for a throwaway staging box only.
- `JWT_SECRET` is a recognised placeholder (`changeme`, `replace-me…`, `password`, …). Padding one to 40 characters does not pass.

All four fail closed with an actionable message rather than warning, so a misconfigured deploy stops instead of serving. Development and staging are unaffected. Covered by `src/config/index.test.js`.

See [docs/ENVIRONMENT.md](../docs/ENVIRONMENT.md) for the full per-environment variable matrix.

### Access tokens

Signed HS256 JWTs, verified for signature (constant-time), issuer, audience, expiry and `iat` skew. Claims: `sub`, `tid`, `rid`, `sid`, `jti`, `iat`, `exp`, `iss`, `aud`.

The permission matrix is deliberately **not** in the token — it is re-read from Postgres on every request, so a role change takes effect inside the 15-minute window instead of surviving until expiry.

```bash
# Mint one (used by tests; /auth/login does this for real)
node --input-type=module -e "
import { issueAccessToken } from './src/auth/tokenService.js';
const { token } = issueAccessToken({ sub:'u-asha', tid:'org_acme', rid:'field-executive' });
console.log(token);
"
```

Full contract: [docs/AUTH_API_SPEC.md §0](../docs/AUTH_API_SPEC.md).

### Logging in

```bash
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
npm run db:migrate
npm run db:seed
npm run seed:dev-credentials   # LOCAL ONLY — see below

curl -s localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"tenantSlug":"acme","email":"asha@acme.example","password":"DemoJoldipabo!2026"}'
```

Returns an `accessToken` (15 min) and a `refreshToken` (7 days). `POST /api/v1/auth/refresh` rotates the refresh token; replaying an already-rotated one revokes the whole session family.

#### 🛑 Demo credentials are local-only

`npm run seed:dev-credentials` sets a known password on every user in the demo tenant so the login flow is usable immediately. The script **refuses any `DATABASE_URL` that is not localhost**, and refuses a database containing any organisation other than the demo tenant. The equivalent SQL is [src/db/005-seed-dev-credentials.sql](src/db/005-seed-dev-credentials.sql), which bails unless the tenant slug is `acme`.

Before a real launch, clear them:

```sql
UPDATE users SET password_hash = NULL, failed_login_count = 0, locked_until = NULL
 WHERE tenant_id = (SELECT id FROM organisations WHERE slug = 'acme');
```

### Onboarding a real user

Nothing but the seed can exist until this lands. With SMTP configured:

```bash
# As an admin (requires staff:create):
curl -X POST localhost:4000/api/v1/auth/invite \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantSlug":"acme","email":"new.hire@acme.example","name":"New Hire","roleId":"field-executive","teamId":"t_north"}'

# They follow the emailed link and set a password:
curl -X POST localhost:4000/api/v1/auth/accept-invite \
  -H 'Content-Type: application/json' \
  -d '{"token":"<from the email>","password":"..."}'

# Forgotten password — does not reveal whether the account exists:
curl -X POST localhost:4000/api/v1/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"tenantSlug":"acme","email":"new.hire@acme.example"}'
```

With no SMTP configured the link is printed to the log and readable from `GET /api/v1/auth/dev/outbox` — which returns `501` in production, because an unauthenticated endpoint serving live reset tokens is a takeover primitive.

Every token is stored hashed, single-use, and time-boxed (invite 7 days, reset 1 hour). Accepting an invite activates the account; resetting a password also revokes **every** session for that user, so whoever held the old one loses access immediately.

Set `AUTH_INVITES_ENABLED=false` or `AUTH_RESETS_ENABLED=false` to switch either flow off — useful before SMTP is configured, so nobody expects a link that will never arrive.

### Password hashing

Argon2id (`argon2` native module) at the OWASP minimum — 19 MiB, t=2, p=1. Stored in self-describing PHC format so the cost parameters travel with the hash; `needsPasswordRehash` upgrades a weaker hash on the next successful login, so raising the policy costs no migration.

Argon2id was chosen over the `node:crypto` scrypt fallback after verifying the native module builds here: OWASP ranks Argon2id first, scrypt is an acceptable alternative, and Argon2id is hybrid — it resists both side-channel and GPU/parallel cracking. Override with `PASSWORD_MEMORY_COST`, `PASSWORD_TIME_COST`, `PASSWORD_PARALLELISM`.

## Local smoke test

End-to-end check against a real Postgres: bring up the DB, migrate + seed, start the server, then run the smoke script. The script is a client — it does not launch the server.

```bash
# 1. Postgres (Docker Compose, persistent named volume)
cd server
docker compose up -d            # postgres:16 on 127.0.0.1:5432, db=estateflow_dev

# 2. Environment
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
export DEV_AUTH_ENABLED=true    # enables Bearer dev-<role> shortcut
export DEV_AUTH_OFFLINE_FALLBACK=false  # fail-closed without DB

# 3. Schema + demo seed (idempotent; seed skips when already seeded)
npm run db:migrate
npm run db:seed

# 4. Start the server (in another shell, or backgrounded)
npm start                       # http://0.0.0.0:4000

# 5. Smoke the listings surface
npm run smoke:listings
# → 8 read assertions; exits 0 on full pass.

# 6. Smoke the write lifecycle (create → patch → assign → verify → photo → delete)
SMOKE_WRITE=1 npm run smoke:listings
# → 8 read assertions + 7 write assertions.
```

The smoke script asserts:

| Probe | Expected |
| --- | --- |
| `GET /health` | `200 { status: 'ok' }` |
| `GET /ready` | `200` with `database: 'connected'` |
| `GET /api/v1/listings` (no auth) | `401 unauthorized` |
| `GET /api/v1/listings` (Bearer `dev-super`) | `200`, items non-empty, total ≥ returned |
| `GET /api/v1/listings?serviceCategory=rent` | `200`, every item has `serviceCategory='rent'` |
| `GET /api/v1/listings?serviceCategory=pg` | `200`, every item has `serviceCategory='pg'` |
| `GET /api/v1/listings/:id` (one returned item) | `200`, body matches the requested id |
| `GET /api/v1/listings` (Bearer `dev-field`) | `200`, every item's `assignedTo.id === 'u-asha'` |
| `POST /api/v1/listings` (`SMOKE_WRITE=1`) | `201`, returns new `id` and `assignedTo.id='u-super'` |
| `PATCH /api/v1/listings/:id` | `200`, `title` reflects the patch |
| `POST /api/v1/listings/:id/assign` | `200`, `assignedTo` flips to the requested user |
| `POST /api/v1/listings/:id/verify` | `200`, `status.verification='verified'` |
| `POST /api/v1/listings/:id/photos` | `201`, metadata row with `approved=false` |
| `DELETE /api/v1/listings/:id` | `200`, body `{ ok: true }`; soft-deleted |
| `GET /api/v1/listings/:id` (post-delete) | `404 not-found` (existence hidden) |

If the backend isn't running the script prints the docker / migrate / seed / start recipe and exits with code `2`.

Override the target with `SMOKE_BASE_URL=http://host:port npm run smoke:listings`.

## Listings write endpoints

All write routes are wired against Postgres with raw `pg` and audit-logged
inside the same transaction as the data mutation. Soft delete only; no
real file storage for photos yet (metadata-only).

| Method + path | RBAC | Audit event(s) | Notes |
| --- | --- | --- | --- |
| `POST /api/v1/listings` | `listings:create` | `created-listing` | Returns `201` with the listing DTO. Defaults: `assignedTo = caller`, `teamId = caller.teamId`. |
| `PATCH /api/v1/listings/:id` | `listings:edit` (then row-level) | `updated-listing` | Partial update of safe fields only. `tenantId`, `id`, `createdBy`, `deletedAt` → `400 forbidden-field`. |
| `POST /api/v1/listings/:id/assign` | `listings:assign` (then row-level) | `assigned-listing` | Cross-tenant or inactive assignee → `404 user-not-found` / `400 user-inactive`. |
| `POST /api/v1/listings/:id/verify` | `listings:approve` (then row-level) | `verified-listing` / `rejected-listing` / `verification-requested-listing` | `status='rejected'` requires `reason` (`400 reason-required`). |
| `POST /api/v1/listings/:id/photos` | `listings:edit` (then row-level) | `uploaded-listing-photo` | Metadata only, no upload yet. `approved=false`. |
| `DELETE /api/v1/listings/:id` | `listings:delete` (then row-level) | `deleted-listing` | Soft delete. Returns `200 { ok: true }`. Row hidden from `GET`. |

Out-of-scope mutations fail-closed with `404 not-found` so existence
across teams/tenants is not leaked. A coarse `listings:delete = 'none'`
matrix entry fires `403 forbidden` before any row check.

Payload validation lives in `server/src/repositories/listingValidation.js`:

- Enum coherence: `serviceCategory` ↔ `listingIntent` (e.g. `rent + available_for_sale` → `400 invalid-intent-for-category`).
- Numeric: `price`, `rentMonthly`, `deposit` must be finite non-negative numbers; `rentMonthly` preferred over `price` for `rent`/`pg`/`office` (`422 rent-prefers-monthly` hint, not a hard error).
- Geo: `lat` ∈ [-90, 90], `lng` ∈ [-180, 180], `accuracy` ≥ 0.
- Amenities: array of unique non-empty strings; unknown entries are dropped silently.
- PATCH forbidden fields: `id`, `tenantId`, `tenant_id`, `createdBy`, `created_by`, `createdAt`, `created_at`, `deletedAt`, `deleted_at`.
- Photo: `objectKey` required; `category` must be in `PHOTO_CATEGORIES` (defaults to `Other`).

## Lint & test

```bash
npm run lint   # syntax-checks every src/*.js (see scripts/lint.js)
npm test       # node --test: rbac primitives + db not-configured behavior
```

`npm run lint` will fail on any syntax error across `src/`.

`npm test` covers the RBAC primitives (`can`, `scopeOf`, `filterByScope`, `scopeFilter`), the production boot guards in `src/config/index.js`, the token signing and verification rules, tenant-scoped identity resolution, the auth middleware dev-shortcut truth table, the DB layer's graceful-degraded mode, migration safety, SSL resolution, and the listings read/write routes. When `DATABASE_URL` is set, the suite additionally runs `SELECT 1` and the DB-integration listing tests.

The script loads `.env.test` via `node --env-file`, which supplies a throwaway `JWT_SECRET` — the token service refuses to sign or verify without a usable key. That file is tracked in git on purpose; every value in it is a constant.

> The `src/auth/*.test.js` glob was added to `npm test` on 2026-09-24. The auth truth table — the most security-relevant suite in the repo — was previously written but never executed by the default script.

End-to-end API tests against a live server are out of scope for the scaffold; use `npm run smoke:listings`.

## Current limitations

A full production-readiness audit lives in [docs/PRODUCT_PRODUCTION_ROADMAP.md](../docs/PRODUCT_PRODUCTION_ROADMAP.md). The go-live gate is [docs/PRODUCTION_LAUNCH_CHECKLIST.md](../docs/PRODUCTION_LAUNCH_CHECKLIST.md). Summary of what blocks production:

- **🛑 Access tokens are signed and login is real, but MFA and user onboarding are not.** HS256 signing, tenant-scoped identity, `POST /auth/login`, Argon2id passwords, refresh rotation with reuse detection and account lockout all landed 2026-09-24. Still open: `/auth/invite`, `/auth/accept-invite`, `/auth/forgot-password`, `/auth/reset-password`, the OTP endpoints and MFA are all 501 — **so a real user cannot be onboarded yet.** `compromised_at` is stamped when a session family is revoked for reuse, but nothing emails the user. `isBreachSafe` and `isReuseAllowed` return `true` unconditionally.
- **🛑 No RLS, application-only tenant isolation.** Every tenant-owned table carries `tenant_id NOT NULL REFERENCES organisations(id)`, but no `CREATE POLICY` exists and `app.tenant_id` is read by nothing. Isolation rests on hand-written `tenant_id = $1` predicates — correct on the listings path, absent on the verticals still returning 501. `withTenant()` in [src/db/client.js](src/db/client.js) sets the config transaction-locally so installing RLS is a migration-only change, but **it is not a control today**. Rollout proposal: [docs/AUTH_TENANT_SECURITY_PLAN.md §23](../docs/AUTH_TENANT_SECURITY_PLAN.md).
- **🛑 No migration rollback, and no `CREATE INDEX CONCURRENTLY`.** Checksums, the advisory lock, and the frozen-file rule landed 2026-09-24, along with `003-cross-vertical.sql` to repair the earlier in-place edit. Still open: there is no `down` path (production rollback is restore-from-backup), and every index uses plain `CREATE INDEX`, which takes an ACCESS EXCLUSIVE lock — fine on a dev box, needs care at scale. See [docs/MIGRATIONS.md](../docs/MIGRATIONS.md).
- **Connection TLS is configurable but `application_name` and retry are not.** `DB_SSL_MODE` landed 2026-09-24 with `verify-full` enforced in production; `statement_timeout` and `lock_timeout` are set. Still open: no `application_name` for connection attribution, and no retry on `40001` / `40P01`.
- **No backup or restore.** No dump script, no PITR configuration, no restore drill. Untested backup is not a backup.
- **No rate limiting and no security headers**, despite `RATE_LIMIT_*` being read into config. No limiter or helmet plugin exists.
- **No real password hashing** — `hashPassword` returns `'argon2id:$pending'` and `verifyPassword` always returns `false`. `/auth/login` returns HTTP 200 for any input.
- **No audit DB writes.** `recordAudit` logs to Fastify stdout only; nothing is ever inserted into `audit_log`, and the `hmac` column is never populated. Call sites are positioned inside their transactions, so wiring the insert is a small change.
- **Three routes lack permission gates** — `GET`/`DELETE /security/sessions` and `POST /sync`. All three currently return 501, so there is no live exposure, but the gates are absent rather than merely permissive.
- **Frontend still uses `demoRepository`.** `VITE_USE_API_REPOSITORY` is inert: the store reads seed data directly and never calls the repository. No login screen, so the app still boots as the seeded `u-admin`. All frontend-side. The role switcher is now gated behind `VITE_ENABLE_DEMO_ROLE_SWITCHER` (default off), so it no longer ships to production users.

## Dev auth shortcut

For local development and curl-driven smoke testing, the server accepts
short bearer tokens of the form `Authorization: Bearer dev-<role>`.
They are **dev-only** — production must leave `DEV_AUTH_ENABLED=false`.

```bash
# Production (default) — dev tokens are rejected as malformed JWTs.
DEV_AUTH_ENABLED=false npm start

# Local development — dev tokens resolve to seeded users.
DEV_AUTH_ENABLED=true DEV_AUTH_OFFLINE_FALLBACK=true npm start
```

| `DEV_AUTH_ENABLED` | `DATABASE_URL` | `DEV_AUTH_OFFLINE_FALLBACK` | `Bearer dev-super` |
| --- | --- | --- | --- |
| `false` (default) | * | * | 401 token-expired (treated as malformed JWT) |
| `true` | set | * | 200 with the seeded `u-super` matrix loaded from Postgres |
| `true` | unset | `true` | RBAC passes, data layer throws `database-not-configured` → 503 |
| `true` | unset | `false` (default since 2026-09-24) | 401 database-not-configured (fail-closed) |

And with `NODE_ENV=production`, the `true` row is not reachable at all: the server refuses to boot before binding a port.

Valid `dev-*` keys (mapped to seeded users in
`server/src/repositories/authRepository.js`):

- `dev-admin` — `u-admin`
- `dev-super` — `u-super`
- `dev-sales` — `u-raj` (sales-manager)
- `dev-site` — `u-priya` (site-manager)
- `dev-field` — `u-asha` (field-executive, t_north)
- `dev-field2` — `u-vijay` (field-executive, t_south)
- `dev-tele` — `u-tele` (telecaller)
- `dev-cpm` — `u-cpm` (channel-partner-manager)
- `dev-accounts` — `u-anil`

The matrix resolution is `merge(DEFAULT_PERMISSION_MATRIX[role], permission_matrices.matrix, users.permission_matrix)` — `permission_matrices` rows are not seeded today, so the practical resolution is the in-code defaults plus the optional `users.permission_matrix` per-user override.

## How the frontend will later connect

The repo swap is one line. From [`docs/BACKEND_INTEGRATION_PLAN.md §8`](../docs/BACKEND_INTEGRATION_PLAN.md):

```js
// src/services/index.js (future)
import { apiRepository } from './apiRepository.js';
import { setRepository } from './index.js';
setRepository(apiRepository);
```

`apiRepository.js` will implement the typed repository interface (`src/services/repositoryTypes.js`) using `fetch('/api/v1/...')`. The CORS origins above already cover the local dev ports used by the frontend.

The endpoint roots live under `/api/v1/*`. Authentication is via `Authorization: Bearer <accessToken>`. The same `Idempotency-Key` header used by the offline queue ([`docs/OFFLINE_QUEUE_CONTRACT.md §5`](../docs/OFFLINE_QUEUE_CONTRACT.md)) is forwarded to mutating endpoints.

## Folder layout

```
server/
├── package.json              # Fastify 4 + pg; no ORM
├── README.md                 # this file
├── .env.example              # sane local defaults
├── scripts/
│   └── lint.js               # node --check over every src/*.js
└── src/
    ├── server.js             # boot: loads app, listens, drains pool on shutdown
    ├── app.js                # builds the Fastify instance
    ├── config/
    │   └── index.js          # reads env, exports the config object
    ├── db/
    │   ├── schema.sql        # tables matching docs/DATA_MODEL.md
    │   ├── indexes.sql       # tenant_id, owner_id, etc.
    │   ├── seed-demo.sql     # demo tenant/roles/teams/projects/users (via db:seed)
    │   ├── client.js         # pg Pool: getDb(), query(), transaction(), closeDb()
    │   ├── health.js         # readiness probe for GET /ready
    │   └── migrate.js        # db:migrate / db:seed / db:reset runner
    ├── auth/
    │   ├── authMiddleware.js # resolves req.user from Bearer
    │   ├── tokenService.js   # issue + verify (placeholder HS256 hook)
    │   └── passwordPolicy.js # length + HIBP-shaped check, no hash yet
    ├── rbac/
    │   ├── permissions.js    # ports RESOURCES / ACTIONS / SCOPES + can()
    │   ├── scopeFilters.js   # SQL WHERE fragments per scope
    │   └── requirePermission.js  # Fastify hook factory
    ├── routes/
    │   ├── auth.js           # /api/v1/auth/* (login, refresh, logout, me, ...)
    │   ├── users.js          # /api/v1/users/* + /security/sessions/*
    │   ├── roles.js          # /api/v1/roles/* (matrix under /:id/matrix)
    │   ├── projects.js       # /api/v1/projects/* + members
    │   ├── teams.js          # /api/v1/teams/*
    │   ├── listings.js       # /api/v1/listings/* (cross-vertical catalogue; read + DB-backed writes)
    │   ├── leads.js          # /api/v1/leads/* + /:id/assign
    │   ├── visits.js         # /api/v1/visits/* + /:id/complete
    │   ├── attendance.js     # /api/v1/attendance/* + check-in/check-out/approve
    │   ├── photos.js         # /api/v1/photos/* + :presign, approve
    │   ├── communications.js # /api/v1/threads/* + /:id/messages
    │   ├── reports.js        # /api/v1/reports/* + export job
    │   └── sync.js           # /api/v1/sync  (offline-queue replay)
    ├── repositories/
    │   ├── authRepository.js      # user + matrix lookup, dev-key resolution
    │   └── listingsRepository.js  # raw pg query helpers for the listings catalogue
    ├── audit/
    │   └── auditLog.js       # append-only helper for mutating handlers
    └── utils/
        └── errors.js         # standard error envelope (AUTH_API_SPEC §1)
```
