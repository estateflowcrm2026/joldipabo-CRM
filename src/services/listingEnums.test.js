// Tests for the listing enum translation layer.
//
// Covers all 9 propertyType and 5 listingIntent seed values, plus the
// serviceCategory values. Verifies that:
//   1. Every seed value maps to a valid backend enum.
//   2. Backend enums pass through unchanged.
//   3. The reverse mapping (backend → frontend) is consistent.
//   4. Ambiguous mappings are flagged, not silently guessed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVICE_CATEGORIES,
  PROPERTY_TYPES,
  LISTING_INTENTS,
  SEED_PROPERTY_TYPES,
  SEED_LISTING_INTENTS,
  SEED_SERVICE_CATEGORIES,
  AMBIGUOUS_PROPERTY_TYPES,
  AMBIGUOUS_LISTING_INTENTS,
  AMBIGUOUS_SERVICE_CATEGORIES,
  serviceCategoryToBackend,
  propertyTypeToBackend,
  listingIntentToBackend,
  serviceCategoryToFrontend,
  propertyTypeToFrontend,
  listingIntentToFrontend,
  listingDtoToFrontend,
  listingPayloadToBackend,
  assertSeedCoverage,
} from './listingEnums.js';

// ---------------------------------------------------------------------------
// Seed coverage — every seed value must map to a valid backend enum
// ---------------------------------------------------------------------------

test('all 9 seed propertyType values map to valid backend enums', () => {
  assert.equal(SEED_PROPERTY_TYPES.length, 9, 'expected 9 seed propertyType values');
  for (const seed of SEED_PROPERTY_TYPES) {
    const backend = propertyTypeToBackend(seed);
    assert.ok(
      PROPERTY_TYPES.includes(backend),
      `propertyType "${seed}" maps to "${backend}", which is not a valid backend enum`,
    );
  }
});

test('all 5 seed listingIntent values map to valid backend enums', () => {
  assert.equal(SEED_LISTING_INTENTS.length, 5, 'expected 5 seed listingIntent values');
  for (const seed of SEED_LISTING_INTENTS) {
    const backend = listingIntentToBackend(seed);
    assert.ok(
      LISTING_INTENTS.includes(backend),
      `listingIntent "${seed}" maps to "${backend}", which is not a valid backend enum`,
    );
  }
});

test('all 6 seed serviceCategory values map to valid backend enums', () => {
  assert.equal(SEED_SERVICE_CATEGORIES.length, 6, 'expected 6 seed serviceCategory values');
  for (const seed of SEED_SERVICE_CATEGORIES) {
    const backend = serviceCategoryToBackend(seed);
    assert.ok(
      SERVICE_CATEGORIES.includes(backend),
      `serviceCategory "${seed}" maps to "${backend}", which is not a valid backend enum`,
    );
  }
});

test('assertSeedCoverage does not throw when all seed values are mapped', () => {
  assert.doesNotThrow(() => assertSeedCoverage());
});

// ---------------------------------------------------------------------------
// Backend enums pass through unchanged
// ---------------------------------------------------------------------------

test('backend enums pass through serviceCategoryToBackend unchanged', () => {
  for (const v of SERVICE_CATEGORIES) {
    assert.equal(serviceCategoryToBackend(v), v);
  }
});

test('backend enums pass through propertyTypeToBackend unchanged', () => {
  for (const v of PROPERTY_TYPES) {
    assert.equal(propertyTypeToBackend(v), v);
  }
});

test('backend enums pass through listingIntentToBackend unchanged', () => {
  for (const v of LISTING_INTENTS) {
    assert.equal(listingIntentToBackend(v), v);
  }
});

// ---------------------------------------------------------------------------
// Specific seed → backend mappings
// ---------------------------------------------------------------------------

test('seed propertyType values map to correct backend enums', () => {
  assert.equal(propertyTypeToBackend('1BHK Apartment'), 'apartment');
  assert.equal(propertyTypeToBackend('2BHK Apartment'), 'apartment');
  assert.equal(propertyTypeToBackend('3BHK Apartment'), 'apartment');
  assert.equal(propertyTypeToBackend('4BHK Sky Villa'), 'villa');
  assert.equal(propertyTypeToBackend('4BHK Villa'), 'villa');
  assert.equal(propertyTypeToBackend('Managed Office'), 'office');
  assert.equal(propertyTypeToBackend('Residential Plot'), 'land_parcel');
  assert.equal(propertyTypeToBackend('Shared Room (PG)'), 'pg_room');
  assert.equal(propertyTypeToBackend('Single Room (PG)'), 'pg_room');
});

test('seed listingIntent values map to correct backend enums', () => {
  assert.equal(listingIntentToBackend('rent-out'), 'available_for_rent');
  assert.equal(listingIntentToBackend('sell'), 'available_for_sale');
  assert.equal(listingIntentToBackend('sell-plot'), 'available_for_sale');
  assert.equal(listingIntentToBackend('list-pg'), 'available_for_rent');
  assert.equal(listingIntentToBackend('lease-out'), 'available_for_rent');
});

test('seed serviceCategory values map to correct backend enums', () => {
  assert.equal(serviceCategoryToBackend('rent'), 'rent');
  assert.equal(serviceCategoryToBackend('pg'), 'pg');
  assert.equal(serviceCategoryToBackend('land'), 'land');
  assert.equal(serviceCategoryToBackend('office'), 'office');
  assert.equal(serviceCategoryToBackend('resale'), 'sell');
  assert.equal(serviceCategoryToBackend('owner-listed'), 'sell');
});

// ---------------------------------------------------------------------------
// Reverse mapping (backend → frontend)
// ---------------------------------------------------------------------------

test('backend serviceCategory enums map back to frontend labels', () => {
  assert.equal(serviceCategoryToFrontend('rent'), 'rent');
  assert.equal(serviceCategoryToFrontend('pg'), 'pg');
  assert.equal(serviceCategoryToFrontend('buy'), 'buy');
  assert.equal(serviceCategoryToFrontend('sell'), 'sell');
  assert.equal(serviceCategoryToFrontend('land'), 'land');
  assert.equal(serviceCategoryToFrontend('office'), 'office');
  assert.equal(serviceCategoryToFrontend('commercial'), 'commercial');
});

test('backend propertyType enums map back to frontend labels', () => {
  assert.equal(propertyTypeToFrontend('apartment'), 'apartment');
  assert.equal(propertyTypeToFrontend('independent_house'), 'independent_house');
  assert.equal(propertyTypeToFrontend('villa'), 'villa');
  assert.equal(propertyTypeToFrontend('pg_bed'), 'pg_bed');
  assert.equal(propertyTypeToFrontend('pg_room'), 'pg_room');
  assert.equal(propertyTypeToFrontend('land_parcel'), 'land_parcel');
  assert.equal(propertyTypeToFrontend('office'), 'office');
  assert.equal(propertyTypeToFrontend('shop'), 'shop');
  assert.equal(propertyTypeToFrontend('warehouse'), 'warehouse');
  assert.equal(propertyTypeToFrontend('plot'), 'plot');
});

test('backend listingIntent enums map back to frontend labels', () => {
  assert.equal(listingIntentToFrontend('available_for_rent'), 'available_for_rent');
  assert.equal(listingIntentToFrontend('available_for_sale'), 'available_for_sale');
  assert.equal(listingIntentToFrontend('wanted'), 'wanted');
  assert.equal(listingIntentToFrontend('client_requirement'), 'client_requirement');
});

// ---------------------------------------------------------------------------
// DTO / payload translation
// ---------------------------------------------------------------------------

test('listingDtoToFrontend translates all three enum fields', () => {
  const dto = {
    id: 'l_test',
    serviceCategory: 'sell',
    propertyType: 'apartment',
    listingIntent: 'available_for_rent',
  };
  const result = listingDtoToFrontend(dto);
  assert.equal(result.serviceCategory, 'sell');
  assert.equal(result.propertyType, 'apartment');
  assert.equal(result.listingIntent, 'available_for_rent');
  // Original is not mutated
  assert.equal(dto.serviceCategory, 'sell');
});

test('listingPayloadToBackend translates all three enum fields', () => {
  const payload = {
    serviceCategory: 'resale',
    propertyType: '2BHK Apartment',
    listingIntent: 'rent-out',
  };
  const result = listingPayloadToBackend(payload);
  assert.equal(result.serviceCategory, 'sell');
  assert.equal(result.propertyType, 'apartment');
  assert.equal(result.listingIntent, 'available_for_rent');
  // Original is not mutated
  assert.equal(payload.serviceCategory, 'resale');
});

test('listingPayloadToBackend leaves non-enum fields unchanged', () => {
  const payload = {
    serviceCategory: 'rent',
    propertyType: 'apartment',
    listingIntent: 'available_for_rent',
    title: 'Test',
    city: 'Bangalore',
  };
  const result = listingPayloadToBackend(payload);
  assert.equal(result.title, 'Test');
  assert.equal(result.city, 'Bangalore');
});

// ---------------------------------------------------------------------------
// Ambiguous mappings are flagged
// ---------------------------------------------------------------------------

test('ambiguous propertyType mappings are flagged', () => {
  assert.ok(AMBIGUOUS_PROPERTY_TYPES.length > 0, 'expected at least one ambiguous propertyType');
  const seeds = AMBIGUOUS_PROPERTY_TYPES.map((m) => m.seed);
  assert.ok(seeds.includes('4BHK Apartment'), '4BHK Apartment should be flagged');
  assert.ok(seeds.includes('Penthouse'), 'Penthouse should be flagged');
  assert.ok(seeds.includes('Commercial Plot'), 'Commercial Plot should be flagged');
});

test('ambiguous listingIntent mappings are flagged', () => {
  assert.ok(AMBIGUOUS_LISTING_INTENTS.length > 0, 'expected at least one ambiguous listingIntent');
  const seeds = AMBIGUOUS_LISTING_INTENTS.map((m) => m.seed);
  assert.ok(seeds.includes('lease-out'), 'lease-out should be flagged');
  assert.ok(seeds.includes('list-office'), 'list-office should be flagged');
});

test('ambiguous serviceCategory mappings are flagged', () => {
  assert.ok(AMBIGUOUS_SERVICE_CATEGORIES.length > 0, 'expected at least one ambiguous serviceCategory');
  const seeds = AMBIGUOUS_SERVICE_CATEGORIES.map((m) => m.seed);
  assert.ok(seeds.includes('resale'), 'resale should be flagged');
  assert.ok(seeds.includes('owner-listed'), 'owner-listed should be flagged');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('null and undefined values pass through unchanged', () => {
  assert.equal(serviceCategoryToBackend(null), null);
  assert.equal(serviceCategoryToBackend(undefined), undefined);
  assert.equal(propertyTypeToBackend(null), null);
  assert.equal(propertyTypeToBackend(undefined), undefined);
  assert.equal(listingIntentToBackend(null), null);
  assert.equal(listingIntentToBackend(undefined), undefined);
});

test('unknown values pass through unchanged (no silent mapping)', () => {
  assert.equal(serviceCategoryToBackend('unknown-category'), 'unknown-category');
  assert.equal(propertyTypeToBackend('unknown-type'), 'unknown-type');
  assert.equal(listingIntentToBackend('unknown-intent'), 'unknown-intent');
});

test('listingDtoToFrontend handles null input', () => {
  assert.equal(listingDtoToFrontend(null), null);
});

test('listingPayloadToBackend handles null input', () => {
  assert.equal(listingPayloadToBackend(null), null);
});
