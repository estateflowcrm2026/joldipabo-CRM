// Listings validation.
//
// Pure-function validators used by the write routes. They throw
// `BadRequest` on failure; the route never has to look at the error
// shape — the Fastify error handler renders it.
//
// Enums mirror the CHECK constraints in `server/src/db/schema.sql`
// and the vocabulary in `docs/DATA_MODEL.md §Listings`.
// Keep this file boring — no I/O, no DB, no async.

import { BadRequest } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Enum vocabularies (mirrors schema.sql CHECK constraints).
// ---------------------------------------------------------------------------

export const SERVICE_CATEGORIES = Object.freeze([
  'rent', 'pg', 'buy', 'sell', 'land', 'office', 'commercial',
]);

export const PROPERTY_TYPES = Object.freeze([
  'apartment',
  'independent_house',
  'villa',
  'pg_bed',
  'pg_room',
  'land_parcel',
  'office',
  'shop',
  'warehouse',
  'plot',
]);

export const LISTING_INTENTS = Object.freeze([
  'available_for_rent',
  'available_for_sale',
  'wanted',
  'client_requirement',
]);

export const AVAILABILITY_STATUSES = Object.freeze([
  'available', 'booked', 'occupied', 'withdrawn',
]);

export const VERIFICATION_STATUSES = Object.freeze([
  'unverified', 'pending', 'verified', 'rejected',
]);

export const FURNISHED_VALUES = Object.freeze(['unfurnished', 'semi', 'fully']);

export const PHOTO_CATEGORIES = Object.freeze([
  'Interior', 'Exterior', 'Amenities', 'Floor Plan', 'Document Cover', 'Other',
]);

// serviceCategory ↔ listingIntent coherence. Buy/sell/land/commercial make
// most sense as `available_for_sale` or `wanted`; rent/pg/office as
// `available_for_rent` or `wanted`; the schema accepts any combination,
// but we soft-warn callers with a 422 (Unprocessable Entity) to keep the
// data coherent.
const INTENT_FOR_CATEGORY = Object.freeze({
  rent:       new Set(['available_for_rent', 'wanted', 'client_requirement']),
  pg:         new Set(['available_for_rent', 'wanted', 'client_requirement']),
  buy:        new Set(['available_for_sale', 'wanted', 'client_requirement']),
  sell:       new Set(['available_for_sale', 'wanted', 'client_requirement']),
  land:       new Set(['available_for_sale', 'wanted', 'client_requirement']),
  office:     new Set(['available_for_rent', 'available_for_sale', 'wanted', 'client_requirement']),
  commercial: new Set(['available_for_rent', 'available_for_sale', 'wanted', 'client_requirement']),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function clampString(v, { max }) {
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

function parseInteger(v, field) {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BadRequest('invalid-field', `${field} must be an integer.`);
  }
  return n;
}

function parseNonNegativeInteger(v, field) {
  const n = parseInteger(v, field);
  if (n === undefined) return undefined;
  if (n < 0) throw new BadRequest('invalid-field', `${field} must be >= 0.`);
  return n;
}

function parsePositiveNumber(v, field, { max } = {}) {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequest('invalid-field', `${field} must be a non-negative number.`);
  }
  if (max !== undefined && n > max) {
    throw new BadRequest('invalid-field', `${field} exceeds maximum (${max}).`);
  }
  return n;
}

/**
 * Validate the `{ lat, lng, accuracy? }` shape. Lat in [-90, 90],
 * lng in [-180, 180]. Returns the JSON-ready object or undefined.
 */
function parseGeo(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new BadRequest('invalid-geo', 'geo must be an object { lat, lng, accuracy? }.');
  }
  const lat = parsePositiveNumber(v.lat, 'geo.lat', { max: 90 });
  const lng = parsePositiveNumber(v.lng, 'geo.lng', { max: 180 });
  if (lat === undefined || lng === undefined) {
    throw new BadRequest('invalid-geo', 'geo requires both lat and lng.');
  }
  if (lat > 90 || lat < -90) throw new BadRequest('invalid-geo', 'geo.lat out of range.');
  if (lng > 180 || lng < -180) throw new BadRequest('invalid-geo', 'geo.lng out of range.');
  const out = { lat, lng };
  if (v.accuracy !== undefined && v.accuracy !== null) {
    const acc = parsePositiveNumber(v.accuracy, 'geo.accuracy');
    if (acc !== undefined) out.accuracy = acc;
  }
  return out;
}

function parseAmenities(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new BadRequest('invalid-amenities', 'amenities must be an array of strings.');
  }
  return v.map((a, i) => {
    if (!isNonEmptyString(a)) {
      throw new BadRequest('invalid-amenities', `amenities[${i}] must be a non-empty string.`);
    }
    return a.trim();
  });
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
 * Validate the body of POST /api/v1/listings. Returns a normalized record
 * ready for the SQL INSERT (tenantId, createdBy, id are added by the repo).
 *
 * Required fields: serviceCategory, propertyType, listingIntent, title.
 *
 * `assignedUserId` is optional; when omitted, the listing is assigned to
 * the current user. The repository still re-checks tenant / active
 * status of the assignee against the users table.
 *
 * @param {object} body
 * @returns {object}
 */
export function validateCreateListing(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }

  const out = {};

  out.serviceCategory = pickEnum(
    clampString(body.serviceCategory, { max: 32 }),
    SERVICE_CATEGORIES,
    'serviceCategory',
  );
  out.propertyType = pickEnum(
    clampString(body.propertyType, { max: 32 }),
    PROPERTY_TYPES,
    'propertyType',
  );
  out.listingIntent = pickEnum(
    clampString(body.listingIntent, { max: 32 }),
    LISTING_INTENTS,
    'listingIntent',
  );

  if (!isNonEmptyString(body.title)) {
    throw new BadRequest('invalid-payload', 'title is required.');
  }
  out.title = clampString(body.title, { max: 200 });

  out.description   = clampString(body.description,   { max: 4000 });
  out.address       = clampString(body.address,       { max: 500 });
  out.city          = clampString(body.city,          { max: 120 });
  out.locality      = clampString(body.locality,      { max: 120 });
  out.notes         = clampString(body.notes,         { max: 4000 });

  if (body.geo !== undefined) out.geo = parseGeo(body.geo);
  if (body.amenities !== undefined) out.amenities = parseAmenities(body.amenities);

  out.price        = parsePositiveNumber(body.price,        'price',        { max: 1e12 });
  out.rentMonthly  = parsePositiveNumber(body.rentMonthly,  'rentMonthly',  { max: 1e10 });
  out.deposit      = parsePositiveNumber(body.deposit,      'deposit',      { max: 1e10 });
  out.areaSqft     = parsePositiveNumber(body.areaSqft,     'areaSqft',     { max: 1e7 });
  out.bedrooms     = parseNonNegativeInteger(body.bedrooms, 'bedrooms');
  out.bathrooms    = parseNonNegativeInteger(body.bathrooms, 'bathrooms');

  if (body.furnished !== undefined && body.furnished !== null) {
    out.furnished = pickEnum(
      clampString(body.furnished, { max: 16 }),
      FURNISHED_VALUES,
      'furnished',
    );
  }

  if (body.availabilityStatus !== undefined && body.availabilityStatus !== null) {
    out.availabilityStatus = pickEnum(
      clampString(body.availabilityStatus, { max: 16 }),
      AVAILABILITY_STATUSES,
      'availabilityStatus',
    );
  }

  if (body.verificationStatus !== undefined && body.verificationStatus !== null) {
    out.verificationStatus = pickEnum(
      clampString(body.verificationStatus, { max: 16 }),
      VERIFICATION_STATUSES,
      'verificationStatus',
    );
  }

  out.ownerContactName  = clampString(body.ownerContactName,  { max: 200 });
  out.ownerContactPhone = clampString(body.ownerContactPhone, { max: 40 });
  out.ownerContactEmail = clampString(body.ownerContactEmail, { max: 200 });

  // Foreign-key ids are optional here; the repository validates their
  // existence against the DB (same tenant, active status).
  if (body.assignedUserId !== undefined && body.assignedUserId !== null) {
    out.assignedUserId = clampString(body.assignedUserId, { max: 64 });
  }
  if (body.projectId !== undefined && body.projectId !== null) {
    out.projectId = clampString(body.projectId, { max: 64 });
  }
  if (body.teamId !== undefined && body.teamId !== null) {
    out.teamId = clampString(body.teamId, { max: 64 });
  }

  // Cross-field coherence: serviceCategory ↔ listingIntent.
  const allowedIntents = INTENT_FOR_CATEGORY[out.serviceCategory];
  if (allowedIntents && !allowedIntents.has(out.listingIntent)) {
    throw new BadRequest(
      'invalid-intent-for-category',
      `listingIntent "${out.listingIntent}" is not typical for serviceCategory "${out.serviceCategory}".`,
      { allowedIntents: [...allowedIntents] },
    );
  }

  // Cross-field hint: rent/pg/service categories usually carry rentMonthly
  // rather than price. This is a soft 422 — callers can override, but
  // we flag it so they confirm.
  if (
    (out.serviceCategory === 'rent' || out.serviceCategory === 'pg' || out.serviceCategory === 'office')
    && out.price !== undefined
    && out.rentMonthly === undefined
  ) {
    // Surface as a 422 to make the client explicit. Skipped silently
    // when both are absent.
    throw new BadRequest(
      'rent-prefers-monthly',
      `serviceCategory="${out.serviceCategory}" typically uses rentMonthly, not price.`,
      { suggestion: 'rentMonthly' },
    );
  }

  return out;
}

/**
 * Validate the body of PATCH /api/v1/listings/:id. Every field is optional;
 * the route rejects unknown fields. tenant_id, created_by, id are never
 * patchable.
 *
 * @param {object} body
 * @returns {object}
 */
export function validateUpdateListing(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }

  // Refuse tenant-spoofing and PK-spoofing attempts explicitly.
  const forbidden = ['id', 'tenantId', 'tenant_id', 'createdBy', 'created_by', 'createdAt', 'created_at', 'deletedAt', 'deleted_at'];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new BadRequest('forbidden-field', `Field "${key}" cannot be modified.`);
    }
  }

  // Reuse the create validator against the partial input by wrapping
  // into the same shape; pick whichever fields the caller provided.
  const partial = {};
  const copyIfPresent = (k) => {
    if (Object.prototype.hasOwnProperty.call(body, k)) partial[k] = body[k];
  };

  [
    'serviceCategory', 'propertyType', 'listingIntent',
    'title', 'description', 'address', 'city', 'locality', 'notes',
    'geo', 'amenities',
    'price', 'rentMonthly', 'deposit', 'areaSqft', 'bedrooms', 'bathrooms',
    'furnished',
    'availabilityStatus', 'verificationStatus',
    'ownerContactName', 'ownerContactPhone', 'ownerContactEmail',
    'assignedUserId', 'projectId', 'teamId',
  ].forEach(copyIfPresent);

  // validateCreateListing enforces required fields. For PATCH we wrap
  // each individually so a missing title doesn't reject a partial update.
  return validatePartialListingFields(partial);
}

function validatePartialListingFields(partial) {
  const out = {};

  if (partial.serviceCategory !== undefined) {
    out.serviceCategory = pickEnum(
      clampString(partial.serviceCategory, { max: 32 }),
      SERVICE_CATEGORIES,
      'serviceCategory',
    );
  }
  if (partial.propertyType !== undefined) {
    out.propertyType = pickEnum(
      clampString(partial.propertyType, { max: 32 }),
      PROPERTY_TYPES,
      'propertyType',
    );
  }
  if (partial.listingIntent !== undefined) {
    out.listingIntent = pickEnum(
      clampString(partial.listingIntent, { max: 32 }),
      LISTING_INTENTS,
      'listingIntent',
    );
  }
  if (partial.title !== undefined) {
    if (!isNonEmptyString(partial.title)) {
      throw new BadRequest('invalid-payload', 'title cannot be empty.');
    }
    out.title = clampString(partial.title, { max: 200 });
  }
  if (partial.description !== undefined) out.description = clampString(partial.description, { max: 4000 });
  if (partial.address !== undefined)     out.address     = clampString(partial.address, { max: 500 });
  if (partial.city !== undefined)        out.city        = clampString(partial.city, { max: 120 });
  if (partial.locality !== undefined)    out.locality    = clampString(partial.locality, { max: 120 });
  if (partial.notes !== undefined)       out.notes       = clampString(partial.notes, { max: 4000 });
  if (partial.geo !== undefined)         out.geo         = parseGeo(partial.geo);
  if (partial.amenities !== undefined)   out.amenities   = parseAmenities(partial.amenities);

  if (partial.price !== undefined)       out.price       = parsePositiveNumber(partial.price, 'price', { max: 1e12 });
  if (partial.rentMonthly !== undefined) out.rentMonthly = parsePositiveNumber(partial.rentMonthly, 'rentMonthly', { max: 1e10 });
  if (partial.deposit !== undefined)     out.deposit     = parsePositiveNumber(partial.deposit, 'deposit', { max: 1e10 });
  if (partial.areaSqft !== undefined)    out.areaSqft    = parsePositiveNumber(partial.areaSqft, 'areaSqft', { max: 1e7 });
  if (partial.bedrooms !== undefined)    out.bedrooms    = parseNonNegativeInteger(partial.bedrooms, 'bedrooms');
  if (partial.bathrooms !== undefined)   out.bathrooms   = parseNonNegativeInteger(partial.bathrooms, 'bathrooms');

  if (partial.furnished !== undefined && partial.furnished !== null) {
    out.furnished = pickEnum(clampString(partial.furnished, { max: 16 }), FURNISHED_VALUES, 'furnished');
  }
  if (partial.availabilityStatus !== undefined && partial.availabilityStatus !== null) {
    out.availabilityStatus = pickEnum(
      clampString(partial.availabilityStatus, { max: 16 }),
      AVAILABILITY_STATUSES,
      'availabilityStatus',
    );
  }
  if (partial.verificationStatus !== undefined && partial.verificationStatus !== null) {
    out.verificationStatus = pickEnum(
      clampString(partial.verificationStatus, { max: 16 }),
      VERIFICATION_STATUSES,
      'verificationStatus',
    );
  }
  if (partial.ownerContactName !== undefined)  out.ownerContactName  = clampString(partial.ownerContactName, { max: 200 });
  if (partial.ownerContactPhone !== undefined) out.ownerContactPhone = clampString(partial.ownerContactPhone, { max: 40 });
  if (partial.ownerContactEmail !== undefined) out.ownerContactEmail = clampString(partial.ownerContactEmail, { max: 200 });

  if (partial.assignedUserId !== undefined && partial.assignedUserId !== null) {
    out.assignedUserId = clampString(partial.assignedUserId, { max: 64 });
  }
  if (partial.projectId !== undefined && partial.projectId !== null) {
    out.projectId = clampString(partial.projectId, { max: 64 });
  }
  if (partial.teamId !== undefined && partial.teamId !== null) {
    out.teamId = clampString(partial.teamId, { max: 64 });
  }

  // If the patch changes serviceCategory AND listingIntent, run the
  // cross-field check.
  if (out.serviceCategory && out.listingIntent) {
    const allowedIntents = INTENT_FOR_CATEGORY[out.serviceCategory];
    if (allowedIntents && !allowedIntents.has(out.listingIntent)) {
      throw new BadRequest(
        'invalid-intent-for-category',
        `listingIntent "${out.listingIntent}" is not typical for serviceCategory "${out.serviceCategory}".`,
        { allowedIntents: [...allowedIntents] },
      );
    }
  }

  return out;
}

/**
 * Validate the body of POST /listings/:id/assign.
 * Required: assignedUserId.
 *
 * @param {object} body
 */
export function validateAssignListing(body = {}) {
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

/**
 * Validate the body of POST /listings/:id/verify.
 * Required: status in {'verified', 'rejected', 'pending'}.
 * `reason` is required when status='rejected'.
 *
 * @param {object} body
 */
export function validateVerifyListing(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }
  const status = clampString(body.status, { max: 16 });
  const allowed = ['pending', 'verified', 'rejected'];
  if (!allowed.includes(status)) {
    throw new BadRequest('invalid-enum', `status must be one of: ${allowed.join(', ')}.`);
  }
  const reason = clampString(body.reason, { max: 500 });
  if (status === 'rejected' && !reason) {
    throw new BadRequest('reason-required', 'reason is required when status is "rejected".');
  }
  return { status, reason };
}

/**
 * Validate the body of POST /listings/:id/photos (metadata-only).
 * Required: objectKey. Optional: caption, category, publicUrl, thumbnailUrl.
 *
 * @param {object} body
 */
export function validateAddListingPhoto(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }
  if (!isNonEmptyString(body.objectKey)) {
    throw new BadRequest('invalid-payload', 'objectKey is required.');
  }
  const out = {
    objectKey: clampString(body.objectKey, { max: 500 }),
    caption: clampString(body.caption, { max: 200 }),
    publicUrl: clampString(body.publicUrl, { max: 1000 }),
    thumbnailUrl: clampString(body.thumbnailUrl, { max: 1000 }),
  };
  if (body.category !== undefined && body.category !== null) {
    out.category = pickEnum(clampString(body.category, { max: 32 }), PHOTO_CATEGORIES, 'category');
  }
  return out;
}
