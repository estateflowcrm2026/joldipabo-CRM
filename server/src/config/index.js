// Centralized config. Most env vars are read once at startup (frozen).
//
// `resolveSsl` is imported so the boot guard can validate the database TLS
// configuration before the server binds a port. It is pure and imports
// nothing from this module, so there is no cycle.
//
// `devAuth` is re-read on every access because tests toggle
// DEV_AUTH_ENABLED / DEV_AUTH_OFFLINE_FALLBACK to exercise the dev
// shortcut. Production reads are unaffected — process.env is stable
// after boot — but the read happens per request, which is fine for
// a path that fires only on `Bearer dev-<role>`.

import { resolveSsl } from '../db/sslConfig.js';

const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Config: ${name} must be an integer, got ${raw}`);
  }
  return parsed;
}

function str(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function list(name, fallback) {
  const raw = env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

export const config = Object.freeze({
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 4000),
  logLevel: str('LOG_LEVEL', 'info'),
  databaseUrl: str('DATABASE_URL', null),
  /**
   * Runtime connection string for the application role.
   *
   * Optional. When set, it is what the pool connects as; the server
   * falls back to `databaseUrl` when it is absent, so an existing
   * development setup needs no change.
   *
   * It exists because a role that OWNS the tables is exempt from row
   * level security, and one with BYPASSRLS is exempt twice over. Running
   * the application as the owner means every installed policy is inert.
   * See docs/RLS_ROLLOUT_PLAN.md §1.
   */
  appDatabaseUrl: str('APP_DATABASE_URL', null),
  /**
   * Postgres TLS.
   *
   * `mode` is one of:
   *   'disable' — no TLS. Correct for a local Docker Postgres, which
   *               speaks cleartext on loopback.
   *   'require' — TLS, and the server certificate is NOT verified. This
   *               encrypts the connection but does not prove the peer
   *               is the database you meant. Acceptable only for a
   *               trusted network or a throwaway staging box.
   *   'verify-full' — TLS with full certificate and hostname
   *               verification. This is the production setting.
   *
   * `mode: 'auto'` (the default) infers from the connection URL: if
   * DATABASE_URL carries sslmode=require/verify-ca/verify-full, use
   * that; otherwise disable. That keeps existing local setups working
   * untouched while making an explicitly-configured URL do the right
   * thing.
   *
   * `rejectUnauthorized: false` is accepted as an escape hatch for a
   * self-signed staging certificate, but it is refused outright in
   * production — see assertSafeToStart.
   */
  dbSsl: {
    mode: str('DB_SSL_MODE', 'auto'),
    rejectUnauthorized: bool('DB_SSL_REJECT_UNAUTHORIZED', true),
    ca: str('DB_SSL_CA', null),
    caFile: str('DB_SSL_CA_FILE', null),
  },
  /** Applied in NODE_ENV=production. */
  database: {
    statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 30_000),
    lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 10_000),
    poolMax: int('DB_POOL_MAX', 10),
  },
  jwt: {
    /**
     * Read live rather than captured at import. The signing key is the
     * one piece of configuration a test must be able to rotate to prove
     * that key rotation actually invalidates issued tokens; a frozen
     * value would make such a test pass vacuously.
     */
    get secret() {
      return str('JWT_SECRET', null);
    },
    accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 900),
    refreshTtlSeconds: int('REFRESH_TTL_SECONDS', 60 * 60 * 24 * 7),
    // `iss` and `aud` are verified on every token. Defaults are stable
    // strings so a misconfigured deployment still produces verifiable
    // tokens; override per-environment if you front several deployments
    // behind one secret. Changing either invalidates existing tokens.
    get issuer() {
      return str('JWT_ISSUER', 'estateflow-api');
    },
    get audience() {
      return str('JWT_AUDIENCE', 'estateflow-clients');
    },
    /**
     * Secret used only when DEV_AUTH_ENABLED is on and no JWT_SECRET is
     * set, so `dev-<role>` flows and the test suite keep working without
     * a configured secret. It is NOT read in production: the production
     * boot guard refuses to start without a real JWT_SECRET, and
     * resolveSigningKey() refuses to use this one there.
     */
    get devFallbackSecret() {
      return str('JWT_DEV_FALLBACK_SECRET', 'estateflow-dev-only-insecure-secret');
    },
    /**
     * Minimum length for a production signing key. HS256 keys shorter
     * than this are refused at boot — a 4-character secret is brute-force
     * feasible offline despite HMAC being a PRF.
     */
    get minSecretLength() {
      return int('JWT_MIN_SECRET_LENGTH', 32);
    },
  },
  rateLimits: {
    readPerMin: int('RATE_LIMIT_READ_PER_MIN', 100),
    writePerMin: int('RATE_LIMIT_WRITE_PER_MIN', 30),
  },
  corsOrigins: list('CORS_ORIGINS', [
    'http://localhost:5173',
    'http://localhost:5180',
    'http://127.0.0.1:5180',
  ]),
  /**
   * Refresh-token cookie.
   *
   * `AUTH_COOKIE_SECURE` must be true anywhere the app is served over
   * HTTPS, which is everywhere except a developer's own machine: a
   * `Secure` cookie is not sent over plain HTTP, so leaving it on locally
   * would make refresh silently fail. It is refused at boot in
   * production when it is off — see `assertCookieSettingsSafe`.
   *
   * `AUTH_COOKIE_SAME_SITE` is `Lax` for same-site deployments (which
   * covers the localhost/127.0.0.1 dev split, where the ports differ
   * but the registrable domain does not) and `None` for a genuinely
   * cross-site one, which browsers only accept with `Secure`.
   */
  authCookie: {
    secure: bool('AUTH_COOKIE_SECURE', true),
    sameSite: str('AUTH_COOKIE_SAME_SITE', 'Lax').toLowerCase(),
  },
  /**
   * Dev auth shortcut. Re-reads process.env on every access so tests
   * can flip DEV_AUTH_ENABLED without re-importing the module.
   *
   * Production paths do not consult `config.devAuth` directly — they
   * call `isDevAuthEnabled()` so the test-only live-read behaviour is
   * localised to one boolean helper.
   *
   * `offlineFallback` defaults to FALSE as of 2026-09-24. It used to
   * default to true, which meant setting only DEV_AUTH_ENABLED=true
   * granted full in-code permission matrices with no database row to
   * back them — a single env slip produced a complete RBAC bypass.
   * Local setups that want the offline behaviour must now opt in
   * explicitly. See docs/ENVIRONMENT.md.
   */
  get devAuth() {
    return {
      enabled: bool('DEV_AUTH_ENABLED', false),
      offlineFallback: bool('DEV_AUTH_OFFLINE_FALLBACK', false),
      tenantId: str('DEV_AUTH_TENANT_ID', 'org_acme'),
    };
  },
});

export function isDevAuthEnabled() {
  return config.devAuth.enabled;
}

/**
 * Refuse to run with the dev-auth bypass enabled in production.
 *
 * When DEV_AUTH_ENABLED=true the server accepts
 * `Authorization: Bearer dev-<role>` and resolves it to a seeded user.
 * The valid role keys are published in server/README.md, so anyone who
 * reads the docs can authenticate as super-admin with a one-word token.
 * That is a development convenience and must never be reachable in
 * production.
 *
 * This throws rather than warns. A warning is easy to miss in a deploy
 * log, and the failure mode is a full privilege bypass. Failing closed
 * means a misconfigured deploy stops instead of serving.
 *
 * The second check is the sharper edge: DEV_AUTH_OFFLINE_FALLBACK
 * defaults to true, so setting only DEV_AUTH_ENABLED=true grants full
 * in-code permission matrices with no database row to back them. Both
 * flags must be off.
 *
 * @returns {void}
 * @throws {Error} when dev auth is on and NODE_ENV=production
 */
export function assertProductionSafety() {
  if (!isDevAuthEnabled()) return;
  const isProduction = env.NODE_ENV === 'production';
  if (!isProduction) return;

  const flags = [
    'DEV_AUTH_ENABLED',
    'DEV_AUTH_OFFLINE_FALLBACK',
    'DEV_AUTH_TENANT_ID',
  ];
  throw new Error(
    'Refusing to start: dev authentication is enabled in production.\n' +
      'The server would accept `Authorization: Bearer dev-<role>` and resolve it\n' +
      'to a seeded user, which is a full privilege bypass. The valid role keys\n' +
      'are documented in server/README.md.\n\n' +
      `Fix: unset these variables before starting the server:\n${flags.map((f) => `  ${f}`).join('\n')}\n\n` +
      'See docs/ENVIRONMENT.md for the production variable matrix.',
  );
}

/**
 * Refuse to run in production without a JWT signing secret.
 *
 * `tokenService.js` currently returns an *unsigned* placeholder token —
 * `header.payload.` with an empty signature — and `verifyAccessToken`
 * only base64-decodes the payload without checking the signature. A
 * token forged by hand is therefore accepted today. The absence of
 * JWT_SECRET is what keeps that path open, so a production boot must
 * not proceed without one.
 *
 * This does not close the forgery hole on its own: signing has to land
 * in Phase 2 (roadmap §2.1). What it does is stop a production deploy
 * that is relying on an unset secret, so the vulnerability cannot reach
 * production by accident.
 *
 * @returns {void}
 * @throws {Error} when NODE_ENV=production and JWT_SECRET is unset
 */
export function assertJwtSecretPresent() {
  if (env.NODE_ENV !== 'production') return;
  if (env.JWT_SECRET && env.JWT_SECRET.trim() !== '') return;

  throw new Error(
    'Refusing to start: JWT_SECRET is not set.\n' +
      'Without a signing secret the server cannot verify access tokens.\n' +
      'See docs/ENVIRONMENT.md for how to generate and store the value.',
  );
}

/**
 * Refuse to start when the production signing key is too weak to trust.
 *
 * HS256 is a MAC, so the key is the entire security boundary: anyone who
 * guesses it can mint valid tokens for any user in any tenant. A short or
 * low-entropy key is brute-forceable offline at negligible cost, which
 * makes "signed" meaningless. Until 2026-09-24 no length check existed
 * and any string — including `secret` — was accepted.
 *
 * The minimum is 32 bytes of entropy. `JWT_MIN_SECRET_LENGTH` lowers
 * the bar; set it to 0 only for a throwaway staging box, never for
 * production.
 *
 * @returns {void}
 * @throws {Error}
 */
export function assertJwtSecretStrength() {
  if (env.NODE_ENV !== 'production') return;

  const secret = env.JWT_SECRET ?? '';
  const minimum = config.jwt.minSecretLength;

  if (minimum > 0 && secret.length < minimum) {
    throw new Error(
      `Refusing to start: JWT_SECRET is ${secret.length} characters, ` +
        `minimum is ${minimum}.\n` +
        'A short signing key can be brute-forced offline, which makes token\n' +
        'signing worthless. Generate a real one:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"\n\n" +
        'To bypass this for a throwaway staging box only, set ' +
        'JWT_MIN_SECRET_LENGTH=0. Never do that in production.',
    );
  }

  // A value that is obviously a placeholder should not pass a length
  // check just because it was padded out.
  //
  // Matching is on the WHOLE value, not a substring: a legitimate
  // 64-character random key can easily contain 'test' or 'secret' by
  // chance, and rejecting those would make the check a coin flip that
  // pushes operators toward a short, memorable secret — the exact
  // outcome this guard exists to prevent. What matters is whether the
  // value is entirely a placeholder.
  const placeholders = new Set([
    'replace-me',
    'replace-me-with-a-real-secret-from-kms',
    'changeme',
    'change-me',
    'change-this',
    'your-secret-here',
    'your-secret',
    'secret',
    'password',
    'insecure',
    'example',
    'test',
    'dev',
    'development',
    'please-change',
  ]);
  if (placeholders.has(secret.trim().toLowerCase())) {
    throw new Error(
      'Refusing to start: JWT_SECRET is a placeholder value.\n' +
        'Generate a real one:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
  }
}

/**
 * Refuse to start a production deployment that has not turned MFA on for
 * privileged roles.
 *
 * `AUTH_MFA_ENFORCE` defaults to false so a development machine is not
 * locked out of its own admin account, and so a staging box can be built
 * before the app can enrol anyone. That default is only safe because
 * production cannot silently inherit it: this check makes "production
 * without MFA enforcement" a boot failure rather than a deployment that
 * looks fine and has an unenforced second factor on every admin.
 *
 * The alternative — logging a warning — is the failure mode this project
 * has already hit twice, with a rollback that discarded a security
 * response and a cascade that silently voided audit signatures. Both
 * looked healthy in the deploy log.
 *
 * Set AUTH_MFA_ENFORCE=true in production. The value must be set
 * explicitly rather than defaulted, because "unset" and "off" are
 * indistinguishable at boot and only one of them is safe here.
 *
 * @returns {void}
 * @throws {Error} when NODE_ENV=production and AUTH_MFA_ENFORCE is not true
 */
export function assertMfaEnforcedInProduction() {
  if (env.NODE_ENV !== 'production') return;
  const enforced = String(env.AUTH_MFA_ENFORCE ?? '').toLowerCase();
  if (enforced === 'true') return;

  throw new Error(
    'Refusing to start: AUTH_MFA_ENFORCE is not true in production.\n\n' +
      'Admin and super-admin accounts are required to use MFA before launch.\n' +
      'Without enforcement those accounts are reachable with a password alone,\n' +
      'which is the exact capability an attacker with a stolen password wants.\n\n' +
      'Fix: set AUTH_MFA_ENFORCE=true, and run `npm run db:migrate` so the MFA\n' +
      'tables exist, then enrol each privileged account from /auth/mfa/setup.\n\n' +
      'To run an unenforced production-like box, set NODE_ENV to something other\n' +
      'than production — do not weaken the check instead.\n' +
      'See docs/AUTH_TENANT_SECURITY_PLAN.md §12.',
  );
}

/**
 * Refuse a production boot whose runtime database role would bypass RLS.
 *
 * The application must not connect as a role that owns the tables or
 * has BYPASSRLS — Postgres exempts the owner from row-level security
 * and exempts BYPASSRLS roles besides, so every installed policy would
 * be silently inert. That was the state as of 2026-09-28: policies
 * existed on four tables and enforced nothing.
 *
 * This is a check on the CONFIGURED role, not on the live database. It
 * cannot know whether a remote role owns the tables, so it does the
 * next best thing: refuse the two conditions it CAN see — an absent
 * APP_DATABASE_URL (meaning the app is running as the owner) and a URL
 * whose username is one of the known superuser or BYPASSRLS roles.
 *
 * `npm run db:app-role:check` is the authoritative test; it queries
 * `pg_roles`. This guard is the cheap tripwire that catches the common
 * mistake without a connection.
 *
 * @returns {void}
 * @throws {Error} when NODE_ENV=production and the runtime role is
 *   absent or recognisably privileged
 */
export function assertRuntimeRoleIsRlsSubject() {
  if (env.NODE_ENV !== 'production') return;

  // Read live rather than from the frozen `config`, so a test can set
  // the variable and see the effect. The other boot guards read live for
  // the same reason; this one is the only new check and would otherwise
  // be untestable without a subprocess.
  const appUrl = env.APP_DATABASE_URL || config.appDatabaseUrl;
  if (!appUrl) {
    throw new Error(
      'Refusing to start: APP_DATABASE_URL is not set.\n\n' +
        'The application would run as the migration role, which owns the tables\n' +
        'and bypasses row-level security. Every installed policy would be inert:\n' +
        'present, correct, and enforcing nothing.\n\n' +
        'Fix:\n' +
        "  1. create the role:  cd server && npm run db:app-role -- --create\n" +
        "  2. give it a URL:   npm run db:app-role -- --show-url\n" +
        '  3. set APP_DATABASE_URL, and keep DATABASE_URL for migrations.\n\n' +
        'Verify with `npm run rls:check`, which runs as that role and proves a\n' +
        'tenant cannot read another. See docs/RLS_ROLLOUT_PLAN.md §1 and §5.',
    );
  }

  let user;
  try {
    user = new URL(appUrl).username;
  } catch {
    throw new Error('APP_DATABASE_URL is not a valid URL.');
  }

  // Roles that are known to bypass RLS. `postgres` is the Supabase
  // default and is a superuser; `service_role` is the other common one.
  // The list is a tripwire, not an authority — `db:app-role:check` is.
  const privileged = new Set(['postgres', 'supabase_admin', 'service_role']);
  if (privileged.has(user)) {
    throw new Error(
      `Refusing to start: APP_DATABASE_URL uses "${user}", which bypasses\n` +
        '  row-level security.\n\n' +
        'A role that owns the tables, or has BYPASSRLS, is exempt from every\n' +
        'policy. Running the application as one means tenant isolation rests\n' +
        'entirely on the hand-written `tenant_id = $1` predicates — which is\n' +
        'where it was before, and is what RLS was added to stop relying on.\n\n' +
        'Fix: point APP_DATABASE_URL at a NOSUPERUSER NOBYPASSRLS role.\n' +
        '  npm run db:app-role -- --create\n' +
        'See docs/RLS_ROLLOUT_PLAN.md §1.',
    );
  }
}

/**
 * Refuse cookie settings that would silently break the session in
 * production.
 *
 * Two ways this goes wrong, both of which present as "everyone is
 * mysteriously logged out":
 *
 *   * `Secure` off in production — the refresh token would be sent over
 *     plain HTTP. Not a lockout, a credential on the wire.
 *   * `SameSite=None` without `Secure` — every browser rejects the
 *     cookie outright, so refresh never works and every session appears
 *     to expire the moment it is created.
 *
 * @returns {void}
 */
export function assertCookieSettingsSafe() {
  if (env.NODE_ENV !== 'production') return;
  const problems = [];

  if (!config.authCookie.secure) {
    problems.push(
      '  AUTH_COOKIE_SECURE is false. The refresh token is a long-lived\n' +
      '  credential; sending it over plain HTTP exposes it to any network\n' +
      '  between the browser and the server.',
    );
  }
  if (config.authCookie.sameSite === 'none' && !config.authCookie.secure) {
    problems.push(
      '  AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true.\n' +
      '  Browsers reject a SameSite=None cookie that is not Secure, so\n' +
      '  refresh would never work.',
    );
  }
  if (!['lax', 'strict', 'none'].includes(config.authCookie.sameSite)) {
    problems.push(
      `  AUTH_COOKIE_SAME_SITE="${config.authCookie.sameSite}" is not one of\n` +
      '  Lax, Strict, None.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: unsafe auth cookie settings.\n\n${problems.join('\n\n')}\n\n` +
        'See docs/AUTH_API_SPEC.md and docs/ENVIRONMENT.md.',
    );
  }
}

/**
 * Run every production-safety check. Call once during boot, before the
 * server starts listening.
 *
 * @returns {void}
 */
export function assertSafeToStart() {
  assertProductionSafety();
  assertJwtSecretPresent();
  assertJwtSecretStrength();
  assertMfaEnforcedInProduction();
  assertRuntimeRoleIsRlsSubject();
  assertCookieSettingsSafe();
}

/**
 * Resolve the database TLS settings at boot, so a broken one stops the
 * deploy instead of surfacing later.
 *
 * The pool resolves `ssl` lazily on first use, which means a typo'd
 * `DB_SSL_CA_FILE` would otherwise let the server start, bind its port,
 * answer `/health` with "ok", and then fail every request that touched the
 * database. `resolveSsl` is pure — it reads the CA file and returns the
 * `pg` options without opening a connection — so calling it here costs one
 * file read and turns the whole class of misconfiguration into a
 * non-zero exit.
 *
 * A deployment with no `DATABASE_URL` is a supported degraded mode, not an
 * error, so it is skipped. This does NOT verify that the CA actually
 * validates the provider's live chain; only a connection can prove that,
 * which is what `npm run db:ssl-check --connect` is for.
 *
 * `sslConfig.js` imports nothing from this module, so a static import
 * cannot cycle.
 *
 * @returns {void}
 * @throws {Error} when the TLS configuration cannot produce usable options
 */
export function assertDatabaseTlsUsable() {
  if (!config.databaseUrl) return;
  resolveSsl({
    databaseUrl: config.databaseUrl,
    ssl: config.dbSsl,
    isProduction: env.NODE_ENV === 'production',
  });
}

