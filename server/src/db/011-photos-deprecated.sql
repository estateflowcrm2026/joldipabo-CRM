-- ---------------------------------------------------------------------------
-- 011-photos-deprecated.sql
--
-- Neutralises the legacy `photos` table as a tenant-isolation risk.
--
-- THE SITUATION
-- -------------
-- There are two media tables:
--
--   photos           project-scoped (project_id), 15 columns, EMPTY
--   listing_photos   listing-scoped (listing_id), 14 columns, 30 rows
--
-- `listing_photos` got RLS in migration 010 and is the one the
-- application uses. `photos` has NO policy, and `estateflow_app` holds
-- full DML on it — so a future route that queries `photos` becomes a
-- side door around every policy, silently, and nothing about the code
-- would look wrong.
--
-- Verified on 2026-09-28 before writing this:
--   * `photos` contains 0 rows, 0 of them deleted (never populated)
--   * no application code anywhere issues SQL against it
--   * routes/photos.js is a set of 501 stubs that never queries it
--   * seed-demo.sql inserts nothing into it
--
-- THE DECISION
-- ------------
-- DENY, do not drop. Three reasons:
--
--   1. Dropping is irreversible on a shared instance and this table is
--      part of the documented data model (docs/DATA_MODEL.md). Whether
--      project-scoped media is a real requirement or a schema that
--      outgrew its use is a product question, not a migration.
--   2. The safest state for a table nobody uses and might need is
--      "exists, documented, unreachable" — a later feature can adopt it
--      deliberately instead of rediscovering that it was deleted.
--   3. A revoked grant is reversible in one statement; a dropped table
--      in a dump taken an hour ago is not.
--
-- So: no policy, and no grants. The application role cannot read or
-- write it. A future implementation must make a deliberate decision —
-- adopt `listing_photos`, or bring `photos` under policy first — and
-- `rls-check.js` and `src/rls/rls.test.js` both assert the grant
-- stays revoked so it cannot be reintroduced by a GRANT ALL.
--
-- Idempotent. See docs/MIGRATIONS.md.
-- 001–010 are FROZEN. Put new schema changes in a new numbered file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Mark the table deprecated, in the database itself
-- ---------------------------------------------------------------------------
-- A COMMENT is the only kind of documentation a developer sees when
-- they open the table in a schema browser and decide to query it. It
-- should say what the table is and why it is empty, not just that it is
-- "legacy".
COMMENT ON TABLE photos IS
  'DEPRECATED and UNREACHABLE (2026-09-28). Project-scoped media, superseded '
  'by listing_photos (listing-scoped), which is the table the application uses '
  'and which carries the tenant_isolation RLS policy. This table holds 0 rows, '
  'no application code queries it, and estateflow_app holds no privileges on '
  'it. Do not query it. To use project-scoped media, either add it to '
  'listing_photos with its own policy, or bring this table under RLS and grant '
  'the app role deliberately. See docs/RLS_ROLLOUT_PLAN.md §8.';

-- Belt and braces alongside the comment: RLS with a policy that is never
-- true. Even if a future GRANT is issued, every row is denied, and a
-- query returns nothing rather than another tenant's data.
--
-- `current_setting('app.tenant_id', true)` yields NULL with no tenant
-- set, and NULL = anything is never true, so this denies by default as
-- well as by accident. The intent is deliberate non-use, not a
-- half-finished isolation rule — hence the deliberately-false
-- expression, with the reason stated where a reader will find it.
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS photos_deprecated_deny ON photos;
CREATE POLICY photos_deprecated_deny ON photos
  USING      (false)
  WITH CHECK (false);

COMMENT ON POLICY photos_deprecated_deny ON photos IS
  'Always-false by design. `photos` is deprecated and holds no data; denying '
  'every row means a GRANT issued by mistake still cannot expose anything. '
  'Replaced with a real policy only together with a decision to use this '
  'table. See the table comment.';

-- ---------------------------------------------------------------------------
-- 2. Revoke every privilege the application role holds
-- ---------------------------------------------------------------------------
-- REVOKE is idempotent in the sense that matters: re-running it on a role
-- that already lacks the privilege succeeds and changes nothing.
--
-- No sequence is revoked: `photos.id` is `text` (the schema uses
-- application-generated ULIDs, not a serial), so `photos_id_seq` does not
-- exist and naming it would fail the whole migration. The dynamic list
-- below picks up whatever the table actually owns.
DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estateflow_app') THEN
    RAISE NOTICE '011: estateflow_app does not exist; nothing to revoke';
    RETURN;
  END IF;

  FOR r IN
    SELECT c.relkind, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'photos'
  LOOP
    IF r.relkind IN ('r', 'p') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I FROM estateflow_app', r.relname);
    ELSIF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %I FROM estateflow_app', r.relname);
    END IF;
  END LOOP;

  RAISE NOTICE '011: revoked all privileges on the deprecated photos table';
END $$;
