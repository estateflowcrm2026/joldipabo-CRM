# Joldipabo / EstateFlow CRM — Environment Configuration

Date: 2026-09-24

Reference for every environment variable the frontend and backend read, and the required value in development, staging, and production.

---

## ⚠️ Production security requirements

These are not optional. Each is a launch blocker.

```bash
# REQUIRED in production — the app refuses to boot otherwise
NODE_ENV=production
DEV_AUTH_ENABLED=false
DEV_AUTH_OFFLINE_FALLBACK=false

# REQUIRED in production — at least 32 characters, not a placeholder.
# Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=<high-entropy random, from the platform secrets manager>

# REQUIRED to be UNSET in production — Vite inlines it into the public bundle
VITE_DEV_AUTH_TOKEN=<must not exist>
```

The server refuses to start in production when `JWT_SECRET` is missing, shorter than `JWT_MIN_SECRET_LENGTH` (default 32), or a recognised placeholder such as `changeme`. All four boot guards — dev auth on, missing secret, weak secret, placeholder secret — fail closed rather than warning, because a misconfigured deploy must stop rather than serve. See [server/README.md](../server/README.md).

**`DEV_AUTH_ENABLED` MUST be `false` in production.**

When `DEV_AUTH_ENABLED=true`, the backend accepts `Authorization: Bearer dev-<role>` and resolves it to a seeded user. The valid keys are published in [server/README.md](../server/README.md). With that flag on in production, anyone who reads the documentation can authenticate as `super-admin` with a one-word bearer token.

That guard has shipped: `NODE_ENV=production` with `DEV_AUTH_ENABLED=true` refuses to boot.

**`VITE_DEV_AUTH_TOKEN` MUST be unset in production.** Vite inlines every `VITE_*` variable into the client bundle as plaintext. A build with this variable set ships a valid bearer token to every visitor who loads the page. It is a build-time secret in a public file.

**`DEV_AUTH_OFFLINE_FALLBACK` now defaults to `false`** (changed 2026-09-24). It used to default to `true`, which meant setting only `DEV_AUTH_ENABLED=true` granted full in-code permission matrices with no database row behind them. The default is now safe; local setups that relied on it must opt in explicitly.

---

## 1. Frontend environment variables

Read at build time by Vite. All are inlined into the client bundle — **never put a real secret in a `VITE_*` variable.**

| Variable | Default | Read at | Purpose |
|----------|---------|---------|---------|
| `VITE_API_BASE_URL` | `http://localhost:4000/api/v1` | `src/services/apiClient.js:38` | Backend API root. Trailing slashes are trimmed. |
| `VITE_USE_API_REPOSITORY` | *(unset → demo)* | `src/services/index.js:54` | Must be exactly the string `'true'` to select `apiRepository`. Any other value selects `demoRepository`. |
| `VITE_ENABLE_DEMO_ROLE_SWITCHER` | *(unset → OFF)* | `src/services/demoFlags.js` | **Gates the role switcher.** Must be exactly `'true'` to render it. Default OFF. |
| `VITE_DEV_AUTH_TOKEN` | `''` (empty) | `src/services/apiClient.js:53` | Static bearer token. **Development only — never set in a production build.** |

### The demo role switcher

The role switcher lets anyone viewing the app assume the identity of any seeded user, including `super-admin`. It used to ship to everyone, with a "Demo only" label that was not a control. It is now behind `VITE_ENABLE_DEMO_ROLE_SWITCHER`:

- **Default (flag unset or anything but `'true'`)** — the desktop topbar menu lists no users, and the mobile drawer section is not rendered at all. Neither is disabled: neither renders.
- **`VITE_ENABLE_DEMO_ROLE_SWITCHER=true`** — both surfaces render the full seeded-user list, and a "Demo mode" badge appears in the desktop topbar and the mobile drawer.

Parsing is strict: only the exact string `'true'` enables it. `'1'`, `'TRUE'`, and `'yes'` all leave it off, because ambiguity in either direction is the wrong default for a control that governs identity switching.

The flag is **build-time**, not runtime. Vite inlines it into the artefact, so enabling it for a demo build means anyone with that artefact can switch users. Keep demo and production builds as separate deploys.

Covered by `src/services/demoFlags.test.mjs` (13 assertions, part of `npm test`).

### Notes

- **There is no `vite.config.js` and no `.env` file in the repo.** Vite's defaults are in effect. A root `.env.example` now documents these three variables; copy to `.env.local` for local work.
- `VITE_USE_API_REPOSITORY` is currently **inert in the app**: the store reads seed data directly and never calls `getRepository()`. Setting it changes nothing observable until Phase 3. This is intentional — the switch is not flipped until the store is moved onto the repository.
- `VITE_API_BASE_URL` and `VITE_DEV_AUTH_TOKEN` are read through a defensive `typeof import.meta !== 'undefined'` guard evaluated per call rather than cached. Harmless in a production build (Vite inlines the value), but worth normalising.

### Per environment

| Variable | Development | Staging | Production |
|----------|-------------|---------|------------|
| `VITE_API_BASE_URL` | `http://localhost:4000/api/v1` | `https://staging-api.<domain>/api/v1` | `https://api.<domain>/api/v1` |
| `VITE_USE_API_REPOSITORY` | unset (demo) | `true` | `true` |
| `VITE_ENABLE_DEMO_ROLE_SWITCHER` | `true` | **unset** | **unset** |
| `VITE_DEV_AUTH_TOKEN` | `dev-super` (optional) | **unset** | **unset** |

---

## 2. Backend environment variables

Read once at startup from `process.env` by [server/src/config/index.js](../server/src/config/index.js), except `devAuth`, which re-reads on each access so tests can toggle it.

| Variable | Default | Purpose | Notes |
|----------|---------|---------|-------|
| `HOST` | `0.0.0.0` | Bind address | |
| `PORT` | `4000` | HTTP port | |
| `NODE_ENV` | `development` | Runtime mode | Drives the production boot guards and the dev-outbox refusal. |
| `LOG_LEVEL` | `info` | Fastify log level | `fatal` `error` `warn` `info` `debug` `trace` |
| `DATABASE_URL` | *(unset)* | Postgres connection string | The app boots without it; DB queries then fail with `database-not-configured`. **Required in production.** |
| `JWT_SECRET` | *(unset)* | HS256 signing key | **Live since 2026-09-24.** Required in production, minimum 32 characters, must not be a placeholder. Boot refuses otherwise. |
| `AUTH_MFA_ENFORCE` | `false` | Require MFA for `admin` / `super-admin` | **Live since 2026-09-27.** A production boot **fails** unless this is `true`. See §2b. |
| `APP_DATABASE_URL` | *(unset)* | Runtime connection for the app role | **Added 2026-09-28.** Optional; falls back to `DATABASE_URL`. A production boot **fails** without it, or if the role is `postgres`/`supabase_admin`/`service_role`. See §2c. |
| `DB_APP_ROLE` | `estateflow_app` | Role name used by the provisioning scripts | `npm run db:app-role`, `npm run rls:check`. |
| `JWT_ISSUER` | `estateflow-api` | `iss` claim, verified on every token | Changing it invalidates existing tokens |
| `JWT_AUDIENCE` | `estateflow-clients` | `aud` claim, verified on every token | |
| `JWT_MIN_SECRET_LENGTH` | `32` | Minimum production key length | Set `0` only for a throwaway staging box |
| `JWT_DEV_FALLBACK_SECRET` | *(built-in dev value)* | Key used when `DEV_AUTH_ENABLED=true` and no `JWT_SECRET` is set | **Never reachable in production** |
| `PASSWORD_MEMORY_COST` | `19456` | Argon2id memory in KiB — the OWASP minimum. Raise where the hardware allows. | A bad or zero value falls back to the default, never below it |
| `PASSWORD_TIME_COST` | `2` | Argon2id iterations | |
| `PASSWORD_PARALLELISM` | `1` | Argon2id lanes | |
| `LOGIN_LOCKOUT_THRESHOLD` | `5` | Failed logins before a known account locks | |
| `LOGIN_LOCKOUT_TENANT_THRESHOLD` | `10` | Failed logins before an identifier locks for the tenant | Must stay above the per-user figure, or spraying one address locks the whole tenant |
| `LOGIN_LOCKOUT_MS` | `900000` | Lockout duration (15 min) | |
| `LOGIN_LOCKOUT_WINDOW_MS` | `3600000` | Inactivity before the failure counter resets | |
| `AUTH_INVITES_ENABLED` | `true` | Set `false` to refuse `POST /auth/invite` | Useful before SMTP is configured |
| `AUTH_RESETS_ENABLED` | `true` | Set `false` to refuse `POST /auth/forgot-password` | |
| `MAIL_TRANSPORT` | `log` | `log` | `none` | `smtp` | `log` captures to the dev outbox. `smtp` is selected by setting `SMTP_HOST` |
| `SMTP_HOST` / `SMTP_PORT` | *(unset)* / `587` | SMTP server. Setting `SMTP_HOST` switches the transport to `smtp` | |
| `SMTP_USER` / `SMTP_PASS` | *(unset)* | SMTP credentials, when the server requires AUTH LOGIN | |
| `MAIL_FROM` | `no-reply@joldipabo.local` | Envelope and From address | |
| `APP_BASE_URL` | `http://localhost:5173` | Base for invite and reset links | **Must** be the real frontend origin in production or links point nowhere |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime (15 min) | |
| `REFRESH_TTL_SECONDS` | `604800` | Refresh token lifetime (7 days) | |
| `RATE_LIMIT_READ_PER_MIN` | `100` | Read rate limit per user | **Dead config — no limiter exists.** |
| `RATE_LIMIT_WRITE_PER_MIN` | `30` | Write rate limit per user | **Dead config — no limiter exists.** |
| `CORS_ORIGINS` | 3 localhost URLs | Comma-separated allowed origins | See the `*` trap below. |
| `DEV_AUTH_ENABLED` | `false` | Enables `Bearer dev-<role>` | **Must be `false` in production.** |
| `DEV_AUTH_OFFLINE_FALLBACK` | **`true`** | Dev-auth matrix fallback with no DB | **Set to `false` everywhere.** Insecure default. |
| `DEV_AUTH_TENANT_ID` | `org_acme` | Tenant dev users resolve into | |
| `DB_SSL_MODE` | `auto` | Postgres TLS: `auto` \| `disable` \| `require` \| `verify-full` | `auto` infers from `DATABASE_URL`'s `sslmode`. **`require` and `DB_SSL_REJECT_UNAUTHORIZED=false` are refused in production.** |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Verify the server certificate | Escape hatch for self-signed staging certs. Refused in production. |
| `DB_SSL_CA_FILE` | *(unset)* | Path to a CA bundle on disk | Root CA for a private PKI. Required for Supabase production. See §2a. |
| `DB_SSL_CA` | *(unset)* | Inline CA bundle (PEM) | For providers with a private CA. `DB_SSL_CA_FILE` takes precedence. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout | Prevents one bad query pinning a pool slot. |
| `DB_LOCK_TIMEOUT_MS` | `10000` | Lock acquisition timeout | Stops a migration deadlocking against live traffic. |
| `DB_POOL_MAX` | `10` | Maximum pool connections | |
| `ESTATEFLOW_ALLOW_RESET` | *(unset)* | Required value is `yes` to run `db:reset` | Also requires a localhost `DATABASE_URL`. |
| `SMOKE_BASE_URL` | `http://127.0.0.1:4000` | Target for `npm run smoke:listings` | Dev tooling. |
| `SMOKE_WRITE` | *(unset)* | Set to `1` to exercise write routes | Dev tooling. |

### Two traps

**1. Nothing loads a `.env` file.** There is no `dotenv` dependency and no `--env-file` flag in the npm scripts. `config/index.js` reads `process.env` only. Copying `server/.env.example` to `server/.env` and running `npm start` will **silently ignore it**. Either:

```bash
# explicit
node --env-file=.env src/server.js

# or the platform's env injection (preferred in production)
```

The first line of `server/.env.example` currently says "Copy this file to .env", which implies a loader exists. Phase 1 corrects this.

**2. `CORS_ORIGINS=*` disables CORS rather than opening it.** `list()` splits on commas and trims, so the value `*` yields `['*']`, and the origin check uses `Array.includes` — an exact match. A real browser sends `Origin: https://app.example.com`, which does not match. **Always enumerate origins explicitly.**

## 2b. Outbound email

The account-lifecycle flows need to send a link, so a developer with no mail server must still be able to complete an invite or a reset. The transport is therefore pluggable and dev-safe by default.

| `MAIL_TRANSPORT` | When selected | Behaviour |
|---|---|---|
| `log` (default when `SMTP_HOST` is unset) | no SMTP configured | Captured in a 100-entry ring buffer and written to stdout |
| `smtp` | `SMTP_HOST` is set, or `MAIL_TRANSPORT=smtp` | Sent over SMTP. A failure is logged and the message is still captured — the user row is already committed, so an operator can re-send |
| `none` | `MAIL_TRANSPORT=none` | Captured but **not** logged. Use on staging so reset links do not land in the log stream |

**In production, `log` redacts the URLs** before writing, and the dev outbox endpoint is refused outright:

```bash
curl localhost:4000/api/v1/auth/dev/outbox
# -> 501 in production, 200 elsewhere
```

That refusal is not a formality. An unauthenticated endpoint returning live invite and reset tokens is a password-takeover primitive.

**Before going live, set `APP_BASE_URL`** to the real frontend origin. It is the base for every invite and reset link, and its default is `http://localhost:5173`, which would send every real user a dead link.

| Environment | Transport | Notes |
|---|---|---|
| Local | `log` | Read the token from `GET /auth/dev/outbox` |
| Staging | `smtp` (a real sandbox) or `none` | Never `log` |
| Production | `smtp` | `MAIL_FROM` on a domain you control, or invites land in spam |

---

## 2b. Multi-factor authentication

`AUTH_MFA_ENFORCE` decides whether `admin` and `super-admin` must present a second factor. It defaults to `false` so a developer is not locked out of their own admin account and a staging box can be built before the app can enrol anyone.

Production **refuses to boot** without it, because "unset" and "off" are indistinguishable at boot and only one of them is safe:

```
Refusing to start: AUTH_MFA_ENFORCE is not true in production.
```

Set it in production and nowhere else you care about:

```bash
NODE_ENV=production
AUTH_MFA_ENFORCE=true
```

The value must be the literal string `true`. `1` is not accepted — the check is a string comparison against `'true'`, and a typo that reads as false should fail closed rather than silently disabling a security control.

### What this key controls

`users.mfa_secret` holds an AES-256-GCM ciphertext whose key is HKDF-derived from `JWT_SECRET`. So `JWT_SECRET` now protects three things: access-token signatures, the audit-log HMAC, and every TOTP secret in the system.

> **Rotation warning.** Rotating `JWT_SECRET` invalidates every stored TOTP secret, which locks out every MFA user. Users must be disabled and re-invited, or an operator must run `POST /auth/mfa/disable` against each account. Plan it as a user-visible event, not a routine key change. Moving the MFA key to an independently-rotatable KMS key is tracked in the [roadmap](PRODUCT_PRODUCTION_ROADMAP.md) §2.1.

### Dev and demo

`DEV_AUTH_ENABLED=true` bypasses MFA entirely — the dev-auth shortcut short-circuits in `authMiddleware.js` and never reaches the MFA code path. A `Bearer dev-<role>` token needs no second factor anywhere dev auth is permitted.

Production refuses to start with dev auth enabled, so a deployment cannot be simultaneously unauthenticated and unenforced.

## 2c. Application database role (`APP_DATABASE_URL`)

Two connection strings, two jobs.

| Variable | Used by | Connects as |
|---|---|---|
| `DATABASE_URL` | `db:migrate`, `db:seed`, `db:reset`, admin scripts | the **owner** |
| `APP_DATABASE_URL` | **the running server** | `estateflow_app` |

The split exists because Postgres exempts the **table owner** from row-level
security, and exempts any role with `BYPASSRLS` twice over. A role that
owns the tables is exempt unless `FORCE ROW LEVEL SECURITY` is set, and
`FORCE` would break migrations and every operator session that
legitimately has no tenant. So the application needs a role that is
neither.

Verified on 2026-09-28: with a policy installed, RLS enabled and
`app.tenant_id` set to one tenant, a `SELECT` as `postgres` returned
**both** tenants' rows.

### Creating it

```bash
cd server
npm run db:app-role -- --create            # role + least-privilege grants
npm run db:app-role:check                  # verify; safe in CI
npm run db:app-role -- --rotate-password --write-env
```

`--write-env` writes `APP_DATABASE_URL` into `.env` and never prints
the password. Without it the password is printed once — a deliberate
choice, not the default.

On Supabase, `ALTER ROLE` is refused for a non-`supabase_admin`
session by a `supautils` hook. Creation and grants work; changing an
existing role's attributes needs the SQL editor:

```sql
ALTER ROLE estateflow_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

### The role

```sql
CREATE ROLE estateflow_app
  NOLOGIN            -- the password is set separately
  NOSUPERUSER
  NOBYPASSRLS        -- the point
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;
GRANT USAGE ON SCHEMA public TO estateflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON <29 app tables> TO estateflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO estateflow_app;
```

Not granted, deliberately: `CREATE`, `ALTER`, `DROP`, `TRUNCATE`,
`REFERENCES`, ownership, and any privilege on `schema_migrations`. A
compromised application process therefore cannot change its own schema —
so it cannot turn RLS off — and cannot rewrite the record of which
migrations have been applied to it.

`NOINHERIT` is **not** set: Supabase grants base types to `PUBLIC`, and a
role that does not inherit would be unable to use `text` or `jsonb`.

### Production

`assertRuntimeRoleIsRlsSubject()` refuses a production boot when
`APP_DATABASE_URL` is absent, or names `postgres`, `supabase_admin` or
`service_role`. It inspects the configured URL and needs no connection,
so it is a cheap tripwire. `npm run db:app-role:check` queries
`pg_roles` and is authoritative; `npm run rls:check` is the behavioural
proof.

### Development

`APP_DATABASE_URL` is optional. When unset the pool falls back to
`DATABASE_URL`, so a laptop running as `postgres` on localhost behaves
exactly as before. The guard only applies to `NODE_ENV=production`.

## 2a. Postgres TLS (`DB_SSL_MODE`)

Managed Postgres providers (RDS, Cloud SQL, Neon, Supabase) present a certificate and **refuse cleartext connections**. A local Docker Postgres speaks cleartext on loopback. The same pool has to serve both.

`DB_SSL_MODE` resolves to what `pg` needs. `auto` (the default) reads `sslmode` out of `DATABASE_URL` and honours it, so a URL that already carries the right parameter needs no other change.

| Mode | Encrypted? | Peer authenticated? | Use for |
|------|-----------|---------------------|---------|
| `disable` | No | n/a | Local Docker Postgres, loopback only |
| `require` | Yes | **No** | Staging behind a trusted network, or a self-signed cert you accept the risk on |
| `verify-full` | Yes | Yes — full chain + hostname | **Production** |
| `auto` | Inferred from `DATABASE_URL` | Inferred | Default; local setups need no change |

Two configurations are **refused at boot in production**, because both silently drop the guarantee the setting exists to provide:

- `DB_SSL_MODE=require` — encrypts, but nothing proves the peer is the database you meant. An active network attacker terminates the connection and reads and writes everything.
- `DB_SSL_REJECT_UNAUTHORIZED=false` — turns off certificate checking entirely.

The escape hatch for a private CA is `DB_SSL_CA_FILE`, not disabling verification.

### Supabase (production)

Supabase does not use a public CA, so `verify-full` fails against a stock Node
trust store with `self-signed certificate in certificate chain`. Its chain is
private:

```
Supabase Root 2021 CA          self-signed, valid to 2031-04-26
  └─ Supabase Intermediate 2021 CA
       └─ db.<project-ref>.supabase.co
```

Two things follow, both non-obvious:

- **Use the direct host in production, not the pooler.** The pooler terminates
  the Postgres protocol before TLS and presents no certificate this client can
  verify, so a pooler connection cannot reach `verify-full` at all. The
  Session Pooler remains correct for dev and staging with `require`.
- **`DB_SSL_CA_FILE` must be the root**, not the intermediate and not the leaf.
  A certificate without the CA basic constraint cannot verify a chain.

```bash
cd server
npm run db:fetch-ca -- --host db.<project-ref>.supabase.co   # writes certs/supabase-root-2021.pem
```

The fetch is fingerprint-pinned — it refuses to write a root it has not been
told to expect, because the initial connection cannot verify anything. Full
procedure, including Docker and system trust-store installs:
[SUPABASE_VERIFICATION.md §5](SUPABASE_VERIFICATION.md#5-obtaining-the-supabase-ca).

Diagnose without starting the server:

```bash
npm run db:ssl-check            # resolve settings, open nothing
npm run db:ssl-check:connect    # also connect with the resolved options
```

**Per environment:**

| Environment | `DATABASE_URL` | `DB_SSL_MODE` | Notes |
|-------------|----------------|---------------|-------|
| Local Docker | `postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev` | unset (`auto` → `disable`) | No change needed. Cleartext on loopback is fine |
| Local host install | `postgres://…@localhost:5432/…` | unset | Same |
| Staging, public provider | `…?sslmode=verify-full` | unset, or `verify-full` | Provider CA is usually in the system trust store |
| Staging, self-signed | `…?sslmode=require` | `require` | Accepted here, refused in production |
| Staging, private CA | `…` | `verify-full` + `DB_SSL_CA_FILE=/path/to/ca.pem` | The correct way to avoid disabling verification |
| **Dev/testing, Supabase** | Session Pooler, `?sslmode=require` | `require` | No CA needed. Refused in production |
| **Production, Supabase** | `postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres` | `verify-full` + `DB_SSL_CA_FILE=<root>.pem` | Direct host, not the pooler |

Resolution lives in [server/src/db/sslConfig.js](../server/src/db/sslConfig.js) and is covered by tests in [server/src/db/sslConfig.test.js](../server/src/db/sslConfig.test.js).

### Per environment

| Variable | Development | Staging | Production |
|----------|-------------|---------|------------|
| `NODE_ENV` | `development` | `staging` | **`production`** |
| `HOST` | `0.0.0.0` | `0.0.0.0` | `0.0.0.0` |
| `PORT` | `4000` | `4000` | `4000` (or `$PORT` from the platform) |
| `LOG_LEVEL` | `debug` | `info` | `info` |
| `DATABASE_URL` | `postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev` | staging DB, `?sslmode=require` | production DB, **`?sslmode=verify-full`** |
| `DB_SSL_MODE` | unset (`auto` → `disable`) | `require` or unset | **`verify-full`** |
| `DB_SSL_CA_FILE` | *(unset)* | only if private CA | **required for Supabase** — see §2a |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | `30000` | `30000` |
| `DB_LOCK_TIMEOUT_MS` | `10000` | `10000` | `10000` |
| `DB_POOL_MAX` | `10` | `10` | `20` |
| `JWT_SECRET` | *(unset)* | staging secret | **production secret from the secrets manager** |
| `JWT_ACCESS_TTL_SECONDS` | `900` | `900` | `900` |
| `REFRESH_TTL_SECONDS` | `604800` | `604800` | `604800` |
| `RATE_LIMIT_READ_PER_MIN` | `1000` | `600` | `600` |
| `RATE_LIMIT_WRITE_PER_MIN` | `300` | `120` | `120` |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5180,http://127.0.0.1:5180` | `https://staging.<domain>` | `https://<domain>` — exact, no `*` |
| `DEV_AUTH_ENABLED` | `true` (optional) | `false` | **`false`** |
| `DEV_AUTH_OFFLINE_FALLBACK` | `true` (optional) | `false` | **`false`** |
| `DEV_AUTH_TENANT_ID` | `org_acme` | *(unused)* | *(unused)* |
| `ESTATEFLOW_ALLOW_RESET` | *(unset)* | *(unset)* | **never set** |
| `STORAGE_*` (Phase 4) | — | — | bucket, region, presign TTL |
| `SENTRY_DSN` (Phase 6) | *(unset)* | staging DSN | production DSN |

---

## 3. Secrets that must never appear in the repository

| Secret | Where it belongs |
|--------|------------------|
| `DATABASE_URL` | Platform secrets manager. Contains the DB password. |
| `JWT_SECRET` | Platform secrets manager. Rotating it invalidates every access token. |
| `VITE_DEV_AUTH_TOKEN` | **Nowhere in production.** It is a public build artifact. |
| `S3_SECRET_ACCESS_KEY` | Platform secrets manager. |
| `SENTRY_AUTH_TOKEN` | Platform secrets manager. |
| Storage presign signing keys | Platform secrets manager. |

A `.gitignore` now excludes `.env`, `.env.*`, `!.env.example`, `node_modules/`, `dist/`, and local database artefacts. See the root `.gitignore`.

Verify before every deploy:

```bash
# 1. No env files tracked
git ls-files | grep -E '\.env$' && echo "FAIL: env file tracked" || echo "ok"

# 2. Production dev-auth is off (Phase 1 — until the boot guard lands)
grep -E '^DEV_AUTH_ENABLED=true' .env.production && echo "FAIL" || echo "ok"
```

---

## 4. Local development setup

```bash
# 1. Frontend
cd <repo root>
npm install
cp .env.example .env.local      # edit as needed
npm run dev                     # http://localhost:5173

# 2. Backend
cd server
npm install
docker compose up -d            # postgres:16 on 127.0.0.1:5432
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
npm run db:migrate
npm run db:seed
DEV_AUTH_ENABLED=true npm start # http://0.0.0.0:4000
```

The legacy Postgres identifiers `estateflow` (role, database, npm package `estateflow-server`) and the storage key `estateflow:offline-queue:v1` are intentional and preserved. **Do not rename them** — doing so breaks existing local databases and any stored offline queue. See [docs/DATA_MODEL.md](DATA_MODEL.md) conventions and the project memory note.

---

## 5. Environment parity checklist

Before promoting a build from staging to production, confirm every row of the two tables above matches, and in particular:

- [ ] `NODE_ENV=production`
- [ ] `DEV_AUTH_ENABLED=false`
- [ ] `DEV_AUTH_OFFLINE_FALLBACK=false`
- [ ] `JWT_SECRET` is set and is **not** the staging value
- [ ] `DATABASE_URL` points at the production database with `sslmode=verify-full`
- [ ] `DB_SSL_MODE=verify-full` (or unset with the `sslmode` in the URL)
- [ ] `DB_SSL_REJECT_UNAUTHORIZED` is not set to `false`
- [ ] `DATABASE_URL` is **not** the staging value
- [ ] `CORS_ORIGINS` is an explicit production origin, not `*`
- [ ] `VITE_DEV_AUTH_TOKEN` is unset
- [ ] `VITE_ENABLE_DEMO_ROLE_SWITCHER` is unset — production must not ship the role switcher
- [ ] `ESTATEFLOW_ALLOW_RESET` is unset
- [ ] The production frontend build contains no dev-role switcher

---

## 6. Cross-references

- [docs/PRODUCT_PRODUCTION_ROADMAP.md](PRODUCT_PRODUCTION_ROADMAP.md) §3.7, §9.2 — auth and deployment plans
- [docs/PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md) — go-live verification
- [docs/SECURITY_ACCEPTANCE_CHECKLIST.md](SECURITY_ACCEPTANCE_CHECKLIST.md) — the launch gate
- [server/README.md](../server/README.md) — backend runbook and dev-token table
- [server/.env.example](../server/.env.example) — backend variable template
