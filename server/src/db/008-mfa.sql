-- ---------------------------------------------------------------------------
-- 008-mfa.sql
--
-- Multi-factor authentication: TOTP secrets, hashed backup codes, and a
-- short-lived challenge table for the second login step.
--
-- `users.mfa_enabled` and `users.mfa_secret` already exist (001-schema);
-- they were declared and never used. This migration makes them real and
-- adds what a login challenge needs to be safe.
--
-- Idempotent. See docs/MIGRATIONS.md.
-- 001–007 are FROZEN. Put new schema changes in a new numbered file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Record when MFA was last used, and which factors are enrolled
-- ---------------------------------------------------------------------------
-- `mfa_enabled` alone cannot answer "was this login challenged?" — a user
-- with MFA on who authenticated with a *backup code* still went through
-- the second step, and an operator reviewing the audit trail needs to
-- tell that from a session that predates the feature.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_used_at timestamptz;

COMMENT ON COLUMN users.mfa_secret IS
  'Base32 TOTP secret. Stored encrypted (AES-256-GCM) with the key derived from '
  'JWT_SECRET — see src/auth/mfaService.js. NULL unless MFA is being set up.';

-- ---------------------------------------------------------------------------
-- 2. Login challenges
-- ---------------------------------------------------------------------------
-- A password-only login for an MFA user must NOT mint a refresh session.
-- It mints a challenge instead: an opaque token, stored hashed, good for
-- a few minutes, carrying only enough to complete the second step.
--
-- It is deliberately NOT a refresh session. A refresh session survives for
-- days and rotates; a challenge lives five minutes, is single-use, and is
-- destroyed on success or on the final failed attempt. Granting the first
-- factor the same lifetime as the second would mean a stolen password
-- alone gets a long-lived credential.
CREATE TABLE IF NOT EXISTS mfa_challenges (
    id           text PRIMARY KEY,
    user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id    text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    token_hash   text NOT NULL UNIQUE,   -- SHA-256 of the opaque challenge token
    attempts     integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    ip           text,
    user_agent   text,
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mfa_challenges IS
  'Short-lived second-factor challenges. Single-use, hashed, destroyed on expiry.';

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user
    ON mfa_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expiry
    ON mfa_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- 3. Backup codes
-- ---------------------------------------------------------------------------
-- Single-use recovery codes, stored hashed. A user who loses their phone
-- needs a way back in that does not involve an operator with database
-- access; that path must not become "read the plaintext out of the row".
--
-- Each code is stored as its own row so that using one can be recorded,
-- revoked independently, and audited individually. A single JSONB column
-- could not express "which one was used" without rewriting the array
-- under a concurrent update.
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id          text PRIMARY KEY,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   text NOT NULL UNIQUE,    -- SHA-256 of the normalised code
    label       text,                    -- e.g. "1 of 10", for the UI
    used_at     timestamptz,
    used_ip     text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mfa_backup_codes IS
  'Single-use MFA recovery codes, stored hashed. Consumption is audited.';

CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user
    ON mfa_backup_codes (user_id, used_at);

-- ---------------------------------------------------------------------------
-- 4. Used TOTP steps, so a code cannot be replayed
-- ---------------------------------------------------------------------------
-- A TOTP code stays valid for its whole 30-second window, and the window
-- either side of it too. Without recording which steps have been spent, a
-- code observed on the shoulder is valid for up to 90 seconds — and the
-- attacker and the legitimate user can both use it.
--
-- Recording the last accepted counter is the standard defence: a step may
-- be used once, so the legitimate user's next code works and the replayed
-- one does not. TOTP does not natively prevent replay and most
-- implementations skip this.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;

COMMENT ON COLUMN users.mfa_last_step IS
  'Highest TOTP counter already accepted for this user. Blocks replay of a '
  'code inside its validity window. NULL when MFA is not enabled.';
