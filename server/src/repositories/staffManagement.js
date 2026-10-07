// Manual staff provisioning — admin creates a user with an initial password,
// and admin resets a user's password directly.
//
// This is the NO-EMAIL workflow: the admin types the initial password into
// the Staff screen and shares it with the staff member out of band. It is
// deliberately separate from the invite flow (`inviteUser` / `acceptInvite`
// in onboardingService.js), which creates an `Invited` user and emails a
// single-use link. The two flows share nothing except the `users` table.
//
// Security properties:
//   * The plaintext password exists only in the request body. It is hashed
//     with Argon2id (`hashPassword`) and never stored, never returned, and
//     never written to the audit row.
//   * The password policy (`validatePassword`) applies to both paths. A weak
//     password is a 400, and the message names the rule, not the input.
//   * A duplicate (tenant_id, email) is a 409, mapped from pg 23505 — the
//     schema's UNIQUE constraint is the arbiter, not a pre-check, so two
//     concurrent creates cannot both succeed.
//   * A reset revokes every session (`revokeAllSessions`) and clears the
//     lockout counters, so whoever held the old password loses access
//     immediately — the same posture as the self-service reset.
//   * Super-admin is protected: only a super-admin actor may create a
//     super-admin or reset one's password. Everyone else gets a 403, the
//     same rule the roles handler applies to system-role mutations.
//   * There is no `force_password_change` column in the schema, so this
//     flow cannot flag "must change on next login". That gap is documented
//     in docs/STAFF_DIRECTORY.md rather than fixed with a broad migration.
//
// Both functions are persistence-shaped: they take the caller's `client`
// so the route can run them inside `transaction()` alongside the audit row.
// Unit tests inject an in-memory stand-in (see staffManagement.test.js),
// the same pattern as onboardingService.test.js.

import { randomBytes } from 'node:crypto';
import { BadRequest, Conflict, Forbidden, NotFound } from '../utils/errors.js';
import { hashPassword, validatePassword } from '../auth/passwordPolicy.js';
import { recordAudit } from '../audit/auditLog.js';
import { revokeAllSessions } from './sessionRepository.js';
import { ROLE_DEFINITIONS } from '../rbac/permissions.js';

const KNOWN_ROLES = Object.freeze(Object.keys(ROLE_DEFINITIONS));
// `Invited` belongs to the email flow — a manually created account is
// usable immediately, so it starts Active (or Inactive/Suspended when the
// admin wants it held).
const CREATABLE_STATUSES = Object.freeze(['Active', 'Inactive', 'Suspended']);

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

function pickString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/**
 * Map a policy rejection to the documented 400. `validatePassword` throws
 * a plain Error naming the rule; the message is safe to surface because
 * it describes the requirement, never the submitted value.
 *
 * @param {Function} fn — () => void, the policy call
 */
function assertPasswordPolicy(password) {
  try {
    validatePassword(password);
  } catch (err) {
    throw new BadRequest('weak-password', err?.message ?? 'Password does not meet the policy.');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new BadRequest('invalid-payload', 'initialPassword is required.');
  }
}

/** Refuse unless the actor may touch a super-admin account. */
function assertSuperAdminAllowed(actor, roleId) {
  if (roleId === 'super-admin' && actor?.role !== 'super-admin') {
    throw new Forbidden(
      'super-admin-protected',
      'Only a super-admin may create or reset a super-admin account.',
      { roleId },
    );
  }
}

async function assertTeamInTenant(client, tenantId, teamId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id FROM teams WHERE id = $1 AND deleted_at IS NULL`,
    [teamId],
  );
  if (rows.length === 0) {
    throw new NotFound('team-not-found', `Team "${teamId}" does not exist.`);
  }
  if (rows[0].tenant_id !== tenantId) {
    throw new NotFound('team-not-found', `Team "${teamId}" is not in this tenant.`);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a sign-in-capable user with an admin-chosen initial password.
 *
 * @param {object} input
 * @param {import('pg').PoolClient} input.client — caller's transaction
 * @param {object} input.actor — req.user (id, tenantId, role)
 * @param {string} input.name
 * @param {string} input.email
 * @param {string} [input.phone]
 * @param {string} input.roleId — must be a known system role
 * @param {string} [input.teamId] — must exist in the actor's tenant
 * @param {string} [input.designation]
 * @param {string} [input.status] — Active (default), Inactive, Suspended
 * @param {string} input.initialPassword — hashed, never stored or returned
 * @param {object} [input.req] — Fastify request, for audit metadata
 * @returns {Promise<{ id: string, email: string, status: string }>}
 */
export async function createStaff(input) {
  const { client, actor } = input;
  const tenantId = actor?.tenantId;
  if (!tenantId) {
    throw new BadRequest('invalid-payload', 'The requesting user has no tenant.');
  }

  const name = pickString(input.name);
  if (!name) {
    throw new BadRequest('invalid-payload', 'name is required.');
  }
  const email = pickString(input.email)?.toLowerCase();
  if (!email || !email.includes('@')) {
    throw new BadRequest('invalid-payload', 'A valid email is required.');
  }
  const roleId = pickString(input.roleId);
  if (!roleId) {
    throw new BadRequest('invalid-payload', 'roleId is required.');
  }
  if (!KNOWN_ROLES.includes(roleId)) {
    throw new BadRequest(
      'invalid-enum',
      `roleId must be one of: ${KNOWN_ROLES.join(', ')}.`,
    );
  }
  assertSuperAdminAllowed(actor, roleId);

  const status = pickString(input.status) ?? 'Active';
  if (!CREATABLE_STATUSES.includes(status)) {
    throw new BadRequest(
      'invalid-enum',
      `status must be one of: ${CREATABLE_STATUSES.join(', ')}.`,
    );
  }

  const teamId = pickString(input.teamId);
  if (teamId) {
    await assertTeamInTenant(client, tenantId, teamId);
  }

  if (typeof input.initialPassword !== 'string' || input.initialPassword.length === 0) {
    throw new BadRequest('invalid-payload', 'initialPassword is required.');
  }
  assertPasswordPolicy(input.initialPassword);
  const passwordHash = await hashPassword(input.initialPassword);

  const id = newId('u');
  let created;
  try {
    const { rows } = await client.query(
      `INSERT INTO users (
          id, tenant_id, name, email, phone, role_id, team_id,
          designation, status, password_hash, password_changed_at,
          joined_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now(), now(), now())
       RETURNING id, email, status`,
      [
        id,
        tenantId,
        name,
        email,
        pickString(input.phone) ?? null,
        roleId,
        teamId ?? null,
        pickString(input.designation) ?? null,
        status,
        passwordHash,
      ],
    );
    created = rows[0];
  } catch (err) {
    // The UNIQUE (tenant_id, email) constraint is the arbiter — a
    // pre-check would race a concurrent create.
    if (err?.code === '23505') {
      throw new Conflict('duplicate-email', 'A user with this email already exists in this tenant.');
    }
    throw err;
  }

  await recordAudit(client, {
    req: input.req,
    tenantId,
    userId: actor?.id ?? null,
    action: 'created-user',
    entity: 'user',
    entityId: created.id,
    metadata: {
      email: created.email,
      roleId,
      teamId: teamId ?? null,
      status: created.status,
      method: 'manual',
      // The password — plaintext or hash — is never audited.
    },
  });

  return { id: created.id, email: created.email, status: created.status };
}

// ---------------------------------------------------------------------------
// Admin reset
// ---------------------------------------------------------------------------

/**
 * Set a new password on an existing user, as an administrator.
 *
 * Clears the lockout counters and revokes every session, so whoever held
 * the old password loses access immediately.
 *
 * @param {object} input
 * @param {import('pg').PoolClient} input.client — caller's transaction
 * @param {object} input.actor — req.user (id, tenantId, role)
 * @param {string} input.userId — the target user
 * @param {string} input.newPassword — hashed, never stored or returned
 * @param {object} [input.req] — Fastify request, for audit metadata
 * @returns {Promise<{ ok: true, userId: string, sessionsRevoked: number }>}
 */
export async function adminResetPassword(input) {
  const { client, actor } = input;
  const tenantId = actor?.tenantId;
  if (!tenantId) {
    throw new BadRequest('invalid-payload', 'The requesting user has no tenant.');
  }
  if (!input.userId) {
    throw new BadRequest('invalid-payload', 'userId is required.');
  }
  if (typeof input.newPassword !== 'string' || input.newPassword.length === 0) {
    throw new BadRequest('invalid-payload', 'newPassword is required.');
  }
  assertPasswordPolicy(input.newPassword);

  // Tenant-scoped lookup. A cross-tenant id is a 404, not a 403 — the
  // caller must not learn that the id exists elsewhere.
  const { rows } = await client.query(
    `SELECT id, tenant_id, email, role_id
       FROM users
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [input.userId, tenantId],
  );
  if (rows.length === 0) {
    throw new NotFound('not-found', 'User not found.');
  }
  const target = rows[0];
  assertSuperAdminAllowed(actor, target.role_id);

  const passwordHash = await hashPassword(input.newPassword);
  await client.query(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = now(),
            failed_login_count = 0,
            locked_until = NULL,
            updated_at = now()
      WHERE id = $1`,
    [target.id, passwordHash],
  );

  const sessionsRevoked = await revokeAllSessions(client, target.id);

  await recordAudit(client, {
    req: input.req,
    tenantId,
    userId: actor?.id ?? null,
    action: 'admin-password-reset',
    entity: 'user',
    entityId: target.id,
    metadata: {
      email: target.email,
      sessionsRevoked,
      // Recorded so a reviewer can tell an admin reset from a
      // self-service one; the password itself is never audited.
      reason: 'admin-reset',
    },
  });

  return { ok: true, userId: target.id, sessionsRevoked };
}
