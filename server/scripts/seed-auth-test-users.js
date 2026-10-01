// Provision the two accounts the Phase 9A sign-in flow is tested against.
//
//   node --env-file=.env scripts/seed-auth-test-users.js
//   node --env-file=.env scripts/seed-auth-test-users.js --fresh   # re-enrol MFA
//
// Two accounts, deliberately different:
//
//   mfa-off@acme.example    plain account, no second factor. Covers the
//                           straight sign-in path.
//   mfa-on@acme.example     MFA enrolled. Covers challenge -> verify.
//
// WHY A SCRIPT RATHER THAN SEED DATA
// ----------------------------------
// `seed-demo.sql` deliberately sets no passwords: the demo tenant is
// browsable without credentials, and a known password in a seed file is a
// known password in git. The password here comes from `DEMO_PASSWORD` in
// `.env`, which is gitignored, and is only ever written as an Argon2id
// hash.
//
// Neither account is a real person. They exist so the sign-in flow can be
// exercised end to end — including MFA, which no demo user has.
//
// Idempotent: re-running updates the password rather than creating a
// duplicate, and leaves MFA enrolment alone unless `--fresh`, so a
// verification run cannot silently re-enrol the account it is testing.

import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, closeDb } from '../src/db/client.js';
import { hashPassword, validatePassword } from '../src/auth/passwordPolicy.js';
import { generateSecret } from '../src/auth/totp.js';
import { encryptSecret } from '../src/auth/mfaCrypto.js';

const here = dirname(fileURLToPath(import.meta.url));
const RESTRICT_PS1 = join(here, 'restrict-file-to-owner.ps1');

/** Where the MFA secret is left for the verification run to read. */
export const MFA_SECRET_FILE =
  process.env.AUTH_TEST_MFA_SECRET_FILE
  || join(tmpdir(), 'joldipabo-test-mfa-secret.txt');

/**
 * Restrict a file to this account, and verify it.
 *
 * Delegates to a .ps1 rather than shelling out inline. Two reasons, both
 * measured on this machine:
 *
 *   1. `icacls <file> /inheritance:r /grant:r <user>:F` does not do what it
 *      looks like — after running it the file still carried `(I)(RX,W)`
 *      grants for two unrelated SIDs. The flag governs a grant being
 *      ADDED, not entries already inherited.
 *   2. Passing a path to `powershell -Command` alongside other arguments
 *      does not populate `$args`; it is parsed as part of the command and
 *      the ACL is silently never set.
 *
 * The .ps1 uses `-File` with an explicit `-Path`, which has neither
 * problem, and exits non-zero if any ACL entry survives beyond this
 * account — so a policy that blocks the change stops the script rather
 * than leaving a credential file open.
 *
 * @param {string} file
 * @throws {Error} when the ACL could not be restricted
 */
function restrictToOwner(file) {
  if (process.platform !== 'win32') {
    // Best effort: re-write with the mode set, which is atomic here.
    writeFileSync(file, readFileSync(file, 'utf8'), { mode: 0o600 });
    return;
  }
  execFileSync(
    'powershell.exe',
    [
      // No -ExecutionPolicy Bypass. The script is in the repo, unsigned,
      // and the machine's policy is the operator's to set — overriding it
      // here would be reaching around a control that exists on purpose.
      // If the policy blocks it, the execFileSync below throws and the
      // caller is told, which is the correct outcome: an unrestricted
      // credential file is worse than no seeded account.
      '-NoProfile', '-NonInteractive',
      '-File', RESTRICT_PS1, '-Path', file,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

const FRESH = process.argv.includes('--fresh');
const PASSWORD = process.env.DEMO_PASSWORD;

if (!PASSWORD) {
  console.error('DEMO_PASSWORD is not set. See docs/ENVIRONMENT.md.');
  process.exit(2);
}
validatePassword(PASSWORD);

const TENANT = process.env.AUTH_TEST_TENANT || 'org_acme';
const ROLE = 'field-executive';

const USERS = [
  { email: 'mfa-off@acme.example', mfa: false },
  { email: 'mfa-on@acme.example', mfa: true },
];

const db = getDb();
const hash = await hashPassword(PASSWORD);

for (const { email, mfa } of USERS) {
  const { rows } = await db.query(
    'SELECT id, mfa_enabled FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)',
    [TENANT, email],
  );

  let userId;
  if (rows.length === 0) {
    const id = `u_${email.split('@')[0].replace(/[^a-z0-9]/gi, '')}_test`;
    const { rows: created } = await db.query(
      `INSERT INTO users (id, tenant_id, email, name, role_id, status, password_hash, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, 'Active', $6, now())
       RETURNING id`,
      [id, TENANT, email, `Test ${mfa ? 'MFA' : 'Plain'} User`, ROLE, hash],
    );
    userId = created[0].id;
    console.log(`[seed] created ${email} (${ROLE})`);
  } else {
    userId = rows[0].id;
    await db.query(
      'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1',
      [userId, hash],
    );
    console.log(`[seed] password refreshed for ${email}`);
  }

  if (mfa && (FRESH || !rows[0]?.mfa_enabled)) {
    // Enrol directly. The setup flow needs an authenticated session, and
    // bootstrapping one here would test the wrong thing.
    //
    // `mfa_last_step` is reset as well. It belongs to the PREVIOUS
    // secret, and the server refuses a step it has already taken, so
    // carrying it over would make every code for the new secret be
    // rejected as a replay. Leaving it is what made a second
    // `--fresh` run fail while the first passed.
    const secret = generateSecret();
    await db.query(
      `UPDATE users
          SET mfa_secret = $2,
              mfa_enabled = true,
              mfa_enabled_at = now(),
              mfa_last_step = NULL,
              mfa_last_used_at = NULL
        WHERE id = $1`,
      [userId, encryptSecret(secret)],
    );
    // The secret goes to a FILE, never to stdout. A TOTP secret printed
    // to a terminal is a credential in scrollback, in the shell history of
    // anything that tees the output, and in the session transcript — and
    // unlike the password, nothing about it is recoverable from the
    // database without the encryption key.
    //
    // DEV/TESTING ONLY. Never for a real staff account.
    writeFileSync(MFA_SECRET_FILE, `${email} ${secret}\n`);
    restrictToOwner(MFA_SECRET_FILE);
    console.log(`[seed] enrolled ${email}; TOTP secret written to ${MFA_SECRET_FILE} (not printed)`);
  } else if (mfa) {
    console.log(`[seed] ${email} already has MFA enrolled; left alone (use --fresh to re-enrol)`);
  } else {
    // Keep this account genuinely MFA-free even if a previous run
    // enrolled it, or the "plain sign-in" case stops being plain.
    await db.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret = NULL,
              mfa_last_step = NULL, mfa_enabled_at = NULL
        WHERE id = $1`,
      [userId],
    );
  }
}

console.log('\n[seed] done. Password read from DEMO_PASSWORD; never printed.');
await closeDb();
