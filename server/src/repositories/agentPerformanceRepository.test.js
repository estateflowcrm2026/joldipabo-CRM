import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateRange, validatePerformanceFilters } from './agentPerformanceRepository.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');

test('monthly preset defaults to the last 30 days ending now', () => {
  const range = resolveDateRange({}, NOW);
  assert.equal(range.to, NOW.toISOString());
  assert.equal(range.from, new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
});

test('weekly and yearly presets span 7 and 365 days', () => {
  assert.equal(
    resolveDateRange({ preset: 'weekly' }, NOW).from,
    new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
  );
  assert.equal(
    resolveDateRange({ preset: 'yearly' }, NOW).from,
    new Date(NOW.getTime() - 365 * 86_400_000).toISOString(),
  );
});

test('custom range is half-open at the next UTC midnight after to', () => {
  const range = resolveDateRange({ preset: 'custom', from: '2026-09-01', to: '2026-09-07' }, NOW);
  assert.equal(range.from, new Date('2026-09-01T00:00:00.000Z').toISOString());
  assert.equal(range.to, new Date('2026-09-08T00:00:00.000Z').toISOString());
});

test('custom range rejects inverted dates, missing bounds and overlong windows', () => {
  assert.throws(
    () => resolveDateRange({ preset: 'custom', from: '2026-09-07', to: '2026-09-01' }, NOW),
    /before/,
  );
  assert.throws(() => resolveDateRange({ preset: 'custom', from: '2026-09-01' }, NOW), /requires from and to/);
  assert.throws(
    () => resolveDateRange({ preset: 'custom', from: '2024-01-01', to: '2026-10-03' }, NOW),
    /exceed/,
  );
  assert.throws(() => resolveDateRange({ preset: 'daily' }, NOW), /preset/);
  assert.throws(() => resolveDateRange({ preset: 'custom', from: 'not-a-date', to: '2026-09-01' }, NOW), /valid date/);
});

test('filter validation trims agentId and defaults preset to monthly', () => {
  const filters = validatePerformanceFilters({ agentId: '  u-asha  ' }, NOW);
  assert.equal(filters.agentId, 'u-asha');
  assert.equal(filters.to, NOW.toISOString());
  assert.equal(validatePerformanceFilters({}, NOW).agentId, null);
  assert.throws(() => validatePerformanceFilters({ agentId: 'x'.repeat(101) }, NOW), /too long/);
});
