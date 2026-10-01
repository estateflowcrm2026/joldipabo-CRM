# Manual cleanup — RESOLVED 2026-09-28 ✅

**Date:** 2026-09-28
**Instance:** the dev/testing Supabase project (`aws-0-ap-south-1`, ap-south-1)

## What was left behind (and is now removed)

Three runs of `scripts/rls-check.js` failed during development and their
cleanup did not complete. Each left a database role; one also left the
scratch schema. All are inert — a role with no grants and a schema with
no owner-assigned privileges cannot read or write anything — but they are
debris and should be removed.

| Object | Kind |
|---|---|
| `ef_rls_check` | schema |
| `ef_rls_check_3ca3cc98` | role |
| `ef_rls_check_bfb80c2e` | role |
| `ef_rls_check_f9b7092c` | role |

## Why the runs failed

Three separate defects in the check script, all since fixed:

1. **`client.release()` after `closeDb()`.** Draining the pool first
   makes `release()` return `undefined`, so the script threw on the last
   line and the process exited non-zero *after* cleanup had run — which
   masked every assertion result.
2. **The scratch schema was created inside a transaction.** The
   `asRole()` helpers take clients from the pool, and a pooled client
   cannot see another connection's uncommitted DDL, so every assertion
   failed with `3F000 schema does not exist`.
3. **Cleanup dropped the role before the schema.** The role holds
   `GRANT`s on the scratch table, and Postgres refuses to drop a role
   that still owns anything.

## How to remove them

Order matters — the schema first, because the roles hold grants on it:

```sql
DROP SCHEMA IF EXISTS ef_rls_check CASCADE;
DROP ROLE IF EXISTS ef_rls_check_3ca3cc98;
DROP ROLE IF EXISTS ef_rls_check_bfb80c2e;
DROP ROLE IF EXISTS ef_rls_check_f9b7092c;
```

Or, in Supabase's SQL editor, the same four statements.

To confirm nothing is left:

```sql
SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ef_rls%';
SELECT rolname FROM pg_roles WHERE rolname LIKE 'ef_rls%';
```

Both should return zero rows.

## The script now cleans up after itself

All three defects are fixed in
[server/scripts/rls-check.js](../server/scripts/rls-check.js). It now:

- drops any pre-existing scratch schema before creating its own, so an
  interrupted run does not block the next one;
- releases the setup client *before* `closeDb()`, so a successful run is
  not masked by a throw on the last line;
- drops the **schema before the role**, because the role holds `GRANT`s
  on it and Postgres refuses to drop a role that still owns anything;
- prints the exact `DROP` statements if cleanup fails — which is how
  these three were identified;
- refuses to run with `NODE_ENV=production`.

## Status as of the end of Phase 8

**Still present** — the three roles and the schema listed above have not
been removed; the removal was blocked pending this note.

**Not present** — the `ef_verify_*` scratch schemas are transient
(`verify:migrations` drops its own on success). One pair may linger after
a run that was interrupted; they are harmless and are dropped by the
next run of the same script.

Re-run `npm run rls:check` to confirm the fixed script leaves nothing
behind.

