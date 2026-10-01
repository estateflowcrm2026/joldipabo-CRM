-- ---------------------------------------------------------------------------
-- 007-audit-actor-preservation.sql
--
-- Keeps `audit_log` tamper-evident when a user is deleted.
--
-- The problem
-- -----------
-- `user_id` is one of the eight fields the HMAC canonical form signs
-- (server/src/audit/auditLog.js). The column carried
-- `ON DELETE SET NULL`, so deleting a user rewrote a SIGNED field of
-- every audit row that user produced:
--
--     UPDATE audit_log SET user_id = NULL ...
--
-- Every one of those rows then failed `verifyAuditRow`. Measured on the
-- verification database after a single smoke run: 38 of 42 audit rows
-- reported as tampered, and the 4 that verified were exactly the rows
-- whose `user_id` had not been nulled. The smoke's own cleanup step
-- — `DELETE FROM users ...` — is what broke them, so the integrity
-- check was reporting tampering on rows nobody had touched.
--
-- This is worse than a false alarm. It is indistinguishable from real
-- tampering: an attacker who can nulls `user_id` can do it deliberately
-- to make genuine evidence unverifiable, and an operator running the
-- integrity job sees a wall of failures and learns to ignore it.
--
-- The fix
-- -------
-- `actor_id` is a new, immutable copy of the actor. The writer fills it
-- on every INSERT; the HMAC signs it instead of `user_id`. The cascade
-- then only nulls `user_id`, which is no longer covered by the
-- signature, so a user deletion no longer invalidates their history.
--
-- `user_id` is kept as-is — nullable, still cascading — because the
-- "is this actor still an active user" join is what the
-- SECURITY_ACCEPTANCE_CHECKLIST §9.4 integrity report needs, and
-- dropping the FK instead would lose that.
--
-- Backfill
-- --------
-- Existing rows have a NULL `actor_id`, which would make them
-- unverifiable. `actor_id` is backfilled from the surviving `user_id`
-- here; the `hmac` re-signing is NOT done in SQL.
--
-- An earlier draft of this file tried to re-sign here and could not
-- reproduce the canonical form: `jsonb` orders object keys by LENGTH
-- then bytewise, where `JSON.stringify` orders them alphabetically,
-- and jsonb's `::text` adds whitespace that JSON.stringify does not.
-- A third copy of a signing routine is how the writer and the verifier
-- came to disagree in the first place, so the backfill is a Node script
-- that calls the same `auditCanonical()` the writer uses:
--
--     node scripts/resign-audit.js
--
-- That is also why `actor_id` is added but not populated by the
-- backfill's own UPDATE ordering — the column is written first, then the
-- script re-signs using the same helper.
--
-- Idempotent. See docs/MIGRATIONS.md.
-- 001–006 are FROZEN. Put new schema changes in a new numbered file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The immutable actor column
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id text;

COMMENT ON COLUMN audit_log.actor_id IS
  'Immutable copy of user_id, captured at write time and covered by the hmac. '
  'user_id may be nulled by ON DELETE SET NULL; this column never changes, so '
  'deleting a user does not invalidate their audit history.';

-- Backfill actor_id from user_id, but ONLY where it is still empty.
--
-- The first draft used `WHERE actor_id IS DISTINCT FROM user_id`, which is
-- not idempotent in the harmful direction: a row whose actor has since been
-- deleted has actor_id set and user_id NULL, so re-running the migration
-- blanked the actor and re-broke its signature. Verified — re-running 007
-- against a live database dropped 38 rows from verifying.
--
-- `actor_id` is the immutable copy, so once written it is never rewritten.
UPDATE audit_log
   SET actor_id = user_id
 WHERE actor_id IS NULL
   AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON audit_log (tenant_id, actor_id, timestamp DESC);

-- ---------------------------------------------------------------------------
-- 2. Signature backfill is NOT done here
-- ---------------------------------------------------------------------------
-- Run, once, after this migration:
--
--     node scripts/resign-audit.js
--
-- It re-signs every row whose signature no longer matches its contents,
-- using `auditCanonical()` from src/audit/auditLog.js — the same function
-- the writer and the verifier use. Rows that already verify are left
-- untouched, so a genuinely tampered row keeps failing.

