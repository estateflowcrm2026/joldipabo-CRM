// Validation unit tests for the listings write surface.
//
// Pure-function tests against listingValidation.js — no DB, no Fastify.
// Run via `npm test` (the glob `src/repositories/*.test.js`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAddListingPhoto,
  validateAssignListing,
  validateCreateListing,
  validateUpdateListing,
  validateVerifyListing,
} from './listingValidation.js';

test('validateCreateListing: minimum valid rent listing', () => {
  const out = validateCreateListing({
    serviceCategory: 'rent',
    propertyType: 'apartment',
    listingIntent: 'available_for_rent',
    title: '3BHK in Indiranagar',
    rentMonthly: 65000,
    city: 'Bangalore',
  });
  assert.equal(out.serviceCategory, 'rent');
  assert.equal(out.propertyType, 'apartment');
  assert.equal(out.title, '3BHK in Indiranagar');
  assert.equal(out.rentMonthly, 65000);
});

test('validateCreateListing: rejects missing title', () => {
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
    }),
    (err) => err.code === 'invalid-payload' && err.message.includes('title'),
  );
});

test('validateCreateListing: rejects unknown serviceCategory', () => {
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'garage',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
      title: 'X',
    }),
    (err) => err.code === 'invalid-enum' && err.message.includes('serviceCategory'),
  );
});

test('validateCreateListing: rejects intent/category mismatch', () => {
  // rent + available_for_sale is not typical
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_sale',
      title: 'X',
    }),
    (err) => err.code === 'invalid-intent-for-category',
  );
});

test('validateCreateListing: rent listing with price (no rentMonthly) is rejected', () => {
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
      title: 'X',
      price: 50000,
    }),
    (err) => err.code === 'rent-prefers-monthly',
  );
});

test('validateCreateListing: rejects negative price', () => {
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'buy',
      propertyType: 'apartment',
      listingIntent: 'available_for_sale',
      title: 'X',
      price: -1,
    }),
    (err) => err.code === 'invalid-field' && err.message.includes('price'),
  );
});

test('validateCreateListing: rejects malformed geo', () => {
  // lat provided as a non-numeric string trips parsePositiveNumber first.
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
      title: 'X',
      geo: { lat: 'north' },
    }),
    (err) => err.code === 'invalid-field' && err.message.includes('geo.lat'),
  );
});

test('validateCreateListing: rejects out-of-range geo.lat', () => {
  // parsePositiveNumber accepts up to 1e12; 999 < 90, so the lat range
  // check fires first with the explicit range error.
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
      title: 'X',
      geo: { lat: 999, lng: 0 },
    }),
    (err) => err.code === 'invalid-field' && err.message.includes('geo.lat'),
  );
});

test('validateCreateListing: accepts amenities array', () => {
  const out = validateCreateListing({
    serviceCategory: 'rent',
    propertyType: 'apartment',
    listingIntent: 'available_for_rent',
    title: 'X',
    amenities: ['Parking', 'Gym'],
  });
  assert.deepEqual(out.amenities, ['Parking', 'Gym']);
});

test('validateCreateListing: rejects amenities containing non-string', () => {
  assert.throws(
    () => validateCreateListing({
      serviceCategory: 'rent',
      propertyType: 'apartment',
      listingIntent: 'available_for_rent',
      title: 'X',
      amenities: ['Parking', 42],
    }),
    (err) => err.code === 'invalid-amenities',
  );
});

test('validateUpdateListing: rejects forbidden fields', () => {
  assert.throws(
    () => validateUpdateListing({ id: 'l_evil', tenantId: 'org_evil' }),
    (err) => err.code === 'forbidden-field',
  );
});

test('validateUpdateListing: accepts a single-field patch', () => {
  const out = validateUpdateListing({ title: 'Renamed' });
  assert.deepEqual(out, { title: 'Renamed' });
});

test('validateUpdateListing: rejects empty title', () => {
  assert.throws(
    () => validateUpdateListing({ title: '   ' }),
    (err) => err.code === 'invalid-payload',
  );
});

test('validateUpdateListing: rejects non-objects', () => {
  assert.throws(
    () => validateUpdateListing('hello'),
    (err) => err.code === 'invalid-payload',
  );
});

test('validateAssignListing: requires assignedUserId', () => {
  assert.throws(
    () => validateAssignListing({}),
    (err) => err.code === 'invalid-payload' && err.message.includes('assignedUserId'),
  );
});

test('validateAssignListing: trims reason', () => {
  const out = validateAssignListing({ assignedUserId: 'u-raj', reason: '  shift change  ' });
  assert.equal(out.assignedUserId, 'u-raj');
  assert.equal(out.reason, 'shift change');
});

test('validateVerifyListing: rejects unknown status', () => {
  assert.throws(
    () => validateVerifyListing({ status: 'unknown' }),
    (err) => err.code === 'invalid-enum',
  );
});

test('validateVerifyListing: requires reason on rejected', () => {
  assert.throws(
    () => validateVerifyListing({ status: 'rejected' }),
    (err) => err.code === 'reason-required',
  );
});

test('validateVerifyListing: accepts verified without reason', () => {
  const out = validateVerifyListing({ status: 'verified' });
  assert.equal(out.status, 'verified');
  assert.equal(out.reason, undefined);
});

test('validateAddListingPhoto: requires objectKey', () => {
  assert.throws(
    () => validateAddListingPhoto({}),
    (err) => err.code === 'invalid-payload' && err.message.includes('objectKey'),
  );
});

test('validateAddListingPhoto: rejects unknown category', () => {
  assert.throws(
    () => validateAddListingPhoto({ objectKey: 'k', category: 'Bogus' }),
    (err) => err.code === 'invalid-enum',
  );
});

test('validateAddListingPhoto: accepts Interior category', () => {
  const out = validateAddListingPhoto({ objectKey: 'listings/x/y.jpg', category: 'Interior', caption: 'Hall' });
  assert.equal(out.category, 'Interior');
  assert.equal(out.caption, 'Hall');
});
