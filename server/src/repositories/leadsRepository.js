// Leads repository — raw `pg` queries over the `leads` table.
//
// Mirrors listingsRepository exactly:
//   * Every read is tenant-scoped at the SQL layer (`tenant_id = $1`) and
//     RBAC-scoped via scopeFilterFor() before being ANDed in.
//   * Mutations run in withTenant + recordAudit inside one transaction,
//     so a failure on either side rolls back the other.
//   * FK checks (assignee user, team, project) live here, not in the
//     pure validator. The validator only checks shape and types.
//
// `pg` returns `numeric` columns as strings; the DTO parser coerces
// them where the frontend expects numbers. Date / timestamp columns
// come back as Date objects, which the DTO normalises to ISO strings.

import { randomBytes } from 'node:crypto';
import {
  query,
  tenantQuery,
  withTenant,
  transaction,
  DB_NOT_CONFIGURED,
} from '../db/client.js';
import { andFilters, scopeFilterFor } from '../rbac/scopeFilters.js';
import { BadRequest, NotFound } from '../utils/errors.js';
import {
  validateAssignLead,
  validateCreateLead,
  validateUpdateLead,
} from './leadValidation.js';
import { recordAudit } from '../audit/auditLog.js';

// re-export so callers don't need to know which file holds the validators
export {
  validateCreateLead,
  validateUpdateLead,
  validateAssignLead,
} from './leadValidation.js';

/**
 * @typedef {Object} ListFilters
 * @property {string=} status
 * @property {string=} score
 * @property {string=} projectId
 * @property {string=} ownerId
 * @property {string=} serviceNeed
 * @property {string=} clientType
 * @property {string=} q              — case-insensitive substring across name/phone/email
 */

/**
 * @typedef {Object} Pagination
 * @property {number} limit
 * @property {number} offset
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const LEAD_COLUMNS = `
  l.id,
  l.tenant_id,
  l.name,
  l.phone,
  l.email,
  l.project_id,
  l.status,
  l.score,
  l.budget_min,
  l.budget_max,
  l.source,
  l.notes,
  l.owner_id,
  l.team_id,
  l.created_by,
  l.next_follow_up,
  l.created_at,
  l.updated_at,
  l.deleted_at,
  l.service_need,
  l.client_type,
  l.requirements,
  l.rent_min,
  l.rent_max,
  l.preferred_location,
  l.desired_property_type,
  l.move_in_date,
  l.purchase_timeline,
  l.matched_listing_ids,
  l.visit_status,
  u.id           AS owner_user_id,
  u.name         AS owner_user_name,
  u.email        AS owner_user_email,
  t.id           AS team_pk,
  t.name         AS team_name,
  p.id           AS project_pk,
  p.name         AS project_name
`;

/**
 * Normalize one row from the joined query into a frontend-friendly DTO.
 *
 * @param {Record<string, any>} row
 * @returns {object|null}
 */
export function toLeadDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    projectId: row.project_id,
    status: row.status,
    score: row.score,
    pricing: {
      budgetMin: toNumberOrNull(row.budget_min),
      budgetMax: toNumberOrNull(row.budget_max),
      rentMin:   toNumberOrNull(row.rent_min),
      rentMax:   toNumberOrNull(row.rent_max),
    },
    source: row.source,
    notes: row.notes,
    owner: row.owner_user_id
      ? {
          id: row.owner_user_id,
          name: row.owner_user_name,
          email: row.owner_user_email,
        }
      : null,
    team: row.team_pk
      ? { id: row.team_pk, name: row.team_name }
      : null,
    teamId: row.team_id ?? null,
    project: row.project_pk
      ? { id: row.project_pk, name: row.project_name }
      : null,
    createdBy: row.created_by,
    nextFollowUp: toIso(row.next_follow_up),
    serviceNeed: row.service_need,
    clientType: row.client_type,
    requirements: row.requirements || {},
    preferredLocation: row.preferred_location,
    desiredPropertyType: row.desired_property_type,
    moveInDate: toIsoDate(row.move_in_date),
    purchaseTimeline: row.purchase_timeline,
    // Always [] on read — the field is not writable until the matching
    // workflow lands. The DTO shape mirrors the frontend so the column
    // is never undefined, which keeps the consumer's render code simple.
    matchedListingIds: [],
    visitStatus: row.visit_status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // pg returns 'YYYY-MM-DD' for `date` columns; accept that directly.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return v.slice(0, 10);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Sanitise pagination input.
 *
 * @param {{limit?: unknown, offset?: unknown}=} input
 * @returns {Pagination}
 */
export function sanitisePagination(input = {}) {
  const limitRaw = Number.parseInt(input.limit, 10);
  const offsetRaw = Number.parseInt(input.offset, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  return { limit, offset };
}

/**
 * Build the WHERE clause + params for the supported filters. Returns
 * { sql, params } where sql references $1..$n in order. The caller is
 * responsible for ANDing this with the scope filter (already $1-bound)
 * and for picking the placeholder numbering.
 *
 * @param {ListFilters=} filters
 * @returns {{ sql: string, params: unknown[] }}
 */
export function buildListFilter(filters = {}) {
  const clauses = [];
  const params = [];

  function add(clause, value) {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  }

  if (filters.status)      add('l.status = ?',      filters.status);
  if (filters.score)       add('l.score = ?',       filters.score);
  if (filters.projectId)   add('l.project_id = ?',  filters.projectId);
  if (filters.ownerId)     add('l.owner_id = ?',    filters.ownerId);
  if (filters.serviceNeed) add('l.service_need = ?', filters.serviceNeed);
  if (filters.clientType)  add('l.client_type = ?', filters.clientType);

  if (filters.q && typeof filters.q === 'string' && filters.q.trim()) {
    const needle = `%${filters.q.trim()}%`;
    const baseIdx = params.length + 1;
    params.push(needle, needle, needle);
    clauses.push(
      `(l.name ILIKE $${baseIdx} OR l.phone ILIKE $${baseIdx + 1} OR COALESCE(l.email, '') ILIKE $${baseIdx + 2})`,
    );
  }

  const sql = clauses.length ? clauses.join(' AND ') : '1 = 1';
  return { sql, params };
}

/**
 * List leads for a user, RBAC-scoped, optionally filtered and paginated.
 *
 * @param {{ user: object, filters?: ListFilters, pagination?: Pagination }} args
 * @returns {Promise<{ items: object[], pagination: { limit: number, offset: number, total: number } }>}
 */
export async function listLeads({ user, filters = {}, pagination = {} }) {
  const scope = scopeFilterFor(user, 'leads', 'view', { table: 'l' });
  const extra = buildListFilter(filters);
  const { sql, params } = andFilters([scope, extra]);

  const page = sanitisePagination(pagination);
  const limitPlaceholder  = `$${params.length + 1}`;
  const offsetPlaceholder = `$${params.length + 2}`;

  const dataSql = `
    SELECT ${LEAD_COLUMNS}
      FROM leads l
      LEFT JOIN users u
        ON u.tenant_id = l.tenant_id AND u.id = l.owner_id AND u.deleted_at IS NULL
      LEFT JOIN teams t
        ON t.tenant_id = l.tenant_id AND t.id = l.team_id AND t.deleted_at IS NULL
      LEFT JOIN projects p
        ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL
     WHERE l.deleted_at IS NULL
       AND ${sql}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
      FROM leads l
     WHERE l.deleted_at IS NULL
       AND ${sql}
  `;

  try {
    const [dataResult, countResult] = await Promise.all([
      tenantQuery(user, dataSql, [...params, page.limit, page.offset]),
      tenantQuery(user, countSql, params),
    ]);
    return {
      items: dataResult.rows.map(toLeadDTO),
      pagination: {
        limit: page.limit,
        offset: page.offset,
        total: countResult.rows[0]?.total ?? 0,
      },
    };
  } catch (err) {
    if (err && err.code === DB_NOT_CONFIGURED) throw err;
    throw err;
  }
}

/**
 * Fetch one lead by id, tenant-scoped. The caller is responsible
 * for the row-level RBAC check (can(user, 'leads', 'view', dto)).
 *
 * Returns null when the row does not exist OR is soft-deleted OR
 * lives in a different tenant — never leak existence.
 *
 * @param {{ user: { tenantId: string }, leadId: string }} args
 * @returns {Promise<object|null>}
 */
export async function getLeadById({ user, leadId }) {
  return getLeadByIdOnClient(null, { user, leadId });
}

/**
 * Variant of getLeadById that uses an explicit `pg` client (so it sees
 * the same transaction's uncommitted writes). When `client` is null,
 * falls back to the shared pool.
 */
async function getLeadByIdOnClient(client, { user, leadId }) {
  if (!user || !user.tenantId) return null;
  if (!leadId) return null;

  const sql = `
    SELECT ${LEAD_COLUMNS}
      FROM leads l
      LEFT JOIN users u
        ON u.tenant_id = l.tenant_id AND u.id = l.owner_id AND u.deleted_at IS NULL
      LEFT JOIN teams t
        ON t.tenant_id = l.tenant_id AND t.id = l.team_id AND t.deleted_at IS NULL
      LEFT JOIN projects p
        ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL
     WHERE l.tenant_id = $1
       AND l.id = $2
       AND l.deleted_at IS NULL
  `;

  try {
    const result = client
      ? await client.query(sql, [user.tenantId, leadId])
      : await tenantQuery(user, sql, [user.tenantId, leadId]);
    return result.rows[0] ? toLeadDTO(result.rows[0]) : null;
  } catch (err) {
    if (err && err.code === DB_NOT_CONFIGURED) throw err;
    throw err;
  }
}

export { DB_NOT_CONFIGURED };

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

function newLeadId() {
  return `ld_${randomBytes(10).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Foreign-key sanity checks
// ---------------------------------------------------------------------------

/**
 * Validate that `userId` exists, is in the given tenant, and is Active.
 * Throws NotFound / BadRequest on failure; returns the trimmed user row otherwise.
 */
async function assertActiveUserInTenant(client, tenantId, userId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, status
       FROM users
      WHERE id = $1
        AND deleted_at IS NULL`,
    [userId],
  );
  if (rows.length === 0) {
    throw new NotFound('user-not-found', `User "${userId}" does not exist.`);
  }
  const u = rows[0];
  if (u.tenant_id !== tenantId) {
    throw new NotFound('user-not-found', `User "${userId}" is not in this tenant.`);
  }
  if (u.status !== 'Active') {
    throw new BadRequest('user-inactive', `User "${userId}" is not Active (status=${u.status}).`);
  }
  return u;
}

async function assertTeamInTenant(client, tenantId, teamId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id
       FROM teams
      WHERE id = $1
        AND deleted_at IS NULL`,
    [teamId],
  );
  if (rows.length === 0) {
    throw new NotFound('team-not-found', `Team "${teamId}" does not exist.`);
  }
  if (rows[0].tenant_id !== tenantId) {
    throw new NotFound('team-not-found', `Team "${teamId}" is not in this tenant.`);
  }
}

async function assertProjectInTenant(client, tenantId, projectId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id
       FROM projects
      WHERE id = $1
        AND deleted_at IS NULL`,
    [projectId],
  );
  if (rows.length === 0) {
    throw new NotFound('project-not-found', `Project "${projectId}" does not exist.`);
  }
  if (rows[0].tenant_id !== tenantId) {
    throw new NotFound('project-not-found', `Project "${projectId}" is not in this tenant.`);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a lead under req.user.tenantId.
 *
 * Inputs are already validated by `validateCreateLead` at the route
 * layer. The repo assigns:
 *   * `id`           — generated
 *   * `tenant_id`    — from req.user.tenantId
 *   * `created_by`   — from req.user.id
 *   * `owner_id`     — from input.ownerId or req.user.id (the route
 *                      must decide whether the caller is allowed to
 *                      assign to someone else; this function trusts the
 *                      explicit value)
 *   * `team_id`      — from input.teamId or req.user.teamId
 *
 * Audit event: created-lead.
 *
 * @param {{ user: object, input: object, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function createLead({ user, input, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }

  const tenantId = user.tenantId;
  const ownerId = input.ownerId ?? user.id;
  const teamId = input.teamId ?? user.teamId ?? null;

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    await assertActiveUserInTenant(client, tenantId, ownerId);
    if (input.projectId) await assertProjectInTenant(client, tenantId, input.projectId);
    if (teamId)          await assertTeamInTenant(client, tenantId, teamId);

    const id = newLeadId();

    const insertSql = `
      INSERT INTO leads (
        id, tenant_id,
        name, phone, email,
        project_id,
        status, score, budget_min, budget_max,
        source, notes,
        owner_id, team_id, created_by,
        next_follow_up,
        service_need, client_type, requirements,
        rent_min, rent_max,
        preferred_location, desired_property_type,
        move_in_date, purchase_timeline,
        matched_listing_ids, visit_status
      ) VALUES (
        $1, $2,
        $3, $4, $5,
        $6,
        COALESCE($7, 'New'), $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        $16,
        $17, $18, COALESCE($19::jsonb, '{}'::jsonb),
        $20, $21,
        $22, $23,
        $24, $25,
        COALESCE($26::jsonb, '[]'::jsonb), $27
      )
      RETURNING id
    `;

    const params = [
      id, tenantId,
      input.name, input.phone, input.email ?? null,
      input.projectId ?? null,
      input.status ?? null, input.score ?? null,
      input.budgetMin ?? null, input.budgetMax ?? null,
      input.source ?? null, input.notes ?? null,
      ownerId, teamId, user.id,
      input.nextFollowUp ?? null,
      input.serviceNeed ?? null, input.clientType ?? null,
      input.requirements ? JSON.stringify(input.requirements) : null,
      input.rentMin ?? null, input.rentMax ?? null,
      input.preferredLocation ?? null, input.desiredPropertyType ?? null,
      input.moveInDate ?? null, input.purchaseTimeline ?? null,
      // matched_listing_ids — always '[]' on insert; the column is not
      // writable until the matching workflow lands.
      '[]',
      input.visitStatus ?? null,
    ];

    const inserted = await client.query(insertSql, params);
    if (inserted.rowCount !== 1) {
      throw new BadRequest('insert-failed', 'Lead insert returned no row.');
    }

    if (req) {
      await recordAudit(client, {
        req,
        action: 'created-lead',
        entity: 'lead',
        entityId: id,
        metadata: {
          serviceNeed: input.serviceNeed ?? null,
          clientType: input.clientType ?? null,
          ownerId,
          projectId: input.projectId ?? null,
          permissionPath: 'leads.create',
        },
      });
    }

    return getLeadByIdOnClient(client, { user, leadId: id });
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update a lead. Inputs are already validated by `validateUpdateLead`.
 * The repo refuses changes to id / tenantId / createdBy / createdAt /
 * deletedAt (the validator surfaces these as 400s).
 *
 * ownerId / teamId are STRIPPED from the update body before reaching
 * this function: they are only mutable via assignLead. That keeps the
 * "who owns this lead" decision in one audited path.
 *
 * Audit event: updated-lead (with a diff of changed keys + before/after).
 *
 * @param {{ user: object, leadId: string, changes: object, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function updateLead({ user, leadId, changes, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!leadId) throw new BadRequest('invalid-id', 'leadId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadLeadRow(client, user.tenantId, leadId);
    if (!before) throw new NotFound('not-found', 'Lead not found.');

    // FK validation for any fields the caller is changing.
    if (changes.projectId !== undefined && changes.projectId !== null) {
      await assertProjectInTenant(client, user.tenantId, changes.projectId);
    }

    // Build the SET clause dynamically. column → camelCase key map.
    const SET_MAP = [
      ['name',                 'name'],
      ['phone',                'phone'],
      ['email',                'email'],
      ['project_id',           'projectId'],
      ['status',               'status'],
      ['score',                'score'],
      ['budget_min',           'budgetMin'],
      ['budget_max',           'budgetMax'],
      ['source',               'source'],
      ['notes',                'notes'],
      ['next_follow_up',       'nextFollowUp'],
      ['service_need',         'serviceNeed'],
      ['client_type',          'clientType'],
      ['requirements',         'requirements'],
      ['rent_min',             'rentMin'],
      ['rent_max',             'rentMax'],
      ['preferred_location',   'preferredLocation'],
      ['desired_property_type','desiredPropertyType'],
      ['move_in_date',         'moveInDate'],
      ['purchase_timeline',    'purchaseTimeline'],
      ['visit_status',         'visitStatus'],
    ];

    const sets = [];
    const params = [];
    const changedKeys = [];
    for (const [col, key] of SET_MAP) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      const val = changes[key];
      changedKeys.push(key);
      if (col === 'requirements') {
        params.push(val === null ? null : JSON.stringify(val));
        sets.push(`${col} = $${params.length}::jsonb`);
      } else if (col === 'move_in_date') {
        // We store the date as DATE; pg accepts 'YYYY-MM-DD' directly.
        params.push(val === null ? null : val);
        sets.push(`${col} = $${params.length}::date`);
      } else if (col === 'next_follow_up') {
        params.push(val === null ? null : new Date(val).toISOString());
        sets.push(`${col} = $${params.length}::timestamptz`);
      } else {
        params.push(val === undefined ? null : val);
        sets.push(`${col} = $${params.length}`);
      }
    }

    if (sets.length === 0) {
      // No-op patch — return current state so PATCH is idempotent.
      return getLeadByIdOnClient(client, { user, leadId });
    }

    sets.push(`updated_at = now()`);

    const tenantParam = params.length + 1;
    const idParam = params.length + 2;
    params.push(user.tenantId, leadId);

    const sql = `
      UPDATE leads
         SET ${sets.join(', ')}
       WHERE tenant_id = $${tenantParam}
         AND id = $${idParam}
         AND deleted_at IS NULL
    `;
    const result = await client.query(sql, params);
    if (result.rowCount !== 1) {
      throw new NotFound('not-found', 'Lead not found.');
    }

    if (req) {
      const diff = {};
      for (const key of changedKeys) {
        diff[key] = { before: before[key], after: changes[key] };
      }
      await recordAudit(client, {
        req,
        action: 'updated-lead',
        entity: 'lead',
        entityId: leadId,
        metadata: {
          changedKeys,
          diff,
          permissionPath: 'leads.edit',
        },
      });
    }

    return getLeadByIdOnClient(client, { user, leadId });
  });
}

/**
 * Load a raw lead row by id (tenant-scoped, soft-delete-aware).
 * Returns the row (camelCased) or null. Used by update / assign / delete
 * inside a transaction so we have a `before` snapshot for the audit diff.
 */
async function loadLeadRow(client, tenantId, leadId) {
  const { rows } = await client.query(
    `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, leadId],
  );
  if (rows.length === 0) return null;
  return rowToLeadRow(rows[0]);
}

function rowToLeadRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    projectId: row.project_id,
    status: row.status,
    score: row.score,
    budgetMin: row.budget_min,
    budgetMax: row.budget_max,
    source: row.source,
    notes: row.notes,
    ownerId: row.owner_id,
    teamId: row.team_id,
    createdBy: row.created_by,
    nextFollowUp: row.next_follow_up,
    serviceNeed: row.service_need,
    clientType: row.client_type,
    requirements: row.requirements,
    rentMin: row.rent_min,
    rentMax: row.rent_max,
    preferredLocation: row.preferred_location,
    desiredPropertyType: row.desired_property_type,
    moveInDate: row.move_in_date,
    purchaseTimeline: row.purchase_timeline,
    matchedListingIds: row.matched_listing_ids,
    visitStatus: row.visit_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

/**
 * Reassign a lead to a new owner.
 *
 * Inputs are already validated by `validateAssignLead`. The target user's
 * team becomes the new team_id, since ownership implies team-scoped
 * reporting.
 *
 * Audit event: assigned-lead with fromUserId / toUserId / reason.
 *
 * @param {{ user: object, leadId: string, assignedUserId: string, reason?: string|null, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function assignLead({ user, leadId, assignedUserId, reason, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!leadId) throw new BadRequest('invalid-id', 'leadId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadLeadRow(client, user.tenantId, leadId);
    if (!before) throw new NotFound('not-found', 'Lead not found.');

    const target = await assertActiveUserInTenant(client, user.tenantId, assignedUserId);

    // Ownership implies the new owner's team. A lead without a team
    // stays without one when the target has no team either.
    const newTeamId = target.team_id ?? null;

    await client.query(
      `UPDATE leads
          SET owner_id  = $1,
              team_id   = COALESCE($2, team_id),
              updated_at = now()
        WHERE tenant_id = $3
          AND id = $4
          AND deleted_at IS NULL`,
      [assignedUserId, newTeamId, user.tenantId, leadId],
    );

    if (req) {
      await recordAudit(client, {
        req,
        action: 'assigned-lead',
        entity: 'lead',
        entityId: leadId,
        metadata: {
          fromUserId: before.ownerId,
          toUserId: assignedUserId,
          fromTeamId: before.teamId,
          toTeamId: newTeamId,
          reason: reason ?? null,
          permissionPath: 'leads.assign',
        },
      });
    }

    return getLeadByIdOnClient(client, { user, leadId });
  });
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

/**
 * Soft-delete a lead. Sets `deleted_at = now()`. Returns { ok: true }.
 *
 * Audit event: deleted-lead.
 *
 * @param {{ user: object, leadId: string, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<{ ok: true, leadId: string, deletedAt: string }>}
 */
export async function softDeleteLead({ user, leadId, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!leadId) throw new BadRequest('invalid-id', 'leadId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadLeadRow(client, user.tenantId, leadId);
    if (!before) throw new NotFound('not-found', 'Lead not found.');

    const { rows } = await client.query(
      `UPDATE leads
          SET deleted_at = now(),
              updated_at = now()
        WHERE tenant_id = $1
          AND id = $2
          AND deleted_at IS NULL
        RETURNING deleted_at`,
      [user.tenantId, leadId],
    );
    if (rows.length === 0) {
      throw new NotFound('not-found', 'Lead not found.');
    }

    const deletedAt = rows[0].deleted_at instanceof Date
      ? rows[0].deleted_at.toISOString()
      : rows[0].deleted_at;

    if (req) {
      await recordAudit(client, {
        req,
        action: 'deleted-lead',
        entity: 'lead',
        entityId: leadId,
        metadata: {
          deletedAt,
          before: { status: before.status, ownerId: before.ownerId },
          permissionPath: 'leads.delete',
        },
      });
    }

    return { ok: true, leadId, deletedAt };
  });
}

// Re-export transaction for tests / advanced callers.
export { transaction, query };
