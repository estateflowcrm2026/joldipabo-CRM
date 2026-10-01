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
