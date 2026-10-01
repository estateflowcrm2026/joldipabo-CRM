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
