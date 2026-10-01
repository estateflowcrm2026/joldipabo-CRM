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
