// Set a password on the local demo users.
//
//   cd server
//   export DATABASE_URL=postgres://estateflow:estateflow@127.0.0.1:5432/estateflow_dev
//   node scripts/seed-dev-credentials.js
//   node scripts/seed-dev-credentials.js --password 'my own password'
//
// Refuses any DATABASE_URL that is not localhost, so a demo password
// cannot be written to a shared or production database by running the
// wrong command. `005-seed-dev-credentials.sql` is the equivalent SQL
// for a local `psql` session; this script exists because it re-hashes
// a password you supply rather than baking one into the repository.
//
// Exit code 0 on success, 2 on refusal, 1 on failure.

import { getDb, closeDb, isDbConfigured } from '../src/db/client.js';
import { hashPassword, validatePassword } from '../src/auth/passwordPolicy.js';

const DEFAULT_PASSWORD = 'DemoJoldipabo!2026';
const DEMO_TENANT_SLUG = 'acme';

function refuse(message) {
  console.error(`[seed-dev-credentials] REFUSED: ${message}`);
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL || '';
if (!isDbConfigured()) {
  refuse('DATABASE_URL is not set. See server/README.md "Local Postgres".');
}

let host = '';
try {
  host = new URL(databaseUrl).hostname;
} catch {
  refuse(`DATABASE_URL is not a valid URL.`);
}
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  refuse(
    `DATABASE_URL host is "${host}".\n` +
      '  This script writes a DEMO password to every user in the demo tenant.\n' +
      '  It only runs against localhost. Point it at a local database.',
  );
}

const argv = process.argv.slice(2);
const pwIndex = argv.indexOf('--password');
const password = pwIndex !== -1 ? argv[pwIndex + 1] : DEFAULT_PASSWORD;

if (!password) {
  refuse('--password was given with no value.');
}
try {
  validatePassword(password);
} catch (err) {
  refuse(err.message);
}

const db = getDb();

try {
  const { rows: tenantRows } = await db.query(
    'SELECT id FROM organisations WHERE slug = $1',
    [DEMO_TENANT_SLUG],
  );
  if (tenantRows.length === 0) {
    refuse(
      `The demo tenant "${DEMO_TENANT_SLUG}" does not exist. Run npm run db:seed first.`,
    );
  }
  const tenantId = tenantRows[0].id;

  // Confirm the organisation is genuinely the demo fixture before
  // writing. A production database that happens to be reachable over
  // localhost (a tunnel, a port-forward) must not be caught by the
  // host check alone.
  const { rows: lookalike } = await db.query(
    "SELECT count(*)::int AS n FROM organisations WHERE id <> $1 AND status = 'Trial'",
    [tenantId],
  );
  if (lookalike[0].n > 0) {
    refuse(
      `This database has ${lookalike[0].n} organisation(s) other than the demo\n` +
        '  tenant. Refusing to write a shared demo password to it.',
    );
  }

  const hash = await hashPassword(password);
  const { rowCount } = await db.query(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = now(),
            failed_login_count = 0,
            locked_until = NULL
      WHERE tenant_id = $1`,
    [tenantId, hash],
  );

  console.log(`[seed-dev-credentials] updated ${rowCount} user(s) in tenant "${DEMO_TENANT_SLUG}".`);
  console.log(`[seed-dev-credentials] sign in as asha@acme.example with the password you supplied.`);
  console.log('[seed-dev-credentials] this is a DEMO credential — do not use it anywhere real.');
} catch (err) {
  console.error('[seed-dev-credentials] failed:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
