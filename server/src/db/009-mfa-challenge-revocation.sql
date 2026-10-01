-- ---------------------------------------------------------------------------
-- 009-mfa-challenge-revocation.sql
--
-- Invalidates outstanding login challenges when MFA enrolment changes.
--
-- THE GAP THIS CLOSES
-- --------------------
-- `POST /auth/login` mints a challenge whenever the account is *already*
-- enrolled, and `POST /auth/mfa/setup` is reachable by any authenticated
-- user. So a challenge minted for a user who has just started enrolling —
-- while `mfa_enabled` was still false and therefore before the reason
-- for the challenge existed — becomes valid the moment they finish
-- confirming. Verified against a live database on 2026-09-27: a challenge
-- issued before enrolment completed successfully against a valid code.
--
-- The impact is bounded but real: it is a 5-minute window in which a
-- password alone, obtained before enrolment finished, buys a full
-- session. That is the exact thing MFA exists to stop, and the window
-- opens precisely while an admin is setting MFA up.
--
-- THE FIX
-- -------
-- A trigger that burns outstanding challenges whenever `mfa_enabled`
-- or `mfa_secret` changes. It is a TRIGGER rather than an application
-- call because the invariant is about the credential, not about any one
-- code path: a future route that enables MFA must not be able to forget.
--
-- Idempotent. See docs/MIGRATIONS.md.
-- 001–008 are FROZEN. Put new schema changes in a new numbered file.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION revoke_mfa_challenges_on_enrolment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only when the factor state actually changes. A no-op update (an
  -- `updated_at` touch, a re-save of the same secret) must not destroy a
  -- challenge the user is in the middle of answering.
  IF NEW.mfa_enabled IS DISTINCT FROM OLD.mfa_enabled
     OR NEW.mfa_secret IS DISTINCT FROM OLD.mfa_secret THEN
    UPDATE mfa_challenges
       SET consumed_at = now()
     WHERE user_id = NEW.id
       AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION revoke_mfa_challenges_on_enrolment() IS
  'Burns outstanding MFA challenges when a user''s factor state changes, so '
  'a challenge minted before enrolment cannot be used after it. See 009.';

-- DROP TRIGGER IF EXISTS makes this re-runnable; the migration runner
-- also refuses to apply an already-applied file, so in practice this only
-- matters for a hand-rolled rollback.
DROP TRIGGER IF EXISTS trg_mfa_challenges_on_enrolment ON users;

CREATE TRIGGER trg_mfa_challenges_on_enrolment
    AFTER UPDATE OF mfa_enabled, mfa_secret ON users
    FOR EACH ROW
    EXECUTE FUNCTION revoke_mfa_challenges_on_enrolment();
