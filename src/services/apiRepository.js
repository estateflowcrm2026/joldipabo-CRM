// API repository — talks to the Joldipabo backend over HTTP.
//
// Scope today: **listings only**. Every other entity delegates to
// `demoRepository` so the rest of the app keeps working in mixed mode.
//
// Activation: NOT automatic. `src/services/index.js` reads the
// `VITE_USE_API_REPOSITORY` env flag and only swaps to this implementation
// when explicitly enabled. See `docs/API_REPOSITORY_SETUP.md`.
//
// Conventions:
//   * The backend emits the listing DTO shape from
//     `server/src/repositories/listingsRepository.js::toListingDTO`.
//     It uses nested `location / pricing / specs / status / ownerContact`
//     objects. This module passes that shape through unchanged — the seed
//     shapes already match (see `src/data/seed.js::LISTINGS`), so the UI
//     does not need to know which side it's talking to.
//   * `list` returns `{ items, pagination: { limit, offset, total } }`,
//     consistent with `demoRepository.list`. The backend uses limit/offset
//     pagination, so callers passing `cursor` get a warning rather than
//     silent fallback (cursors are not yet supported on listings).

import { apiRequest } from './apiClient.js';
import { demoRepository } from './demoRepository.js';
import { listingPayloadToBackend } from './listingEnums.js';

// ---------------------------------------------------------------------------
// Shape translation
// ---------------------------------------------------------------------------
//
// The backend and the frontend agree on the READ shape: `toListingDTO`
// (server/src/repositories/listingsRepository.js) already emits the nested
// `location / pricing / specs / status / ownerContact` objects the UI renders.
//
// Two things do NOT line up and are reconciled here:
//
//   1. WRITE shape. The backend's `validateCreateListing` / `validateUpdateListing`
//      take a FLAT body (`address`, `price`, `rentMonthly`, `bedrooms`,
//      `ownerContactName`, `availabilityStatus`, …). The UI builds the nested
//      DTO. Posting the nested object verbatim is accepted (200/201) but every
//      nested field is silently dropped — a listing created from the UI loses
//      its owner contact, price, specs and location. `toBackendCreatePayload`
//      and `toBackendPatch` flatten it.
//
//   2. Ownership fields. The backend emits `assignedTo` as an object
//      `{ id, name, email }` and the project as `project`; the rest of the app
//      treats `assignedTo` / `projectId` as ids (that is what `can()`'s OWN
//      scope and `filterByScope` compare against, and what the seed uses).
//      `toFrontendListing` normalises to the id form and keeps the backend's
//      display name alongside it so the UI can show a real name in live mode.

/**
 * Flatten the nested Listing DTO the UI builds into the flat body the
 * backend's create validator accepts.
 *
 * @param {object} input
 * @returns {object}
 */
export function toBackendCreatePayload(input = {}) {
  // Translate any frontend enum labels (e.g. seed values) to backend enums.
  const enums = listingPayloadToBackend(input);
  const loc = input.location || {};
  const pricing = input.pricing || {};
  const specs = input.specs || {};
  const status = input.status || {};
  const owner = input.ownerContact || {};

  const payload = {
    serviceCategory: enums.serviceCategory,
    propertyType: enums.propertyType,
    listingIntent: enums.listingIntent,
    title: input.title,
  };

  const put = (key, value) => {
    if (value !== undefined && value !== null) payload[key] = value;
  };

  put('description', input.description);
  put('address', loc.address);
  put('city', loc.city);
  put('locality', loc.locality);
  put('geo', loc.geo);
  put('amenities', specs.amenities);
  put('price', pricing.price);
  put('rentMonthly', pricing.rentMonthly);
  put('deposit', pricing.deposit);
  put('areaSqft', pricing.areaSqft);
  put('bedrooms', specs.bedrooms);
  put('bathrooms', specs.bathrooms);
  put('furnished', specs.furnished);
  put('availabilityStatus', status.availability);
  put('verificationStatus', status.verification);
  put('ownerContactName', owner.name);
  put('ownerContactPhone', owner.phone);
  put('ownerContactEmail', owner.email);

  const assignedId = typeof input.assignedTo === 'string'
    ? input.assignedTo
    : input.assignedTo?.id ?? null;
  put('assignedUserId', assignedId);
  put('projectId', input.projectId);
  put('teamId', input.teamId);
  put('notes', input.notes);

  return payload;
}

/**
 * Flatten a nested partial update into the flat PATCH body. Only keys the
 * caller actually provided are forwarded, so a patch never clobbers a field
 * it did not mention.
 *
 * @param {object} changes
 * @returns {object}
 */
export function toBackendPatch(changes = {}) {
  const enums = listingPayloadToBackend(changes);
  const out = {};
  const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);

  if ('serviceCategory' in changes) out.serviceCategory = enums.serviceCategory;
  if ('propertyType' in changes) out.propertyType = enums.propertyType;
  if ('listingIntent' in changes) out.listingIntent = enums.listingIntent;
  if ('title' in changes) out.title = changes.title;
  if ('description' in changes) out.description = changes.description;
  if ('notes' in changes) out.notes = changes.notes;

  const loc = changes.location;
  if (has(loc, 'address')) out.address = loc.address;
  if (has(loc, 'city')) out.city = loc.city;
  if (has(loc, 'locality')) out.locality = loc.locality;
  if (has(loc, 'geo')) out.geo = loc.geo;

  const pricing = changes.pricing;
  if (has(pricing, 'price')) out.price = pricing.price;
  if (has(pricing, 'rentMonthly')) out.rentMonthly = pricing.rentMonthly;
  if (has(pricing, 'deposit')) out.deposit = pricing.deposit;
  if (has(pricing, 'areaSqft')) out.areaSqft = pricing.areaSqft;

  const specs = changes.specs;
  if (has(specs, 'bedrooms')) out.bedrooms = specs.bedrooms;
  if (has(specs, 'bathrooms')) out.bathrooms = specs.bathrooms;
  if (has(specs, 'furnished')) out.furnished = specs.furnished;
  if (has(specs, 'amenities')) out.amenities = specs.amenities;

  const status = changes.status;
  if (has(status, 'availability')) out.availabilityStatus = status.availability;
  // verificationStatus is deliberately NOT forwarded here: the edit form
  // spreads the current status (so it can preserve verification fields in
  // demo mode), and forwarding an unchanged value would write a spurious
  // "verification changed" audit row. Verification has its own endpoint
  // (POST /listings/:id/verify).

  const owner = changes.ownerContact;
  if (has(owner, 'name')) out.ownerContactName = owner.name;
  if (has(owner, 'phone')) out.ownerContactPhone = owner.phone;
  if (has(owner, 'email')) out.ownerContactEmail = owner.email;

  if ('assignedTo' in changes) {
    out.assignedUserId = typeof changes.assignedTo === 'string'
      ? changes.assignedTo
      : changes.assignedTo?.id ?? null;
  }
  if ('projectId' in changes) out.projectId = changes.projectId;
  if ('teamId' in changes) out.teamId = changes.teamId;

  return out;
}

/**
 * Normalise a backend listing DTO to the shape the UI consumes: `assignedTo`
 * and `projectId` as ids (matching the seed and `can()`), with the backend's
 * display names kept for live-mode rendering.
 *
 * @param {object|null} dto
 * @returns {object|null}
 */
export function toFrontendListing(dto) {
  if (!dto || typeof dto !== 'object') return dto;
  const assigned = dto.assignedTo;
  const assignedId = typeof assigned === 'string'
    ? assigned
    : assigned?.id ?? null;
  const assignedName = assigned && typeof assigned === 'object'
    ? assigned.name ?? null
    : null;

  return {
    ...dto,
    assignedTo: assignedId,
    assignedToName: assignedName,
    projectId: dto.projectId ?? dto.project?.id ?? null,
  };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate the frontend `ListFilters` shape into the backend query
 * string. The backend supports: `serviceCategory`, `propertyType`,
 * `listingIntent`, `availabilityStatus`, `verificationStatus`,
 * `assignedUserId`, `city` (case-insensitive substring), `search` (across
 * title/description/address). Other `where` operators (`__in`, `__gt`, …)
 * are ignored — listings query is flat.
 *
 * @param {object} [filters]
 * @returns {object}
 */
function buildListingsQuery(filters = {}) {
  const query = {};
  const pagination = filters.pagination || {};
  if (pagination.limit != null) query.limit = pagination.limit;
  if (pagination.offset != null) query.offset = pagination.offset;

  const where = filters.where || {};
  for (const [rawKey, value] of Object.entries(where)) {
    // The demo accepts `{ field__op: value }`; the backend has no notion
    // of `__op` operators on listings. Take the field name only.
    const field = rawKey.includes('__') ? rawKey.slice(0, rawKey.indexOf('__')) : rawKey;
    if (
      [
        'serviceCategory',
        'propertyType',
        'listingIntent',
        'availabilityStatus',
        'verificationStatus',
        'assignedUserId',
        'city',
        'search',
      ].includes(field)
    ) {
      query[field] = value;
    }
  }
  return query;
}

// ---------------------------------------------------------------------------
// Listings adapter — direct calls to the backend.
// ---------------------------------------------------------------------------

const listingsAdapter = {
  /**
   * GET /api/v1/listings.
   *
   * @param {object} [filters]
   * @returns {Promise<{ items: object[], pagination: { limit: number, offset: number, total: number } }>}
   */
  async list(filters = {}) {
    const result = await apiRequest('/listings', { method: 'GET', query: buildListingsQuery(filters) });
    return {
      ...result,
      items: (result.items || []).map(toFrontendListing),
    };
  },

  /**
   * GET /api/v1/listings/:id.
   *
   * @param {string} id
   * @returns {Promise<object|null>}  null when the backend returns 404.
   */
  async get(id) {
    try {
      const dto = await apiRequest(`/listings/${encodeURIComponent(id)}`, { method: 'GET' });
      return toFrontendListing(dto);
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * POST /api/v1/listings.
   *
   * @param {object} input  the nested Listing DTO the UI builds
   * @returns {Promise<{ record: object }>}  Mirrors the demo `create` shape.
   */
  async create(input) {
    const record = await apiRequest('/listings', {
      method: 'POST',
      body: toBackendCreatePayload(input),
    });
    return { record: toFrontendListing(record) };
  },

  /**
   * PATCH /api/v1/listings/:id.
   *
   * @param {string} id
   * @param {object} changes  nested partial update
   * @returns {Promise<{ record: object }>}
   */
  async update(id, changes) {
    const record = await apiRequest(`/listings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: toBackendPatch(changes),
    });
    return { record: toFrontendListing(record) };
  },

  /**
   * DELETE /api/v1/listings/:id (soft delete).
   *
   * @param {string} id
   */
  async remove(id) {
    await apiRequest(`/listings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /**
   * POST /api/v1/listings/:id/assign.
   *
   * @param {string} id
   * @param {string} assignedUserId
   * @param {string} [reason]
   * @returns {Promise<{ record: object }>}
   */
  async assign(id, assignedUserId, reason) {
    const record = await apiRequest(`/listings/${encodeURIComponent(id)}/assign`, {
      method: 'POST',
      body: { assignedUserId, reason },
    });
    return { record: toFrontendListing(record) };
  },

  /**
   * POST /api/v1/listings/:id/verify.
   *
   * @param {string} id
   * @param {'unverified'|'pending'|'verified'|'rejected'} status
   * @param {string} [reason]
   * @returns {Promise<{ record: object }>}
   */
  async verify(id, status, reason) {
    const record = await apiRequest(`/listings/${encodeURIComponent(id)}/verify`, {
      method: 'POST',
      body: { status, reason },
    });
    return { record: toFrontendListing(record) };
  },

  /**
   * POST /api/v1/listings/:id/photos (metadata only).
   *
   * @param {string} id
   * @param {{ objectKey: string, caption?: string, category?: string }} input
   * @returns {Promise<{ record: object }>}
   */
  async addPhoto(id, input) {
    const record = await apiRequest(`/listings/${encodeURIComponent(id)}/photos`, {
      method: 'POST',
      body: input,
    });
    return { record };
  },
};

// ---------------------------------------------------------------------------
// Repository object — generic methods (entity, ...) and a `listings`
// specialised adapter. Non-listings entities delegate to demoRepository.
// ---------------------------------------------------------------------------

export const apiRepository = {
  /**
   * @param {string} entity
   * @param {object} [filters]
   */
  async list(entity, filters) {
    if (entity === 'listings') return listingsAdapter.list(filters);
    return demoRepository.list(entity, filters);
  },

  async get(entity, id) {
    if (entity === 'listings') return listingsAdapter.get(id);
    return demoRepository.get(entity, id);
  },

  async create(entity, payload) {
    if (entity === 'listings') return listingsAdapter.create(payload);
    return demoRepository.create(entity, payload);
  },

  async update(entity, id, changes) {
    if (entity === 'listings') return listingsAdapter.update(id, changes);
    return demoRepository.update(entity, id, changes);
  },

  async remove(entity, id) {
    if (entity === 'listings') return listingsAdapter.remove(id);
    return demoRepository.remove(entity, id);
  },

  // Specialised namespace. The demo's `custom` object already mirrors this
  // shape (`repo.custom.attendance.checkIn(...)`); keeping the listings
  // methods on the same surface makes future wiring trivial.
  custom: {
    listings: listingsAdapter,
  },
};

// Named export so callers can `import { listings } from './apiRepository.js'`
// if they prefer the namespaced form. Mirrors the spec.
export const listings = listingsAdapter;
