// Diagnostic: why does POST /auth/mfa/backup-codes refuse a valid code?
//
// Run after `seed-auth-test-users.js --fresh`. Deletes nothing — it
// re-seeds before it starts, and leaves the secret file for
// verify-auth-flow.js.
//
// Prints step COUNTERS only. Never a code, never a secret.

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { totp } from '../src/auth/totp.js';
import { decryptSecret } from '../src/auth/mfaCrypto.js';
import { getDb, closeDb } from '../src/db/client.js';

const BASE = process.env.AUTH_VERIFY_BASE_URL || 'http://127.0.0.1:4000/api/v1';
const SECRET_FILE =
  process.env.AUTH_TEST_MFA_SECRET_FILE
  || join(tmpdir(), 'joldipabo-test-mfa-secret.txt');

const post = async (path, body, token = null) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const secret = readFileSync(SECRET_FILE, 'utf8').trim().split(/\s+/)[1];
const db = getDb();

try {
  const { rows } = await db.query(
    "SELECT id, mfa_secret, mfa_last_step FROM users WHERE email = 'mfa-on@acme.example'",
  );
  const plain = decryptSecret(rows[0].mfa_secret);
  const stepNow = () => Math.floor(Date.now() / 30_000);
  const readStep = async () => {
    const r = await db.query('SELECT mfa_last_step FROM users WHERE id = $1', [rows[0].id]);
    const v = r.rows[0].mfa_last_step;
    // bigint arrives as a string; without this `after + 1` concatenates.
    return v == null ? null : Number(v);
  };
  
  const login = await post('/auth/login', {
    tenantSlug: 'acme', email: 'mfa-on@acme.example', password: process.env.DEMO_PASSWORD,
  });
  console.log('[diag] login          ->', login.status, login.body?.mfaRequired ? '(mfaRequired)' : '');
  
  const cur = stepNow();
  const done = await post('/auth/mfa/challenge', {
    challengeToken: login.body.challengeToken,
    code: totp(plain, { atMs: cur * 30_000 }),
  });
  console.log('[diag] mfa challenge  ->', done.status, done.body?.error?.code ?? 'ok');
  
  const after = await readStep();
  console.log('[diag] server step    :', after, '| test clock:', cur, '| delta:', after - cur);
  
  const next = after + 1;
  const regen = await post(
    '/auth/mfa/backup-codes',
    { code: totp(plain, { atMs: next * 30_000 }) },
    done.body.accessToken,
  );
  console.log('[diag] backup-codes   ->', regen.status, regen.body?.error?.code ?? `codes=${(regen.body?.backupCodes ?? []).length}`);
  console.log('[diag]   used step    :', next, '| server accepted window: [' + (after - 1) + '..' + (after + 1) + ']');
  
  const end = await readStep();
  console.log('[diag] step after     :', end, end === next ? '(advanced - the verify consumed it, so regeneration did NOT rewind it)' : end === after ? '(UNCHANGED - regeneration refused the code)' : '(other)');
} finally {
  rmSync(SECRET_FILE, { force: true });
  console.log('[diag] deleted the secret file');
  await closeDb();
}