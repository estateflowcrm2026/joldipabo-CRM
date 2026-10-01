# Migrations — how they work, and how to repair local drift

Applies to [server/src/db/](../server/src/db/).

---

## 1. The rules

1. **`001-schema.sql` and `002-indexes.sql` are FROZEN.** Do not edit them. They have been applied to real databases and their checksums are recorded.
2. **Every schema change goes in a new numbered file** — `004-…`, `005-…` — registered in `MIGRATIONS` in [migrate.js](../server/src/db/migrate.js).
3. **Every statement must be idempotent.** Use `IF NOT EXISTS`, or a guarded `DO` block. `db:migrate` is run repeatedly by design; a statement that fails on the second run is a bug.
4. **Order matters.** Migrations apply in array order. The runner refuses to proceed if a later migration is recorded but an earlier one is not.

Why rules 1–3 exist: on 2026-09-23 the cross-vertical lead columns and `visits.listing_id` were added by editing `001-schema.sql` **in place**, after it had already been applied locally. The runner tracked migrations by name with no checksums, so it skipped the file on every database that had already run it. Fresh databases got the columns; existing ones did not. The two schemas silently diverged and nobody found out for a week.

`003-cross-vertical.sql` repairs that. The freeze, the checksum tracking, and the "put it in a new file" convention exist so it cannot happen again.

---

## 2. Safety properties

### Checksums

Every applied migration records a SHA-256 of its SQL. On each run the runner re-hashes every applied file and **refuses to migrate** on any mismatch — before touching the schema.

The failure names the file, and gives three paths: new migration file for an intended change, `db:reset` for a scratch database, or a corrective migration for a database that has real data. History is never rewritten.

A row with a `NULL` checksum (a database created before 2026-09-24) is tolerated — there is no baseline to compare against. The checksum is backfilled on the next run, so the check is armed from then on.

### Advisory lock

The runner holds a session-level `pg_advisory_lock` for the whole run. Two concurrent deploys cannot both migrate: the second blocks, then sees the first one's result. Without this, two replicas starting together would each read "001 not applied" and both apply it.

Session-scoped means a killed runner releases the lock when its connection dies — a crashed migration cannot leave a permanent lock.

### Partial failure

Each file is sent as one parameterless query, which uses the simple query protocol; Postgres wraps that in an implicit transaction. If statement 40 of a file fails, statements 1–39 roll back and the migration is not recorded. The next run retries cleanly.

The known weak link is the gap *after* the DDL: a crash between the SQL and the tracking-row insert leaves the schema applied but unrecorded. Idempotency rescues this, at the cost of re-running the file.

---

## 3. Repairing a local dev database

Pick the situation that matches yours.

### A. You have never run migrations — nothing to repair

```bash
export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
cd server
npm run db:migrate
npm run db:seed
```

### B. You ran migrations before 2026-09-24 and want the cross-vertical columns

Just run migrate. `003-cross-vertical.sql` is idempotent and every statement is `IF NOT EXISTS`, so it creates what is missing and skips what is present. **No data is touched** — it only adds columns, one index set, and one foreign key.

```bash
npm run db:migrate
npm run db:seed      # optional; skips if organisations already has rows
```

Verify:

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'leads' AND column_name IN
       ('service_need','client_type','rent_min','rent_max','visit_status');
-- expect 5 rows

SELECT indexname FROM pg_indexes WHERE indexname = 'idx_visits_tenant_listing';
-- expect 1 row
```

### C. `db:migrate` refuses with a checksum mismatch

Something edited an applied migration file. Diagnose which:

```bash
npm run db:migrate
```

The error names the migration and prints the recorded and current hashes. Then:

- **If it was you, just now** — revert the file (`git checkout -- server/src/db/schema.sql`) and re-run. You were editing a frozen file.
- **If the file is legitimately correct and the database is stale** — you have a pre-2026-09-24 database. The `NULL`-checksum backfill handles that case, so a mismatch here means a real edit. Put the change in a new migration file instead.
- **If it is a scratch database with nothing worth keeping** — recreate it:

  ```bash
  ESTATEFLOW_ALLOW_RESET=yes npm run db:reset
  npm run db:seed
  ```

  The guard also requires a localhost `DATABASE_URL`, so this cannot drop a shared or production database by accident.

### D. A database recorded a later migration but not an earlier one

```
Refusing to migrate: migration history is out of order.
  001-schema has not been applied, but the later 002-indexes has.
```

History was tampered with, or rows were deleted by hand. Fix by recreating the database (`db:reset`, scratch only) or restoring from backup. Do not hand-edit `schema_migrations` to make the error go away — that is how the original drift happened.

---

## 4. Verifying without a spare database

`npm run verify:migrations` runs all three scenarios end-to-end against a local Postgres, in throwaway databases it creates and drops:

1. **Fresh** — a brand-new database migrates from zero and has every expected column and index.
2. **Idempotent** — migrate runs twice more with no error and no duplicates.
3. **Drifted** — 001 and 002 are applied with 003 withheld, reproducing a pre-2026-09-24 database; then the full manifest runs and the result is compared column-for-column and index-for-index against the fresh database. This is the scenario that motivated 003.
4. **Immutability** — a recorded checksum is corrupted and the runner must refuse.

```bash
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/estateflow
npm run verify:migrations
```

It refuses to run against a non-localhost host, and it names its scratch databases (`ef_verify_fresh_*`, `ef_verify_drift_*`). Set `VERIFY_KEEP=1` to leave them in place for inspection.

To run it against Supabase or any other hosted Postgres, see [SUPABASE_VERIFICATION.md](SUPABASE_VERIFICATION.md). A remote target needs `VERIFY_ALLOW_REMOTE=1`, and a connection pooler needs `VERIFY_SCOPE=schema` because the pooler makes `DROP DATABASE` impossible.

The pure-logic half — checksum computation, drift detection, ordering checks, manifest integrity — is in [migrate.test.js](../server/src/db/migrate.test.js) and runs on every `npm test` with no database.

There is also a static idempotency linter:

```bash
node scripts/check-migration-sql.js src/db/003-cross-vertical.sql
```

It reports top-level statements, DO blocks, and anything not guarded by `IF NOT EXISTS`. Useful in review; it is a lint, not a substitute for running the migration.

---

## 5. Adding a migration

1. Create `server/src/db/004-short-description.sql`.
2. Write idempotent statements only.
3. Register it in `MIGRATIONS` in [migrate.js](../server/src/db/migrate.js), **appended to the end**.
4. Lint it: `node scripts/check-migration-sql.js server/src/db/004-short-description.sql`.
5. Apply it: `npm run db:migrate`.
6. Run it twice — the second run must be a no-op.
7. If it changes a DTO, update `docs/DATA_MODEL.md` and the relevant module doc.

```sql
-- 004-example.sql
-- Idempotent. Do not edit 001-003.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS preferred_locality text;
CREATE INDEX IF NOT EXISTS idx_leads_tenant_locality
    ON leads (tenant_id, preferred_locality)
    WHERE deleted_at IS NULL AND preferred_locality IS NOT NULL;
```

**Do not** use `CREATE INDEX CONCURRENTLY` in a numbered migration yet. It cannot run inside the implicit transaction of a multi-statement query, so it will fail. Supporting it needs a non-transactional mode on the runner — tracked in [PRODUCT_PRODUCTION_ROADMAP.md](PRODUCT_PRODUCTION_ROADMAP.md) §4.3. Until then, `CREATE INDEX` takes an ACCESS EXCLUSIVE lock for its duration, which is fine on a dev database and needs care in production.

---

## 6. Related

- [PRODUCT_PRODUCTION_ROADMAP.md](PRODUCT_PRODUCTION_ROADMAP.md) §4.6 — migration tooling in the phased plan
- [ENVIRONMENT.md](ENVIRONMENT.md) — `DATABASE_URL` and TLS settings
- [server/README.md](../server/README.md) — `db:migrate` / `db:seed` / `db:reset`
