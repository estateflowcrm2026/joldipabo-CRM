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
