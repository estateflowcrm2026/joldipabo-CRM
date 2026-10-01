// MFA service — enrolment, challenge verification, recovery.
//
// TRANSACTION RULE
// ----------------
// Every security-relevant write here must survive the error that follows
// it. `transaction()` in db/client.js rolls back on throw, which is
// correct for a mutation that should not persist — but it means a
// challenge consumed inside a callback that then throws is consumed
// *not*. That bug shipped once already: refresh() rolled back a stolen
// token's family revocation (see authService.js). So: commit the work,
// then throw.
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not decide POLICY. Whether MFA is *required* is a deployment
// question answered by `roleRequiresMfa` plus AUTH_MFA_ENFORCE, and is
// applied by the login flow in authService.js. Keeping that out means the
// enforcement rule can be changed without touching cryptography, and can
// be tested without a database.

import { BadRequest, Unauthorized, TooManyRequests } from '../utils/errors.js';
import { recordAudit } from '../audit/auditLog.js';
import { encryptSecret, decryptSecret, mfaEncryptionAvailable } from './mfaCrypto.js';
import {
  generateSecret,
  otpauthUri,
  verifyTotp,
  secondsRemaining,
  TOTP_ISSUER,
} from './totp.js';
import {
  getMfaState,
  setPendingSecret,
  enableMfa,
  replaceBackupCodesOnly,
  disableMfa,
  consumeTotpStep,
  generateBackupCodes,
  consumeBackupCode,
  countUnusedBackupCodes,
  newChallengeToken,
  createChallenge,
  findChallenge,
  recordChallengeFailure,
  consumeChallenge,
  roleRequiresMfa,
  CHALLENGE_TTL_SECONDS,
} from '../repositories/mfaRepository.js';
import { transaction as realTransaction } from '../db/client.js';

/**
 * Injectable collaborators, mirroring authService.js. The in-memory
 * harness (`scripts/smoke-auth.js`) passes its own `transaction`, so this
 * indirection is what makes the MFA flows testable without a database.
 */
const defaultDeps = () => ({
  transaction: realTransaction,
});

/**
 * Begin enrolment.
 *
 * Returns the secret and the otpauth URI. The secret is stored encrypted
 * but `mfa_enabled` stays FALSE — a user who abandons setup has not
 * enabled MFA, and must not be forced into a second factor they never
 * finished configuring.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tenantId
 * @param {string} input.email used as the authenticator account label
 * @param {object} [input.req]
 * @returns {Promise<{secret: string, otpauthUri: string, issuer: string}>}
 */
export async function startSetup(input, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };
  if (!mfaEncryptionAvailable()) {
    throw new BadRequest(
      'mfa-unavailable',
      'MFA cannot be enabled because the server has no secret configured.',
    );
  }

  const secret = generateSecret();
  await transaction((client) =>
    setPendingSecret(client, input.userId, encryptSecret(secret)),
  );

  await transaction((client) =>
    recordAudit(client, {
      req: input.req,
      tenantId: input.tenantId,
      userId: input.userId,
      action: 'mfa-setup-started',
      entity: 'user',
      entityId: input.userId,
      metadata: { issuer: TOTP_ISSUER, email: input.email ?? null },
    }),
  );

  return {
    secret,
    otpauthUri: otpauthUri({ secret, account: input.email ?? input.userId }),
    issuer: TOTP_ISSUER,
  };
}

/**
 * Confirm enrolment with a code from the authenticator app.
 *
 * On success MFA is enabled, the accepted TOTP step is recorded so the
 * code cannot be replayed, and a fresh set of backup codes is issued.
 * The codes are returned HERE AND NOW — only their hashes are stored, so
 * this is the only chance to show them.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tenantId
 * @param {string} input.code
 * @param {object} [input.req]
 * @returns {Promise<{backupCodes: string[]}>}
 */
export async function confirmSetup(input, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };

  const state = await transaction((client) => getMfaState(client, input.userId));
  if (state.mfaEnabled) {
    throw new BadRequest('mfa-already-enabled', 'MFA is already enabled for this account.');
  }
  if (!state.mfaSecret) {
    throw new BadRequest('mfa-setup-not-started', 'Start MFA setup before verifying it.');
  }

  const secret = decryptSecret(state.mfaSecret);
  if (!secret) {
    // Encrypted with a different key than this process has. Unrecoverable
    // from here; the fix is to disable MFA and re-enrol, which is a
    // deliberate operator action rather than something to paper over.
    throw new BadRequest(
      'mfa-secret-unreadable',
      'The stored MFA secret cannot be decrypted. Disable MFA and start again.',
    );
  }

  const step = verifyTotp({ secret, code: input.code, atMs: input.atMs });
  if (step === null) {
    await transaction((client) =>
      recordAudit(client, {
        req: input.req,
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'mfa-challenge-failed',
        entity: 'user',
        entityId: input.userId,
        metadata: { phase: 'setup', reason: 'invalid-code' },
      }),
    );
    throw new BadRequest('mfa-invalid-code', 'That code is not valid. Check your authenticator and try again.');
  }

  const codes = generateBackupCodes();

  await transaction(async (client) => {
    await enableMfa(
      client,
      input.userId,
      step,
      codes.map((c) => c.hash),
      codes.map((_, i) => `${i + 1} of ${codes.length}`),
    );
    await recordAudit(client, {
      req: input.req,
      tenantId: input.tenantId,
      userId: input.userId,
      action: 'mfa-enabled',
      entity: 'user',
      entityId: input.userId,
      metadata: { issuer: TOTP_ISSUER, backupCodesIssued: codes.length },
    });
  });

  return { backupCodes: codes.map((c) => c.code) };
}

/**
 * Turn MFA off.
 *
 * Requires the caller to have proved the second factor already (see the
 * route): a password alone must not be able to strip MFA, or an attacker
 * with a stolen password removes the very control meant to stop them.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tenantId
 * @param {string} [input.reason]
 * @param {object} [input.req]
 */
export async function disable(input, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };

  await transaction(async (client) => {
    await disableMfa(client, input.userId);
    await recordAudit(client, {
      req: input.req,
      tenantId: input.tenantId,
      userId: input.userId,
      action: 'mfa-disabled',
      entity: 'user',
      entityId: input.userId,
      metadata: { reason: input.reason ?? 'user-requested' },
    });
  });
}

/**
 * Issue a fresh set of backup codes, invalidating the old ones.
 *
 * @param {object} input
 * @returns {Promise<{backupCodes: string[], replaced: number}>}
 */
export async function regenerateBackupCodes(input, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };

  const state = await transaction((client) => getMfaState(client, input.userId));
  if (!state.mfaEnabled) {
    throw new BadRequest('mfa-not-enabled', 'MFA is not enabled for this account.');
  }

  const replaced = await transaction((client) => countUnusedBackupCodes(client, input.userId));
  const codes = generateBackupCodes();

  await transaction(async (client) => {
    // `replaceBackupCodesOnly`, NOT `enableMfa`. The latter rewrites
    // mfa_last_step, and the value it would write is the one read before
    // the current code was verified — so regenerating backup codes
    // rewound the TOTP counter and made the user's next authenticator
    // code a replay. See mfaRepository.js.
    await replaceBackupCodesOnly(
      client,
      input.userId,
      codes.map((c) => c.hash),
      codes.map((_, i) => `${i + 1} of ${codes.length}`),
    );
    await recordAudit(client, {
      req: input.req,
      tenantId: input.tenantId,
      userId: input.userId,
      action: 'mfa-backup-codes-regenerated',
      entity: 'user',
      entityId: input.userId,
      metadata: { replaced, issued: codes.length },
    });
  });

  return { backupCodes: codes.map((c) => c.code), replaced };
}

/**
 * Mint a second-factor challenge. No session is created.
 *
 * @param {object} input
 * @returns {Promise<{challengeToken: string, expiresIn: number, expiresAt: string}>}
 */
export async function issueChallenge(input, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };
  const { token, id, hash } = newChallengeToken();

  const { expiresAt } = await transaction((client) =>
    createChallenge(client, {
      id,
      hash,
      userId: input.userId,
      tenantId: input.tenantId,
      ip: input.ip,
      userAgent: input.userAgent,
    }),
  );

  return {
    challengeToken: token,
    expiresIn: CHALLENGE_TTL_SECONDS,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Check a code against a live challenge and consume it.
 *
 * @param {object} input
 * @param {string} input.challengeToken
 * @param {string} input.code a 6-digit TOTP code OR a backup code
 * @param {object} [input.req]
 * @returns {Promise<{userId: string, tenantId: string, method: 'totp'|'backup-code', backupCodesRemaining: number|null}>}
 * @throws {Unauthorized|TooManyRequests|BadRequest}
 */
export async function verifyChallenge(input, deps = defaultDeps()) {
  const { transaction } = { ...defaultDeps(), ...deps };
  const token = String(input.challengeToken || '').trim();
  if (!token) {
    throw new Unauthorized('invalid-challenge', 'This sign-in attempt is no longer valid. Sign in again.');
  }

  const challenge = await transaction((client) => findChallenge(client, token));
  if (!challenge) {
    throw new Unauthorized('invalid-challenge', 'This sign-in attempt is no longer valid. Sign in again.');
  }

  const code = String(input.code || '').trim();
  if (!code) {
    throw new BadRequest('mfa-code-required', 'Enter your authentication code.');
  }

  // Backup codes are longer and hyphenated; try them only when the input
  // cannot be a TOTP code, so a 6-digit guess never touches that table.
  const looksLikeTotp = /^\d{6}$/.test(code);

  const outcome = await transaction(async (client) => {
    const state = await getMfaState(client, challenge.userId);
    if (!state.mfaEnabled || !state.mfaSecret) {
      return { kind: 'gone' };
    }
    const secret = decryptSecret(state.mfaSecret);
    if (!secret) return { kind: 'unreadable' };

    if (looksLikeTotp) {
      const step = verifyTotp({ secret, code, atMs: input.atMs });
      if (step !== null) {
        // Atomic: a step already spent fails here, so the same code
        // cannot be presented twice.
        const fresh = await consumeTotpStep(client, challenge.userId, step);
        if (fresh) return { kind: 'totp' };
        return { kind: 'replay' };
      }
    }

    const backup = await consumeBackupCode(client, challenge.userId, code);
    if (backup.ok) {
      return { kind: 'backup', remaining: backup.remaining };
    }
    return { kind: 'invalid' };
  });

  if (outcome.kind === 'totp' || outcome.kind === 'backup') {
    await transaction(async (client) => {
      await consumeChallenge(client, challenge.id);
      await recordAudit(client, {
        req: input.req,
        tenantId: challenge.tenantId,
        userId: challenge.userId,
        action: 'mfa-challenge-passed',
        entity: 'user',
        entityId: challenge.userId,
        metadata: {
          method: outcome.kind,
          backupCodesRemaining: outcome.kind === 'backup' ? outcome.remaining : null,
          ip: input.ip ?? null,
        },
      });
    });
    return {
      userId: challenge.userId,
      tenantId: challenge.tenantId,
      method: outcome.kind === 'backup' ? 'backup-code' : 'totp',
      backupCodesRemaining: outcome.kind === 'backup' ? outcome.remaining : null,
    };
  }

  // Failure paths. The counter is committed in its own transaction so the
  // attempt is counted even though we are about to throw — the same trap
  // as the login lockout counters.
  const { exhausted, gone } = await transaction((client) =>
    recordChallengeFailure(client, challenge.id),
  );

  // The challenge vanished between `findChallenge` and here — a parallel
  // request completed it. That is not a wrong code and not a lockout; the
  // caller simply has to start a new sign-in.
  if (gone) {
    throw new Unauthorized('invalid-challenge', 'This sign-in attempt is no longer valid. Sign in again.');
  }

  await transaction((client) =>
    recordAudit(client, {
      req: input.req,
      tenantId: challenge.tenantId,
      userId: challenge.userId,
      action: 'mfa-challenge-failed',
      entity: 'user',
      entityId: challenge.userId,
      metadata: {
        reason: outcome.kind,
        phase: 'login',
        attempts: challenge.attempts + 1,
        ip: input.ip ?? null,
      },
    }),
  );

  if (outcome.kind === 'replay') {
    throw new Unauthorized(
      'mfa-code-replayed',
      'That code has already been used. Sign in again.',
    );
  }
  if (outcome.kind === 'gone' || outcome.kind === 'unreadable') {
    throw new Unauthorized('invalid-challenge', 'This sign-in attempt is no longer valid. Sign in again.');
  }
  if (exhausted) {
    // Burn the challenge so the correct code cannot follow the guesses.
    await transaction((client) => consumeChallenge(client, challenge.id));
    throw new TooManyRequests(
      'mfa-attempts-exhausted',
      'Too many incorrect codes. Sign in again.',
    );
  }
  throw new Unauthorized('mfa-invalid-code', 'That code is not valid.');
}

/**
 * Whether a role must have MFA in this deployment.
 *
 * `AUTH_MFA_ENFORCE` is the switch. It is `false` by default so a
 * development machine is not locked out of its own admin account, and the
 * production boot guard turns it on — see config/index.js. Dev auth is
 * unaffected either way: a `dev-<role>` token never reaches this code.
 *
 * @param {string} roleId
 * @returns {boolean}
 */
export function mfaRequiredForRole(roleId) {
  return mfaEnforcementEnabled() && roleRequiresMfa(roleId);
}

function mfaEnforcementEnabled() {
  return String(process.env.AUTH_MFA_ENFORCE ?? 'false').toLowerCase() === 'true';
}

export { secondsRemaining, countUnusedBackupCodes, getMfaState, roleRequiresMfa };
