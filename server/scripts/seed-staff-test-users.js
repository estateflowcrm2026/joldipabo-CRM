// Provision four sign-in-capable test accounts for the staff directory.
//
//   cd server
//   node --env-file=.env scripts/seed-staff-test-users.js
//
// One manager, two field executives (different teams, so team scoping is
// exercisable), and one telecaller:
//
//   manager.dir@acme.example     sales-manager,    t_north
//   exec-a.dir@acme.example       field-executive,  t_north
//   exec-b.dir@acme.example       field-executive,  t_south
//   tele.dir@acme.example         telecaller,       t_north
//
// WHY A SCRIPT RATHER THAN SEED DATA
// ----------------------------------
// `seed-demo.sql` deliberately sets no passwords: the demo tenant is
// browsable without credentials, and a known password in a seed file is a
// known password in git. The password here comes from `DEMO_PASSWORD` in
// `.env`, which is gitignored, and is only ever written as an Argon2id
// hash — the same posture as scripts/seed-auth-test-users.js.
//
// SAFETY
// ------
// Refuses any DATABASE_URL that is not localhost (exit 2), and refuses a
// database whose demo tenant shares space with any other live
// organisation — the same two guards as seed-dev-credentials.js. A
// production database reachable over a tunnel must not gain test accounts.
//
// Idempotent: re-running refreshes the password and repairs the
// role/team/status rather than creating duplicates. The `.dir@` address
// namespace keeps these rows out of the way of the demo seed and the
// auth-test accounts, and marks them for what they are.

// Refuses any DATABASE_URL that is not localhost, so test accounts cannot
// be written to a shared or production database by running the wrong
// command.
//
// Exit code 0 on success, 2 on refusal, 1 on failure.

import { getDb, closeDb, isDbConfigured } from '../src/db/client.js';
import { hashPassword, validatePassword } from '../src/auth/passwordPolicy.js';

function refuse(message) {
  console.error(`[seed-staff-test-users] REFUSED: ${message}`);
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
  refuse('DATABASE_URL is not a valid URL.');
}
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  refuse(
    `DATABASE_URL host is "${host}".\n` +
      '  This script creates test accounts with a DEMO password.\n' +
      '  It only runs against localhost. Point it at a local database.',
  );
}

const PASSWORD = process.env.DEMO_PASSWORD;
if (!PASSWORD) {
  refuse('DEMO_PASSWORD is not set. See docs/ENVIRONMENT.md.');
}
try {
  validatePassword(PASSWORD);
} catch (err) {
  refuse(err.message);
}

const TENANT = process.env.STAFF_TEST_TENANT || 'org_acme';

const ACCOUNTS = [
  { email: 'manager.dir@acme.example', name: 'Dir Manager', roleId: 'sales-manager', teamId: 't_north', designation: 'Sales Manager', projects: ['p_skyline', 'p_heights'] },
  { email: 'exec-a.dir@acme.example', name: 'Dir Exec A', roleId: 'field-executive', teamId: 't_north', designation: 'Field Executive', projects: ['p_skyline'] },
  { email: 'exec-b.dir@acme.example', name: 'Dir Exec B', roleId: 'field-executive', teamId: 't_south', designation: 'Field Executive', projects: ['p_heights'] },
  { email: 'tele.dir@acme.example', name: 'Dir Telecaller', roleId: 'telecaller', teamId: 't_north', designation: 'Telecaller', projects: [] },
];

const db = getDb();

try {
  const { rows: tenantRows } = await db.query(
    'SELECT id FROM organisations WHERE id = $1',
    [TENANT],
  );
  if (tenantRows.length === 0) {
    refuse(`Tenant "${TENANT}" does not exist. Run npm run db:seed first.`);
  }

  // Same lookalike guard as seed-dev-credentials.js: a database that holds
  // any other live organisation is not a scratch dev database.
  const { rows: lookalike } = await db.query(
    "SELECT count(*)::int AS n FROM organisations WHERE id <> $1 AND status = 'Trial'",
    [TENANT],
  );
  if (lookalike[0].n > 0) {
    refuse(
      `This database has ${lookalike[0].n} organisation(s) other than the demo\n` +
        '  tenant. Refusing to write test accounts to it.',
    );
  }

  const hash = await hashPassword(PASSWORD);

  for (const account of ACCOUNTS) {
    const { rows } = await db.query(
      'SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)',
      [TENANT, account.email],
    );
    let userId;
    if (rows.length === 0) {
      const id = `u_${account.email.split('@')[0].replace(/[^a-z0-9]/gi, '')}`;
      const { rows: created } = await db.query(
        `INSERT INTO users (id, tenant_id, branch_id, name, email, role_id, team_id,
            designation, status, password_hash, password_changed_at, joined_at)
         VALUES ($1, $2, 'br_bangalore', $3, $4, $5, $6, $7, 'Active', $8, now(), now())
         RETURNING id`,
        [id, TENANT, account.name, account.email, account.roleId, account.teamId, account.designation, hash],
      );
      userId = created[0].id;
      console.log(`[seed-staff-test-users] created ${account.email} (${account.roleId}, ${account.teamId})`);
    } else {
      userId = rows[0].id;
      await db.query(
        `UPDATE users
            SET name = $2, role_id = $3, team_id = $4, designation = $5,
                status = 'Active', deleted_at = NULL,
                password_hash = $6, password_changed_at = now(),
                failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [userId, account.name, account.roleId, account.teamId, account.designation, hash],
      );
      console.log(`[seed-staff-test-users] refreshed ${account.email} (${account.roleId}, ${account.teamId})`);
    }

    // Repair project links so the manager sees both projects and each
    // executive sees their own — the topology the scoping tests assume.
    await db.query('DELETE FROM user_project_ids WHERE user_id = $1', [userId]);
    for (const projectId of account.projects) {
      await db.query(
        'INSERT INTO user_project_ids (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, projectId],
      );
    }
  }

  console.log('\n[seed-staff-test-users] done. Password read from DEMO_PASSWORD; never printed.');
  console.log('[seed-staff-test-users] sign in as manager.dir@acme.example to exercise team scoping.');
} catch (err) {
  console.error('[seed-staff-test-users] failed:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
