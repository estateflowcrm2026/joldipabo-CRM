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
