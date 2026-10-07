// Lead ↔ listing saved matches — GET / POST / PATCH read model + writer.
//
// Backed by the `listing_matches` table (server/src/db/schema.sql):
//   id, tenant_id, lead_id, listing_id, match_score numeric(5,2),
//   matched_at, matched_by, status CHECK
//   ('suggested','viewed_by_lead','visit_scheduled','rejected_by_lead',
//    'withdrawn'), note, UNIQUE (lead_id, listing_id).
//
// No migration was required: the table, its status CHECK, the unique pair,
// and the app-role DML grant (server/scripts/app-role.js) all exist.
// `listing_matches` has no RLS policy by design — tenant isolation stays
// in the SQL predicates, the same posture as the staff/teams/projects
// directories.
//
// Permission shape (mirrors docs/LEAD_LISTING_MATCHING.md §4, adapted to
// the live status vocabulary):
//   * view   — `leads:view` on the lead (route gate + row can(), out of
//              scope → 404). Each row additionally needs `listings:view`
//              on its listing; out-of-scope listings are skipped silently,
//              never leaked as 404s inside the list.
//   * refresh / status update — `leads:edit` on the lead (route gate +
//              row can(), out of scope → 404) plus `listings:view` on each
//              listing touched (scope filter for candidates, per-row can()
//              for a single status update → 404 when out of scope).
//
// Scoring is deterministic, no ML (leadMatchScorer.js — hard filters,
// then weighted signals, same weights as the demo scorer). Scores are
// recomputed on every refresh and stored; `reason` strings are recomputed
// at read time from the current lead/listing rows so the UI always
// explains the present state, while `note` stays the human-written field.
//
// The `/* scope:… */` markers are stable seams for the no-DB unit tests,
// which interpret them instead of parsing SQL.

import { randomBytes } from 'node:crypto';
import { tenantQuery, withTenant } from '../db/client.js';
import { can } from '../rbac/permissions.js';
import { andFilters, scopeFilterFor } from '../rbac/scopeFilters.js';
import { BadRequest, NotFound } from '../utils/errors.js';
import { recordAudit } from '../audit/auditLog.js';
import { toLeadDTO } from './leadsRepository.js';
import { toListingDTO } from './listingsRepository.js';
import {
  passesHardFilter,
  rankLeadMatches,
  scoreLeadListing,
} from './leadMatchScorer.js';

export const MATCH_STATUSES = Object.freeze([
  'suggested',
  'viewed_by_lead',
  'visit_scheduled',
  'rejected_by_lead',
  'withdrawn',
]);

// Statuses a human has explicitly set. A refresh never moves a row out of
// one of these — it may update the stored score, but the status stands.
const HUMAN_STATUSES = new Set([
  'viewed_by_lead',
  'visit_scheduled',
  'rejected_by_lead',
  'withdrawn',
]);

const MAX_NOTE_LENGTH = 4000;

function pickString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/**
 * Validate the PATCH body for a single match. At least one of `status`
 * / `note` must be present. `status` must be a known match status;
 * `note` is trimmed, capped at 4000 chars, and `null` clears it.
 *
 * @param {unknown} body
 * @returns {{ status?: string, note?: string|null }}
 */
export function validateMatchUpdate(body) {
  if (!body || typeof body !== 'object') {
    throw new BadRequest('invalid-body', 'Request body must be an object.');
  }
  const out = {};
  if ('status' in body) {
    const status = pickString(body.status);
    if (!status || !MATCH_STATUSES.includes(status)) {
      throw new BadRequest(
        'invalid-status',
        `status must be one of: ${MATCH_STATUSES.join(', ')}.`,
      );
    }
    out.status = status;
  }
  if ('note' in body) {
    const raw = body.note;
    if (raw === null) {
      out.note = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > MAX_NOTE_LENGTH) {
        throw new BadRequest(
          'invalid-note',
          `note exceeds maximum length of ${MAX_NOTE_LENGTH} characters.`,
        );
      }
      out.note = trimmed ? trimmed : null;
    } else {
      throw new BadRequest('invalid-note', 'note must be a string or null.');
    }
  }
  if (!('status' in out) && !('note' in out)) {
    throw new BadRequest('empty-update', 'Provide status and/or note to update.');
  }
  return out;
}

/**
 * Validate the POST-refresh query/body options. Both optional:
 * `topN` (1..25, default 10) caps how many suggested rows are written;
 * `minScore` (0..100, default 45) is the floor below which a candidate is
 * dropped before ranking.
 *
 * @param {unknown} input
 * @returns {{ topN: number, minScore: number }}
 */
export function validateRefreshOptions(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  let topN = 10;
  let minScore = 45;
  if (src.topN !== undefined && src.topN !== null && src.topN !== '') {
    const n = Number(src.topN);
    if (!Number.isFinite(n) || n < 1 || n > 25) {
      throw new BadRequest('invalid-topN', 'topN must be a number between 1 and 25.');
    }
    topN = Math.floor(n);
  }
  if (src.minScore !== undefined && src.minScore !== null && src.minScore !== '') {
    const n = Number(src.minScore);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new BadRequest('invalid-minScore', 'minScore must be a number between 0 and 100.');
    }
    minScore = n;
  }
  return { topN, minScore };
}

/**
 * Validate the GET interested-leads query options. Only `status` is
 * supported, and only as a known match status; anything else is a 400
 * (an unknown status silently returning [] would lie).
 *
 * @param {unknown} input
 * @returns {{ status?: string }}
 */
export function validateInterestedLeadsOptions(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  if (src.status !== undefined && src.status !== null && src.status !== '') {
    const status = pickString(src.status);
    if (!MATCH_STATUSES.includes(status)) {
      throw new BadRequest(
        'invalid-status',
        `status must be one of: ${MATCH_STATUSES.join(', ')}.`,
      );
    }
    out.status = status;
  }
  return out;
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

function runnerFor(user, deps) {
  if (deps && deps.client) return (text, params) => deps.client.query(text, params);
  return (text, params) => tenantQuery(user, text, params);
}

function listingRecord(dto) {
  return {
    assignedTo: dto?.assignedTo?.id ?? dto?.assignedTo ?? null,
    teamId: dto?.teamId ?? null,
    projectId: dto?.project?.id ?? null,
  };
}

/**
 * Build one API match row from a `listing_matches` row joined to its
 * listing. `reason` is recomputed from the live lead/listing pair so the
 * UI explains the present state; `note` is the stored human text.
 */
function toMatchDTO(matchRow, listingDTO, leadDTO, project) {
  const { reason } = scoreLeadListing(leadDTO, listingDTO, project);
  return {
    id: matchRow.id,
    leadId: matchRow.lead_id,
    listingId: matchRow.listing_id,
    score: toNumberOrNull(matchRow.match_score),
    reason,
    status: matchRow.status,
    note: matchRow.note ?? null,
    matchedAt: toIso(matchRow.matched_at),
    matchedBy: matchRow.matched_by ?? null,
    listing: listingDTO
      ? {
          id: listingDTO.id,
          title: listingDTO.title,
          city: listingDTO.location?.city ?? null,
          locality: listingDTO.location?.locality ?? null,
          price: listingDTO.pricing?.price ?? null,
          rentMonthly: listingDTO.pricing?.rentMonthly ?? null,
          propertyType: listingDTO.propertyType ?? null,
          serviceCategory: listingDTO.serviceCategory ?? null,
          listingIntent: listingDTO.listingIntent ?? null,
          availability: listingDTO.status?.availability ?? null,
          verification: listingDTO.status?.verification ?? null,
        }
      : null,
  };
}

async function loadLeadDTO(client, tenantId, leadId) {
  const { rows } = await client.query(
    `SELECT l.*,
        u.id AS owner_user_id, u.name AS owner_user_name, u.email AS owner_user_email,
        t.id AS team_pk, t.name AS team_name,
        p.id AS project_pk, p.name AS project_name
       FROM leads l
       LEFT JOIN users u
         ON u.tenant_id = l.tenant_id AND u.id = l.owner_id AND u.deleted_at IS NULL
       LEFT JOIN teams t
         ON t.tenant_id = l.tenant_id AND t.id = l.team_id AND t.deleted_at IS NULL
       LEFT JOIN projects p
         ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL
      WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL`,
    [tenantId, leadId],
  );
  if (rows.length === 0) return null;
  return toLeadDTO(rows[0]);
}

async function loadProject(client, tenantId, projectId) {
  if (!projectId) return null;
  const { rows } = await client.query(
    `SELECT id, city, location FROM projects
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, projectId],
  );
  return rows[0] ?? null;
}

function leadRecord(dto) {
  return {
    ownerId: dto?.owner?.id ?? null,
    teamId: dto?.teamId ?? null,
    projectId: dto?.project?.id ?? dto?.projectId ?? null,
  };
}

function assertLeadVisible(user, leadDTO) {
  if (!leadDTO) throw new NotFound('not-found', 'Lead not found.');
  if (!can(user, 'leads', 'view', leadRecord(leadDTO))) {
    throw new NotFound('not-found', 'Lead not found.');
  }
}

function assertLeadEditable(user, leadDTO) {
  if (!leadDTO) throw new NotFound('not-found', 'Lead not found.');
  if (!can(user, 'leads', 'edit', leadRecord(leadDTO))) {
    throw new NotFound('not-found', 'Lead not found.');
  }
}

// Listing columns needed to rebuild a listing DTO for scoring + display.
// Mirrors listingsRepository LISTING_COLUMNS minus the photo-count
// subquery (counts are display-only; the scorer never reads them).
const MATCH_LISTING_COLUMNS = `
  l.id, l.tenant_id, l.service_category, l.property_type, l.listing_intent,
  l.title, l.description, l.address, l.city, l.locality, l.geo,
  l.price, l.rent_monthly, l.deposit, l.area_sqft,
  l.bedrooms, l.bathrooms, l.furnished, l.amenities,
  l.availability_status, l.verification_status,
  l.owner_contact_name, l.owner_contact_phone, l.owner_contact_email,
  l.assigned_to, l.team_id, l.project_id,
  l.notes, l.created_by, l.created_at, l.updated_at, l.deleted_at,
  u.id AS assigned_user_id, u.name AS assigned_user_name, u.email AS assigned_user_email,
  p.id AS project_pk, p.name AS project_name, p.city AS project_city
`;

function listingJoins() {
  return `LEFT JOIN users u
      ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to AND u.deleted_at IS NULL
    LEFT JOIN projects p
      ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL`;
}

// Lead columns needed to rebuild a lead DTO for the interested-leads
// pivot. Mirrors leadsRepository LEAD_COLUMNS verbatim (including the
// contact_id subquery) so toLeadDTO receives every field it reads.
const INTERESTED_LEAD_COLUMNS = `
  l.id, l.tenant_id, l.name, l.phone, l.email, l.project_id, l.status,
  l.score, l.budget_min, l.budget_max, l.source, l.notes, l.owner_id,
  l.team_id, l.created_by, l.next_follow_up, l.created_at, l.updated_at,
  l.deleted_at, l.service_need, l.client_type, l.requirements,
  l.rent_min, l.rent_max, l.preferred_location, l.desired_property_type,
  l.move_in_date, l.purchase_timeline, l.matched_listing_ids, l.visit_status,
  (SELECT c.id FROM contacts c WHERE c.tenant_id = l.tenant_id AND c.lead_id = l.id LIMIT 1) AS contact_id,
  u.id AS owner_user_id, u.name AS owner_user_name, u.email AS owner_user_email,
  t.id AS team_pk, t.name AS team_name,
  p.id AS project_pk, p.name AS project_name
`;

function interestedLeadJoins() {
  return `LEFT JOIN users u
      ON u.tenant_id = l.tenant_id AND u.id = l.owner_id AND u.deleted_at IS NULL
    LEFT JOIN teams t
      ON t.tenant_id = l.tenant_id AND t.id = l.team_id AND t.deleted_at IS NULL
    LEFT JOIN projects p
      ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL`;
}

/**
 * Build one API interested-lead row from a `listing_matches` row joined
 * to its lead. `reason` is recomputed from the live pair (same as the
 * lead-side pivot); the `lead` subset carries the fields a listing
 * drawer needs without re-fetching the lead.
 */
function toInterestedLeadDTO(matchRow, leadDTO, listingDTO, project) {
  const { reason } = scoreLeadListing(leadDTO, listingDTO, project);
  return {
    id: matchRow.id,
    leadId: matchRow.lead_id,
    listingId: matchRow.listing_id,
    score: toNumberOrNull(matchRow.match_score),
    reason,
    status: matchRow.status,
    note: matchRow.note ?? null,
    matchedAt: toIso(matchRow.matched_at),
    matchedBy: matchRow.matched_by ?? null,
    lead: leadDTO
      ? {
          id: leadDTO.id,
          name: leadDTO.name,
          phone: leadDTO.phone,
          email: leadDTO.email,
          status: leadDTO.status,
          score: leadDTO.score,
          serviceNeed: leadDTO.serviceNeed,
          clientType: leadDTO.clientType,
          pricing: leadDTO.pricing,
          preferredLocation: leadDTO.preferredLocation,
          desiredPropertyType: leadDTO.desiredPropertyType,
          nextFollowUp: leadDTO.nextFollowUp,
          owner: leadDTO.owner,
          teamId: leadDTO.teamId,
        }
      : null,
  };
}

/**
 * List saved matches for a listing (the interested-leads pivot),
 * score-desc. An out-of-scope (or missing) listing 404s; out-of-scope
 * leads are skipped silently, never leaked as 404s inside the list.
 * Optional `status` narrows to one match status.
 *
 * @param {object} user — req.user
 * @param {string} listingId
 * @param {{ status?: string }} [options]
 * @param {{ client?: { query: Function } }=} deps — injectable client for tests
 * @returns {Promise<{ listingId: string, items: object[] }>}
 */
export async function listInterestedLeads(user, listingId, options = {}, deps = {}) {
  if (!user?.tenantId) throw new NotFound('not-found', 'Listing not found.');
  if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');
  const { status } = validateInterestedLeadsOptions(options);
  const run = runnerFor(user, deps);

  const { rows: listingRows } = await run(
    `SELECT ${MATCH_LISTING_COLUMNS}
       FROM listings l
       ${listingJoins()}
      WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL`,
    [user.tenantId, listingId],
  );
  const listingDTO = listingRows[0] ? toListingDTO(listingRows[0]) : null;
  if (!listingDTO || !can(user, 'listings', 'view', listingRecord(listingDTO))) {
    throw new NotFound('not-found', 'Listing not found.');
  }

  const matchParams = [user.tenantId, listingId];
  let matchWhere = `m.tenant_id = $1 AND m.listing_id = $2`;
  if (status) {
    matchParams.push(status);
    matchWhere += ` AND m.status = $3`;
  }
  const { rows: matchRows } = await run(
    `SELECT m.* FROM listing_matches m
      WHERE ${matchWhere}
      ORDER BY m.match_score DESC NULLS LAST, m.matched_at DESC, m.id DESC`,
    matchParams,
  );
  if (matchRows.length === 0) return { listingId, items: [] };

  const leadIds = [...new Set(matchRows.map((r) => r.lead_id))];
  const placeholders = leadIds.map((_, i) => `$${i + 2}`).join(', ');
  const { rows: leadRows } = await run(
    `SELECT ${INTERESTED_LEAD_COLUMNS}
       FROM leads l
       ${interestedLeadJoins()}
      WHERE l.tenant_id = $1 AND l.id IN (${placeholders}) AND l.deleted_at IS NULL`,
    [user.tenantId, ...leadIds],
  );
  const byId = new Map();
  for (const row of leadRows) {
    const dto = toLeadDTO(row);
    if (dto && can(user, 'leads', 'view', leadRecord(dto))) {
      byId.set(dto.id, dto);
    }
  }

  const project = await loadProject(
    { query: (text, params) => run(text, params) },
    user.tenantId,
    listingDTO.project?.id ?? null,
  );

  const items = [];
  for (const matchRow of matchRows) {
    const leadDTO = byId.get(matchRow.lead_id);
    // Skipped silently: deleted, cross-tenant, or outside the caller's
    // leads:view scope. Never a 404 inside the list.
    if (!leadDTO) continue;
    items.push(toInterestedLeadDTO(matchRow, leadDTO, listingDTO, project));
  }
  return { listingId, items };
}

/**
 * List saved matches for a lead, newest-score-first. Out-of-scope
 * listings are skipped silently; an out-of-scope (or missing) lead 404s.
 *
 * @param {object} user — req.user
 * @param {string} leadId
 * @param {{ client?: { query: Function } }=} deps — injectable client for tests
 * @returns {Promise<{ leadId: string, items: object[] }>}
 */
export async function listMatches(user, leadId, deps = {}) {
  if (!user?.tenantId) throw new NotFound('not-found', 'Lead not found.');
  if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');
  const run = runnerFor(user, deps);

  const leadRows = await run(
    `SELECT l.*,
        u.id AS owner_user_id, u.name AS owner_user_name, u.email AS owner_user_email,
        t.id AS team_pk, t.name AS team_name,
        p.id AS project_pk, p.name AS project_name
       FROM leads l
       LEFT JOIN users u
         ON u.tenant_id = l.tenant_id AND u.id = l.owner_id AND u.deleted_at IS NULL
       LEFT JOIN teams t
         ON t.tenant_id = l.tenant_id AND t.id = l.team_id AND t.deleted_at IS NULL
       LEFT JOIN projects p
         ON p.tenant_id = l.tenant_id AND p.id = l.project_id AND p.deleted_at IS NULL
      WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL`,
    [user.tenantId, leadId],
  );
  const leadDTO = leadRows.rows[0] ? toLeadDTO(leadRows.rows[0]) : null;
  assertLeadVisible(user, leadDTO);

  const projectRows = await run(
    `SELECT id, city, location FROM projects
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [user.tenantId, leadDTO.projectId ?? leadDTO.project?.id ?? null],
  );
  const project = projectRows.rows[0] ?? null;

  const matchRows = await run(
    `SELECT m.* FROM listing_matches m
      WHERE m.tenant_id = $1 AND m.lead_id = $2
      ORDER BY m.match_score DESC NULLS LAST, m.matched_at DESC, m.id DESC`,
    [user.tenantId, leadId],
  );
  if (matchRows.rows.length === 0) return { leadId, items: [] };

  const listingIds = [...new Set(matchRows.rows.map((r) => r.listing_id))];
  const placeholders = listingIds.map((_, i) => `$${i + 2}`).join(', ');
  const listingRows = await run(
    `SELECT ${MATCH_LISTING_COLUMNS}
       FROM listings l
       ${listingJoins()}
      WHERE l.tenant_id = $1 AND l.id IN (${placeholders}) AND l.deleted_at IS NULL`,
    [user.tenantId, ...listingIds],
  );
  const byId = new Map();
  for (const row of listingRows.rows) {
    const dto = toListingDTO(row);
    if (dto && can(user, 'listings', 'view', listingRecord(dto))) {
      byId.set(dto.id, dto);
    }
  }

  const items = [];
  for (const matchRow of matchRows.rows) {
    const listingDTO = byId.get(matchRow.listing_id);
    // Skipped silently: deleted, cross-tenant, or outside the caller's
    // listings:view scope. Never a 404 inside the list.
    if (!listingDTO) continue;
    items.push(toMatchDTO(matchRow, listingDTO, leadDTO, project));
  }
  return { leadId, items };
}

/**
 * Recompute matches for a lead: score every scope-visible available
 * listing, keep the top `topN` at/above `minScore`, and upsert them as
 * `suggested` rows. Rows a human has already moved (viewed / scheduled /
 * rejected / withdrawn) keep their status — only the stored score is
 * refreshed. Rows that no longer rank are left untouched (audit trail,
 * not a cache).
 *
 * Requires `leads:edit` on the lead. Audit event: `recalculated-matches`.
 *
 * @param {{ user: object, leadId: string, topN?: number, minScore?: number, req?: object }} args
 * @param {{ client?: { query: Function } }=} deps — injectable client for tests
 * @returns {Promise<{ leadId: string, items: object[] }>}
 */
export async function refreshMatches({ user, leadId, topN = 10, minScore = 45, req = null }, deps = {}) {
  if (!user?.tenantId) throw new NotFound('not-found', 'Lead not found.');
  if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');
  const { topN: cap, minScore: floor } = validateRefreshOptions({ topN, minScore });

  const exec = async (client) => {
    const leadDTO = await loadLeadDTO(client, user.tenantId, leadId);
    assertLeadEditable(user, leadDTO);
    const project = await loadProject(client, user.tenantId, leadDTO.projectId ?? leadDTO.project?.id ?? null);

    const scope = scopeFilterFor(user, 'listings', 'view', { table: 'l' });
    const extra = {
      sql: `l.deleted_at IS NULL AND l.availability_status = 'available' /* scope:candidates */`,
      params: [],
    };
    const { sql, params } = andFilters([scope, extra]);

    const { rows: candidateRows } = await client.query(
      `SELECT ${MATCH_LISTING_COLUMNS}
         FROM listings l
         ${listingJoins()}
        WHERE ${sql}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 500`,
      params,
    );
    const candidates = [];
    for (const row of candidateRows) {
      const dto = toListingDTO(row);
      // Belt and braces: the SQL scope filter already narrows, but a
      // hand-written scope predicate must never leak through a JOIN.
      if (dto && can(user, 'listings', 'view', listingRecord(dto))) {
        candidates.push(dto);
      }
    }

    const ranked = rankLeadMatches(leadDTO, candidates, project, { topN: cap, minScore: floor });

    const existing = await client.query(
      `SELECT id, listing_id, status FROM listing_matches
        WHERE tenant_id = $1 AND lead_id = $2`,
      [user.tenantId, leadId],
    );
    const statusByListing = new Map(existing.rows.map((r) => [r.listing_id, r.status]));

    let upserted = 0;
    for (const { listing, score } of ranked) {
      const prev = statusByListing.get(listing.id);
      if (prev && HUMAN_STATUSES.has(prev)) {
        await client.query(
          `UPDATE listing_matches SET match_score = $3, matched_at = now()
            WHERE tenant_id = $1 AND lead_id = $2 AND listing_id = $4`,
          [user.tenantId, leadId, score.toFixed(2), listing.id],
        );
      } else if (prev) {
        await client.query(
          `UPDATE listing_matches SET match_score = $3, matched_at = now(), matched_by = $5
            WHERE tenant_id = $1 AND lead_id = $2 AND listing_id = $4`,
          [user.tenantId, leadId, score.toFixed(2), listing.id, user.id],
        );
      } else {
        await client.query(
          `INSERT INTO listing_matches (id, tenant_id, lead_id, listing_id, match_score, matched_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'suggested')`,
          [`lm_${randomBytes(10).toString('hex')}`, user.tenantId, leadId, listing.id, score.toFixed(2), user.id],
        );
      }
      upserted += 1;
    }

    if (req) {
      await recordAudit(client, {
        req,
        action: 'recalculated-matches',
        entity: 'lead',
        entityId: leadId,
        metadata: {
          topN: cap,
          minScore: floor,
          candidates: candidates.length,
          upserted,
          permissionPath: 'leads.edit',
        },
      });
    }

    // Read back through the same transaction so the response reflects the
    // write even before commit.
    const matchRows = await client.query(
      `SELECT m.* FROM listing_matches m
        WHERE m.tenant_id = $1 AND m.lead_id = $2
        ORDER BY m.match_score DESC NULLS LAST, m.matched_at DESC, m.id DESC`,
      [user.tenantId, leadId],
    );
    const byId = new Map(candidates.map((d) => [d.id, d]));
    // Rows whose listing fell outside the candidate window (e.g. booked
    // since) still need a DTO for the response — fetch the missing few.
    const missing = matchRows.rows
      .map((r) => r.listing_id)
      .filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const placeholders = missing.map((_, i) => `$${i + 2}`).join(', ');
      const extra2 = await client.query(
        `SELECT ${MATCH_LISTING_COLUMNS}
           FROM listings l
           ${listingJoins()}
          WHERE l.tenant_id = $1 AND l.id IN (${placeholders}) AND l.deleted_at IS NULL`,
        [user.tenantId, ...missing],
      );
      for (const row of extra2.rows) {
        const dto = toListingDTO(row);
        if (dto && can(user, 'listings', 'view', listingRecord(dto))) {
          byId.set(dto.id, dto);
        }
      }
    }
    const items = [];
    for (const matchRow of matchRows.rows) {
      const listingDTO = byId.get(matchRow.listing_id);
      if (!listingDTO) continue;
      items.push(toMatchDTO(matchRow, listingDTO, leadDTO, project));
    }
    return { leadId, items };
  };

  if (deps && deps.client) return exec(deps.client);
  return withTenant({ tenantId: user.tenantId }, exec);
}

/**
 * Update one saved match's status and/or note. The lead must be
 * `leads:edit`-visible and the listing `listings:view`-visible, else 404.
 * Audit event: `updated-match-status`.
 *
 * @param {{ user: object, leadId: string, listingId: string, changes: { status?: string, note?: string|null }, req?: object }} args
 * @param {{ client?: { query: Function } }=} deps — injectable client for tests
 */
export async function updateMatch({ user, leadId, listingId, changes, req = null }, deps = {}) {
  if (!user?.tenantId) throw new NotFound('not-found', 'Lead not found.');
  if (!leadId) throw new BadRequest('invalid-id', 'Lead id is required.');
  if (!listingId) throw new BadRequest('invalid-id', 'Listing id is required.');
  const patch = validateMatchUpdate(changes);

  const exec = async (client) => {
    const leadDTO = await loadLeadDTO(client, user.tenantId, leadId);
    assertLeadEditable(user, leadDTO);

    const { rows: matchRows } = await client.query(
      `SELECT m.* FROM listing_matches m
        WHERE m.tenant_id = $1 AND m.lead_id = $2 AND m.listing_id = $3`,
      [user.tenantId, leadId, listingId],
    );
    const matchRow = matchRows[0];
    if (!matchRow) throw new NotFound('not-found', 'Match not found.');

    const { rows: listingRows } = await client.query(
      `SELECT ${MATCH_LISTING_COLUMNS}
         FROM listings l
         ${listingJoins()}
        WHERE l.tenant_id = $1 AND l.id = $2 AND l.deleted_at IS NULL`,
      [user.tenantId, listingId],
    );
    const listingDTO = listingRows[0] ? toListingDTO(listingRows[0]) : null;
    if (!listingDTO || !can(user, 'listings', 'view', listingRecord(listingDTO))) {
      throw new NotFound('not-found', 'Match not found.');
    }

    const sets = [];
    const params = [];
    if (patch.status !== undefined) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    if (patch.note !== undefined) {
      params.push(patch.note);
      sets.push(`note = $${params.length}`);
    }
    params.push(user.tenantId, leadId, listingId);
    await client.query(
      `UPDATE listing_matches SET ${sets.join(', ')}
        WHERE tenant_id = $${params.length - 2}
          AND lead_id = $${params.length - 1}
          AND listing_id = $${params.length}`,
      params,
    );

    if (req) {
      await recordAudit(client, {
        req,
        action: 'updated-match-status',
        entity: 'lead_match',
        entityId: matchRow.id,
        metadata: {
          leadId,
          listingId,
          fromStatus: matchRow.status,
          toStatus: patch.status ?? matchRow.status,
          noteUpdated: patch.note !== undefined,
          permissionPath: 'leads.edit',
        },
      });
    }

    const project = await loadProject(client, user.tenantId, leadDTO.projectId ?? leadDTO.project?.id ?? null);
    const { rows: after } = await client.query(
      `SELECT m.* FROM listing_matches m
        WHERE m.tenant_id = $1 AND m.lead_id = $2 AND m.listing_id = $3`,
      [user.tenantId, leadId, listingId],
    );
    return toMatchDTO(after[0], listingDTO, leadDTO, project);
  };

  if (deps && deps.client) return exec(deps.client);
  return withTenant({ tenantId: user.tenantId }, exec);
}

export { passesHardFilter };
