// Lead validation.
//
// Pure-function validators used by the write routes. They throw
// `BadRequest` on failure; the route never has to look at the error
// shape — the Fastify error handler renders it.
//
// Enums mirror the CHECK constraints in `server/src/db/schema.sql`
// and the vocabulary in `docs/DATA_MODEL.md §Leads`.
// Keep this file boring — no I/O, no DB, no async.

import { BadRequest } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Enum vocabularies (mirrors schema.sql CHECK constraints).
// ---------------------------------------------------------------------------

export const LEAD_STATUSES = Object.freeze([
  'New',
  'Contacted',
  'Site Visit Scheduled',
  'Visit Done',
  'Negotiation',
  'Booked',
  'Lost',
  'Follow-up',
]);

export const LEAD_SCORES = Object.freeze(['hot', 'warm', 'cold']);

export const SERVICE_NEEDS = Object.freeze([
  'rent', 'pg', 'buy', 'sell', 'land', 'office', 'commercial', 'project_buy',
]);

export const CLIENT_TYPES = Object.freeze([
  'tenant', 'buyer', 'seller', 'landlord', 'investor', 'business',
]);

export const DESIRED_PROPERTY_TYPES = Object.freeze([
  'apartment', 'independent_house', 'villa', 'pg_bed', 'pg_room',
  'land_parcel', 'office', 'shop', 'warehouse', 'plot',
]);

export const PURCHASE_TIMELINES = Object.freeze([
  'immediate', 'within_3_months', 'within_6_months', 'within_12_months', 'exploratory',
]);

export const VISIT_STATUSES = Object.freeze([
  'no_visit_planned', 'visit_planned', 'visit_completed', 'visit_cancelled', 'no_show',
]);

export const LEAD_SOURCES = Object.freeze([
  'Website', 'Referral', 'Channel Partner', 'Walk-in', 'Meta Ads', 'Direct',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function clampString(v, { max } = {}) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new BadRequest('invalid-field', `Expected string, got ${typeof v}.`);
  }
  const trimmed = v.trim();
  if (max && trimmed.length > max) {
    throw new BadRequest('invalid-field', `Text exceeds maximum length of ${max} characters.`);
  }
  return trimmed;
}

/**
 * Strict integer parsing. Rejects malformed numeric values rather than
 * partially parsing them — `Number.parseInt("12abc", 10)` returns 12,
 * which would silently store a truncated budget. A value is valid only
 * when it is already a finite integer number, or a string that matches
 * `/^[+-]?\d+$/` after trimming.
 */
function parseInteger(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new BadRequest('invalid-field', `${field} must be an integer.`);
    }
    return v;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new BadRequest('invalid-field', `${field} must be an integer.`);
    }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new BadRequest('invalid-field', `${field} must be an integer.`);
    }
    return n;
  }
  throw new BadRequest('invalid-field', `${field} must be an integer.`);
}

function parseNonNegativeInteger(v, field) {
  const n = parseInteger(v, field);
  if (n === undefined) return undefined;
  if (n < 0) throw new BadRequest('invalid-field', `${field} must be >= 0.`);
  return n;
}

function pickEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new BadRequest('invalid-enum', `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate the body of POST /api/v1/leads. Returns a normalized record
 * ready for the SQL INSERT (tenantId, createdBy, id are added by the repo).
 *
 * Required fields: name, phone.
 * Optional: email, projectId, status, score, budgetMin, budgetMax, source,
 * notes, ownerId, teamId, nextFollowUp, serviceNeed, clientType, requirements,
 * rentMin, rentMax, preferredLocation, desiredPropertyType, moveInDate,
 * purchaseTimeline, matchedListingIds, visitStatus.
 *
 * @param {object} body
 * @returns {object}
 */
export function validateCreateLead(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }

  const out = {};

  if (!isNonEmptyString(body.name)) {
    throw new BadRequest('invalid-payload', 'name is required.');
  }
  out.name = clampString(body.name, { max: 200 });

  if (!isNonEmptyString(body.phone)) {
    throw new BadRequest('invalid-payload', 'phone is required.');
  }
  out.phone = clampString(body.phone, { max: 40 });

  out.email = clampString(body.email, { max: 200 });
  out.source = clampString(body.source, { max: 64 });
  out.notes = clampString(body.notes, { max: 4000 });

  if (body.status !== undefined && body.status !== null) {
    out.status = pickEnum(
      clampString(body.status, { max: 32 }),
      LEAD_STATUSES,
      'status',
    );
  }

  if (body.score !== undefined && body.score !== null) {
    out.score = pickEnum(
      clampString(body.score, { max: 16 }),
      LEAD_SCORES,
      'score',
    );
  }

  out.budgetMin = parseNonNegativeInteger(body.budgetMin, 'budgetMin');
  out.budgetMax = parseNonNegativeInteger(body.budgetMax, 'budgetMax');

  // Cross-field: budgetMin <= budgetMax when both present.
  if (out.budgetMin !== undefined && out.budgetMax !== undefined && out.budgetMin > out.budgetMax) {
    throw new BadRequest('invalid-field', 'budgetMin must be <= budgetMax.');
  }

  if (body.projectId !== undefined && body.projectId !== null) {
    out.projectId = clampString(body.projectId, { max: 64 });
  }

  if (body.ownerId !== undefined && body.ownerId !== null) {
    out.ownerId = clampString(body.ownerId, { max: 64 });
  }

  if (body.teamId !== undefined && body.teamId !== null) {
    out.teamId = clampString(body.teamId, { max: 64 });
  }

  if (body.nextFollowUp !== undefined && body.nextFollowUp !== null) {
    const d = new Date(body.nextFollowUp);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequest('invalid-field', 'nextFollowUp must be a valid date.');
    }
    out.nextFollowUp = d.toISOString();
  }

  // Cross-vertical fields
  if (body.serviceNeed !== undefined && body.serviceNeed !== null) {
    out.serviceNeed = pickEnum(
      clampString(body.serviceNeed, { max: 32 }),
      SERVICE_NEEDS,
      'serviceNeed',
    );
  }

  if (body.clientType !== undefined && body.clientType !== null) {
    out.clientType = pickEnum(
      clampString(body.clientType, { max: 32 }),
      CLIENT_TYPES,
      'clientType',
    );
  }

  if (body.requirements !== undefined && body.requirements !== null) {
    if (typeof body.requirements !== 'object' || Array.isArray(body.requirements)) {
      throw new BadRequest('invalid-field', 'requirements must be an object.');
    }
    out.requirements = body.requirements;
  }

  out.rentMin = parseNonNegativeInteger(body.rentMin, 'rentMin');
  out.rentMax = parseNonNegativeInteger(body.rentMax, 'rentMax');

  if (out.rentMin !== undefined && out.rentMax !== undefined && out.rentMin > out.rentMax) {
    throw new BadRequest('invalid-field', 'rentMin must be <= rentMax.');
  }

  out.preferredLocation = clampString(body.preferredLocation, { max: 200 });

  if (body.desiredPropertyType !== undefined && body.desiredPropertyType !== null) {
    out.desiredPropertyType = pickEnum(
      clampString(body.desiredPropertyType, { max: 32 }),
      DESIRED_PROPERTY_TYPES,
      'desiredPropertyType',
    );
  }

  if (body.moveInDate !== undefined && body.moveInDate !== null) {
    const d = new Date(body.moveInDate);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequest('invalid-field', 'moveInDate must be a valid date.');
    }
    out.moveInDate = d.toISOString().slice(0, 10);
  }

  if (body.purchaseTimeline !== undefined && body.purchaseTimeline !== null) {
    out.purchaseTimeline = pickEnum(
      clampString(body.purchaseTimeline, { max: 32 }),
      PURCHASE_TIMELINES,
      'purchaseTimeline',
    );
  }

  if (body.matchedListingIds !== undefined && body.matchedListingIds !== null) {
    throw new BadRequest(
      'field-not-writable',
      'matchedListingIds is not writable until the matching workflow lands.',
    );
  }

  if (body.visitStatus !== undefined && body.visitStatus !== null) {
    out.visitStatus = pickEnum(
      clampString(body.visitStatus, { max: 32 }),
      VISIT_STATUSES,
      'visitStatus',
    );
  }

  return out;
}

/**
 * Validate the body of PATCH /api/v1/leads/:id. Every field is optional;
 * the route rejects unknown fields. id, tenantId, createdBy, createdAt,
 * deletedAt are never patchable.
 *
 * @param {object} body
 * @returns {object}
 */
export function validateUpdateLead(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }

  const forbidden = ['id', 'tenantId', 'tenant_id', 'createdBy', 'created_by', 'createdAt', 'created_at', 'deletedAt', 'deleted_at'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new BadRequest('forbidden-field', `Field "${key}" cannot be modified.`);
    }
  }

  const partial = {};
  const copyIfPresent = (k) => {
    if (Object.prototype.hasOwnProperty.call(body, k)) partial[k] = body[k];
  };

  [
    'name', 'phone', 'email', 'source', 'notes',
    'status', 'score', 'budgetMin', 'budgetMax',
    'projectId', 'ownerId', 'teamId', 'nextFollowUp',
    'serviceNeed', 'clientType', 'requirements',
    'rentMin', 'rentMax', 'preferredLocation', 'desiredPropertyType',
    'moveInDate', 'purchaseTimeline', 'matchedListingIds', 'visitStatus',
  ].forEach(copyIfPresent);

  return validatePartialLeadFields(partial);
}

function validatePartialLeadFields(partial) {
  const out = {};

  if (partial.name !== undefined) {
    if (!isNonEmptyString(partial.name)) {
      throw new BadRequest('invalid-payload', 'name cannot be empty.');
    }
    out.name = clampString(partial.name, { max: 200 });
  }
  if (partial.phone !== undefined) {
    if (!isNonEmptyString(partial.phone)) {
      throw new BadRequest('invalid-payload', 'phone cannot be empty.');
    }
    out.phone = clampString(partial.phone, { max: 40 });
  }
  if (partial.email !== undefined) out.email = clampString(partial.email, { max: 200 });
  if (partial.source !== undefined) out.source = clampString(partial.source, { max: 64 });
  if (partial.notes !== undefined) out.notes = clampString(partial.notes, { max: 4000 });

  if (partial.status !== undefined && partial.status !== null) {
    out.status = pickEnum(clampString(partial.status, { max: 32 }), LEAD_STATUSES, 'status');
  }
  if (partial.score !== undefined && partial.score !== null) {
    out.score = pickEnum(clampString(partial.score, { max: 16 }), LEAD_SCORES, 'score');
  }

  if (partial.budgetMin !== undefined) out.budgetMin = parseNonNegativeInteger(partial.budgetMin, 'budgetMin');
  if (partial.budgetMax !== undefined) out.budgetMax = parseNonNegativeInteger(partial.budgetMax, 'budgetMax');
  if (out.budgetMin !== undefined && out.budgetMax !== undefined && out.budgetMin > out.budgetMax) {
    throw new BadRequest('invalid-field', 'budgetMin must be <= budgetMax.');
  }

  if (partial.projectId !== undefined && partial.projectId !== null) {
    out.projectId = clampString(partial.projectId, { max: 64 });
  }
  if (partial.ownerId !== undefined && partial.ownerId !== null) {
    out.ownerId = clampString(partial.ownerId, { max: 64 });
  }
  if (partial.teamId !== undefined && partial.teamId !== null) {
    out.teamId = clampString(partial.teamId, { max: 64 });
  }

  if (partial.nextFollowUp !== undefined) {
    if (partial.nextFollowUp === null) {
      out.nextFollowUp = null;
    } else {
      const d = new Date(partial.nextFollowUp);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequest('invalid-field', 'nextFollowUp must be a valid date.');
      }
      out.nextFollowUp = d.toISOString();
    }
  }

  if (partial.serviceNeed !== undefined && partial.serviceNeed !== null) {
    out.serviceNeed = pickEnum(clampString(partial.serviceNeed, { max: 32 }), SERVICE_NEEDS, 'serviceNeed');
  }
  if (partial.clientType !== undefined && partial.clientType !== null) {
    out.clientType = pickEnum(clampString(partial.clientType, { max: 32 }), CLIENT_TYPES, 'clientType');
  }
  if (partial.requirements !== undefined && partial.requirements !== null) {
    if (typeof partial.requirements !== 'object' || Array.isArray(partial.requirements)) {
      throw new BadRequest('invalid-field', 'requirements must be an object.');
    }
    out.requirements = partial.requirements;
  }

  if (partial.rentMin !== undefined) out.rentMin = parseNonNegativeInteger(partial.rentMin, 'rentMin');
  if (partial.rentMax !== undefined) out.rentMax = parseNonNegativeInteger(partial.rentMax, 'rentMax');
  if (out.rentMin !== undefined && out.rentMax !== undefined && out.rentMin > out.rentMax) {
    throw new BadRequest('invalid-field', 'rentMin must be <= rentMax.');
  }

  if (partial.preferredLocation !== undefined) out.preferredLocation = clampString(partial.preferredLocation, { max: 200 });

  if (partial.desiredPropertyType !== undefined && partial.desiredPropertyType !== null) {
    out.desiredPropertyType = pickEnum(
      clampString(partial.desiredPropertyType, { max: 32 }),
      DESIRED_PROPERTY_TYPES,
      'desiredPropertyType',
    );
  }

  if (partial.moveInDate !== undefined && partial.moveInDate !== null) {
    const d = new Date(partial.moveInDate);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequest('invalid-field', 'moveInDate must be a valid date.');
    }
    out.moveInDate = d.toISOString().slice(0, 10);
  }

  if (partial.purchaseTimeline !== undefined && partial.purchaseTimeline !== null) {
    out.purchaseTimeline = pickEnum(
      clampString(partial.purchaseTimeline, { max: 32 }),
      PURCHASE_TIMELINES,
      'purchaseTimeline',
    );
  }

  if (partial.matchedListingIds !== undefined && partial.matchedListingIds !== null) {
    throw new BadRequest(
      'field-not-writable',
      'matchedListingIds is not writable until the matching workflow lands.',
    );
  }

  if (partial.visitStatus !== undefined && partial.visitStatus !== null) {
    out.visitStatus = pickEnum(
      clampString(partial.visitStatus, { max: 32 }),
      VISIT_STATUSES,
      'visitStatus',
    );
  }

  return out;
}

/**
 * Validate the body of POST /leads/:id/assign.
 * Required: assignedUserId.
 *
 * @param {object} body
 */
export function validateAssignLead(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }
  if (!isNonEmptyString(body.assignedUserId)) {
    throw new BadRequest('invalid-payload', 'assignedUserId is required.');
  }
  return {
    assignedUserId: clampString(body.assignedUserId, { max: 64 }),
    reason: clampString(body.reason, { max: 500 }),
  };
}
