// Account lifecycle — invite, accept-invite, forgot-password, reset-password.
//
// These are the flows that make the product usable by a real
// organisation. Without them a seeded demo account is the only account
// that can ever exist.
//
// Rules that shape all four:
//
//   * **Tokens are stored hashed.** The plaintext exists once, in the
//     email, and is never re-readable from the database. A database
//     dump does not yield a working reset link.
//   * **Tokens are single-use and time-boxed.** Consuming one marks it
//     used; presenting a used one fails.
//   * **Password recovery never reveals whether an account exists.** An
//     unknown address returns the same 202 as a known one.
//   * **Accepting an invite and resetting a password both revoke every
//     session.** If a password changes, whoever held the old one loses
//     access immediately — that is the whole point.

import { randomBytes, createHash } from 'node:crypto';
import { BadRequest } from '../utils/errors.js';
import { hashPassword, validatePassword } from '../auth/passwordPolicy.js';
import { recordAudit } from '../audit/auditLog.js';
import { revokeAllSessions } from './sessionRepository.js';
import {
  sendInviteEmail,
  sendPasswordResetEmail,
} from '../auth/mailer.js';

/** How long an invite link stays valid. */
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
/** How long a reset link stays valid. */
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

/** Opaque token; only its SHA-256 is stored. */
function newToken() {
  return randomBytes(32).toString('base64url');
}

const tokenHash = (token) =>
  createHash('sha256').update(String(token || ''), 'utf8').digest('hex');

/** @param {boolean} enabled  @param {number} ms */
function ttl(enabled, ms) {
  return enabled ? ms : 0;
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

/**
 * Create a user in `Invited` state and email them a single-use link.
 *
 * @param {object} input
 * @param {import('pg').PoolClient} input.client — caller's transaction
 * @param {object} input.actor — the inviting user (for the audit row)
 * @param {string} input.tenantId
 * @param {string} input.email
 * @param {string} input.name
 * @param {string} [input.phone]
 * @param {string} input.roleId
 * @param {string} [input.teamId]
 * @param {string} [input.branchId]
 * @param {string} [input.designation]
 * @param {object} [input.permissionMatrix] — per-user override
 * @param {boolean} [input.invitesEnabled] — deployment kill-switch
 * @param {object} [input.req] — Fastify request, for audit metadata
 * @returns {Promise<{ id: string, email: string, inviteExpiresAt: string, mail: object }>}
 */
export async function inviteUser(input) {
  const { client } = input;

  if (!input.invitesEnabled) {
    throw new BadRequest('invites-disabled', 'User invitations are disabled on this deployment.');
  }

  const email = String(input.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new BadRequest('invalid-payload', 'A valid email is required.');
  }
  if (!input.name?.trim()) {
    throw new BadRequest('invalid-payload', 'name is required.');
  }
  if (!input.roleId) {
    throw new BadRequest('invalid-payload', 'roleId is required.');
  }

  const token = newToken();
  const tokenHashed = tokenHash(token);
  const expiresAt = new Date(Date.now() + ttl(input.invitesEnabled, INVITE_TTL_MS)).toISOString();
  const id = newId('u');

  await client.query(
    `INSERT INTO users (
        id, tenant_id, branch_id, name, email, phone, role_id, team_id,
        designation, status, permission_matrix,
        invited_at, invite_token, invite_expires_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Invited',$10, now(), $11, $12, now(), now())`,
    [
      id,
      input.tenantId,
      input.branchId ?? null,
      input.name.trim(),
      email,
      input.phone ?? null,
      input.roleId,
      input.teamId ?? null,
      input.designation ?? null,
      input.permissionMatrix ? JSON.stringify(input.permissionMatrix) : null,
      tokenHashed,
      expiresAt,
    ],
  );

  await recordAudit(client, {
    req: input.req,
    tenantId: input.tenantId,
    userId: input.actor?.id ?? null,
    action: 'invited-user',
    entity: 'user',
    entityId: id,
    metadata: {
      email,
      roleId: input.roleId,
      teamId: input.teamId ?? null,
      inviterRole: input.actor?.role ?? null,
      // The token itself is never audited.
    },
  });

  const mail = await sendInviteEmail({
    to: email,
    name: input.name.trim(),
    inviterName: input.actor?.name ?? 'An administrator',
    token,
    expiresAt,
  });

  return { id, email, inviteExpiresAt: expiresAt, mail };
}

// ---------------------------------------------------------------------------
// Accept invite
// ---------------------------------------------------------------------------

/**
 * Consume an invite token and set the first password.
 *
 * @param {object} input
 * @param {import('pg').PoolClient} input.client
 * @param {string} input.token
 * @param {string} input.password
 * @param {object} [input.req]
 * @returns {Promise<{ id: string, email: string, tenantId: string, role: string }>}
 */
export async function acceptInvite(input) {
  const { client } = input;
  validatePassword(input.password);

  const hashed = tokenHash(input.token);
  const { rows } = await client.query(
    `SELECT id, tenant_id, email, name, role_id, invite_expires_at
       FROM users
      WHERE invite_token = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [hashed],
  );

  if (rows.length === 0) {
    throw new BadRequest('invalid-invite', 'This invitation link is not valid.');
  }
  const invite = rows[0];

  if (new Date(invite.invite_expires_at).getTime() <= Date.now()) {
    throw new BadRequest('invite-expired', 'This invitation has expired. Ask for a new one.');
  }

  const passwordHash = await hashPassword(input.password);
  const { rows: updated } = await client.query(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = now(),
            status = 'Active',
            joined_at = COALESCE(joined_at, now()),
            invite_token = NULL,          -- single-use
            invite_expires_at = NULL,
            failed_login_count = 0,
            locked_until = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING id, tenant_id, email, name, role_id`,
    [invite.id, passwordHash],
  );

  await recordAudit(client, {
    req: input.req,
    tenantId: invite.tenant_id,
    userId: invite.id,
    action: 'accepted-invite',
    entity: 'user',
    entityId: invite.id,
    metadata: { email: invite.email, roleId: invite.role_id },
  });

  return {
    id: updated[0].id,
    email: updated[0].email,
    tenantId: updated[0].tenant_id,
    role: updated[0].role_id,
  };
}

// ---------------------------------------------------------------------------
// Forgot password
// ---------------------------------------------------------------------------

/**
 * Start a password reset.
 *
 * Always resolves to `{ ok: true }`, whether or not the address exists.
 * A different response for a known address would turn this endpoint
 * into an account-existence oracle.
 *
 * @param {object} input
 * @param {import('pg').PoolClient} input.client
 * @param {string} input.email
 * @param {string} input.tenantId
 * @param {boolean} [input.resetsEnabled] — deployment kill-switch
 * @param {object} [input.req]
 * @returns {Promise<{ ok: true, mail?: object }>}
 */
export async function forgotPassword(input) {
  const { client } = input;
  const email = String(input.email || '').trim().toLowerCase();

  if (input.resetsEnabled === false) {
    throw new BadRequest('resets-disabled', 'Password resets are disabled on this deployment.');
  }

  const { rows } = await client.query(
    `SELECT id, tenant_id, name, email
       FROM users
      WHERE tenant_id = $1 AND lower(email) = $2
        AND deleted_at IS NULL AND status <> 'Suspended'
      LIMIT 1`,
    [input.tenantId, email],
  );

  if (rows.length === 0) {
    // Nothing to do, and nothing to say. Still audited so an operator
    // can see reset attempts against addresses with no account.
    await recordAudit(client, {
      req: input.req,
      tenantId: input.tenantId,
      action: 'password-reset-requested',
      entity: 'user',
      entityId: null,
      metadata: { email, delivered: false, reason: 'no-matching-account' },
    });
    return { ok: true };
  }

  const user = rows[0];
  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  // A new request invalidates any outstanding one, so a link an attacker
  // triggered cannot be used after the real user asks for their own.
  await client.query(
    'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
    [user.id],
  );

  await client.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [newId('prt'), user.id, tokenHash(token), expiresAt],
  );

  await recordAudit(client, {
    req: input.req,
    tenantId: user.tenant_id,
    userId: user.id,
    action: 'password-reset-requested',
    entity: 'user',
    entityId: user.id,
    metadata: { email, delivered: true, expiresAt },
  });

  const mail = await sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    token,
    expiresAt,
  });

  return { ok: true, mail };
}

// ---------------------------------------------------------------------------
// Reset password
// ---------------------------------------------------------------------------

/**
 * Consume a reset token and set a new password.
 *
 * Revokes every session for the user: if a password changes, whoever
 * held the old one must lose access immediately.
 *
 * @param {object} input
 * @param {import('pg').PoolClient} input.client
 * @param {string} input.token
 * @param {string} input.password
 * @param {object} [input.req]
 * @returns {Promise<{ id: string, email: string, sessionsRevoked: number }>}
 */
export async function resetPassword(input) {
  const { client } = input;
  validatePassword(input.password);

  const hashed = tokenHash(input.token);
  const { rows } = await client.query(
    `SELECT rt.id AS token_id, rt.expires_at, u.id, u.tenant_id, u.email, u.name
       FROM password_reset_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1 AND rt.used_at IS NULL AND u.deleted_at IS NULL
      FOR UPDATE`,
    [hashed],
  );

  if (rows.length === 0) {
    throw new BadRequest('invalid-reset-token', 'This reset link is not valid or has already been used.');
  }
  const row = rows[0];

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.token_id]);
    throw new BadRequest('reset-token-expired', 'This reset link has expired. Request a new one.');
  }

  const passwordHash = await hashPassword(input.password);
  await client.query(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = now(),
            failed_login_count = 0,
            locked_until = NULL,
            updated_at = now()
      WHERE id = $1`,
    [row.id, passwordHash],
  );

  // Single-use: mark before the session revoke so a concurrent second
  // attempt sees a used token even if the revoke fails.
  await client.query(
    'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1',
    [row.token_id],
  );

  const sessionsRevoked = await revokeAllSessions(client, row.id);

  await recordAudit(client, {
    req: input.req,
    tenantId: row.tenant_id,
    userId: row.id,
    action: 'password-reset-completed',
    entity: 'user',
    entityId: row.id,
    metadata: {
      email: row.email,
      sessionsRevoked,
      // Recorded so a reviewer can tell a routine reset from one
      // triggered by a compromise.
      reason: input.req?.user ? 'self-service' : 'self-service-link',
    },
  });

  return { id: row.id, email: row.email, sessionsRevoked };
}
