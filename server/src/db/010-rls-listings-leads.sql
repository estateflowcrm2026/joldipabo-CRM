-- ---------------------------------------------------------------------------
-- 010-rls-listings-leads.sql
--
-- Row-level security for the first four tenant-scoped tables:
-- listings, leads, visits, listing_photos.
--
-- WHY THESE FOUR
-- --------------
-- They are the highest-value objects (a listing or a lead is the thing a
-- tenant pays for) and the lowest-risk to protect, because every read
-- and write already carries a `tenant_id = $1` predicate. Enabling policy
-- on them changes nothing about what the application sees — which is the
-- point: it is a first step whose failure mode is "no effect", not "no
-- data".
--
-- Deliberately NOT included, and why:
--
--   organisations, refresh_sessions, login_attempts
--       Read during authentication, BEFORE a tenant is established. A
--       tenant policy makes those lookups fail. Needs the answer to
--       "how does login pick a tenant" first — rollout plan §4.
--
--   audit_log
--       Already has a special relationship with its own tenant column
--       (migration 007). The integrity job reads every row across every
--       tenant by design, so a policy needs a deliberate exemption
--       rather than an accident. Last, not first.
--
--   roles, permission_matrices
--       Global catalogues, read by every tenant. A policy would break
--       login outright.
--
--   The six junction tables
--       Have no `tenant_id` of their own; see rollout plan §2b.
--
-- POLICY SHAPE
-- ------------
--   USING      (tenant_id = current_setting('app.tenant_id', true))
--   WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
--
-- `WITH CHECK` is the half that gets forgotten. Without it, reads are
-- filtered but a row can still be WRITTEN into another tenant — the
-- policy would look correct and still permit a cross-tenant insert.
--
-- `missing_ok = true` is what makes an absent tenant DENY rather than
-- allow: `tenant_id = NULL` is never true, so a query with no context
-- sees no rows. Fail-closed by construction, not by an extra check.
--
-- THE FLAG
-- --------
-- `DB_RLS_MODE` (see src/db/rlsMode.js) decides whether
-- ENABLE ROW LEVEL SECURITY is set:
--
--   off      (default) policies created, RLS NOT enabled. Zero change
--                     to existing behaviour.
--   probe    enabled; the application must behave identically and the
--            test suite proves it does. Used by CI.
--   enforce  live. Requires a non-owner, non-BYPASSRLS role, or the
--            policies are inert — see rollout plan §1.
--
-- This matters more than it looks. A migration cannot read an
-- application environment variable, so the ENABLE is decided by a
-- session setting that `migrate.js` sets from `DB_RLS_MODE` before
-- running. Default to NOT enabling, so a migration run without that
-- plumbing is the safe one.
--
-- Idempotent. See docs/MIGRATIONS.md.
-- 001–009 are FROZEN. Put new schema changes in a new numbered file.
-- ---------------------------------------------------------------------------

-- A helper so the policy body is written once. Kept as a plain function
-- rather than inlined into each policy: four copies of the same
-- expression is four chances to typo one.
--
-- SECURITY INVOKER (the default) is deliberate. A SECURITY DEFINER
-- helper would run with the owner's rights and silently bypass RLS on
-- the table it reads — the opposite of what this migration is for.
CREATE OR REPLACE FUNCTION app_current_tenant()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

COMMENT ON FUNCTION app_current_tenant() IS
  'The tenant for the current transaction, or NULL when none is set. NULL '
  'compares false against every non-null tenant_id, so an absent context '
  'denies rather than allows. Used by the 010 RLS policies.';

-- ---------------------------------------------------------------------------
-- Policies (created regardless of mode; only ENABLE is conditional)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['listings', 'leads', 'visits', 'listing_photos'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING      (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Enable, but only when the deployment says so
-- ---------------------------------------------------------------------------
-- `app.rls_enabled` is set by migrate.js from DB_RLS_MODE. Absent (a
-- hand-run psql session, a restore) means NOT enabled, which is the
-- safe direction: a missed enable costs protection, a mistaken enable
-- costs an outage.
DO $$
DECLARE
  t text;
  enabled boolean := COALESCE(current_setting('app.rls_enabled', true), 'off') IN ('on', 'true', 'probe', 'enforce');
  tables text[] := ARRAY['listings', 'leads', 'visits', 'listing_photos'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF enabled THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    ELSE
      EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;

  RAISE NOTICE '010: RLS % for % (app.rls_enabled=%)',
    CASE WHEN enabled THEN 'ENABLED' ELSE 'DISABLED' END,
    array_to_string(tables, ', '),
    coalesce(current_setting('app.rls_enabled', true), '(unset)');
END $$;
