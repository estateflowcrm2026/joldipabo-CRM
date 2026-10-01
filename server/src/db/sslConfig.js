// Postgres TLS resolution.
//
// Kept separate from client.js so the decision can be unit-tested
// without opening a connection. `pg` needs a concrete object (or
// `false`) on the Pool; what the operator types in an env var is a
// mode string, so something has to translate between them.
//
// The three modes, and what each actually guarantees:
//
//   disable      no TLS. Local Docker Postgres on loopback.
//   require      TLS, certificate NOT verified. The connection is
//                encrypted, but nothing proves the peer is the
//                database you intended. Vulnerable to an active
//                MITM on a network you do not control.
//   verify-full  TLS, full certificate chain and hostname check. The
//                only mode appropriate for production.
//
// `auto` is the default and infers from DATABASE_URL, so a URL that
// already carries `?sslmode=verify-full` starts verifying without any
// other change — the common hosted-Postgres case.

import { readFileSync } from 'node:fs';

const VALID_MODES = new Set(['auto', 'disable', 'require', 'verify-full']);

/**
 * Read the `sslmode` query parameter out of a connection URL.
 * Returns null when absent or unparseable.
 */
export function sslModeFromUrl(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const mode = new URL(databaseUrl).searchParams.get('sslmode');
    return mode || null;
  } catch {
    return null;
  }
}

/**
 * Build the value to pass as `Pool.ssl`.
 *
 * @param {object} input
 * @param {string|null} input.databaseUrl
 * @param {{mode: string, rejectUnauthorized: boolean, ca: string|null, caFile: string|null}} input.ssl
 * @param {boolean} [input.isProduction] relaxes `require` to be refused
 * @returns {false | {rejectUnauthorized: boolean, ca?: string}}
 * @throws {Error} on an unrecognised mode, or on an unsafe
 *   `require` configuration in production
 */
export function resolveSsl({ databaseUrl, ssl, isProduction = false }) {
  const requested = String(ssl?.mode ?? 'auto').toLowerCase();
  if (!VALID_MODES.has(requested)) {
    throw new Error(
      `DB_SSL_MODE must be one of ${[...VALID_MODES].join(', ')}; got "${ssl?.mode}".`,
    );
  }

  let mode = requested;
  if (mode === 'auto') {
    // Mirror what the operator already wrote in the URL rather than
    // "improving" it. Escalating `require` to `verify-full` here would
    // break any self-signed staging database that is working today, and
    // silently changing a security setting is worse than honouring it.
    //
    // `verify-ca` is approximated by `require`: pg does not expose
    // chain-without-hostname verification, and silently skipping
    // hostname checks would be a downgrade.
    const fromUrl = sslModeFromUrl(databaseUrl);
    if (fromUrl === 'verify-full') mode = 'verify-full';
    else if (fromUrl === 'require' || fromUrl === 'verify-ca') mode = 'require';
    else mode = 'disable';
  }

  if (mode === 'disable') return false;

  if (mode === 'require') {
    if (isProduction) {
      throw new Error(
        'Refusing to start: DB_SSL_MODE=require in production.\n' +
          'That encrypts the connection but does not verify the certificate,\n' +
          'so it does not prove the peer is the database you intended.\n\n' +
          'Use DB_SSL_MODE=verify-full with a trusted CA (DB_SSL_CA_FILE),\n' +
          'or append `?sslmode=verify-full` to DATABASE_URL.\n' +
          'See docs/ENVIRONMENT.md.',
      );
    }
    // A CA supplied alongside `require` is still applied. Node 22.15
    // changed `sslmode=require` in the connection string to ALIAS
    // verify-full, so a provider with a private root — Supabase — now
    // fails to connect even though the operator asked for encryption
    // only. Honouring the bundle is what keeps `require` usable, and it
    // cannot weaken anything: rejectUnauthorized is still false, so the
    // chain is trusted but not required.
    const relaxed = { rejectUnauthorized: false };
    if (ssl?.caFile) {
      try {
        relaxed.ca = readFileSync(ssl.caFile, 'utf8');
      } catch (err) {
        throw new Error(
          'Refusing to start: DB_SSL_CA_FILE could not be read.\n' +
            `  file:    ${ssl.caFile}\n` +
            `  reason:  ${err.code ?? err.message}\n\n` +
            'DB_SSL_CA_FILE was supplied with DB_SSL_MODE=require, so the\n' +
            'bundle is needed to reach a provider with a private root.\n' +
            'Run `node --env-file=.env scripts/check-db-ssl.js` to diagnose.',
        );
      }
    } else if (ssl?.ca) {
      relaxed.ca = ssl.ca;
    }
    return relaxed;
  }

  // verify-full
  const rejectUnauthorized = ssl?.rejectUnauthorized !== false;

  if (isProduction && rejectUnauthorized === false) {
    throw new Error(
      'Refusing to start: DB_SSL_REJECT_UNAUTHORIZED=false in production.\n' +
        'That disables certificate verification for the database connection.\n\n' +
        'If your provider uses a private CA, point DB_SSL_CA_FILE at the\n' +
        'certificate bundle instead of turning verification off.\n' +
        'See docs/ENVIRONMENT.md.',
    );
  }

  const options = { rejectUnauthorized };

  if (ssl?.caFile) {
    // A bare ENOENT here is a terrible thing for a deploy to surface: the
    // message names a Windows-resolved path with no hint that the setting
    // is what caused it, and it does not say whether the file is missing,
    // unreadable by this user, or a directory. The CA bundle is how a
    // hosted provider with a private root is verified at all, so a
    // misconfigured DB_SSL_CA_FILE must fail loudly and legibly.
    try {
      options.ca = readFileSync(ssl.caFile, 'utf8');
    } catch (err) {
      throw new Error(
        'Refusing to start: DB_SSL_CA_FILE could not be read.\n' +
          `  file:    ${ssl.caFile}\n` +
          `  reason:  ${err.code ?? err.message}\n\n` +
          'DB_SSL_MODE=' + mode + ' verifies the database certificate against this\n' +
          'bundle. Without it the connection cannot be verified at all.\n\n' +
          'For Supabase, obtain the root with:\n' +
          '  node scripts/fetch-supabase-ca.js --host db.<project-ref>.supabase.co\n' +
          'which writes certs/supabase-root-2021.pem and tells you the path to set.\n\n' +
          'Check that the file exists on the machine that runs the server (in the\n' +
          'container, if it is one) and is readable by the process user.\n' +
          'Run `node scripts/check-db-ssl.js` to diagnose without starting up.\n' +
          'See docs/SUPABASE_VERIFICATION.md §5.',
      );
    }
    if (options.ca.trim() === '') {
      throw new Error(
        `Refusing to start: DB_SSL_CA_FILE is empty.\n  file: ${ssl.caFile}\n\n` +
          'Point it at the CA certificate in PEM form, not at an empty or\n' +
          'placeholder file. See docs/SUPABASE_VERIFICATION.md §5.',
      );
    }
  } else if (ssl?.ca) {
    options.ca = ssl.ca;
  }

  return options;
}

export { VALID_MODES };
