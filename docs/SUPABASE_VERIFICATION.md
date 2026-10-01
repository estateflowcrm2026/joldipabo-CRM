# Verifying against Supabase Postgres

Everything in [MIGRATIONS.md](MIGRATIONS.md) §4 assumes a local Postgres. This
document covers running the same checks against a hosted Supabase project, which
is what `verify:migrations`, `smoke:auth-db` and `smoke:listings` do when
`DATABASE_URL` points at one.

All of it is safe on a **dev/testing** project. Two of the scripts write and
destroy data; see [Safety](#safety) before pointing them at anything else.

---

## 1. Which connection string

Supabase gives you three. They are not interchangeable, and using the wrong one
fails in a way that looks like an application bug.

| | Host | Port | Username | Use for |
|---|---|---|---|---|
| **Direct** | `db.<project-ref>.supabase.co` | 5432 | `postgres` | migrations, verification |
| Session pooler | `aws-<n>-<region>.pooler.supabase.com` | 5432 | `postgres.<project-ref>` | the running app |
| Transaction pooler | `aws-<n>-<region>.pooler.supabase.com` | 6543 | `postgres.<project-ref>` | serverless / many short connections |

**Which to copy:** Project Settings → Database → Connection string → the **URI**
tab. Turn the *Session pooler* toggle **OFF** to get the direct string, leave it
**ON** for the pooler string.

- For `verify:migrations` you need the **direct** string, or the schema-scoped
  mode described below (§4).
- For `smoke:auth-db` and the app, the **session pooler** is fine.

Why the distinction is enforced rather than suggested: the pooler keeps one
backend open per database for as long as that database exists, so
`DROP DATABASE` can never succeed against it. Measured, not assumed — a
verification run against the pooler failed with `55006 "is being accessed by
other users"` on every retry, and left scratch databases behind.

## 2. SSL

Supabase requires TLS, and it is the reason `DB_SSL_MODE` exists. What the
string means depends on where it points.

### Development and testing — Session Pooler, `require`

```bash
DATABASE_URL=postgresql://postgres.PROJECT-REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require
DB_SSL_MODE=require
```

Encrypted, certificate not verified. **Refused at boot when
`NODE_ENV=production`** — it encrypts but does not prove the peer is your
database, so an active network attacker terminates the link and reads and
writes everything. This is the configuration the dev verification run in §4
uses, and it needs no CA.

### Production — direct connection, `verify-full`

```bash
DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT-REF.supabase.co:5432/postgres
DB_SSL_MODE=verify-full
DB_SSL_CA_FILE=/etc/ssl/certs/supabase-root-2021.pem
DB_SSL_REJECT_UNAUTHORIZED=true
```

Use the **direct** host, not the pooler. The pooler terminates the Postgres
protocol before TLS, and it presents no certificate this client can verify —
a pooler connection cannot reach `verify-full` at all.

### Why production needs a CA file

Supabase does not use a public CA. The chain it presents is:

```
Supabase Root 2021 CA          self-signed, isCA, valid to 2031-04-26
  └─ Supabase Intermediate 2021 CA
       └─ db.<project-ref>.supabase.co
```

The root is in no system trust store, so stock Node rejects it:

```
error: self-signed certificate in certificate chain
```

`DB_SSL_CA_FILE` supplies the root so the chain can be verified. Without it
`/ready` reports the database unreachable — that is the guard working, not a
connection failure. See §5 for how to obtain the certificate.

### Checking without starting the server

```bash
npm run db:ssl-check            # resolve the settings, open nothing
npm run db:ssl-check:connect    # also connect with the resolved options
```

Prints the target with the password masked, describes the CA bundle by
subject/fingerprint rather than dumping it, and never reads `JWT_SECRET`. The
`--connect` form is the only way to know a bundle actually verifies the live
chain — a correct-looking config with a stale CA still fails.

## 3. The env file

`server/.env` is gitignored and must stay that way — it holds the database
password. It is **not** loaded automatically; there is no `dotenv`. Every
command below passes `--env-file=.env` explicitly.

```bash
NODE_ENV=development
DATABASE_URL=postgresql://postgres.PROJECT-REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require
DB_SSL_MODE=require
JWT_SECRET=<48+ random bytes>
DEV_AUTH_ENABLED=true          # required for the listings smoke; refused in production
DEV_AUTH_OFFLINE_FALLBACK=false
DEV_AUTH_TENANT_ID=org_acme
CORS_ORIGINS=http://localhost:5173,http://localhost:5180,http://127.0.0.1:5180
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` is not optional. It signs access tokens **and** derives the audit
HMAC key, so a run without it reports every audit row as "unsigned" rather than
verified — which is not the same as intact, and will read as a pass.

`server/.env.test` is the opposite: a throwaway-constant fixture, tracked on
purpose, loaded by `npm test`. It is un-ignored in `.gitignore` explicitly.
Real secrets never go in it.

## 4. Run the checks

```bash
cd server

# 0. Schema + demo data (idempotent; skips the seed if organisations has rows)
node --env-file=.env src/db/migrate.js
node --env-file=.env src/db/migrate.js --seed

# 1. Migrations: fresh, idempotent, drifted, immutable
VERIFY_ALLOW_REMOTE=1 node --env-file=.env scripts/verify-migrations.js

# 2. Auth flows against a real database
VERIFY_ALLOW_REMOTE=1 node --env-file=.env scripts/smoke-auth-db.js

# 3. Listings, read and write (needs the server running)
node --env-file=.env src/server.js &
node --env-file=.env scripts/smoke-listings.js
SMOKE_WRITE=1 node --env-file=.env scripts/smoke-listings.js
```

### Scopes: `db` and `schema`

`verify:migrations` isolates each scenario in a throwaway target and drops it
afterwards. Which kind depends on what the target supports:

| `VERIFY_SCOPE` | Target | Needs | Use when |
|---|---|---|---|
| `db` (auto on a direct connection) | a scratch **database** per scenario | `CREATEDB`; **no** connection pooler | local, or a direct Supabase string |
| `schema` (auto on a pooler) | a scratch **schema** per scenario in `postgres` | nothing extra | pooler, or a role without `CREATEDB` |
| `auto` (default) | picks | — | just works |

`auto` is the default and needs no configuration. Force one with
`VERIFY_SCOPE=db` or `VERIFY_SCOPE=schema`.

In schema scope the migrations run with
`?options=-c search_path=ef_verify_<stamp>`, so every object lands in the scratch
schema and the script asserts that it did — an accidental write to `public`
fails the run rather than passing quietly. Schema teardown takes ~100ms; database
teardown has to wait for pooled backends to release.

Two things schema scope cannot check, and says so in its output rather than
reporting a false pass:

- Applying 003 to a **populated** `leads` table (a `NOT NULL` add with no default
  would fail on real rows, and a scratch schema starts empty). To cover it:
  `VERIFY_SCOPE=db` against a direct connection, insert a lead, re-run 003.
- Anything that depends on the target being its own database rather than a
  namespace within one.

Leave the targets in place for inspection with `VERIFY_KEEP=1`.

## 5. Obtaining the Supabase CA

`DB_SSL_CA_FILE` needs the **Supabase Root 2021 CA**, not the intermediate and
not the server certificate. A leaf certificate cannot verify a chain; pointing
`DB_SSL_CA_FILE` at the wrong one produces a TLS error that gives no hint.

There is no stable public download URL for it — `supabase.com/cacerts` returns
404. Two supported routes:

### A. `npm run db:fetch-ca` (recommended)

```bash
cd server
node scripts/fetch-supabase-ca.js --host db.<project-ref>.supabase.co
# writes server/certs/supabase-root-2021.pem
```

It reads the chain the endpoint presents, walks to the self-signed root, and
**refuses to write anything whose SHA-256 fingerprint is not pinned** in
`PINNED_ROOTS` inside that script. The initial connection does not verify the
certificate — that is the only way to read a chain whose root you do not have
yet — so the pin is what makes the fetch trustworthy. Without it the script
would happily save an attacker's root CA.

Currently pinned:

| CN | SHA-256 | Valid to |
|---|---|---|
| `Supabase Root 2021 CA` | `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa` | 2031-04-26 |

`--check` verifies without writing. `--out <path>` chooses the destination.

**When Supabase rotates the root** the fetch fails with a fingerprint mismatch
and tells you the value it saw. Confirm it against Supabase's own published
chain, then update `PINNED_ROOTS` and re-run. A stale pin is the correct
behaviour: a CA quietly swapped underneath a deploy is exactly the attack this
guards against.

`server/certs/` is gitignored. The CA is a public document, but a copy in the
repo goes stale silently and the failure only appears as a TLS error at
connect time.

### B. From the Supabase dashboard

Project Settings → Database → Connection string. The certificate shown for
your project is the leaf; the root is what `fetch-ca` retrieves for you. If you
obtain the PEM another way, verify it before installing:

```bash
openssl x509 -in <file> -noout -subject -issuer -fingerprint -sha256
```

You are looking for `subject == issuer` (self-signed), `CA:TRUE`, and a
fingerprint matching the table above.

### Installing it

```bash
# Development
node scripts/fetch-supabase-ca.js --host db.<ref>.supabase.co
export DB_SSL_CA_FILE="$PWD/certs/supabase-root-2021.pem"

# Docker
cp certs/supabase-root-2021.pem ./certs/     # on the host
#   …and mount it:  -v "$PWD/certs:/app/certs:ro"
# The path is resolved INSIDE the container.

# Debian/Ubuntu system trust store (affects psql and other clients too)
sudo cp certs/supabase-root-2021.pem /usr/local/share/ca-certificates/supabase-root-2021.crt
sudo update-ca-certificates
```

Then confirm before deploying:

```bash
npm run db:ssl-check:connect
```

## 6. Safety

Both writing scripts default to **localhost only**. Pointing one at a hosted
Postgres has to be deliberate:

- `VERIFY_ALLOW_REMOTE=1` is required. Without it the localhost check refuses,
  exactly as before, so local setups are unaffected.
- `NODE_ENV=production` is refused outright, remote or not.
- The target is printed before any write — host, port, user, database, password
  masked — along with what the run is about to do.
- `verify:migrations` refuses to `DROP DATABASE` anything not named
  `ef_verify_fresh_*` / `ef_verify_drift_*`, and the same for schemas. The
  `postgres` database is never a drop candidate.
- `smoke:auth-db` creates and deletes users **inside the demo tenant only**, and
  cleans up after itself.
- The Supabase pooler is refused for `VERIFY_SCOPE=db` by name, because the
  scratch databases would be orphaned.

## 7. Reading the output

### `verify:migrations` — exit 0 means all four scenarios passed

```
[verify] scope: schema
=== 1. FRESH ===        all 6 migrations recorded; every checksum present;
                        the cross-vertical columns and indexes exist
=== 2. IDEMPOTENT ===   migrate ran twice more; still exactly 6 rows, no
                        duplicate indexes
=== 3. DRIFTED ===      a pre-003 target was rebuilt and matched a fresh one
                        column-for-column and index-for-index
=== 4. IMMUTABILITY === a corrupted checksum was refused
```

- `FAIL <label>` — a real regression; the detail line names what differed.
- `--  SKIPPED: <reason>` — a check this scope cannot honestly perform, with the
  command to run it elsewhere. Not a failure.
- The scenario-3 drift is built explicitly (003's objects are dropped and
  re-applied), because withholding 003 alone no longer reproduces the
  2026-09-23 drift: 001 was frozen *after* the in-place edit, so today's 001
  already creates every column 003 would.

### `smoke:auth-db` — exit 0 means all 51 checks passed

Eight sections: invite, accept, login, refresh + reuse detection, logout,
forgot/reset, lockout, audit rows. Every `ok` line is a behavioural claim
verified against a real row — for example "the password is Argon2id-hashed" and
"the stored hash rejects a wrong password" actually run Argon2 against what
Postgres returned.

### `smoke:listings` — exit 0 means the HTTP lifecycle worked

`SMOKE_WRITE=1` adds create / patch / assign / verify / upload-photo / delete
and a post-delete 404. Each write also produces an `audit_log` row; check them
with `npm run audit:resign:dry`, which reports how many verify.

### Audit integrity

```bash
npm run audit:resign:dry   # report only, changes nothing
npm run audit:resign       # re-sign rows that do not verify
```

Re-signing is a separate, explicit step rather than something a migration does
to you unattended: a row that fails verification is, by construction,
indistinguishable from a row that genuinely was altered. The dry run groups the
failures by cause so you can tell "expected" from "needs explaining" before
changing anything.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `self-signed certificate in certificate chain` | no CA bundle, or a stale one | §5 — `npm run db:fetch-ca`, then set `DB_SSL_CA_FILE` |
| `hostname/IP does not match the certificate` | connected through the pooler, whose cert is not for your host | use the direct host for production |
| `Refusing to start: DB_SSL_CA_FILE could not be read` | wrong path, or a path that only exists on the host | check the path *inside* the container; §5 |
| `DB_SSL_MODE=require in production` | dev value deployed | `verify-full` + CA; `require` is dev/staging only |
| `DB_SSL_REJECT_UNAUTHORIZED=false in production` | certificate checking turned off | remove it and supply a CA instead |
| `Refusing to run: DATABASE_URL host is "…pooler…"` | `VERIFY_SCOPE=db` on a pooler | use the direct string, or `VERIFY_SCOPE=schema` |
| `DROP DATABASE … is being accessed by other users` (55006) | pooler holding a backend | same as above |
| `permission denied to create database` | role lacks `CREATEDB` | `VERIFY_SCOPE=schema` |
| `null value in column "tenant_id" of relation "audit_log"` | a code path audits without a tenant | the actor must come from the row, not `req.user` |
| every audit row "verifies" but none are signed | `JWT_SECRET` unset | set it; verification makes no claim without a key |
| `refusing to migrate: … file has changed` | an applied migration was edited | put the change in a new numbered file |

Diagnose any of the SSL rows with `npm run db:ssl-check:connect`, which
reproduces the exact TLS decision the pool will make without starting the
server.


---

## 9. CI

`.github/workflows/ci.yml` runs on every push and pull request.

### Why a real database in CI

Mock-based tests reported green twice while the database path was broken.
Both defects were invisible to a mock and obvious to a real Postgres:

- `refresh()` revoked a stolen token's family inside a transaction that
  then threw, rolling the revocation back.
- `ON DELETE SET NULL` on `audit_log.user_id` nulled a **signed** field,
  so 38 of 42 audit rows reported as tampered.

The second one had a test — the fake simply did not reproduce the
cascade. Neither would have been caught without a database.

### The gate: `REQUIRE_DB=1`

The DB-integration tests used to skip silently when `DATABASE_URL` was
absent, so a green run could mean "the database was never touched". Set:

```bash
REQUIRE_DB=1 DATABASE_URL=… npm test
```

and any DB-dependent test that would skip instead **fails**, naming the
missing variable. See [server/src/test-support/requireDb.js](../server/src/test-support/requireDb.js).
Unset, behaviour is unchanged — a contributor with no database still gets
a green run.

The asymmetry is deliberate. Some tests assert the *absence* of a
database ("`query()` throws a not-configured error", "offline dev auth
grants nothing"); those still skip when a database is present and are
never escalated.

### Jobs

| Job | Database | Runs on |
|---|---|---|
| `static` | none — lint, build, secret check | every push/PR |
| `unit` | none, `REQUIRE_DB` unset | every push/PR |
| `postgres` | **ephemeral** `postgres:16` service | every push/PR |
| `supabase` | Supabase, from secrets | manual, scheduled, or when `SUPABASE_CI_ENABLED=true` |
| `ca-drift` | none — fingerprint check only | scheduled, manual |

`postgres` is the one that makes CI meaningful for contributors: an
ephemeral container needs no secrets and cannot be pointed at anything
shared. `supabase` is what exercises the production TLS path, which the
ephemeral container cannot — it speaks cleartext.

### Commands each database job runs

```bash
node src/db/migrate.js
node src/db/migrate.js --seed
REQUIRE_DB=1 npm test
npm run verify:migrations
npm run smoke:auth-db
# server started on loopback, then:
node scripts/smoke-listings.js
SMOKE_WRITE=1 node scripts/smoke-listings.js
npm run audit:resign:dry -- --since "$RUN_STARTED_AT"
```

### Secrets and variables

None are needed for `static`, `unit` or `postgres`.

For `supabase`, add to the repository (or the `supabase-ci` environment):

| Kind | Name | Value |
|---|---|---|
| secret | `SUPABASE_DIRECT_DATABASE_URL` | `postgresql://postgres:PASS@db.<ref>.supabase.co:5432/postgres` |
| secret | `SUPABASE_DATABASE_URL` | `postgresql://postgres.<ref>:PASS@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require` |
| secret | `SUPABASE_CA_PEM` | the Supabase root CA **body**, from `npm run db:fetch-ca` |
| secret | `JWT_SECRET` | 32+ random bytes — **stable**, see below |
| variable | `SUPABASE_CI_ENABLED` | `true` to run `supabase` on push/PR |
| variable | `SUPABASE_DIRECT_HOST` | `db.<ref>.supabase.co`, for the CA-drift check |

`SUPABASE_CA_PEM` must be the certificate text, not a path. The workflow
writes it to `/usr/local/share/ca-certificates/`, points
`DB_SSL_CA_FILE` at it, and deletes it. It is never uploaded as an
artefact.

### `JWT_SECRET` must be stable

The audit signing key is derived from `JWT_SECRET`. A job using a
different secret finds every pre-existing row unverified, which is a
false alarm — and a false alarm in CI is how people learn to ignore a
real tamper-evidence failure.

Two defences:

- the job records `RUN_STARTED_AT` before doing anything and checks only
  the rows it wrote, which were signed with the key it holds;
- `audit:resign:dry` detects "no row verifies with this key" and exits
  **3** with a key-mismatch message rather than reporting 222 rows as
  tampered.

### Safety

- `NODE_ENV=production` is never set; every step refuses it.
- `VERIFY_ALLOW_REMOTE=1` is set only in the jobs whose database is a
  throwaway (ephemeral container, or the Supabase test project).
- The target is printed with the password masked, and the Supabase job
  additionally refuses any host that is not `db.*.supabase.co`.
- `verify:migrations` runs in **schema** scope against the pooler and
  drops only `ef_verify_*` schemas.
- `smoke:auth-db` creates and deletes users in the demo tenant only.
- The `static` job fails if `server/.env` or any certificate is tracked.

**Point the Supabase job at a test project, never production.** It runs
`db:migrate --seed` and writes listings.
