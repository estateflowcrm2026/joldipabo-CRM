// Unit tests for followUpValidation.js — pure functions, no DB, no I/O.
//
// Covers:
//   * validateFollowUpFilters — empty input, window normalisation,
//     set/unset, rejections (bad enum, bad date, contradictory combo).
//   * isFollowUpFiltered / followUpSortActive — which filter shapes drive
//     a WHERE clause and which drive oldest-due-first ordering.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFollowUpFilters,
  isFollowUpFiltered,
  followUpSortActive,
} from './followUpValidation.js';

test('follow-up filters default to empty and ignore unrelated keys', () => {
  assert.deepEqual(validateFollowUpFilters({}), {});
  assert.deepEqual(validateFollowUpFilters(), {});
  assert.deepEqual(validateFollowUpFilters(undefined), {});
  assert.deepEqual(validateFollowUpFilters({ q: 'asha', limit: 25 }), {});
});

test('follow-up windows normalise to ISO datetimes', () => {
  const out = validateFollowUpFilters({
    followUpFrom: '2026-10-04T00:00:00+05:30',
    followUpTo: '2026-10-05T00:00:00+05:30',
  });
  assert.equal(out.followUpFrom, '2026-10-03T18:30:00.000Z');
  assert.equal(out.followUpTo, '2026-10-04T18:30:00.000Z');
  assert.equal(out.followUpSet, undefined);
});

test('follow-up set/unset round-trips and combines with a window', () => {
  assert.equal(validateFollowUpFilters({ followUpSet: 'set' }).followUpSet, 'set');
  assert.equal(validateFollowUpFilters({ followUpSet: 'unset' }).followUpSet, 'unset');
  const combined = validateFollowUpFilters({ followUpSet: 'set', followUpTo: '2026-10-05T00:00:00Z' });
  assert.equal(combined.followUpSet, 'set');
  assert.equal(combined.followUpTo, '2026-10-05T00:00:00.000Z');
});

test('follow-up filters reject bad values loudly', () => {
  assert.throws(() => validateFollowUpFilters({ followUpSet: 'someday' }), /followUpSet/);
  assert.throws(() => validateFollowUpFilters({ followUpFrom: 'not-a-date' }), /followUpFrom/);
  assert.throws(() => validateFollowUpFilters({ followUpTo: 'yesterday-ish' }), /followUpTo/);
  // "Unset" contradicts a window: NULL dues never satisfy a comparison,
  // so this combination would silently return zero rows.
  assert.throws(
    () => validateFollowUpFilters({ followUpSet: 'unset', followUpFrom: '2026-10-04T00:00:00Z' }),
    /unset/,
  );
  assert.throws(
    () => validateFollowUpFilters({ followUpSet: 'unset', followUpTo: '2026-10-04T00:00:00Z' }),
    /unset/,
  );
});

test('isFollowUpFiltered detects any active predicate', () => {
  assert.equal(isFollowUpFiltered({}), false);
  assert.equal(isFollowUpFiltered(), false);
  assert.equal(isFollowUpFiltered({ status: 'New' }), false);
  assert.equal(isFollowUpFiltered({ followUpFrom: '2026-10-04T00:00:00.000Z' }), true);
  assert.equal(isFollowUpFiltered({ followUpTo: '2026-10-04T00:00:00.000Z' }), true);
  assert.equal(isFollowUpFiltered({ followUpSet: 'set' }), true);
  assert.equal(isFollowUpFiltered({ followUpSet: 'unset' }), true);
});

test('follow-up sort is oldest-due-first, except for pure unset lists', () => {
  assert.equal(followUpSortActive({}), false);
  assert.equal(followUpSortActive({ status: 'New' }), false);
  // A pure "no follow-up" list has no due time to sort by — keep newest-first.
  assert.equal(followUpSortActive({ followUpSet: 'unset' }), false);
  assert.equal(followUpSortActive({ followUpSet: 'set' }), true);
  assert.equal(followUpSortActive({ followUpFrom: '2026-10-04T00:00:00.000Z' }), true);
  assert.equal(followUpSortActive({ followUpTo: '2026-10-04T00:00:00.000Z' }), true);
});
