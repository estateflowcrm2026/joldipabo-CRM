import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact, validateCall } from './contactValidation.js';

test('contact validation accepts manual intake and rejects owner injection', () => {
  assert.equal(validateContact({ name: ' Asha ', phone: ' 9876543210 ', requirements: '2 BHK' }).name, 'Asha');
  assert.throws(() => validateContact({ name: 'Asha', phone: '1', ownerId: 'other' }), /server-owned/);
  assert.throws(() => validateContact({ phone: '1' }), /name is required/);
});

test('call validation requires bounded, meaningful event fields', () => {
  const input = { direction: 'inbound', outcome: 'interested', occurredAt: '2026-10-02T10:00:00Z', durationSeconds: 42 };
  assert.equal(validateCall(input).durationSeconds, 42);
  assert.throws(() => validateCall({ ...input, durationSeconds: -1 }), /durationSeconds/);
  assert.throws(() => validateCall({ ...input, outcome: 'Completed' }), /outcome/);
  assert.throws(() => validateCall({ ...input, tenantId: 'other' }), /server-owned/);
});
