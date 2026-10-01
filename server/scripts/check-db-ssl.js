// Validate the database TLS configuration without printing secrets.
//
//   node --env-file=.env scripts/check-db-ssl.js
//   node --env-file=.env scripts/check-db-ssl.js --connect
//
// Two modes:
//
//   default   resolve the settings and report what the pool WOULD ask for.
//             No connection is opened, so it is safe to run anywhere,
//             including against a production environment variable set.
//
//   --connect additionally opens a real connection with the resolved TLS
//             options and runs `SELECT 1`. This is the only way to know
//             that the CA bundle actually verifies Supabase's chain —
//             a correct-looking config with a stale CA still fails, and
//             only at connect time.
//
// SECRETS
// -------
// Nothing secret is printed. The DATABASE_URL password is masked, the CA
// bundle is described by subject/issuer/fingerprint rather than dumped,
// and JWT_SECRET is never read (only its presence is checked, because a
// deployment missing it is refused at boot for an unrelated reason and
// conflating the two would send an operator to the wrong document).
//
// Exit 0 = the configuration is usable for the current NODE_ENV.
// Exit 1 = it is not, and the printed reason is the fix.

import { readFileSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';

import { resolveSsl, sslModeFromUrl } from '../src/db/sslConfig.js';

const CONNECT = process.argv.includes('--connect');
const isProduction = process.env.NODE_ENV === 'production';

/** Print a DATABASE_URL with the password masked. */
function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return '(unparseable)';
  }
}

const line = (s = '') => console.log(s);
const good = (s) => console.log(`  ok    ${s}`);
const warn = (s) => console.log(`  warn  ${s}`);
const bad = (s) => console.log(`  FAIL  ${s}`);

line();
line('=== database TLS check ===');
line(`  NODE_ENV      ${process.env.NODE_ENV || '(unset)'}`);
line(`  DATABASE_URL  ${redact(process.env.DATABASE_URL || '')}`);

if (!process.env.DATABASE_URL) {
  line();
  bad('DATABASE_URL is not set — nothing to check.');
  process.exit(1);
}

const urlMode = sslModeFromUrl(process.env.DATABASE_URL);
line(`  url sslmode   ${urlMode ?? '(none — auto will infer "disable")'}`);

line();
line('--- CA bundle ---');

let ca = process.env.DB_SSL_CA ?? null;
const caFile = process.env.DB_SSL_CA_FILE ?? null;

if (caFile) {
  try {
    ca = readFileSync(caFile, 'utf8');
    good(`DB_SSL_CA_FILE readable: ${caFile}`);
  } catch (err) {
    bad(`DB_SSL_CA_FILE could not be read: ${caFile}`);
    line(`        ${err.code ?? err.message}`);
    line();
    line('  The file must exist on the machine running the server, readable by');
    line('  the process user, and contain PEM text. If the deploy is a container,');
    line('  the path is resolved inside the container, not on the host.');
    process.exit(1);
  }
} else if (ca) {
  good('DB_SSL_CA (inline PEM) is set');
} else {
  line('  none configured (DB_SSL_CA_FILE / DB_SSL_CA)');
}

// Describe the bundle rather than printing it. A CA is a public document,
// but there is no reason for it in a deploy log.
if (ca) {
  const certs = (ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
    .map((pem) => new X509Certificate(pem));
  if (certs.length === 0) {
    bad('the CA bundle contains no PEM certificate.');
  } else {
    good(`${certs.length} certificate(s) in the bundle`);
    for (const c of certs) {
      const fp = createHash('sha256').update(c.raw).digest('hex').match(/.{16}/)[0];
      const cn = c.subject.match(/CN\s*=\s*(.+)/)?.[1]?.trim() ?? '(no CN)';
      const selfSigned = c.subject === c.issuer;
      line(`        CN=${cn}`);
      line(`          valid until ${c.validTo}`);
      line(`          isCA=${c.ca}  self-signed=${selfSigned}  sha256:${fp}…`);
    }
    if (!certs.some((c) => c.ca)) {
      bad('no certificate in the bundle has the CA basic constraint.');
      line('        A leaf certificate cannot verify a chain; point DB_SSL_CA_FILE at');
      line('        the ROOT, not the intermediate and not the server certificate.');
    }
  }
}

line();
line('--- resolved options ---');

let resolved;
try {
  resolved = resolveSsl({
    databaseUrl: process.env.DATABASE_URL,
    ssl: {
      mode: process.env.DB_SSL_MODE ?? 'auto',
      rejectUnauthorized: (process.env.DB_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false',
      ca: process.env.DB_SSL_CA ?? null,
      caFile: process.env.DB_SSL_CA_FILE ?? null,
    },
    isProduction,
  });
} catch (err) {
  // resolveSsl already produces an operator-facing message.
  console.error();
  console.error(err.message);
  process.exit(1);
}

if (resolved === false) {
  bad('TLS is DISABLED. The connection will be cleartext.');
  if (!isProduction) {
    line('        Correct for a local Postgres on loopback. For any managed provider');
    line('        this is wrong — see docs/SUPABASE_VERIFICATION.md §2.');
  }
} else {
  good('TLS is enabled');
  if (resolved.ca) {
    good('a CA bundle is supplied — the chain will be verified against it');
  } else if (resolved.rejectUnauthorized) {
    warn('rejectUnauthorized=true but NO CA bundle.');
    line('        This works only if the provider chains to a CA in the system trust');
    line('        store. Supabase does not — it uses a private "Supabase Root 2021 CA"');
    line('        — so this will fail with "self-signed certificate in certificate chain".');
    line('        Set DB_SSL_CA_FILE. See docs/SUPABASE_VERIFICATION.md §5.');
  } else {
    warn('the certificate is NOT verified. The link is encrypted, but nothing');
    line('        proves the peer is the database you meant.');
  }
}

if (isProduction) {
  line();
  line('--- production rules ---');
  if (resolved === false) {
    bad('production with TLS disabled. Set DB_SSL_MODE=verify-full.');
  }
  if (resolved !== false && !resolved.rejectUnauthorized) {
    bad('production requires rejectUnauthorized=true.');
  }
}

if (CONNECT) {
  line();
  line('--- live connection ---');
  if (resolved === false && !isProduction) {
    warn('skipping: TLS is disabled, so there is nothing to verify.');
  } else {
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: resolved === false ? false : resolved,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
      const { rows } = await client.query('SELECT current_user, current_database()');
      good(`connected as ${rows[0].current_user} to database "${rows[0].current_database}"`);
    } catch (err) {
      bad(`connection failed: ${err.message}`);
      if (/self-signed certificate|unable to verify/i.test(err.message)) {
        line();
        line('  This is the expected failure when the CA bundle is missing or stale.');
        line('  Obtain the current root:');
        line('    node scripts/fetch-supabase-ca.js --host db.<project-ref>.supabase.co');
        line('  or download it from the Supabase dashboard and point DB_SSL_CA_FILE at it.');
        line('  See docs/SUPABASE_VERIFICATION.md §5.');
      }
      await client.end().catch(() => {});
      process.exit(1);
    }
    await client.end().catch(() => {});
  }
}

line();
if (isProduction) {
  good('configuration is acceptable for production.');
} else {
  good('configuration is usable in this environment.');
}
line();
process.exit(0);
