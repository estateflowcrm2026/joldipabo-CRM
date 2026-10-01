-- ---------------------------------------------------------------------------
-- 003-cross-vertical.sql
--
-- Why this file exists
-- -------------------
-- On 2026-09-23 the cross-vertical lead fields and `visits.listing_id` were
-- added by editing `001-schema.sql` and `002-indexes.sql` IN PLACE, after
-- those migrations had already been applied to local and staging
-- databases. The migration runner tracks applied migrations by NAME only
-- and has no checksums, so any database that already recorded
-- `001-schema` skips the file entirely and never receives those columns.
--
-- A fresh `CREATE DATABASE` + `db:migrate` produces the new columns.
-- An existing database does not. The two schemas had diverged.
--
-- This migration closes that gap. It is idempotent: every statement is
-- `IF NOT EXISTS`, so it is safe on a fresh database (where `001` already
-- created the columns) and on a drifted one (where it creates them for
-- the first time).
--
-- `001-schema.sql` and `002-indexes.sql` are FROZEN as of 2026-09-24.
-- Do not edit them again. Put new schema changes in a new numbered file
-- (004, 005, ...) and add it to MIGRATIONS in migrate.js.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. leads — cross-vertical columns
-- ---------------------------------------------------------------------------
-- Mirrors schema.sql:222-238. All nullable (or defaulted) so existing
-- new-sale rows keep working untouched.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS service_need       text
    CHECK (service_need IN ('rent','pg','buy','sell','land','office','commercial','project_buy'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_type        text
    CHECK (client_type IN ('tenant','buyer','seller','landlord','investor','business'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS requirements       jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rent_min           integer;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rent_max           integer;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS preferred_location text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS desired_property_type text
    CHECK (desired_property_type IN ('apartment','independent_house','villa','pg_bed','pg_room','land_parcel','office','shop','warehouse','plot'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS move_in_date       date;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS purchase_timeline  text
    CHECK (purchase_timeline IN ('immediate','within_3_months','within_6_months','within_12_months','exploratory'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS matched_listing_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS visit_status       text
    CHECK (visit_status IN ('no_visit_planned','visit_planned','visit_completed','visit_cancelled','no_show'));

COMMENT ON COLUMN leads.service_need IS 'Vertical. project_buy = legacy new-sale flow.';

-- ---------------------------------------------------------------------------
-- 2. visits — listing source column + FK
-- ---------------------------------------------------------------------------
-- Mirrors schema.sql:259 (column) and schema.sql:378-389 (FK).
-- `listing_id` lets a site visit be traced back to the listing that
-- triggered it. See docs/LEAD_LISTING_MATCHING.md.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS listing_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'visits_listing_id_fk'
      AND table_name = 'visits'
  ) THEN
    ALTER TABLE visits
      ADD CONSTRAINT visits_listing_id_fk
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes for the cross-vertical columns
-- ---------------------------------------------------------------------------
-- Mirrors indexes.sql:87-96 and indexes.sql:119-122. Partial indexes
-- exclude soft-deleted rows and NULL values, matching the surrounding
-- index style.
--
-- At scale these should be rebuilt with CREATE INDEX CONCURRENTLY, which
-- cannot run inside the implicit transaction of a multi-statement query.
-- That requires a non-transactional migration mode on the runner — see
-- docs/PRODUCT_PRODUCTION_ROADMAP.md §4.6.
CREATE INDEX IF NOT EXISTS idx_leads_tenant_service
    ON leads (tenant_id, service_need)
    WHERE deleted_at IS NULL AND service_need IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_client_type
    ON leads (tenant_id, client_type)
    WHERE deleted_at IS NULL AND client_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_visit_status
    ON leads (tenant_id, visit_status)
    WHERE deleted_at IS NULL AND visit_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_visits_tenant_listing
    ON visits (tenant_id, listing_id)
    WHERE deleted_at IS NULL AND listing_id IS NOT NULL;
