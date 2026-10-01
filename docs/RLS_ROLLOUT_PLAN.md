# RLS rollout plan

Tenant isolation today rests entirely on hand-written `tenant_id = $1`
predicates in the repositories — 68 sites across
[server/src/repositories/](../server/src/repositories/) and
[server/src/routes/](../server/src/routes/). That is a lot of places to
be right, and one omission is a cross-tenant read.

Row-level security moves the guarantee into the database, where no
forgotten `WHERE` clause can bypass it. This document records the
readiness audit, the plan, and what is implemented so far.

**Status as of 2026-09-28: RLS IS ENFORCING.** The `estateflow_app` role
exists, `APP_DATABASE_URL` points at it, and `npm run rls:check` passes
7/7 — tenant A cannot read, update or insert into tenant B, and can
still read its own rows. See §1 and §6.

---

## 1. The finding that blocks rollout

**The application connects as a role with `BYPASSRLS`, so policies would
not apply at all.**

```
current_user: postgres
rolbypassrls: true
tables owned by the connecting role: 30 / 30
```

Postgres exempts table owners from RLS unless `FORCE ROW LEVEL SECURITY`
is set, and this role has `BYPASSRLS` besides. Demonstrated against a
throwaway schema on the verification database:

```sql
CREATE TABLE ef_rls_probe.t (id text primary key, tenant_id text not null);
INSERT INTO ef_rls_probe.t VALUES ('a','tenantA'),('b','tenantB');
ALTER TABLE ef_rls_probe.t ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON ef_rls_probe.t
  USING (tenant_id = current_setting('app.tenant_id', true));

BEGIN;
SELECT set_config('app.tenant_id', 'tenantA', true);
SELECT id FROM ef_rls_probe.t;   -- returns BOTH rows
```

Two rows, with the tenant set. The policy is present, correct, and
inert. **Enabling RLS today would produce a green deploy and no
protection whatsoever** — the same failure shape as the two already in
this codebase's history: a control that looks configured and is not.

### What has to change first

A **non-owner, non-BYPASSRLS application role**. Concretely:

```sql
CREATE ROLE estateflow_app LOGIN PASSWORD :from-secret-manager NOSUPERUSER
      NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO estateflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO estateflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO estateflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO estateflow_app;
```

Migrations keep running as the owner. The app connects as
`estateflow_app`. That split is the normal shape and is what makes RLS
mean anything.

> **Do not** reach for `FORCE ROW LEVEL SECURITY` as a shortcut. It makes
> the *owner* subject to policy, which means migrations, `db:reset` and
> any operator session also need a tenant set — including the ones that
> legitimately have no tenant. It converts "policies are ignored" into
> "everything breaks at once", and it does not remove the need for a
> separate role.

### DONE — 2026-09-28 (Phase 8B)

The role exists. `server/scripts/app-role.js` creates and reconciles it;
`npm run db:app-role:check` reports its current state.

```
[app-role] estateflow_app
  ok   is NOT a superuser
  ok   does NOT bypass RLS — this is the whole point
  ok   cannot create databases
  ok   cannot create roles
  ok   inherits PUBLIC grants — needed for base types on Supabase
  ok   owns no tables
  ok   has DML on all 29 application tables
  ok   holds no DDL/TRUNCATE/REFERENCES grants
  ok   has NO access to schema_migrations
```

Three decisions worth recording:

- **`NOINHERIT` is deliberately NOT set.** Supabase grants usage on
  schemas and the base types to `PUBLIC`; a role that does not inherit
  would be unable to use `text` or `jsonb` at all, and the failure
  would read as a missing grant rather than a missing `INHERIT`.
- **`schema_migrations` is excluded.** The application never reads its
  own migration history — only the runner does. Granting it would let a
  compromised process rewrite the record of what has been applied to it.
  `--check` asserts the exclusion so a convenient `GRANT ALL ON ALL
  TABLES` cannot quietly reintroduce it.
- **Supabase blocks `ALTER ROLE`** through a `supautils` hook for a
  non-`supabase_admin` session. Creation and grants work; attribute
  changes need the SQL editor. The script reports which case it is in
  and verifies the attributes as they stand rather than failing silently.

### Two connection strings

| Variable | Used by | Role |
|---|---|---|
| `DATABASE_URL` | `db:migrate`, `db:seed`, `db:reset`, admin scripts | owner |
| `APP_DATABASE_URL` | **the running server** | `estateflow_app` |

`APP_DATABASE_URL` is optional. When absent the pool falls back to
`DATABASE_URL`, so every existing development setup is unchanged. What
changed is that **production refuses to boot without it**:
`assertRuntimeRoleIsRlsSubject()` fails when it is missing, or when the
username is `postgres`, `supabase_admin` or `service_role`.

That guard checks the *configured* role, which is cheap and needs no
connection. `npm run db:app-role:check` is the authoritative test — it
queries `pg_roles`. `npm run rls:check` is the behavioural proof: it
connects as the app role and asks whether tenant A can read tenant B.

---

## 2. Readiness audit

30 tables in `public`. 20 carry `tenant_id` directly; 6 inherit it
through a foreign key; 4 have no tenant at all.

### 2a. Tenant-scoped, `tenant_id` present (20)

| Table | Notes |
|---|---|
| `listings` | primary business object; reads are `l.tenant_id = $1` |
| `leads` | same shape as listings |
| `visits` | references `listings`; `listing_id` added by 003 |
| `listing_photos` | |
| `photos` | **legacy** duplicate of `listing_photos` — confirm which is authoritative before protecting |
| `listing_documents` | |
| `listing_matches` | |
| `attendance` | |
| `export_jobs` | |
| `messages`, `threads` | |
| `users` | |
| `branches`, `teams`, `projects` | |
| `refresh_sessions` | see §2d |
| `login_attempts` | see §2d |
| `otp_codes` | `phone` is `NOT NULL`; used by an unbuilt OTP flow |
| `mfa_challenges` | Phase 7; short-lived, see §2d |
| `audit_log` | see §2d |

### 2b. Tenant-scoped by inheritance, no `tenant_id` (6)

These cannot use a `tenant_id = current_setting(...)` policy. Either add
the column or write an `EXISTS` policy that walks the FK.

| Table | Tenant reached via |
|---|---|
| `mfa_backup_codes` | `user_id` → `users.tenant_id` |
| `password_reset_tokens` | `user_id` → `users.tenant_id` |
| `project_members` | `project_id` → `projects.tenant_id` |
| `team_members` | `team_id` → `teams.tenant_id` |
| `thread_participants` | `thread_id` → `threads.tenant_id` |
| `user_project_ids` | `project_id` → `projects.tenant_id` |

An `EXISTS` policy is correct but costs a subquery per row and, more
importantly, makes the security property depend on the FK never being
dropped. **Adding a denormalised `tenant_id` to these six is the better
trade** — cheap to backfill, cheap to verify, and the same predicate
shape as everything else.

### 2c. Global / reference (4)

| Table | Treatment |
|---|---|
| `organisations` | the tenant itself. RLS by `id = current_setting('app.tenant_id')`. But `db:seed` and tenant resolution read it **before** a tenant is known — see §4. |
| `roles` | global catalogue, 8 rows, no tenant. **No RLS.** |
| `permission_matrices` | keyed by `role_id` → `roles`. Global. Empty today. **No RLS.** |
| `schema_migrations` | migration bookkeeping. **No RLS**, and deliberately so — the runner must work with no tenant set. |

`roles` and `permission_matrices` are read by every tenant, so a tenant
policy would break login outright. They are the clearest case for
documenting "this table is intentionally global" rather than defending
it.

### 2d. Special handling required

| Table | Why it is not like the others |
|---|---|
| `audit_log` | `ON DELETE SET NULL` on `user_id` already bit once (see [auth plan](AUTH_TENANT_SECURITY_PLAN.md) and migration 007). An audit row must survive its actor. RLS on `audit_log` needs `INSERT`-only policies for most paths, and a **deliberate bypass for the integrity job**, which reads every row across tenants by design. |
| `schema_migrations` | Runs with no tenant. Must never be policy-protected. |
| `refresh_sessions` | The login flow looks a session up **before** the tenant is known — by token hash alone. A tenant policy would make that lookup fail. Needs either a `SECURITY DEFINER` function or an explicit exemption for the pre-auth window. |
| `login_attempts` | Same pre-auth problem: keyed by `tenant|identifier` to count a spray across unknown tenants. |
| `organisations` | Tenant *lookup* by slug happens with no tenant set (`resolveTenantId`). |
| `roles` | Global, see §2c. |

**`refresh_sessions`, `login_attempts` and `organisations` share one
constraint: they are read during authentication, before a tenant is
established.** That is the hard part of this rollout and is why they are
not in the first batch.

### 2e. Queries that already filter by tenant

68 sites carry a `tenant_id` predicate. The listings repository is the
densest (`l.tenant_id = $1` on every read, plus join conditions pinning
`u.tenant_id = l.tenant_id` and `p.tenant_id = l.tenant_id`).

`scopeFilterFor()` in
[server/src/rbac/scopeFilters.js](../server/src/rbac/scopeFilters.js)
returns `1 = 0` when the user has no tenant — a deny-all default that
is worth keeping regardless of RLS, because it is a second, independent
check.

### 2f. Leak surface

Three shapes of exposure, in descending likelihood:

1. **A new query without the predicate.** Most likely. A repository
   method written for a new screen, a JOIN whose `ON` clause omits the
   tenant condition, an aggregate over a child table.
2. **`photos` vs `listing_photos`.** Two tables for what looks like one
   concept. If they are not both consistently filtered, one is a
   side door into listing media.
3. **Junction tables.** `team_members`, `project_members`,
   `thread_participants`, `user_project_ids` have no `tenant_id`, so
   nothing in the current code filters them directly — they are reached
   through their parent. A direct query against one is unguarded today.

---

## 3. Tenant context

Implemented in
[server/src/db/client.js](../server/src/db/client.js) as
`withTenant()`. It already existed and was **never called**; its own
comment said so. It is now used, and `set_config(..., true)` is
transaction-scoped, so the value cannot leak to the next request that
borrows the same pooled connection.

```js
await withTenant({ tenantId }, async (client) => {
  // app.tenant_id is set for the duration of THIS transaction only
});
```

Properties this gives, each with a test:

- **Scoped to the transaction.** The `true` third argument to
  `set_config` makes it local. Postgres discards it at `COMMIT`/`ROLLBACK`.
- **Set before the first query in the transaction**, so no statement in
  the block can run without it.
- **Transaction-scoped, not session-scoped.** A session-level setting
  would persist across pool reuse and cross tenants — the failure mode
  documented in the function header.
- **Fails closed.** `withTenant({})` throws rather than running the
  block unscoped. A typo must not silently disable isolation.

### What is NOT yet true

`withTenant` is now called from the listing and lead read/write paths.
It is **not** wired into every repository, so a table without a policy is
still protected only by its predicates. RLS is the backstop for the
tables in §5, and nothing else yet.

---

## 4. Why not all at once

Enabling RLS on `organisations`, `refresh_sessions` and `login_attempts`
requires answering "how does a login establish a tenant when reading the
rows that decide which tenant to use?". The options:

- **`SECURITY DEFINER` functions** for the pre-auth reads. Precise, but
  each function is a hole that must be audited individually, and
  `SECURITY DEFINER` combined with RLS is easy to get subtly wrong.
- **Keep those three exempt**, and accept that the auth path relies on
  predicates alone.
- **Two-phase login**: resolve the tenant in an exempt step, then run
  everything else under policy.

The recommendation is the second for the first rollout, with the auth
path called out in the security review. The first is the right end
state and is a separate piece of work.

---

## 5. Implemented so far — migration 010

Four tables, behind an off-by-default flag:

| Table | Rationale |
|---|---|
| `listings` | highest-value object; reads already predicate-filtered |
| `leads` | same access pattern, high value |
| `visits` | child of listings; tests the child-table case |
| `listing_photos` | child of listings; tests a second child shape |

Policy shape, identical on all four:

```sql
USING      (tenant_id = current_setting('app.tenant_id', true))
WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
```

`WITH CHECK` is the half that is easy to forget: without it a row can be
**written** into another tenant even though reads are filtered.

`current_setting('app.tenant_id', true)` — the `true` is
`missing_ok`, so a query with no tenant set yields `NULL`,
`tenant_id = NULL` is never true, and the row is invisible. **That is
fail-closed**: a missing context denies access rather than granting it.

### The flag

`DB_RLS_MODE` — `off` (default) | `enforce` | `probe`.

| Mode | Effect |
|---|---|
| `off` | migration applies the schema, policies are created but `ENABLE ROW LEVEL SECURITY` is **not** set. The app behaves exactly as before. |
| `enforce` | RLS enabled. Only meaningful with a non-BYPASSRLS role (§1). |
| `probe` | enabled, and `smoke:listings` and the RLS test suite assert that behaviour is **identical** to `off` while also asserting the policy is present. Divergence fails. |

`probe` is the mode CI runs. It is the interesting one: it proves the
policies do not change what the application sees, using the existing
predicate-based tests as the oracle — see §6.

### Migration/admin paths

`db:migrate`, `db:seed` and `db:reset` run as the owner. With
`ENABLE ROW LEVEL SECURITY` unset (the default) they are unaffected. If
an operator enables RLS manually, the runner still works because the
owner bypasses policy — which is exactly why the owner is not the role
the app should use.

---

## 6. Parallel RLS test mode

`npm run test:rls` and `DB_RLS_MODE=probe` in CI.

The oracle is the existing test suite. Every test that asserts
tenant-scoped behaviour must produce **the same result** with policies
present and with them absent. A test that passes only under one mode is
either a latent leak or an RLS policy that is too strict — both are
failures, and both are things the existing predicates alone would not
have told you.

```bash
# locally
DB_RLS_MODE=probe REQUIRE_DB=1 DATABASE_URL=… npm test
npm run test:rls          # the RLS-specific suite
npm run rls:check         # a real-database probe, creates nothing permanent
```

`scripts/rls-check.js` connects as **`estateflow_app`** — the role the
application actually uses — against the four real protected tables, and
asks six questions:

1. baseline: the owner sees both tenants (the contrast that matters)
2. can tenant A read tenant B's rows?            → no
3. can tenant A still read its OWN rows?           → yes
4. can tenant A update tenant B's rows?           → no
5. can tenant A insert a row into tenant B?        → no
6. with no tenant set, is anything visible?       → no

Question 3 is the one a too-strict policy fails. A policy that denies
everything would pass 2, 4, 5 and 6 and be useless.

It writes nothing: every statement runs inside a transaction that is
always rolled back, including the probe row and the second tenant it
creates as the owner. Verified afterwards — zero rows left behind.

It refuses to run with `NODE_ENV=production`, and refuses to run at all
if `APP_DATABASE_URL` is missing or names a role with `BYPASSRLS` —
because a run that silently degrades to the owner is worse than no run.

### Phase 8C — the other three tables, 2026-09-28

Of the four protected tables, only **two have any application code**:

| Table | Application SQL | Wired |
|---|---|---|
| `listings` | [listingsRepository.js](../server/src/repositories/listingsRepository.js) | ✅ 6 write paths + 3 read paths |
| `listing_photos` | same file (`addListingPhoto`, plus the correlated `photo_count` subquery) | ✅ already covered by the listings wiring |
| `leads` | **none** | n/a |
| `visits` | **none** | n/a |

`leads` and `visits` have **no repository and no SQL anywhere in the
application**. [routes/leads.js](../server/src/routes/leads.js) and
[routes/visits.js](../server/src/routes/visits.js) return
`{ items: [], placeholder: true }` and throw `501 NotImplemented`; they
never issue a statement. Their tables carry RLS policies that nothing can
currently exercise, because nothing queries them.

So there was nothing to wire, and that is worth recording rather than
leaving as a silent gap: **when leads and visits are built, their
repositories must use `tenantQuery` / `withTenant` from the first
query.** A regression test asserts they still contain no SQL — so the day
someone adds one, the test fails and points here.

[`src/routes/photos.js`](../server/src/routes/photos.js) targets the
LEGACY `photos` table, not `listing_photos`, and is also a set of 501
stubs. The `photos` vs `listing_photos` duplication is still unresolved.

Verified under `estateflow_app` with RLS enforcing: a photo written
through `POST /listings/:id/photos` reads back as `photoCount = 1` on
both the detail and the list endpoint, so the correlated subquery is
correctly tenant-scoped too.

### Result, 2026-09-28

```
[rls-check] role=estateflow_app  table=listings
  ok  baseline: the owner sees the other tenant's rows
  ok  tenant A cannot read tenant B rows
  ok  tenant A still sees its OWN rows
  ok  tenant A cannot UPDATE tenant B rows
  ok  tenant A cannot INSERT into tenant B
  ok  with no tenant set, nothing is visible
  ok  the tenant context does not survive a transaction
7 passed, 0 failed, 0 skipped.
```

Enabling it then BROKE the application, which is the point of doing it
this way: with RLS on, every listings read returned zero rows and every
INSERT was rejected with *"new row violates row-level security policy"*,
because no repository set a tenant context. `tenantQuery()` (single
statement) and `withTenant()` (a block) were added to
[server/src/db/client.js](../server/src/db/client.js) and the listings
repository routed through them. The full listings read AND write
lifecycle then passed unchanged as `estateflow_app`.

```bash
npm run rls:check          # reads APP_DATABASE_URL from .env
```

An earlier version created a throwaway role and tested a scratch schema.
That proved the policy TEXT was sound but never exercised the real
tables or the real role, and it left debris behind when a run failed.

---

## 7. Sequence to full rollout

1. ~~**Create `estateflow_app`**~~ ✅ 2026-09-28. `npm run db:app-role
   -- --create`. Worth doing on its own: it stops the app being able to
   `ALTER` its own tables, and it is a prerequisite for everything below.
2. **Run `probe` in CI** for a week. No behaviour change; the point is
   to prove the policies are correct before they bite.
   *(the probe step is in `.github/workflows/ci.yml`; the `enforce` step
   needs a `APP_DATABASE_URL` secret)*
3. **Wire `withTenant` into every repository** that touches a protected
   table. The flag makes this verifiable — a missing call shows up as a
   probe failure.
4. **`enforce` for the four tables** in staging. Watch for the
   pre-auth reads.
5. **Add `tenant_id` to the six junction tables** (§2b) and protect them.
6. **Decide the auth path** (§4) for `organisations`,
   `refresh_sessions`, `login_attempts`.
7. **`audit_log` last**, with a deliberate exemption for the integrity
   job.
8. **`enforce` in production**, with a documented rollback (set
   `DB_RLS_MODE=off` and redeploy — the policies stay, the gate opens).

Every step is independently reversible. Step 8's rollback is one
environment variable.

---

## 8. The `photos` / `listing_photos` duplication — resolved 2026-09-28

Two media tables, and the earlier claim that this was an open risk was
right: `photos` had **no RLS policy** and `estateflow_app` held **full
DML** on it. A future route querying it would have walked past every
guard, silently.

| | `photos` | `listing_photos` |
|---|---|---|
| Scoped by | `project_id` (project media) | `listing_id` (listing media) |
| Columns | 15 | 14 |
| Rows | **0** | 30 |
| RLS | none (now always-false) | `tenant_isolation` |
| App role grants | 4 → **0** | 4 |
| Application SQL | **none** | `addListingPhoto`, `photo_count` |

### Decision: DENY, do not drop

[`011-photos-deprecated.sql`](../server/src/db/011-photos-deprecated.sql)
does three things, all reversible:

1. **RLS with an always-false policy.** Even if a GRANT is issued by
   mistake, every row is denied and a query returns nothing rather than
   another tenant's data.
2. **`REVOKE ALL` from `estateflow_app`** — via a `format()` over
   `pg_class`, because `photos.id` is `text` and may own no sequence.
3. **A `COMMENT ON TABLE`** saying it is deprecated and that
   `listing_photos` is the table to use. This is the only documentation
   a developer sees in a schema browser before deciding to query it.

Not dropped, because dropping is irreversible on a shared instance, the
table is in [DATA_MODEL.md](DATA_MODEL.md), and whether project-scoped
media is a real requirement is a product question. A revoked grant is one
statement; a dropped table in a dump taken an hour ago is not.

### The intended model

**Consolidate on `listing_photos`.** It is the only one with code, a
policy and rows. Project-scoped media, if it is ever required, becomes a
column or a join on `listing_photos` rather than a second table — two
media tables with different scoping is the root of the problem.

### Verified, not asserted

`npm run rls:check` now runs an eighth assertion as the app role:

```
ok  the deprecated photos table is unreachable for the app role
      (refused with 42501)
8 passed, 0 failed, 0 skipped.
```

`GET /api/v1/photos` returns `{ deprecatedTable: "photos", use:
"listing_photos" }` rather than a bare placeholder, and
[routes/photos.js](../server/src/routes/photos.js) carries a header
explaining the two non-negotiable rules for whoever implements it. A
regression test fails if that file gains SQL without tenant context.

## 9. Related

- [AUTH_TENANT_SECURITY_PLAN.md](AUTH_TENANT_SECURITY_PLAN.md) — where
  tenant isolation is discussed in the wider auth design
- [MIGRATIONS.md](MIGRATIONS.md) — how to add 011 without editing 010
- [server/src/db/010-rls-listings-leads.sql](../server/src/db/010-rls-listings-leads.sql)
- [server/src/db/rlsMode.js](../server/src/db/rlsMode.js) — the flag
- [server/src/rls/rls.test.js](../server/src/rls/rls.test.js)
- [server/scripts/rls-check.js](../server/scripts/rls-check.js)
