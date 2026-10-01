-- ============================================================================
-- Joldipabo / EstateFlow CRM — Supabase one-shot setup
-- ============================================================================
-- Generated for a FRESH, EMPTY Supabase project. Run ONCE.
--
-- HOW TO RUN:
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file
--   -> Run. It creates all tables, indexes, demo data, and demo logins.
--
-- Order matches the app's migration runner exactly:
--   001-schema, 002-indexes, 003-cross-vertical, 004-auth-sessions,
--   006-audit-integrity, then demo seed, then demo credentials.
-- The schema_migrations rows at the very end record these as "applied"
-- with their real checksums, so `npm run db:migrate` later is a no-op
-- instead of a conflict.
--
-- DEMO LOGIN after this runs:
--   email:    asha@acme.example   (and super@acme.example, etc.)
--   password: DemoJoldipabo!2026
--   (demo credentials — fine for a dev/test database, not for real data)
-- ============================================================================


-- ==================== 001-schema (schema.sql) ==============================
-- ===========================================================================
-- 001-schema.sql — FROZEN as of 2026-09-24. DO NOT EDIT.
--
-- This migration has been applied to local and staging databases. The
-- migration runner records checksums, so any edit to this file makes a
-- previously-applied database refuse to migrate (by design — see
-- `migrate.js` verifyChecksums). Put new schema changes in a NEW numbered
-- file (004, 005, ...) and register it in MIGRATIONS.
--
-- Historical note: cross-vertical lead columns and visits.listing_id were
-- added to this file in place on 2026-09-23, after it had already been
-- applied. Databases that recorded 001-schema before that edit never
-- received them. `003-cross-vertical.sql` repairs that gap. Do not
-- replicate the mistake.
-- ===========================================================================
--
-- Joldipabo CRM — Postgres schema.
--
-- Mirrors docs/DATA_MODEL.md and docs/AUTH_TENANT_SECURITY_PLAN.md.
--
-- TENANT ISOLATION: every tenant-owned table carries `tenant_id NOT NULL
-- REFERENCES organisations(id)`, and the application layer binds it from
-- the authenticated user context (`scopeFilterFor` in
-- server/src/rbac/scopeFilters.js). As of 2026-09-24 there is NO row-level
-- security: the policies below are placeholders and `set_config('app.
-- tenant_id', ...)` is not yet called. Do not assume RLS protects this
-- schema. See docs/PRODUCT_PRODUCTION_ROADMAP.md §3.5.
--
-- Conventions:
--   * `id text PRIMARY KEY` (ULID; sortable, friendly to logs).
--   * `created_at` / `updated_at` defaulted; soft delete via `deleted_at`.
--   * FKs use `text` (not `varchar(n)`).
--   * `permission_matrix` is JSONB on `roles`.
--   * `audit_log` is append-only — application DB role has no UPDATE/DELETE.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), if we ever need it

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisations (
    id              text PRIMARY KEY,
    slug            text NOT NULL UNIQUE,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Suspended', 'Trial')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE organisations IS 'A tenant. Path-based slug in v1; subdomain in v2.';

CREATE TABLE IF NOT EXISTS branches (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    region          text,
    manager_id      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE branches IS 'Regional / project-cluster subdivision. Not an isolation boundary.';
-- RLS policy here in a future migration. See docs/AUTH_TENANT_SECURITY_PLAN.md §23.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    description     text,
    color           text,
    accent          text,
    is_system       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE roles IS 'System roles (super-admin, admin) are protected; is_system = true.';

CREATE TABLE IF NOT EXISTS permission_matrices (
    role_id         text PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
    matrix          jsonb NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE permission_matrices IS 'Live matrix per role. Mirrors src/data/permissions.js DEFAULT_PERMISSION_MATRIX.';

CREATE TABLE IF NOT EXISTS teams (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    region          text,
    lead_id         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE teams IS 'Working unit inside a branch. Drives `team` scope checks.';

CREATE TABLE IF NOT EXISTS projects (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    code            text,
    city            text,
    location        text,
    stage           text,
    total_units     integer,
    available_units integer,
    price_range     text,
    image           text,
    manager_id      text,
    amenities       jsonb NOT NULL DEFAULT '[]'::jsonb,
    rera_number     text,
    possession_date date,
    type            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE projects IS 'A development site. Drives `project` scope checks.';

CREATE TABLE IF NOT EXISTS users (
    id                  text PRIMARY KEY,
    tenant_id           text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    branch_id           text REFERENCES branches(id) ON DELETE SET NULL,
    name                text NOT NULL,
    email               text NOT NULL,
    phone               text,
    role_id             text REFERENCES roles(id) ON DELETE RESTRICT,
    team_id             text REFERENCES teams(id) ON DELETE SET NULL,
    designation         text,
    status              text NOT NULL DEFAULT 'Active'
                          CHECK (status IN ('Active','Inactive','On Leave','Invited','Suspended')),
    permission_matrix   jsonb,                  -- per-user override; merged at request time
    password_hash       text,                   -- Argon2id
    password_changed_at timestamptz,
    mfa_enabled         boolean NOT NULL DEFAULT false,
    mfa_secret          text,                   -- encrypted at rest
    failed_login_count  integer NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    last_login_at       timestamptz,
    invited_at          timestamptz,
    invite_token        text,                   -- single-use; cleared on accept
    invite_expires_at   timestamptz,
    joined_at           timestamptz,
    deleted_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);
COMMENT ON TABLE users IS 'A user belongs to exactly one tenant. UNIQUE (tenant_id, email).';

CREATE TABLE IF NOT EXISTS user_project_ids (
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, project_id)
);
COMMENT ON TABLE user_project_ids IS 'Denormalised read convenience for project-scope checks.';

CREATE TABLE IF NOT EXISTS team_members (
    team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
    id                  text PRIMARY KEY,                -- rt_<ulid>
    user_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id           text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    token_hash          text NOT NULL UNIQUE,            -- SHA-256 of the opaque refresh token
    device_fingerprint  text,
    device_label        text,
    user_agent          text,
    ip                  text,
    trusted             boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz
);
COMMENT ON TABLE refresh_sessions IS 'Rotating refresh tokens, stored hashed. See docs/AUTH_TENANT_SECURITY_PLAN.md §9.';

CREATE TABLE IF NOT EXISTS otp_codes (
    id          text PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    user_id     text REFERENCES users(id) ON DELETE CASCADE,
    phone       text NOT NULL,
    code_hash   text NOT NULL,            -- SHA-256 of the 6-digit code
    channel     text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'totp')),
    attempts    integer NOT NULL DEFAULT 0,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          text PRIMARY KEY,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Domain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    phone           text NOT NULL,
    email           text,
    project_id      text REFERENCES projects(id) ON DELETE SET NULL,
    status          text NOT NULL DEFAULT 'New'
                      CHECK (status IN ('New','Contacted','Site Visit Scheduled','Visit Done','Negotiation','Booked','Lost','Follow-up')),
    score           text CHECK (score IN ('hot','warm','cold')),
    budget_min      integer,
    budget_max      integer,
    source          text,
    notes           text,
    owner_id        text REFERENCES users(id) ON DELETE SET NULL,
    team_id         text REFERENCES teams(id) ON DELETE SET NULL,
    created_by      text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    next_follow_up  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE leads IS 'Pipeline row. owner_id + team_id drive scope checks.';

-- Cross-vertical lead fields (added 2026-09-23 for the rent/PG/buy/sell/land/office expansion).
-- All nullable so existing new-sale seed data keeps working.
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

CREATE TABLE IF NOT EXISTS visits (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    lead_id         text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    project_id      text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    assigned_to     text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scheduled_at    timestamptz NOT NULL,
    status          text NOT NULL DEFAULT 'Scheduled'
                      CHECK (status IN ('Scheduled','In Progress','Completed','Cancelled','No Show')),
    notes           text,
    rating          integer CHECK (rating BETWEEN 1 AND 5),
    feedback        text,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
-- Cross-vertical visit support (added 2026-09-23). For rent / PG / resale / office / land tours,
-- listing_id is set and project_id may stay set only if the listing is anchored to a project.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS listing_id text;

CREATE TABLE IF NOT EXISTS attendance (
    id                  text PRIMARY KEY,
    tenant_id           text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    staff_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date                date NOT NULL,
    check_in            timestamptz,
    check_out           timestamptz,
    check_in_location   jsonb,
    check_out_location  jsonb,
    check_in_site_id    text REFERENCES projects(id) ON DELETE SET NULL,
    check_out_site_id   text REFERENCES projects(id) ON DELETE SET NULL,
    status              text NOT NULL DEFAULT 'Checked In'
                          CHECK (status IN ('Checked In','On Field','Late','Checked Out','Approved')),
    approved_by         text REFERENCES users(id) ON DELETE SET NULL,
    hours_worked        numeric(6,2),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE attendance IS 'Daily attendance. Unique partial index enforces one open shift per staff/day (indexes.sql).';

CREATE TABLE IF NOT EXISTS photos (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    project_id      text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    staff_id        text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    category        text NOT NULL
                      CHECK (category IN ('Progress','Amenities','Inventory','Handover','Marketing')),
    caption         text,
    object_key      text NOT NULL,        -- S3 key
    public_url      text,
    thumbnail_url   text,
    geo             jsonb,
    approved        boolean NOT NULL DEFAULT false,
    approved_by     text REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    deleted_at      timestamptz
);
COMMENT ON TABLE photos IS 'S3-backed site photos. EXIF stripped server-side. See docs/AUTH_TENANT_SECURITY_PLAN.md §15.';

CREATE TABLE IF NOT EXISTS threads (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    subject         text,
    last_message_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE TABLE IF NOT EXISTS thread_participants (
    thread_id   text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id          text PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    thread_id   text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    from_id     text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body        text NOT NULL,
    channel     text NOT NULL DEFAULT 'in-app'
                  CHECK (channel IN ('in-app','email','sms','whatsapp')),
    timestamp   timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Listings (cross-vertical property catalogue)
-- ---------------------------------------------------------------------------
-- Covers rent, PG / hostel, buy / sell residential, land buy/sell,
-- office / commercial / shop / warehouse, and direct owner / landlord
-- listings. Listings are independent from Projects; a row with
-- project_id IS NULL is a fully standalone owner-listed property.
CREATE TABLE IF NOT EXISTS listings (
    id                   text PRIMARY KEY,
    tenant_id            text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    service_category     text NOT NULL
                          CHECK (service_category IN ('rent','pg','buy','sell','land','office','commercial')),
    property_type        text NOT NULL
                          CHECK (property_type IN ('apartment','independent_house','villa','pg_bed','pg_room','land_parcel','office','shop','warehouse','plot')),
    listing_intent       text NOT NULL
                          CHECK (listing_intent IN ('available_for_rent','available_for_sale','wanted','client_requirement')),
    title                text NOT NULL,
    description          text,
    address              text,
    city                 text,
    locality             text,
    geo                  jsonb,                  -- { lat: number, lng: number, accuracy?: number }
    price                numeric(14,2),
    rent_monthly         numeric(12,2),
    deposit              numeric(12,2),
    area_sqft            numeric(10,2),
    bedrooms             integer,
    bathrooms            integer,
    furnished            text CHECK (furnished IN ('unfurnished','semi','fully')),
    amenities            jsonb NOT NULL DEFAULT '[]'::jsonb,
    availability_status  text NOT NULL DEFAULT 'available'
                          CHECK (availability_status IN ('available','booked','occupied','withdrawn')),
    verification_status  text NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN ('unverified','pending','verified','rejected')),
    owner_contact_name   text,
    owner_contact_phone  text,
    owner_contact_email  text,
    assigned_to          text REFERENCES users(id) ON DELETE SET NULL,
    team_id              text REFERENCES teams(id) ON DELETE SET NULL,
    project_id           text REFERENCES projects(id) ON DELETE SET NULL,
    notes                text,
    created_by           text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    deleted_at           timestamptz
);
COMMENT ON TABLE listings IS 'Property catalogue for rent/PG/buy/sell/land/office/commercial/owner listings. See docs/DATA_MODEL.md §Listings.';

-- Wire up visits.listing_id once listings exists. Idempotent via DO block.
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

CREATE TABLE IF NOT EXISTS listing_photos (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    listing_id      text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    staff_id        text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    object_key      text NOT NULL,
    public_url      text,
    thumbnail_url   text,
    caption         text,
    category        text NOT NULL DEFAULT 'Other'
                      CHECK (category IN ('Interior','Exterior','Amenities','Floor Plan','Document Cover','Other')),
    approved        boolean NOT NULL DEFAULT false,
    approved_by     text REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    deleted_at      timestamptz
);
COMMENT ON TABLE listing_photos IS 'S3-backed photos for listings. Distinct from photos (project site photos).';

CREATE TABLE IF NOT EXISTS listing_documents (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    listing_id      text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    name            text NOT NULL,
    object_key      text NOT NULL,
    mime_type       text,
    uploaded_by     text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
COMMENT ON TABLE listing_documents IS 'Internal documents attached to a listing (ID proofs, agreements). No public read endpoint in v1.';

CREATE TABLE IF NOT EXISTS listing_matches (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    lead_id         text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    listing_id      text NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    match_score     numeric(5,2),
    matched_at      timestamptz NOT NULL DEFAULT now(),
    matched_by      text REFERENCES users(id) ON DELETE SET NULL,
    status          text NOT NULL DEFAULT 'suggested'
                      CHECK (status IN ('suggested','viewed_by_lead','visit_scheduled','rejected_by_lead','withdrawn')),
    note            text,
    UNIQUE (lead_id, listing_id)
);
COMMENT ON TABLE listing_matches IS 'Lead ↔ listing junction populated by the matching service.';

-- ---------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          text PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    user_id     text REFERENCES users(id) ON DELETE SET NULL,   -- actor
    action      text NOT NULL,                                  -- verb: 'created-lead', 'checked-in', ...
    entity      text NOT NULL,                                  -- 'lead', 'visit', 'attendance', ...
    entity_id   text,                                           -- foreign key to the affected record
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    timestamp   timestamptz NOT NULL DEFAULT now(),
    hmac        text                                            -- tamper-evidence; KMS-signed
);
COMMENT ON TABLE audit_log IS 'Append-only. Application DB role has no UPDATE/DELETE permission.';

-- ---------------------------------------------------------------------------
-- Reports (export jobs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS export_jobs (
    id              text PRIMARY KEY,
    tenant_id       text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    report_name     text NOT NULL,
    status          text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','done','failed')),
    format          text NOT NULL DEFAULT 'csv',
    filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
    row_count       integer,
    result_url      text,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE export_jobs IS 'Async export jobs. Result is delivered via a signed URL that expires.';

-- ---------------------------------------------------------------------------
-- Future migrations
-- ---------------------------------------------------------------------------
-- RLS policies (docs/AUTH_TENANT_SECURITY_PLAN.md §23):
--   CREATE POLICY tenant_isolation ON <table>
--     USING (tenant_id = current_setting('app.tenant_id')::text);
--
-- Tamper-evidence HMAC on audit_log (docs/AUTH_TENANT_SECURITY_PLAN.md §13):
--   ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--   GRANT INSERT ON audit_log TO app;
--   REVOKE UPDATE, DELETE ON audit_log FROM app;


-- ==================== 002-indexes (indexes.sql) ============================
-- ===========================================================================
-- 002-indexes.sql — FROZEN as of 2026-09-24. DO NOT EDIT.
--
-- This migration has been applied to local and staging databases. The
-- migration runner records checksums, so any edit makes a previously
-- applied database refuse to migrate. Put new indexes in a NEW numbered
-- file and register it in MIGRATIONS.
--
-- Historical note: the cross-vertical lead indexes and the visits-by-listing
-- index were added here in place on 2026-09-23, after this file had already
-- been applied. Databases that recorded 002-indexes before that edit never
-- received them. `003-cross-vertical.sql` repairs that gap.
-- ===========================================================================
--
-- Joldipabo CRM — Indexes.
--
-- All partial indexes include `WHERE deleted_at IS NULL` (or the relevant
-- equivalent) so soft-deleted rows do not bloat the working set.
--
-- Run after schema.sql.
--
-- Note: every index below uses plain CREATE INDEX, which takes an ACCESS
-- EXCLUSIVE lock for the duration. On large tables these need
-- CREATE INDEX CONCURRENTLY, which cannot run inside the implicit
-- transaction of a multi-statement query. See
-- docs/PRODUCT_PRODUCTION_ROADMAP.md §4.3.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_tenant_status
    ON users (tenant_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant_team
    ON users (tenant_id, team_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant_role
    ON users (tenant_id, role_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_invite_token
    ON users (invite_token)
    WHERE invite_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_project_ids_user
    ON user_project_ids (user_id);

CREATE INDEX IF NOT EXISTS idx_team_members_team
    ON team_members (team_id);

CREATE INDEX IF NOT EXISTS idx_project_members_project
    ON project_members (project_id);

-- ---------------------------------------------------------------------------
-- Refresh / OTP / password reset
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_active
    ON refresh_sessions (user_id, created_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_tenant
    ON refresh_sessions (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_codes_phone
    ON otp_codes (phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_codes_user
    ON otp_codes (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_password_reset_user
    ON password_reset_tokens (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Domain — leads
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_tenant_owner
    ON leads (tenant_id, owner_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_team
    ON leads (tenant_id, team_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_project
    ON leads (tenant_id, project_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_status
    ON leads (tenant_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_score
    ON leads (tenant_id, score)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_followup
    ON leads (tenant_id, next_follow_up)
    WHERE deleted_at IS NULL AND next_follow_up IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_created
    ON leads (tenant_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Cross-vertical lead indexes (added 2026-09-23).
CREATE INDEX IF NOT EXISTS idx_leads_tenant_service
    ON leads (tenant_id, service_need)
    WHERE deleted_at IS NULL AND service_need IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_client_type
    ON leads (tenant_id, client_type)
    WHERE deleted_at IS NULL AND client_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_visit_status
    ON leads (tenant_id, visit_status)
    WHERE deleted_at IS NULL AND visit_status IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Domain — visits
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_visits_tenant_assigned
    ON visits (tenant_id, assigned_to, scheduled_at)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visits_tenant_lead
    ON visits (tenant_id, lead_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visits_tenant_project
    ON visits (tenant_id, project_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visits_tenant_status
    ON visits (tenant_id, status)
    WHERE deleted_at IS NULL;

-- Cross-vertical visit lookup (added 2026-09-23).
CREATE INDEX IF NOT EXISTS idx_visits_tenant_listing
    ON visits (tenant_id, listing_id)
    WHERE deleted_at IS NULL AND listing_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Domain — attendance
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_attendance_tenant_staff_date
    ON attendance (tenant_id, staff_id, date DESC);

-- One open shift per staff/day: check_out IS NULL means "still checked in".
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_open_shift
    ON attendance (staff_id, date)
    WHERE check_out IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_tenant_status
    ON attendance (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Domain — photos
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_photos_tenant_project
    ON photos (tenant_id, project_id, uploaded_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_photos_tenant_staff
    ON photos (tenant_id, staff_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_photos_tenant_approved
    ON photos (tenant_id, approved)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Domain — communications
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_thread_time
    ON messages (thread_id, timestamp DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_thread_participants_user
    ON thread_participants (user_id);

-- ---------------------------------------------------------------------------
-- Domain — listings (cross-vertical)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_listings_tenant_service
    ON listings (tenant_id, service_category)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_intent
    ON listings (tenant_id, listing_intent)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_city
    ON listings (tenant_id, city)
    WHERE deleted_at IS NULL AND city IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_assigned
    ON listings (tenant_id, assigned_to)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_verification
    ON listings (tenant_id, verification_status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_team
    ON listings (tenant_id, team_id)
    WHERE deleted_at IS NULL AND team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_project
    ON listings (tenant_id, project_id)
    WHERE deleted_at IS NULL AND project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_tenant_availability
    ON listings (tenant_id, availability_status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listing_photos_listing
    ON listing_photos (tenant_id, listing_id, uploaded_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listing_photos_approved
    ON listing_photos (tenant_id, approved)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listing_documents_listing
    ON listing_documents (tenant_id, listing_id, uploaded_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_listing_matches_lead
    ON listing_matches (tenant_id, lead_id, status);

CREATE INDEX IF NOT EXISTS idx_listing_matches_listing
    ON listing_matches (tenant_id, listing_id, status);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time
    ON audit_log (tenant_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_user
    ON audit_log (tenant_id, user_id, timestamp DESC)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_tenant_entity
    ON audit_log (tenant_id, entity, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_action
    ON audit_log (tenant_id, action);

-- ---------------------------------------------------------------------------
-- Export jobs
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_export_jobs_user
    ON export_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant_status
    ON export_jobs (tenant_id, status, created_at DESC);


-- ==================== 003-cross-vertical ==================================
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


-- ==================== 004-auth-sessions ===================================
-- ---------------------------------------------------------------------------
-- 004-auth-sessions.sql
--
-- Additions for the real login flow (Phase 3): refresh-token rotation
-- with reuse detection, and per-tenant login attempt tracking.
--
-- Idempotent. Adds to `refresh_sessions` (created in 001-schema) and
-- creates one new table.
--
-- 001–003 are FROZEN. Put new schema changes in a new numbered file and
-- register it in MIGRATIONS in migrate.js. See docs/MIGRATIONS.md.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. refresh_sessions — rotation and family tracking
-- ---------------------------------------------------------------------------
-- Before this, refresh_sessions could store one token per row but had
-- no way to express "this is the successor of that one" or "this whole
-- family is now suspect". Reuse detection needs both.

-- The session this row descends from. NULL for the first token in a
-- family. Set on every rotation, so a chain is walkable.
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS parent_id text
    REFERENCES refresh_sessions(id) ON DELETE SET NULL;

-- Stable identifier for the whole rotation family. Every token minted
-- by one login shares it, so revoking a family is a single indexed
-- UPDATE rather than a recursive walk. Populated on insert and on every
-- rotation; the first row seeds it with its own id.
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS family_id text;

-- Incremented on each rotation. Lets a client notice it presented a
-- stale token, and gives reuse detection a cheap monotonic check.
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS rotation_count integer NOT NULL DEFAULT 0;

-- Set when a revoked token is presented again. The whole family is
-- revoked in the same transaction; this flag records WHY, so an
-- operator can tell a theft from a normal logout.
ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS compromised_at timestamptz;

COMMENT ON COLUMN refresh_sessions.family_id IS
  'Stable id shared by every token in one rotation family. Revoking a family is a single indexed UPDATE.';
COMMENT ON COLUMN refresh_sessions.compromised_at IS
  'Set when a revoked token is replayed. Triggers revocation of the whole family.';

-- Family lookup: revoking a family, and reuse detection both go through
-- this. Partial on the live rows, which is the hot path.
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_family
    ON refresh_sessions (family_id)
    WHERE revoked_at IS NULL;

-- Listing a user's live sessions for the "active devices" screen.
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user_active
    ON refresh_sessions (user_id, created_at DESC)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. login_attempts — per (tenant, identifier) failure counting
-- ---------------------------------------------------------------------------
-- Lockout state lives on `users` (failed_login_count, locked_until) for
-- a known account. This table covers the case where the account is NOT
-- known: a tenant can be sprayed with guesses across many addresses, and
-- a per-user counter cannot see that.
--
-- The identifier is stored lowercased and hashed. Storing the raw
-- address would turn this table into a list of every address ever
-- guessed against the tenant, which is both a privacy problem and a
-- useful list for an attacker.
CREATE TABLE IF NOT EXISTS login_attempts (
    tenant_id        text NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    identifier_hash  text NOT NULL,        -- SHA-256 of the lowercased email
    failure_count    integer NOT NULL DEFAULT 0,
    first_failed_at  timestamptz NOT NULL DEFAULT now(),
    last_failed_at   timestamptz NOT NULL DEFAULT now(),
    locked_until     timestamptz,
    PRIMARY KEY (tenant_id, identifier_hash)
);
COMMENT ON TABLE login_attempts IS
  'Per (tenant, email) failure counter, including for addresses with no user. Identifier is hashed, never stored in the clear.';

-- Sweeping expired rows. Everything older than the retention window is
-- useless for rate limiting.
CREATE INDEX IF NOT EXISTS idx_login_attempts_last_failed
    ON login_attempts (last_failed_at);


-- ==================== 006-audit-integrity =================================
-- ---------------------------------------------------------------------------
-- 006-audit-integrity.sql
--
-- Audit-log support for the account-lifecycle events added in Phase 4
-- (login, logout, refresh, lockout, invite, password reset).
--
-- Idempotent. See docs/MIGRATIONS.md.
--
-- 001–005 are FROZEN. Put new schema changes in a new numbered file.
-- ---------------------------------------------------------------------------

-- The `hmac` column already exists (001-schema, annotated as tamper
-- evidence) and is written by server/src/audit/auditLog.js since
-- 2026-09-24. No schema change is needed for the events themselves.
--
-- What is missing is a cheap way to *find* rows for the integrity
-- check in docs/SECURITY_ACCEPTANCE_CHECKLIST.md §9.4 — currently that
-- check means reading every row.
CREATE INDEX IF NOT EXISTS idx_audit_log_action_time
    ON audit_log (tenant_id, action, timestamp DESC);

-- Signature verification deliberately does NOT live here. The signing
-- key is the JWT secret, held by the application and not by Postgres,
-- so a SQL function would need the key passed in as a parameter on
-- every call — and a function that accepted the key as an argument
-- invites a caller to pass the wrong one and conclude the log is
-- intact.
--
-- Verification is a Node script that holds the key:
--     node scripts/verify-audit-integrity.js
-- It re-computes each row's canonical form and compares, exactly as
-- `verifyAuditRow` in server/src/audit/auditLog.js does. Keep the two
-- canonical forms in step — the test in
-- src/audit/auditLog.test.js asserts they agree on a known row.


-- ==================== demo seed (seed-demo.sql) ===========================
-- Joldipabo CRM — Demo seed.
--
-- Mirrors the frontend's src/data/seed.js shape so the demo backend
-- can be queried the same way the frontend is today.
--
-- This file is illustrative only. The scaffold does not run it
-- automatically (no DB connection wired yet). To load it manually:
--   psql "$DATABASE_URL" -f src/db/schema.sql -f src/db/indexes.sql -f src/db/seed-demo.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
INSERT INTO organisations (id, slug, name, status) VALUES
    ('org_acme', 'acme', 'Acme Developers', 'Active');

INSERT INTO branches (id, tenant_id, name, region) VALUES
    ('br_bangalore', 'org_acme', 'Bangalore', 'South India');

-- ---------------------------------------------------------------------------
-- Roles (mirrors src/data/permissions.js ROLE_DEFINITIONS)
-- ---------------------------------------------------------------------------
INSERT INTO roles (id, name, description, color, accent, is_system) VALUES
    ('super-admin',              'Super Admin',              'Org owner. Unrestricted access.',                       '#0F1A1F', '#C49B4A', true),
    ('admin',                    'Admin',                    'Configures teams, projects, and staff.',                '#1F3A36', '#3F7B6F', true),
    ('sales-manager',            'Sales Manager',            'Owns a sales team.',                                    '#3D2E1F', '#C49B4A', false),
    ('site-manager',             'Site Manager',             'Owns site operations.',                                 '#2A3D2F', '#5E8C5A', false),
    ('field-executive',          'Field Executive',          'Field sales. Self check-in, logs visits.',              '#2E3447', '#6F7BB3', false),
    ('telecaller',               'Telecaller',               'Phone-based lead qualification.',                       '#3F2D45', '#9D6FA3', false),
    ('channel-partner-manager',  'Channel Partner Manager',  'Manages external broker network.',                      '#1F3D3A', '#3F8C84', false),
    ('accounts',                 'Accounts',                 'Read-only on pipeline, full access to bookings.',       '#3D3A1F', '#B0A14A', false);

-- Permission matrices — copy of src/data/permissions.js DEFAULT_PERMISSION_MATRIX,
-- stored as JSONB. Kept short here for readability; the real seed is the file above.

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
INSERT INTO teams (id, tenant_id, name, region, lead_id) VALUES
    ('t_north',  'org_acme', 'North Sales',  'North Bangalore', 'u-raj'),
    ('t_south',  'org_acme', 'South Sales',  'South Bangalore', NULL);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
INSERT INTO projects (id, tenant_id, name, code, city, stage, total_units, available_units, manager_id, type) VALUES
    ('p_skyline', 'org_acme', 'Skyline Heights',  'SKY', 'Bangalore', 'Booking open', 120, 42, 'u-priya', 'Residential'),
    ('p_heights', 'org_acme', 'Acme Heights',     'HTS', 'Bangalore', 'Pre-launch',   80, 80, 'u-priya', 'Luxury Residential');

-- ---------------------------------------------------------------------------
-- Users (mirrors src/data/seed.js USERS)
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, branch_id, name, email, phone, role_id, team_id, designation, status, joined_at) VALUES
    ('u-admin',   'org_acme', 'br_bangalore', 'Demo Admin',     'admin@acme.example',    '+910000000001', 'admin',         NULL,      'Operations Manager',  'Active', '2024-01-15'),
    ('u-super',   'org_acme', 'br_bangalore', 'Demo Super',     'super@acme.example',    '+910000000002', 'super-admin',    NULL,      'Org Owner',           'Active', '2024-01-01'),
    ('u-raj',     'org_acme', 'br_bangalore', 'Raj Mehta',      'raj@acme.example',      '+919876500001', 'sales-manager',  't_north', 'Sales Manager',       'Active', '2024-02-10'),
    ('u-priya',   'org_acme', 'br_bangalore', 'Priya Sharma',   'priya@acme.example',    '+919876500002', 'site-manager',   NULL,      'Site Manager',        'Active', '2024-02-12'),
    ('u-asha',    'org_acme', 'br_bangalore', 'Asha Rao',       'asha@acme.example',     '+919876500003', 'field-executive','t_north', 'Field Executive',     'Active', '2024-03-01'),
    ('u-vijay',   'org_acme', 'br_bangalore', 'Vijay Kumar',    'vijay@acme.example',    '+919876500004', 'field-executive','t_south', 'Field Executive',     'Active', '2024-03-08'),
    ('u-anil',    'org_acme', 'br_bangalore', 'Anil Verma',     'anil@acme.example',     '+919876500005', 'accounts',       NULL,      'Accounts',            'Active', '2024-03-15'),
    ('u-tele',    'org_acme', 'br_bangalore', 'Tara Iyer',      'tara@acme.example',     '+919876500006', 'telecaller',     't_north', 'Telecaller',          'Active', '2024-03-20'),
    ('u-cpm',     'org_acme', 'br_bangalore', 'Partner Lead',   'cpm@acme.example',      '+919876500007', 'channel-partner-manager', NULL, 'Partner Manager', 'Active', '2024-04-01');

INSERT INTO user_project_ids (user_id, project_id) VALUES
    ('u-priya', 'p_skyline'),
    ('u-priya', 'p_heights'),
    ('u-asha',  'p_skyline'),
    ('u-raj',   'p_skyline'),
    ('u-raj',   'p_heights'),
    ('u-anil',  'p_skyline');

INSERT INTO project_members (project_id, user_id) VALUES
    ('p_skyline', 'u-priya'),
    ('p_heights', 'u-priya'),
    ('p_skyline', 'u-asha'),
    ('p_heights', 'u-raj'),
    ('p_skyline', 'u-raj'),
    ('p_skyline', 'u-anil');

-- ---------------------------------------------------------------------------
-- Listings — cross-vertical property catalogue.
-- One row per vertical to demonstrate the matrix. Real seed data
-- grows organically as field executives collect more properties.
-- ---------------------------------------------------------------------------
INSERT INTO listings (
    id, tenant_id, service_category, property_type, listing_intent,
    title, description, address, city, locality, geo,
    price, rent_monthly, deposit, area_sqft, bedrooms, bathrooms, furnished,
    amenities, availability_status, verification_status,
    owner_contact_name, owner_contact_phone,
    assigned_to, team_id, project_id,
    created_by
) VALUES
    ('l_rent_indiranagar_3bhk',
     'org_acme', 'rent', 'apartment', 'available_for_rent',
     '3BHK in Indiranagar with covered parking',
     'Semi-furnished 3BHK on the 4th floor of a quiet lane. Walking distance to 100ft Road.',
     '14, 5th Cross, Indiranagar', 'Bangalore', 'Indiranagar',
     '{"lat": 12.9719, "lng": 77.6412, "accuracy": 8}',
     NULL, 65000, 200000, 1450, 3, 2, 'semi',
     '["Covered parking","24x7 water","Power backup","Lift"]'::jsonb,
     'available', 'verified',
     'Mr. Bhattacharya', '+919900000111',
     'u-asha', 't_north', NULL,
     'u-asha'),

    ('l_pg_koramangala_bed',
     'org_acme', 'pg', 'pg_bed', 'available_for_rent',
     'Single bed in Koramangala ladies PG',
     'Single-occupancy bed in a 4-sharing room. AC, attached bath, meals included.',
     '8, 1st Main, Koramangala 5th Block', 'Bangalore', 'Koramangala',
     '{"lat": 12.9352, "lng": 77.6245, "accuracy": 12}',
     NULL, 14500, 29000, NULL, 1, 1, 'fully',
     '["Meals included","Wi-Fi","Laundry","CCTV"]'::jsonb,
     'available', 'pending',
     'Ms. Reddy', '+919900000222',
     'u-asha', 't_north', NULL,
     'u-asha'),

    ('l_land_devanahalli_plot',
     'org_acme', 'land', 'land_parcel', 'available_for_sale',
     '1.2 acre NA plot near Devanahalli',
     'Clear-title NA converted plot, 200m from the upcoming PRR exit. Ideal for villa project.',
     'Sy No. 47, Devanahalli', 'Bangalore', 'Devanahalli',
     '{"lat": 13.2506, "lng": 77.7094, "accuracy": 20}',
     45000000, NULL, NULL, 52272, NULL, NULL, NULL,
     '["NA converted","Clear title","Road access","Bore well"]'::jsonb,
     'available', 'verified',
     'Mr. Shetty', '+919900000333',
     'u-vijay', 't_south', NULL,
     'u-vijay'),

    ('l_office_whitefield_3000sqft',
     'org_acme', 'office', 'office', 'available_for_rent',
     'Ready-to-move office, Whitefield',
     'Fully fitted 3000 sq ft office with 12 cabins, 1 conference room, 1 server room.',
     'Tower B, RMZ Infinity, Whitefield', 'Bangalore', 'Whitefield',
     '{"lat": 12.9698, "lng": 77.7500, "accuracy": 10}',
     NULL, 175000, 700000, 3000, NULL, 4, 'fully',
     '["Fitted cabins","Conference room","Server room","Pantry","24x7 access"]'::jsonb,
     'available', 'verified',
     'RMZ Leasing', '+919900000444',
     'u-asha', 't_north', NULL,
     'u-asha'),

    ('l_buy_indep_house_jayanagar',
     'org_acme', 'buy', 'independent_house', 'wanted',
     'Looking for 4BHK independent house in Jayanagar / JP Nagar',
     'Buyer relocating from Singapore. Needs ready-to-move, 2500+ sq ft, east-facing.',
     NULL, 'Bangalore', 'Jayanagar',
     NULL,
     75000000, NULL, NULL, 2800, 4, 4, 'fully',
     '["Garden","Servant quarter","4 car parking"]'::jsonb,
     'available', 'unverified',
     'Mr. Iyer (Buyer)', '+919900000555',
     'u-tele', 't_north', NULL,
     'u-tele'),

    -- Owner-listed resale: a 3BHK in a residential society, owner selling
    -- directly (no project anchor, no team anchor), captured by Tara
    -- (telecaller, t_north) and verified by the site team.
    ('l_sell_resale_3bhk_hsr',
     'org_acme', 'sell', 'apartment', 'available_for_sale',
     'Owner-resale 3BHK in HSR Layout Sector 2',
     'Direct from owner. 3BHK on the 6th floor, semi-furnished, registered Khata, clear title.',
     '27, 14th Cross, HSR Layout Sector 2', 'Bangalore', 'HSR Layout',
     '{"lat": 12.9116, "lng": 77.6473, "accuracy": 9}',
     18500000, NULL, NULL, 1620, 3, 2, 'semi',
     '["Gym","Swimming pool","Children play area","2 car parking","24x7 security"]'::jsonb,
     'available', 'verified',
     'Mr. Kulkarni', '+919900000666',
     'u-tele', 't_north', NULL,
     'u-tele');

-- ---------------------------------------------------------------------------
-- Leads (sample) — extends the legacy new-sale shape with the new
-- cross-vertical fields. Keep this block small; the frontend seed in
-- src/data/seed.js remains the canonical reference.
-- ---------------------------------------------------------------------------
INSERT INTO leads (
    id, tenant_id, name, phone, email,
    service_need, client_type, requirements,
    budget_min, budget_max, rent_min, rent_max,
    preferred_location, desired_property_type,
    move_in_date, purchase_timeline,
    status, score, source, notes,
    owner_id, team_id, created_by
) VALUES
    ('ld_tenant_meera',
     'org_acme', 'Meera Krishnan', '+919811110001', 'meera@example.com',
     'rent', 'tenant', '{"furnished": "semi", "pets": "friendly", "parking": 1}'::jsonb,
     NULL, NULL, 45000, 75000,
     'Indiranagar | Koramangala', 'apartment',
     '2026-10-15', NULL,
     'Site Visit Scheduled', 'hot', 'Walk-in', 'Wants east-facing. Has a small dog.',
     'u-asha', 't_north', 'u-asha'),

    ('ld_buyer_sandeep',
     'org_acme', 'Sandeep Reddy', '+919811110002', 'sandeep@example.com',
     'buy', 'buyer', '{"bedrooms": 4, "car_parking": 2, "floor": "high"}'::jsonb,
     60000000, 80000000, NULL, NULL,
     'Jayanagar | JP Nagar', 'independent_house',
     NULL, 'within_3_months',
     'Negotiation', 'hot', 'Referral', 'NRIs, agreement signing this month.',
     'u-vijay', 't_south', 'u-vijay'),

    ('ld_land_seller_rajesh',
     'org_acme', 'Rajesh Gowda', '+919811110003', 'rajesh.land@example.com',
     'sell', 'landlord', '{"area_min_sqft": 40000, "zoning": "NA", "title_clear": true}'::jsonb,
     38000000, 48000000, NULL, NULL,
     'Devanahalli', 'land_parcel',
     NULL, 'immediate',
     'New', 'warm', 'Direct', 'Looking for quick closure; banker referred.',
     'u-vijay', 't_south', 'u-vijay'),

    ('ld_pg_seeker_anu',
     'org_acme', 'Anu Pillai', '+919811110004', 'anu@example.com',
     'pg', 'tenant', '{"gender": "female", "occupancy": "single", "meals": true}'::jsonb,
     NULL, NULL, 12000, 18000,
     'Koramangala | BTM', 'pg_bed',
     '2026-09-01', NULL,
     'Follow-up', 'warm', 'Meta Ads', 'Working professional. Visits this weekend.',
     'u-asha', 't_north', 'u-tele');

-- Seed two listing_matches to exercise the cross-suggest flow.
INSERT INTO listing_matches (id, tenant_id, lead_id, listing_id, match_score, status, matched_by) VALUES
    ('lm_001', 'org_acme', 'ld_tenant_meera',  'l_rent_indiranagar_3bhk',     92.50, 'viewed_by_lead', 'u-asha'),
    ('lm_002', 'org_acme', 'ld_pg_seeker_anu', 'l_pg_koramangala_bed',       88.00, 'suggested',     NULL),
    ('lm_003', 'org_acme', 'ld_land_seller_rajesh', 'l_land_devanahalli_plot', 75.00, 'suggested',  'u-vijay');

COMMIT;

-- ---------------------------------------------------------------------------
-- Notes for future seeds
-- ---------------------------------------------------------------------------
-- * Lead, visit, attendance, photo, thread, message seeds are deliberately
--   omitted here; they are large and should be loaded from src/data/seed.js
--   converted to SQL by an offline script.
-- * permission_matrices rows must be added per role — keep this file in
--   sync with src/data/permissions.js DEFAULT_PERMISSION_MATRIX.


-- ==================== demo credentials (005) ==============================
-- ---------------------------------------------------------------------------
-- 005-seed-dev-credentials.sql
--
-- 🛑 LOCAL / DEMO ONLY. NEVER RUN IN STAGING OR PRODUCTION.
--
-- Gives the seeded demo users a known password so the login flow can
-- be exercised locally. These are the SAME accounts `db:seed` creates,
-- which is the point — a developer can log in as `asha@acme.example`
-- and immediately see a field-executive's scope without a provisioning
-- step.
--
-- THIS IS A DELIBERATE DEMO CREDENTIAL AND NOT A SECRET.
--   tenant : acme
--   email  : <role>@acme.example
--   password: DemoJoldipabo!2026
--
-- Consequences, stated plainly:
--   * Any environment seeded with this file has a known password for
--     every account, including `super@acme.example`.
--   * It must never be applied to a database that holds real data.
--   * The password below is NOT the plaintext — it is a real Argon2id
--     hash, so the column holds no readable secret. That does not make
--     the credentials safe; it only means the file leaks no new material
--     beyond the password already printed above.
--
-- How to apply safely
-- ------------------
--   LOCAL ONLY:  psql "$DATABASE_URL" -f 005-seed-dev-credentials.sql
--
--   Better:      node scripts/seed-dev-credentials.js
--                (hashes a password you supply; refuses a non-local
--                 DATABASE_URL)
--
-- Refuse to apply in production by checking the organisation slug —
-- this file bails unless the tenant is `acme`, the demo tenant. A
-- production organisation with a different slug cannot match.
--
-- To remove the risk entirely before a real launch:
--   UPDATE users SET password_hash = NULL, failed_login_count = 0,
--                   locked_until = NULL
--    WHERE tenant_id = (SELECT id FROM organisations WHERE slug = 'acme');
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  demo_tenant text;
  -- Argon2id, m=19456 t=2 p=1, of the literal password
  -- `DemoJoldipabo!2026`. One hash reused across demo accounts: they
  -- are throwaway fixtures, and distinct salts would imply distinct
  -- passwords, which is misleading.
  demo_hash text := '$argon2id$v=19$m=19456,p=1,t=2$G5JPwjpWvhwDmKNUI8Az3w$GQZRYmQHrWZkk4AXpL5jK3FKodHXcZpl8gRPNudfY6c';
BEGIN
  SELECT id INTO demo_tenant FROM organisations WHERE slug = 'acme';
  IF demo_tenant IS NULL THEN
    RAISE EXCEPTION 'Refusing to seed dev credentials: the demo tenant "acme" does not exist. Run db:seed first.';
  END IF;

  UPDATE users
     SET password_hash = demo_hash,
         password_changed_at = now(),
         failed_login_count = 0,
         locked_until = NULL
   WHERE tenant_id = demo_tenant;

  RAISE NOTICE 'Set the demo password on % users in tenant %',
    (SELECT count(*) FROM users WHERE tenant_id = demo_tenant), demo_tenant;
  RAISE NOTICE 'Sign in as asha@acme.example / DemoJoldipabo!2026';
END $$;


-- ==================== record migrations as applied ========================
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
INSERT INTO schema_migrations (name, checksum) VALUES
  ('001-schema',         '54dd941723eaea4daf441f3372281a56e43f6937fb4fb3c06b742b53a8a87f83'),
  ('002-indexes',        '3bf077aaf7a53e5c62bf1b4c9b71469d8b15973556f4ffb0d49dcfa6aa9143ff'),
  ('003-cross-vertical', '95d433d515f489880e5d58a56be7936ca40ba5362729a148a3c6846f9488ea6d'),
  ('004-auth-sessions',  '55d37ed2b775a2ce97bb40f588b79a174ff13ef47732d6c44b7db40e534b4290'),
  ('006-audit-integrity','f1fa99bbe8ed07830636a92b2b9b7adb2097b11f7d273bf30a2d274a6ce16c35')
ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum;
