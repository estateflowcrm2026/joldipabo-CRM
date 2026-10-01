// Pure-logic tests for the listings repository helpers.
//
// These tests cover filter / pagination / DTO shaping without touching
// the database. The route-level auth + RBAC tests live in
// server/src/routes/listings.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListFilter,
  sanitisePagination,
  toListingDTO,
} from './listingsRepository.js';

const baseRow = {
  id: 'l_test',
  tenant_id: 'org_acme',
  service_category: 'rent',
  property_type: 'apartment',
  listing_intent: 'available_for_rent',
  title: 'Test',
  description: 'desc',
  address: 'addr',
  city: 'Bangalore',
  locality: 'Indiranagar',
  geo: { lat: 12.97, lng: 77.64 },
  price: null,
  rent_monthly: '65000',
  deposit: '200000',
  area_sqft: '1450.5',
  bedrooms: 3,
  bathrooms: 2,
  furnished: 'semi',
  amenities: ['Wi-Fi', 'Lift'],
  availability_status: 'available',
  verification_status: 'verified',
  owner_contact_name: 'Owner',
  owner_contact_phone: '+910000000000',
  owner_contact_email: null,
  assigned_to: 'u-asha',
  assigned_user_id: 'u-asha',
  assigned_user_name: 'Asha Rao',
  assigned_user_email: 'asha@acme.example',
  team_id: 't_north',
  project_id: null,
  project_pk: null,
  project_name: null,
  project_city: null,
  photo_count: 4,
  notes: null,
  created_by: 'u-asha',
  created_at: new Date('2026-09-23T10:00:00Z'),
  updated_at: new Date('2026-09-23T11:00:00Z'),
  deleted_at: null,
};

test('sanitisePagination clamps to [1, 100] and non-negative', () => {
  assert.deepEqual(sanitisePagination(), { limit: 25, offset: 0 });
  assert.deepEqual(sanitisePagination({ limit: 0 }), { limit: 1, offset: 0 });
  assert.deepEqual(sanitisePagination({ limit: -5 }), { limit: 1, offset: 0 });
  assert.deepEqual(sanitisePagination({ limit: 9999 }), { limit: 100, offset: 0 });
  assert.deepEqual(sanitisePagination({ limit: 50, offset: -1 }), { limit: 50, offset: 0 });
  assert.deepEqual(sanitisePagination({ limit: 50, offset: 200 }), { limit: 50, offset: 200 });
  assert.deepEqual(sanitisePagination({ limit: 'abc' }), { limit: 25, offset: 0 });
});

test('buildListFilter returns 1=1 when no filters provided', () => {
  const out = buildListFilter();
  assert.equal(out.sql, '1 = 1');
  assert.deepEqual(out.params, []);
});

test('buildListFilter adds single-column equality filters with sequential placeholders', () => {
  const out = buildListFilter({
    serviceCategory: 'rent',
    listingIntent: 'available_for_rent',
  });
  assert.equal(out.sql, 'l.service_category = $1 AND l.listing_intent = $2');
  assert.deepEqual(out.params, ['rent', 'available_for_rent']);
});

test('buildListFilter uses ILIKE for city substring', () => {
  const out = buildListFilter({ city: 'Banga' });
  assert.equal(out.sql, 'l.city ILIKE $1');
  assert.deepEqual(out.params, ['%Banga%']);
});

test('buildListFilter builds a 3-way OR for search across title/description/address', () => {
  const out = buildListFilter({ search: '3BHK' });
  assert.equal(
    out.sql,
    '(l.title ILIKE $1 OR l.description ILIKE $2 OR l.address ILIKE $3)',
  );
  assert.deepEqual(out.params, ['%3BHK%', '%3BHK%', '%3BHK%']);
});

test('buildListFilter combines multiple filters with AND', () => {
  const out = buildListFilter({
    serviceCategory: 'rent',
    city: 'Bangalore',
    assignedUserId: 'u-asha',
  });
  // Each filter consumes exactly one placeholder; the order in the clause
  // string mirrors the order in which keys appear in the implementation —
  // assert the SQL structurally rather than ordering the keys.
  assert.match(out.sql, /l\.service_category = \$\d+/);
  assert.match(out.sql, /l\.city ILIKE \$\d+/);
  assert.match(out.sql, /l\.assigned_to = \$\d+/);
  assert.match(out.sql, / AND /);
  // Every $n placeholder that appears in sql must have a matching param.
  const placeholders = [...out.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = Math.max(...placeholders);
  assert.equal(max, out.params.length);
  assert.deepEqual(new Set(placeholders).size, placeholders.length,
    'placeholders must be unique');
});

test('buildListFilter ignores empty-string filters', () => {
  const out = buildListFilter({
    serviceCategory: '',
    city: '   ',
    search: '',
  });
  assert.equal(out.sql, '1 = 1');
  assert.deepEqual(out.params, []);
});

test('toListingDTO parses numeric strings and shapes the frontend-friendly object', () => {
  const dto = toListingDTO(baseRow);
  assert.equal(dto.id, 'l_test');
  assert.equal(dto.tenantId, 'org_acme');
  assert.equal(dto.serviceCategory, 'rent');
  assert.equal(dto.propertyType, 'apartment');
  assert.equal(dto.listingIntent, 'available_for_rent');
  assert.deepEqual(dto.location, {
    address: 'addr',
    city: 'Bangalore',
    locality: 'Indiranagar',
    geo: { lat: 12.97, lng: 77.64 },
  });
  assert.deepEqual(dto.pricing, {
    price: null,
    rentMonthly: 65000,
    deposit: 200000,
    areaSqft: 1450.5,
  });
  assert.equal(dto.pricing.rentMonthly, 65000); // parsed from '65000'
  assert.equal(dto.assignedTo.id, 'u-asha');
  assert.equal(dto.assignedTo.name, 'Asha Rao');
  assert.equal(dto.project, null);
  assert.equal(dto.photoCount, 4);
  assert.equal(typeof dto.createdAt, 'string');
  assert.match(dto.createdAt, /^2026-09-23T/);
});

test('toListingDTO tolerates null numerics and missing user/project', () => {
  const dto = toListingDTO({ ...baseRow, price: null, assigned_to: null, assigned_user_id: null });
  assert.equal(dto.pricing.price, null);
  assert.equal(dto.assignedTo, null);
});

test('toListingDTO returns null for null input', () => {
  assert.equal(toListingDTO(null), null);
});

test('toListingDTO exposes teamId so route-level RBAC can scope by team', () => {
  // Regression: the DTO used to omit teamId, which made every team-scoped
  // can() check fail (record.teamId == undefined) and 404 the manager's own
  // team's listings. The route rebuilds the record shape from the DTO, so
  // teamId MUST be present.
  const dto = toListingDTO(baseRow);
  assert.equal(dto.teamId, 't_north');
});

test('toListingDTO tolerates null teamId (listing with no team)', () => {
  const dto = toListingDTO({ ...baseRow, team_id: null });
  assert.equal(dto.teamId, null);
});

test('toListingDTO exposes teamId for row-level RBAC', () => {
  // The route handlers rebuild the record shape for can() from the DTO.
  // Without teamId, team-scoped users always fail the scope check.
  const dto = toListingDTO(baseRow);
  assert.equal(dto.teamId, 't_north');
});

test('toListingDTO tolerates null teamId', () => {
  const dto = toListingDTO({ ...baseRow, team_id: null });
  assert.equal(dto.teamId, null);
});
