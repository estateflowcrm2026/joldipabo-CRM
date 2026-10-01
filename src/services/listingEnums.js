// Listing enum translation — frontend labels ↔ backend CHECK constraints.
//
// The backend schema (server/src/db/schema.sql) constrains:
//   service_category  ∈ {rent, pg, buy, sell, land, office, commercial}
//   property_type    ∈ {apartment, independent_house, villa, pg_bed, pg_room,
//                        land_parcel, office, shop, warehouse, plot}
//   listing_intent   ∈ {available_for_rent, available_for_sale, wanted,
//                        client_requirement}
//
// The demo seed (src/data/seed.js) and the create/edit forms historically
// used human-friendly labels ('2BHK Apartment', 'rent-out', 'resale',
// 'owner-listed', 'list-pg', 'sell-plot', 'lease-out', 'list-office').
// Those values are NOT valid backend enums — submitting them verbatim
// would fail the CHECK constraint.
//
// This module is the single translation point. Forms call toBackend()
// before submitting; views call toFrontend() when rendering a backend
// DTO that carries a canonical enum. Both directions are total over the
// seed vocabulary so existing demo records stay usable.
//
// Ambiguous mappings are flagged rather than guessed:
//   * '4BHK Apartment' / '4BHK Sky Villa' / 'Villa' / 'Penthouse' /
//     'Studio Apartment' / 'Commercial Plot' / 'Coworking Desk' /
//     'Private Office' / 'Independent House' have no exact backend
//     equivalent. They map to the closest canonical value and are listed
//     in AMBIGUOUS_PROPERTY_TYPES so a reviewer can confirm.
//   * 'list-office' is ambiguous between 'available_for_rent' and
//     'available_for_sale' — the backend accepts both for office, so we
//     default to 'available_for_rent' and flag it.

// ---------------------------------------------------------------------------
// Canonical vocabularies (mirror server/src/repositories/listingValidation.js)
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

// ---------------------------------------------------------------------------
// Frontend label → backend enum
// ---------------------------------------------------------------------------

/**
 * serviceCategory: the demo seed uses 'resale' and 'owner-listed', which
 * are not backend enums. Both describe an existing property being sold
 * by its owner (as opposed to 'sell', which the backend uses for a
 * developer/new-sale listing). We map both to 'sell' — the closest
 * canonical value — and flag the ambiguity.
 */
const SERVICE_CATEGORY_TO_BACKEND = Object.freeze({
  rent: 'rent',
  pg: 'pg',
  buy: 'buy',
  sell: 'sell',
  land: 'land',
  office: 'office',
  commercial: 'commercial',
  resale: 'sell',        // ambiguous: resale vs. new-sale
  'owner-listed': 'sell', // ambiguous: owner-listed vs. developer sale
});

/**
 * propertyType: the demo seed uses human-friendly labels. Most map
 * cleanly; a few are ambiguous and flagged below.
 */
const PROPERTY_TYPE_TO_BACKEND = Object.freeze({
  // Exact matches
  apartment: 'apartment',
  independent_house: 'independent_house',
  villa: 'villa',
  pg_bed: 'pg_bed',
  pg_room: 'pg_room',
  land_parcel: 'land_parcel',
  office: 'office',
  shop: 'shop',
  warehouse: 'warehouse',
  plot: 'plot',

  // Seed labels → canonical
  'Studio Apartment': 'apartment',
  '1BHK Apartment': 'apartment',
  '2BHK Apartment': 'apartment',
  '3BHK Apartment': 'apartment',
  '4BHK Apartment': 'apartment',
  '4BHK Sky Villa': 'villa',
  '4BHK Villa': 'villa',
  Villa: 'villa',
  Penthouse: 'villa',       // ambiguous: penthouse vs. apartment
  'PG Bed': 'pg_bed',
  'PG Room': 'pg_room',
  'Single Room (PG)': 'pg_room',
  'Shared Room (PG)': 'pg_room',
  'Residential Plot': 'land_parcel',
  'Commercial Plot': 'plot', // ambiguous: commercial plot vs. land_parcel
  'Coworking Desk': 'office', // ambiguous: coworking vs. private office
  'Private Office': 'office',
  'Managed Office': 'office',
  'Independent House': 'independent_house',
});

/**
 * listingIntent: the demo seed uses action-oriented labels.
 */
const LISTING_INTENT_TO_BACKEND = Object.freeze({
  // Exact matches
  available_for_rent: 'available_for_rent',
  available_for_sale: 'available_for_sale',
  wanted: 'wanted',
  client_requirement: 'client_requirement',

  // Seed labels → canonical
  'rent-out': 'available_for_rent',
  sell: 'available_for_sale',
  'sell-plot': 'available_for_sale',
  'list-pg': 'available_for_rent',
  'lease-out': 'available_for_rent', // ambiguous: lease vs. sale
  'list-office': 'available_for_rent', // ambiguous: rent vs. sale
});

// ---------------------------------------------------------------------------
// Backend enum → frontend label (for rendering)
// ---------------------------------------------------------------------------

const SERVICE_CATEGORY_TO_FRONTEND = Object.freeze({
  rent: 'rent',
  pg: 'pg',
  buy: 'buy',
  sell: 'sell',
  land: 'land',
  office: 'office',
  commercial: 'commercial',
});

const PROPERTY_TYPE_TO_FRONTEND = Object.freeze({
  apartment: 'apartment',
  independent_house: 'independent_house',
  villa: 'villa',
  pg_bed: 'pg_bed',
  pg_room: 'pg_room',
  land_parcel: 'land_parcel',
  office: 'office',
  shop: 'shop',
  warehouse: 'warehouse',
  plot: 'plot',
});

const LISTING_INTENT_TO_FRONTEND = Object.freeze({
  available_for_rent: 'available_for_rent',
  available_for_sale: 'available_for_sale',
  wanted: 'wanted',
  client_requirement: 'client_requirement',
});

// ---------------------------------------------------------------------------
// Ambiguous mappings — flagged, not guessed
// ---------------------------------------------------------------------------

/**
 * Property types where the seed label does not have an exact backend
 * equivalent. Reviewers should confirm these mappings are acceptable.
 */
export const AMBIGUOUS_PROPERTY_TYPES = Object.freeze([
  { seed: '4BHK Apartment', backend: 'apartment', reason: 'No BHK-specific enum; all apartments map to apartment.' },
  { seed: '4BHK Sky Villa', backend: 'villa', reason: 'Sky villa is a villa variant.' },
  { seed: '4BHK Villa', backend: 'villa', reason: 'Villa with BHK count.' },
  { seed: 'Penthouse', backend: 'villa', reason: 'Penthouse could be apartment or villa; mapped to villa as the more specific type.' },
  { seed: 'Studio Apartment', backend: 'apartment', reason: 'Studio is an apartment variant.' },
  { seed: 'Commercial Plot', backend: 'plot', reason: 'Commercial plot could be land_parcel; mapped to plot.' },
  { seed: 'Coworking Desk', backend: 'office', reason: 'Coworking desk is an office variant.' },
  { seed: 'Private Office', backend: 'office', reason: 'Private office is an office variant.' },
  { seed: 'Managed Office', backend: 'office', reason: 'Managed office is an office variant.' },
  { seed: 'Independent House', backend: 'independent_house', reason: 'Exact match.' },
]);

/**
 * Listing intents where the seed label is ambiguous.
 */
export const AMBIGUOUS_LISTING_INTENTS = Object.freeze([
  { seed: 'lease-out', backend: 'available_for_rent', reason: 'Lease could be rent or sale; mapped to rent as the more common interpretation.' },
  { seed: 'list-office', backend: 'available_for_rent', reason: 'Office listing could be rent or sale; mapped to rent.' },
]);

/**
 * Service categories where the seed label is ambiguous.
 */
export const AMBIGUOUS_SERVICE_CATEGORIES = Object.freeze([
  { seed: 'resale', backend: 'sell', reason: 'Resale is a sale of an existing property; mapped to sell.' },
  { seed: 'owner-listed', backend: 'sell', reason: 'Owner-listed is a sale by the owner; mapped to sell.' },
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a frontend serviceCategory label to the backend enum.
 * Returns the input unchanged when it is already a valid backend enum.
 *
 * @param {string} value
 * @returns {string}
 */
export function serviceCategoryToBackend(value) {
  if (!value) return value;
  if (SERVICE_CATEGORIES.includes(value)) return value;
  return SERVICE_CATEGORY_TO_BACKEND[value] || value;
}

/**
 * Translate a frontend propertyType label to the backend enum.
 * Returns the input unchanged when it is already a valid backend enum.
 *
 * @param {string} value
 * @returns {string}
 */
export function propertyTypeToBackend(value) {
  if (!value) return value;
  if (PROPERTY_TYPES.includes(value)) return value;
  return PROPERTY_TYPE_TO_BACKEND[value] || value;
}

/**
 * Translate a frontend listingIntent label to the backend enum.
 * Returns the input unchanged when it is already a valid backend enum.
 *
 * @param {string} value
 * @returns {string}
 */
export function listingIntentToBackend(value) {
  if (!value) return value;
  if (LISTING_INTENTS.includes(value)) return value;
  return LISTING_INTENT_TO_BACKEND[value] || value;
}

/**
 * Translate a backend serviceCategory enum to the frontend label.
 * Returns the input unchanged when no mapping exists.
 *
 * @param {string} value
 * @returns {string}
 */
export function serviceCategoryToFrontend(value) {
  if (!value) return value;
  return SERVICE_CATEGORY_TO_FRONTEND[value] || value;
}

/**
 * Translate a backend propertyType enum to the frontend label.
 * Returns the input unchanged when no mapping exists.
 *
 * @param {string} value
 * @returns {string}
 */
export function propertyTypeToFrontend(value) {
  if (!value) return value;
  return PROPERTY_TYPE_TO_FRONTEND[value] || value;
}

/**
 * Translate a backend listingIntent enum to the frontend label.
 * Returns the input unchanged when no mapping exists.
 *
 * @param {string} value
 * @returns {string}
 */
export function listingIntentToFrontend(value) {
  if (!value) return value;
  return LISTING_INTENT_TO_FRONTEND[value] || value;
}

/**
 * Translate a full listing DTO from backend enums to frontend labels.
 * Returns a new object; does not mutate the input.
 *
 * @param {object} dto
 * @returns {object}
 */
export function listingDtoToFrontend(dto) {
  if (!dto) return dto;
  return {
    ...dto,
    serviceCategory: serviceCategoryToFrontend(dto.serviceCategory),
    propertyType: propertyTypeToFrontend(dto.propertyType),
    listingIntent: listingIntentToFrontend(dto.listingIntent),
  };
}

/**
 * Translate a full listing payload from frontend labels to backend enums.
 * Returns a new object; does not mutate the input.
 *
 * @param {object} payload
 * @returns {object}
 */
export function listingPayloadToBackend(payload) {
  if (!payload) return payload;
  return {
    ...payload,
    serviceCategory: serviceCategoryToBackend(payload.serviceCategory),
    propertyType: propertyTypeToBackend(payload.propertyType),
    listingIntent: listingIntentToBackend(payload.listingIntent),
  };
}

// ---------------------------------------------------------------------------
// Seed coverage — every seed value must have a mapping
// ---------------------------------------------------------------------------

/**
 * All 9 propertyType values used in the demo seed.
 */
export const SEED_PROPERTY_TYPES = Object.freeze([
  '1BHK Apartment',
  '2BHK Apartment',
  '3BHK Apartment',
  '4BHK Sky Villa',
  '4BHK Villa',
  'Managed Office',
  'Residential Plot',
  'Shared Room (PG)',
  'Single Room (PG)',
]);

/**
 * All 5 listingIntent values used in the demo seed.
 */
export const SEED_LISTING_INTENTS = Object.freeze([
  'lease-out',
  'list-pg',
  'rent-out',
  'sell',
  'sell-plot',
]);

/**
 * All 6 serviceCategory values used in the demo seed.
 */
export const SEED_SERVICE_CATEGORIES = Object.freeze([
  'land',
  'office',
  'owner-listed',
  'pg',
  'rent',
  'resale',
]);

/**
 * Verify that every seed value has a mapping. Throws if any are missing.
 * Called at module load to fail fast on a missing mapping.
 *
 * @returns {void}
 * @throws {Error} when a seed value has no mapping
 */
export function assertSeedCoverage() {
  const missing = [];
  for (const v of SEED_PROPERTY_TYPES) {
    if (!PROPERTY_TYPE_TO_BACKEND[v] && !PROPERTY_TYPES.includes(v)) {
      missing.push(`propertyType: ${v}`);
    }
  }
  for (const v of SEED_LISTING_INTENTS) {
    if (!LISTING_INTENT_TO_BACKEND[v] && !LISTING_INTENTS.includes(v)) {
      missing.push(`listingIntent: ${v}`);
    }
  }
  for (const v of SEED_SERVICE_CATEGORIES) {
    if (!SERVICE_CATEGORY_TO_BACKEND[v] && !SERVICE_CATEGORIES.includes(v)) {
      missing.push(`serviceCategory: ${v}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing enum mappings for seed values: ${missing.join(', ')}`);
  }
}

// Fail fast at module load if any seed value is unmapped.
assertSeedCoverage();
