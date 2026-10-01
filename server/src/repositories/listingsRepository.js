// Listings repository — raw `pg` queries over the `listings` table.
//
// Every read is tenant-scoped at the SQL layer (`tenant_id = $1`) and
// RBAC-scoped via scopeFilterFor() before being ANDed in. The repo is
// intentionally tiny: list, count, and get-by-id. Mutations live in
// future routes.
//
// `pg` returns `numeric` columns as strings; the DTO parser converts
// them to numbers so the JSON body matches what the frontend demo
// (src/services/demoRepository.js) emits today.

import { randomBytes } from 'node:crypto';
import { query, tenantQuery, withTenant, transaction, DB_NOT_CONFIGURED, getDb } from '../db/client.js';
import { andFilters, scopeFilterFor } from '../rbac/scopeFilters.js';
import { BadRequest, NotFound } from '../utils/errors.js';
import {
  validateAddListingPhoto,
  validateAssignListing,
  validateCreateListing,
  validateUpdateListing,
  validateVerifyListing,
} from './listingValidation.js';
import { recordAudit } from '../audit/auditLog.js';

// re-export so callers don't need to know which file holds the validators
export {
  validateCreateListing,
  validateUpdateListing,
  validateAssignListing,
  validateVerifyListing,
  validateAddListingPhoto,
} from './listingValidation.js';

/**
 * @typedef {Object} ListFilters
 * @property {string=} serviceCategory
 * @property {string=} propertyType
 * @property {string=} listingIntent
 * @property {string=} availabilityStatus
 * @property {string=} verificationStatus
 * @property {string=} assignedUserId
 * @property {string=} city              — case-insensitive substring
 * @property {string=} search            — case-insensitive substring across title/description/address
 */

/**
 * @typedef {Object} Pagination
 * @property {number} limit
 * @property {number} offset
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const LISTING_COLUMNS = `
  l.id,
  l.tenant_id,
  l.service_category,
  l.property_type,
  l.listing_intent,
  l.title,
  l.description,
  l.address,
  l.city,
  l.locality,
  l.geo,
  l.price,
  l.rent_monthly,
  l.deposit,
  l.area_sqft,
  l.bedrooms,
  l.bathrooms,
  l.furnished,
  l.amenities,
  l.availability_status,
  l.verification_status,
  l.owner_contact_name,
  l.owner_contact_phone,
  l.owner_contact_email,
  l.assigned_to,
  l.team_id,
  l.project_id,
  l.notes,
  l.created_by,
  l.created_at,
  l.updated_at,
  l.deleted_at,
  u.id           AS assigned_user_id,
  u.name         AS assigned_user_name,
  u.email        AS assigned_user_email,
  p.id           AS project_pk,
  p.name         AS project_name,
  p.city         AS project_city,
  (
    SELECT COUNT(*)::int
      FROM listing_photos lp
     WHERE lp.tenant_id = l.tenant_id
       AND lp.listing_id = l.id
       AND lp.deleted_at IS NULL
  ) AS photo_count
`;

/**
 * Normalize one row from the joined query into a frontend-friendly DTO.
 * `pg` returns numeric columns as strings; we parse to numbers so the JSON
 * body matches what the demo repository emits.
 *
 * @param {Record<string, any>} row
 * @returns {object}
 */
export function toListingDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    serviceCategory: row.service_category,
    propertyType: row.property_type,
    listingIntent: row.listing_intent,
    title: row.title,
    description: row.description,
    location: {
      address: row.address,
      city: row.city,
      locality: row.locality,
      geo: row.geo,
    },
    pricing: {
      price:        toNumberOrNull(row.price),
      rentMonthly:  toNumberOrNull(row.rent_monthly),
      deposit:      toNumberOrNull(row.deposit),
      areaSqft:     toNumberOrNull(row.area_sqft),
    },
    specs: {
      bedrooms:   row.bedrooms,
      bathrooms:  row.bathrooms,
      furnished:  row.furnished,
      amenities:  row.amenities || [],
    },
    status: {
      availability: row.availability_status,
      verification: row.verification_status,
    },
    ownerContact: {
      name:  row.owner_contact_name,
      phone: row.owner_contact_phone,
      email: row.owner_contact_email,
    },
    assignedTo: row.assigned_user_id
      ? {
          id:    row.assigned_user_id,
          name:  row.assigned_user_name,
          email: row.assigned_user_email,
        }
      : null,
    // teamId is exposed so the route handlers can rebuild the row-level
    // record shape that `can(user, 'listings', action, record)` expects
    // (assignedTo + teamId + projectId). Without this the team/project
    // scope checks always see record.teamId == undefined and refuse every
    // row in those scopes — a manager with `team` scope would 404 against
    // their own team's listings.
    teamId: row.team_id ?? null,
    project: row.project_pk
      ? {
          id:   row.project_pk,
          name: row.project_name,
          city: row.project_city,
        }
      : null,
    photoCount: row.photo_count ?? 0,
    notes: row.notes,
    createdBy: row.created_by,
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
  // pg returns ISO strings already; normalise to ms for downstream parsers.
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

  if (filters.serviceCategory)    add('l.service_category = ?',    filters.serviceCategory);
  if (filters.propertyType)       add('l.property_type = ?',       filters.propertyType);
  if (filters.listingIntent)      add('l.listing_intent = ?',      filters.listingIntent);
  if (filters.availabilityStatus) add('l.availability_status = ?', filters.availabilityStatus);
  if (filters.verificationStatus) add('l.verification_status = ?', filters.verificationStatus);
  if (filters.assignedUserId)     add('l.assigned_to = ?',         filters.assignedUserId);

  if (filters.city && typeof filters.city === 'string' && filters.city.trim()) {
    add('l.city ILIKE ?', `%${filters.city.trim()}%`);
  }

  if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
    const needle = `%${filters.search.trim()}%`;
    // Three ILIKE clauses share one bound parameter; we push the value three
    // times and build a single $n, $n+1, $n+2 placeholder block manually.
    const baseIdx = params.length + 1;
    params.push(needle, needle, needle);
    clauses.push(
      `(l.title ILIKE $${baseIdx} OR l.description ILIKE $${baseIdx + 1} OR l.address ILIKE $${baseIdx + 2})`,
    );
  }

  const sql = clauses.length ? clauses.join(' AND ') : '1 = 1';
  return { sql, params };
}

/**
 * List listings for a user, RBAC-scoped, optionally filtered and paginated.
 *
 * @param {{ user: object, filters?: ListFilters, pagination?: Pagination }} args
 * @returns {Promise<{ items: object[], pagination: { limit: number, offset: number, total: number } }>}
 */
export async function listListings({ user, filters = {}, pagination = {} }) {
  const scope = scopeFilterFor(user, 'listings', 'view', { table: 'l' });
  const extra = buildListFilter(filters);
  const { sql, params } = andFilters([scope, extra]);

  // Pagination placeholders are appended last.
  const page = sanitisePagination(pagination);
  const limitPlaceholder  = `$${params.length + 1}`;
  const offsetPlaceholder = `$${params.length + 2}`;

  // The data SQL.
  const dataSql = `
    SELECT ${LISTING_COLUMNS}
      FROM listings l
      LEFT JOIN users u
        ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to AND u.deleted_at IS NULL
      LEFT JOIN projects p
        ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL
     WHERE l.deleted_at IS NULL
       AND ${sql}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
  `;

  // Count SQL — same WHERE without pagination, no joins needed.
  const countSql = `
    SELECT COUNT(*)::int AS total
      FROM listings l
     WHERE l.deleted_at IS NULL
       AND ${sql}
  `;

  try {
    // `tenantQuery`, not `query`: a policy reads app.tenant_id, and a
    // bare pool query has no transaction to set it in. Without this the
    // read returns zero rows and every write is rejected — which is RLS
    // working, but indistinguishable from an empty database.
    const [dataResult, countResult] = await Promise.all([
      tenantQuery(user, dataSql, [...params, page.limit, page.offset]),
      tenantQuery(user, countSql, params),
    ]);
    return {
      items: dataResult.rows.map(toListingDTO),
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
 * Fetch one listing by id, tenant-scoped. The caller is responsible
 * for the row-level RBAC check (can(user, 'listings', 'view', dto)).
 *
 * Returns null when the row does not exist OR is soft-deleted OR
 * lives in a different tenant — never leak existence.
 *
 * @param {{ user: { tenantId: string }, listingId: string }} args
 * @returns {Promise<object|null>}
 */
export async function getListingById({ user, listingId }) {
  return getListingByIdOnClient(null, { user, listingId });
}

/**
 * Variant of getListingById that uses an explicit `pg` client (so it sees
 * the same transaction's uncommitted writes). When `client` is null,
 * falls back to the shared pool.
 */
async function getListingByIdOnClient(client, { user, listingId }) {
  if (!user || !user.tenantId) return null;
  if (!listingId) return null;

  const sql = `
    SELECT ${LISTING_COLUMNS}
      FROM listings l
      LEFT JOIN users u
        ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to AND u.deleted_at IS NULL
      LEFT JOIN projects p
        ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL
     WHERE l.tenant_id = $1
       AND l.id = $2
       AND l.deleted_at IS NULL
  `;

  try {
    // Inside an existing transaction the caller has already set the
    // context (or is the pre-auth path); on the pool, wrap it.
    const result = client
      ? await client.query(sql, [user.tenantId, listingId])
      : await tenantQuery(user, sql, [user.tenantId, listingId]);
    return result.rows[0] ? toListingDTO(result.rows[0]) : null;
  } catch (err) {
    if (err && err.code === DB_NOT_CONFIGURED) throw err;
    throw err;
  }
}

export { DB_NOT_CONFIGURED };

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable, URL-safe listing ID. Mirrors the `l_<ulid>` style
 * of the seeded fixtures but is fully random — ULID is overkill for the
 * scaffold.
 */
function newListingId() {
  return `l_${randomBytes(10).toString('hex')}`;
}

function newPhotoId() {
  return `lp_${randomBytes(10).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Foreign-key sanity checks
// ---------------------------------------------------------------------------

/**
 * Validate that `userId` exists, is in the given tenant, and is Active.
 * Used by create + assign to refuse cross-tenant or inactive targets.
 * Throws BadRequest on failure; returns the trimmed user row otherwise.
 */
async function assertActiveUserInTenant(client, tenantId, userId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, status, role_id
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

async function assertTeamInTenant(client, tenantId, teamId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id
       FROM teams
      WHERE id = $1`,
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
 * Create a listing under req.user.tenantId.
 *
 * Inputs are already validated by `validateCreateListing` at the route
 * layer. The repo assigns:
 *   * `id`           — generated
 *   * `tenant_id`    — from req.user.tenantId
 *   * `created_by`   — from req.user.id
 *   * `assigned_to`  — from input.assignedUserId or req.user.id (the route
 *                      must decide whether the caller is allowed to assign
 *                      to someone else; this function always trusts the
 *                      explicit value)
 *   * `team_id`      — from input.teamId or req.user.teamId
 *   * `availability_status` / `verification_status` — defaults from input
 *                      or column defaults
 *
 * Audit event: created-listing.
 *
 * @param {{ user: object, input: object, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>} — the created listing DTO
 */
export async function createListing({ user, input, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }

  // Resolve FKs first so the partial index / fk violations are caught
  // before we issue the INSERT.
  const tenantId = user.tenantId;

  // assignedUserId defaults to the caller. The route has already checked
  // whether the caller is allowed to assign to someone else; we trust the
  // input here.
  const assignedTo = input.assignedUserId ?? user.id;

  // teamId defaults to the caller's team when not supplied.
  const teamId = input.teamId ?? user.teamId ?? null;

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    await assertActiveUserInTenant(client, tenantId, assignedTo);
    if (input.projectId) await assertProjectInTenant(client, tenantId, input.projectId);
    if (teamId)          await assertTeamInTenant(client, tenantId, teamId);

    const id = newListingId();

    const insertSql = `
      INSERT INTO listings (
        id, tenant_id,
        service_category, property_type, listing_intent,
        title, description, address, city, locality,
        geo,
        price, rent_monthly, deposit, area_sqft,
        bedrooms, bathrooms, furnished, amenities,
        availability_status, verification_status,
        owner_contact_name, owner_contact_phone, owner_contact_email,
        assigned_to, team_id, project_id,
        notes, created_by
      ) VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19::jsonb,
        COALESCE($20, 'available'),
        COALESCE($21, 'unverified'),
        $22, $23, $24,
        $25, $26, $27,
        $28, $29
      )
      RETURNING id
    `;

    const params = [
      id, tenantId,
      input.serviceCategory, input.propertyType, input.listingIntent,
      input.title, input.description ?? null, input.address ?? null,
      input.city ?? null, input.locality ?? null,
      input.geo ? JSON.stringify(input.geo) : null,
      input.price ?? null, input.rentMonthly ?? null,
      input.deposit ?? null, input.areaSqft ?? null,
      input.bedrooms ?? null, input.bathrooms ?? null,
      input.furnished ?? null,
      JSON.stringify(input.amenities ?? []),
      input.availabilityStatus ?? null,
      input.verificationStatus ?? null,
      input.ownerContactName ?? null,
      input.ownerContactPhone ?? null,
      input.ownerContactEmail ?? null,
      assignedTo, teamId, input.projectId ?? null,
      input.notes ?? null, user.id,
    ];

    const inserted = await client.query(insertSql, params);
    if (inserted.rowCount !== 1) {
      throw new BadRequest('insert-failed', 'Listing insert returned no row.');
    }

    // Write the audit event inside the same transaction so an audit
    // failure rolls back the insert.
    if (req) {
      await recordAudit(client, { req, action: 'created-listing', entity: 'listing', entityId: id, metadata: {
        serviceCategory: input.serviceCategory,
        propertyType: input.propertyType,
        listingIntent: input.listingIntent,
        ownerContactName: input.ownerContactName ?? null,
        assignedTo,
        geo: input.geo ?? null,
        permissionPath: 'listings.create',
        scope: 'own-or-team-or-all',
      } });
    }

    return getListingByIdOnClient(client, { user, listingId: id });
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update a listing. Inputs are already validated by
 * `validateUpdateListing`. The repo refuses changes to id / tenantId /
 * createdBy / createdAt / deletedAt; the validator surfaces these as 400s.
 *
 * Audit event: updated-listing (with a diff of changed keys + before/after).
 *
 * Returns the updated DTO; throws NotFound when the row does not exist
 * (or is soft-deleted) in the caller's tenant.
 *
 * @param {{ user: object, listingId: string, changes: object, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function updateListing({ user, listingId, changes, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!listingId) throw new BadRequest('invalid-id', 'listingId is required.');

  // Validate FKs that the caller wants to set. (When a change is not
  // present, leave the existing value untouched.)
  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadListingRow(client, user.tenantId, listingId);
    if (!before) {
      throw new NotFound('not-found', 'Listing not found.');
    }

    if (changes.assignedUserId !== undefined) {
      await assertActiveUserInTenant(client, user.tenantId, changes.assignedUserId);
    }
    if (changes.projectId !== undefined && changes.projectId !== null) {
      await assertProjectInTenant(client, user.tenantId, changes.projectId);
    }
    if (changes.teamId !== undefined && changes.teamId !== null) {
      await assertTeamInTenant(client, user.tenantId, changes.teamId);
    }

    // Build the SET clause dynamically. column → camelCase key map.
    const SET_MAP = [
      ['service_category',     'serviceCategory'],
      ['property_type',        'propertyType'],
      ['listing_intent',       'listingIntent'],
      ['title',                'title'],
      ['description',          'description'],
      ['address',              'address'],
      ['city',                 'city'],
      ['locality',             'locality'],
      ['geo',                  'geo'],
      ['price',                'price'],
      ['rent_monthly',         'rentMonthly'],
      ['deposit',              'deposit'],
      ['area_sqft',            'areaSqft'],
      ['bedrooms',             'bedrooms'],
      ['bathrooms',            'bathrooms'],
      ['furnished',            'furnished'],
      ['amenities',            'amenities'],
      ['availability_status',  'availabilityStatus'],
      ['verification_status',  'verificationStatus'],
      ['owner_contact_name',   'ownerContactName'],
      ['owner_contact_phone',  'ownerContactPhone'],
      ['owner_contact_email',  'ownerContactEmail'],
      ['assigned_to',          'assignedUserId'],
      ['team_id',              'teamId'],
      ['project_id',           'projectId'],
      ['notes',                'notes'],
    ];

    const sets = [];
    const params = [];
    const changedKeys = [];
    for (const [col, key] of SET_MAP) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      const val = changes[key];
      changedKeys.push(key);
      if (col === 'geo') {
        params.push(val === null ? null : JSON.stringify(val));
        sets.push(`${col} = $${params.length}::jsonb`);
      } else if (col === 'amenities') {
        params.push(JSON.stringify(val ?? []));
        sets.push(`${col} = $${params.length}::jsonb`);
      } else {
        params.push(val === undefined ? null : val);
        sets.push(`${col} = $${params.length}`);
      }
    }

    if (sets.length === 0) {
      // No-op patch — still return the current DTO so the caller can
      // chain PATCH safely.
      return getListingByIdOnClient(client, { user, listingId });
    }

    // updated_at bump.
    sets.push(`updated_at = now()`);

    const tenantParam = params.length + 1;
    const idParam = params.length + 2;
    params.push(user.tenantId, listingId);

    const sql = `
      UPDATE listings
         SET ${sets.join(', ')}
       WHERE tenant_id = $${tenantParam}
         AND id = $${idParam}
         AND deleted_at IS NULL
    `;
    const result = await client.query(sql, params);
    if (result.rowCount !== 1) {
      // Row was deleted between load + update — treat as not-found.
      throw new NotFound('not-found', 'Listing not found.');
    }

    if (req) {
      const diff = {};
      for (const key of changedKeys) {
        diff[key] = { before: before[key], after: changes[key] };
      }
      await recordAudit(client, { req, action: 'updated-listing', entity: 'listing', entityId: listingId, metadata: {
        changedKeys,
        diff,
        permissionPath: 'listings.edit',
      } });
    }

    return getListingByIdOnClient(client, { user, listingId });
  });
}

/**
 * Load a raw listing row by id (tenant-scoped, soft-delete-aware).
 * Returns the row (camelCased) or null. Used by update / assign / verify
 * inside a transaction so we have a `before` snapshot for the audit diff.
 */
async function loadListingRow(client, tenantId, listingId) {
  const { rows } = await client.query(
    `SELECT * FROM listings WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, listingId],
  );
  if (rows.length === 0) return null;
  return rowToListingRow(rows[0]);
}

function rowToListingRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    serviceCategory: row.service_category,
    propertyType: row.property_type,
    listingIntent: row.listing_intent,
    title: row.title,
    description: row.description,
    address: row.address,
    city: row.city,
    locality: row.locality,
    geo: row.geo,
    price: row.price,
    rentMonthly: row.rent_monthly,
    deposit: row.deposit,
    areaSqft: row.area_sqft,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    furnished: row.furnished,
    amenities: row.amenities,
    availabilityStatus: row.availability_status,
    verificationStatus: row.verification_status,
    ownerContactName: row.owner_contact_name,
    ownerContactPhone: row.owner_contact_phone,
    ownerContactEmail: row.owner_contact_email,
    assignedTo: row.assigned_to,
    teamId: row.team_id,
    projectId: row.project_id,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

/**
 * Reassign a listing to a new field executive.
 *
 * Inputs are already validated by `validateAssignListing`. Validates the
 * target user is in the same tenant + active.
 *
 * Audit event: assigned-listing with fromUserId / toUserId / reason.
 *
 * @param {{ user: object, listingId: string, assignedUserId: string, reason?: string|null, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function assignListing({ user, listingId, assignedUserId, reason, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!listingId) throw new BadRequest('invalid-id', 'listingId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadListingRow(client, user.tenantId, listingId);
    if (!before) throw new NotFound('not-found', 'Listing not found.');

    await assertActiveUserInTenant(client, user.tenantId, assignedUserId);

    await client.query(
      `UPDATE listings
          SET assigned_to = $1,
              updated_at  = now()
        WHERE tenant_id = $2
          AND id = $3
          AND deleted_at IS NULL`,
      [assignedUserId, user.tenantId, listingId],
    );

    if (req) {
      await recordAudit(client, { req, action: 'assigned-listing', entity: 'listing', entityId: listingId, metadata: {
        fromUserId: before.assignedTo,
        toUserId: assignedUserId,
        reason: reason ?? null,
        permissionPath: 'listings.assign',
      } });
    }

    return getListingByIdOnClient(client, { user, listingId });
  });
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Update the verification status of a listing. Accepts `pending | verified | rejected`.
 * Reason is required when status='rejected' (enforced by the validator).
 *
 * Audit event: verified-listing (status=verified) or rejected-listing
 * (status=rejected). For 'pending' we use `verification-requested-listing`.
 *
 * @param {{ user: object, listingId: string, status: string, reason?: string|null, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function verifyListing({ user, listingId, status, reason, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!listingId) throw new BadRequest('invalid-id', 'listingId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadListingRow(client, user.tenantId, listingId);
    if (!before) throw new NotFound('not-found', 'Listing not found.');

    await client.query(
      `UPDATE listings
          SET verification_status = $1,
              updated_at           = now()
        WHERE tenant_id = $2
          AND id = $3
          AND deleted_at IS NULL`,
      [status, user.tenantId, listingId],
    );

    if (req) {
      const verb =
        status === 'verified' ? 'verified-listing' :
        status === 'rejected' ? 'rejected-listing' :
        'verification-requested-listing';

      await recordAudit(client, {
        req,
        action: verb,
        entity: 'listing',
        entityId: listingId,
        metadata: {
          fromStatus: before.verificationStatus,
          toStatus: status,
          reason: reason ?? null,
          permissionPath: 'listings.approve',
        },
      });
    }

    return getListingByIdOnClient(client, { user, listingId });
  });
}

// ---------------------------------------------------------------------------
// Photo metadata
// ---------------------------------------------------------------------------

/**
 * Add a listing-photo row (metadata only — no upload pipeline yet).
 * The route must have already loaded the listing under tenant scope.
 *
 * Audit event: uploaded-listing-photo.
 *
 * @param {{ user: object, listingId: string, input: { objectKey: string, caption?: string|null, category?: string|null, publicUrl?: string|null, thumbnailUrl?: string|null }, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<object>}
 */
export async function addListingPhoto({ user, listingId, input, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!listingId) throw new BadRequest('invalid-id', 'listingId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    // Confirm the listing is in scope + not deleted.
    const { rows } = await client.query(
      `SELECT id FROM listings
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [user.tenantId, listingId],
    );
    if (rows.length === 0) {
      throw new NotFound('not-found', 'Listing not found.');
    }

    const id = newPhotoId();

    await client.query(
      `INSERT INTO listing_photos (
         id, tenant_id, listing_id, staff_id,
         object_key, public_url, thumbnail_url,
         caption, category, approved, uploaded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, COALESCE($9, 'Other'), false, now()
       )`,
      [
        id, user.tenantId, listingId, user.id,
        input.objectKey, input.publicUrl ?? null, input.thumbnailUrl ?? null,
        input.caption ?? null, input.category ?? null,
      ],
    );

    if (req) {
      await recordAudit(client, { req, action: 'uploaded-listing-photo', entity: 'listing_photo', entityId: id, metadata: {
        listingId,
        category: input.category ?? 'Other',
        caption: input.caption ?? null,
        approved: false,
        permissionPath: 'listings.edit',
      } });
    }

    // Return the new photo row (read with a fresh query so DTO shape
    // matches what GET /api/v1/listings/:id photos would expose).
    const { rows: photoRows } = await client.query(
      `SELECT id, tenant_id, listing_id, staff_id,
              object_key, public_url, thumbnail_url,
              caption, category, approved, approved_by,
              uploaded_at, processed_at
         FROM listing_photos
        WHERE tenant_id = $1 AND id = $2`,
      [user.tenantId, id],
    );
    return toListingPhotoDTO(photoRows[0]);
  });
}

function toListingPhotoDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    listingId: row.listing_id,
    staffId: row.staff_id,
    objectKey: row.object_key,
    publicUrl: row.public_url,
    thumbnailUrl: row.thumbnail_url,
    caption: row.caption,
    category: row.category,
    approved: row.approved,
    approvedBy: row.approved_by,
    uploadedAt: row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : row.uploaded_at,
    processedAt: row.processed_at instanceof Date ? row.processed_at.toISOString() : row.processed_at,
  };
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

/**
 * Soft-delete a listing. Sets `deleted_at = now()`. Returns { ok: true }.
 *
 * Audit event: deleted-listing.
 *
 * @param {{ user: object, listingId: string, req?: import('fastify').FastifyRequest }} args
 * @returns {Promise<{ ok: true, listingId: string, deletedAt: string }>}
 */
export async function softDeleteListing({ user, listingId, req }) {
  if (!user || !user.tenantId) {
    throw new BadRequest('invalid-user', 'Authenticated user with tenantId required.');
  }
  if (!listingId) throw new BadRequest('invalid-id', 'listingId is required.');

  return withTenant({ tenantId: user.tenantId }, async (client) => {
    const before = await loadListingRow(client, user.tenantId, listingId);
    if (!before) throw new NotFound('not-found', 'Listing not found.');

    const { rows } = await client.query(
      `UPDATE listings
          SET deleted_at = now(),
              updated_at = now()
        WHERE tenant_id = $1
          AND id = $2
          AND deleted_at IS NULL
        RETURNING deleted_at`,
      [user.tenantId, listingId],
    );
    if (rows.length === 0) {
      throw new NotFound('not-found', 'Listing not found.');
    }

    const deletedAt = rows[0].deleted_at instanceof Date
      ? rows[0].deleted_at.toISOString()
      : rows[0].deleted_at;

    if (req) {
      await recordAudit(client, { req, action: 'deleted-listing', entity: 'listing', entityId: listingId, metadata: {
        deletedAt,
        before: { verificationStatus: before.verificationStatus },
        permissionPath: 'listings.delete',
      } });
    }

    return { ok: true, listingId, deletedAt };
  });
}
