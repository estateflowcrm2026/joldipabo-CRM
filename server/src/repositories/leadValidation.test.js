// Unit tests for leadValidation.js — pure functions, no DB, no I/O.
//
// Covers:
//   * validateCreateLead — required fields, enums, cross-field rules,
//     integer parsing, date normalization, matchedListingIds rejection.
//   * validateUpdateLead — forbidden fields, partial updates, same rules.
//   * validateAssignLead — required assignedUserId, optional reason.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreateLead,
  validateUpdateLead,
  validateAssignLead,
  LEAD_STATUSES,
  LEAD_SCORES,
  SERVICE_NEEDS,
  CLIENT_TYPES,
  DESIRED_PROPERTY_TYPES,
  PURCHASE_TIMELINES,
  VISIT_STATUSES,
  LEAD_SOURCES,
} from './leadValidation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectThrow(fn, code, messagePart) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `Expected code "${code}", got "${err.code}"`);
    if (messagePart) {
      assert.ok(
        err.message.includes(messagePart),
        `Expected message to include "${messagePart}", got "${err.message}"`,
      );
    }
    return err;
  }
  assert.fail(`Expected throw with code "${code}", but no error was thrown.`);
}

// ---------------------------------------------------------------------------
// validateCreateLead — happy path
// ---------------------------------------------------------------------------

describe('validateCreateLead — happy path', () => {
  it('accepts a minimal valid body (name + phone only)', () => {
    const result = validateCreateLead({ name: 'Alice', phone: '9998887777' });
    assert.equal(result.name, 'Alice');
    assert.equal(result.phone, '9998887777');
    assert.equal(result.email, undefined);
    assert.equal(result.status, undefined);
  });

  it('accepts a fully-populated body', () => {
    const result = validateCreateLead({
      name: 'Bob',
      phone: '1234567890',
      email: 'bob@example.com',
      projectId: 'prj_1',
      status: 'Contacted',
      score: 'hot',
      budgetMin: 100000,
      budgetMax: 500000,
      source: 'Website',
      notes: 'Interested in 2BHK',
      ownerId: 'usr_1',
      teamId: 'team_1',
      nextFollowUp: '2026-10-15T10:00:00.000Z',
      serviceNeed: 'rent',
      clientType: 'tenant',
      requirements: { bedrooms: 2 },
      rentMin: 10000,
      rentMax: 20000,
      preferredLocation: 'Indiranagar',
      desiredPropertyType: 'apartment',
      moveInDate: '2026-11-01',
      purchaseTimeline: 'within_3_months',
      visitStatus: 'visit_planned',
    });
    assert.equal(result.name, 'Bob');
    assert.equal(result.email, 'bob@example.com');
    assert.equal(result.status, 'Contacted');
    assert.equal(result.score, 'hot');
    assert.equal(result.budgetMin, 100000);
    assert.equal(result.budgetMax, 500000);
    assert.equal(result.serviceNeed, 'rent');
    assert.equal(result.clientType, 'tenant');
    assert.deepEqual(result.requirements, { bedrooms: 2 });
    assert.equal(result.rentMin, 10000);
    assert.equal(result.rentMax, 20000);
    assert.equal(result.preferredLocation, 'Indiranagar');
    assert.equal(result.desiredPropertyType, 'apartment');
    assert.equal(result.moveInDate, '2026-11-01');
    assert.equal(result.purchaseTimeline, 'within_3_months');
    assert.equal(result.visitStatus, 'visit_planned');
  });

  it('trims whitespace from string fields', () => {
    const result = validateCreateLead({ name: '  Alice  ', phone: '  999  ' });
    assert.equal(result.name, 'Alice');
    assert.equal(result.phone, '999');
  });

  it('normalizes nextFollowUp to ISO string', () => {
    const result = validateCreateLead({
      name: 'Alice',
      phone: '999',
      nextFollowUp: '2026-10-15T10:30:00.000Z',
    });
    assert.equal(result.nextFollowUp, '2026-10-15T10:30:00.000Z');
  });

  it('normalizes moveInDate to YYYY-MM-DD', () => {
    const result = validateCreateLead({
      name: 'Alice',
      phone: '999',
      moveInDate: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(result.moveInDate, '2026-11-01');
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — required fields
// ---------------------------------------------------------------------------

describe('validateCreateLead — required fields', () => {
  it('throws when name is missing', () => {
    expectThrow(
      () => validateCreateLead({ phone: '999' }),
      'invalid-payload',
      'name is required',
    );
  });

  it('throws when name is empty string', () => {
    expectThrow(
      () => validateCreateLead({ name: '', phone: '999' }),
      'invalid-payload',
      'name is required',
    );
  });

  it('throws when name is whitespace only', () => {
    expectThrow(
      () => validateCreateLead({ name: '   ', phone: '999' }),
      'invalid-payload',
      'name is required',
    );
  });

  it('throws when phone is missing', () => {
    expectThrow(
      () => validateCreateLead({ name: 'Alice' }),
      'invalid-payload',
      'phone is required',
    );
  });

  it('throws when phone is empty string', () => {
    expectThrow(
      () => validateCreateLead({ name: 'Alice', phone: '' }),
      'invalid-payload',
      'phone is required',
    );
  });

  it('throws when body is not an object', () => {
    expectThrow(() => validateCreateLead(null), 'invalid-payload');
    expectThrow(() => validateCreateLead('string'), 'invalid-payload');
    expectThrow(() => validateCreateLead(42), 'invalid-payload');
    expectThrow(() => validateCreateLead([]), 'invalid-payload');
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — enum validation
// ---------------------------------------------------------------------------

describe('validateCreateLead — enum validation', () => {
  it('accepts all valid statuses', () => {
    for (const status of LEAD_STATUSES) {
      const result = validateCreateLead({ name: 'A', phone: '1', status });
      assert.equal(result.status, status);
    }
  });

  it('rejects an invalid status', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', status: 'Invalid' }),
      'invalid-enum',
      'status',
    );
  });

  it('accepts all valid scores', () => {
    for (const score of LEAD_SCORES) {
      const result = validateCreateLead({ name: 'A', phone: '1', score });
      assert.equal(result.score, score);
    }
  });

  it('rejects an invalid score', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', score: 'lukewarm' }),
      'invalid-enum',
      'score',
    );
  });

  it('accepts all valid serviceNeeds', () => {
    for (const sn of SERVICE_NEEDS) {
      const result = validateCreateLead({ name: 'A', phone: '1', serviceNeed: sn });
      assert.equal(result.serviceNeed, sn);
    }
  });

  it('rejects an invalid serviceNeed', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', serviceNeed: 'unknown' }),
      'invalid-enum',
      'serviceNeed',
    );
  });

  it('accepts all valid clientTypes', () => {
    for (const ct of CLIENT_TYPES) {
      const result = validateCreateLead({ name: 'A', phone: '1', clientType: ct });
      assert.equal(result.clientType, ct);
    }
  });

  it('rejects an invalid clientType', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', clientType: 'alien' }),
      'invalid-enum',
      'clientType',
    );
  });

  it('accepts all valid desiredPropertyTypes', () => {
    for (const dpt of DESIRED_PROPERTY_TYPES) {
      const result = validateCreateLead({ name: 'A', phone: '1', desiredPropertyType: dpt });
      assert.equal(result.desiredPropertyType, dpt);
    }
  });

  it('rejects an invalid desiredPropertyType', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', desiredPropertyType: 'castle' }),
      'invalid-enum',
      'desiredPropertyType',
    );
  });

  it('accepts all valid purchaseTimelines', () => {
    for (const pt of PURCHASE_TIMELINES) {
      const result = validateCreateLead({ name: 'A', phone: '1', purchaseTimeline: pt });
      assert.equal(result.purchaseTimeline, pt);
    }
  });

  it('rejects an invalid purchaseTimeline', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', purchaseTimeline: 'someday' }),
      'invalid-enum',
      'purchaseTimeline',
    );
  });

  it('accepts all valid visitStatuses', () => {
    for (const vs of VISIT_STATUSES) {
      const result = validateCreateLead({ name: 'A', phone: '1', visitStatus: vs });
      assert.equal(result.visitStatus, vs);
    }
  });

  it('rejects an invalid visitStatus', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', visitStatus: 'teleported' }),
      'invalid-enum',
      'visitStatus',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — integer parsing
// ---------------------------------------------------------------------------

describe('validateCreateLead — integer parsing', () => {
  it('accepts integer numbers', () => {
    const result = validateCreateLead({ name: 'A', phone: '1', budgetMin: 100, budgetMax: 200 });
    assert.equal(result.budgetMin, 100);
    assert.equal(result.budgetMax, 200);
  });

  it('accepts integer strings', () => {
    const result = validateCreateLead({ name: 'A', phone: '1', budgetMin: '100', budgetMax: '200' });
    assert.equal(result.budgetMin, 100);
    assert.equal(result.budgetMax, 200);
  });

  it('rejects float numbers', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: 1.5 }),
      'invalid-field',
      'budgetMin must be an integer',
    );
  });

  it('rejects float strings', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: '1.5' }),
      'invalid-field',
      'budgetMin must be an integer',
    );
  });

  it('rejects malformed numeric strings like "12abc"', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: '12abc' }),
      'invalid-field',
      'budgetMin must be an integer',
    );
  });

  it('rejects negative numbers', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: -1 }),
      'invalid-field',
      'budgetMin must be >= 0',
    );
  });

  it('rejects negative rentMin', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', rentMin: -100 }),
      'invalid-field',
      'rentMin must be >= 0',
    );
  });

  it('rejects non-numeric types (boolean)', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: true }),
      'invalid-field',
      'budgetMin must be an integer',
    );
  });

  it('rejects non-numeric types (object)', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: {} }),
      'invalid-field',
      'budgetMin must be an integer',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — cross-field rules
// ---------------------------------------------------------------------------

describe('validateCreateLead — cross-field rules', () => {
  it('rejects budgetMin > budgetMax', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', budgetMin: 500, budgetMax: 100 }),
      'invalid-field',
      'budgetMin must be <= budgetMax',
    );
  });

  it('accepts budgetMin === budgetMax', () => {
    const result = validateCreateLead({ name: 'A', phone: '1', budgetMin: 100, budgetMax: 100 });
    assert.equal(result.budgetMin, 100);
    assert.equal(result.budgetMax, 100);
  });

  it('rejects rentMin > rentMax', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', rentMin: 5000, rentMax: 1000 }),
      'invalid-field',
      'rentMin must be <= rentMax',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — matchedListingIds rejection
// ---------------------------------------------------------------------------

describe('validateCreateLead — matchedListingIds rejection', () => {
  it('throws when matchedListingIds is provided', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', matchedListingIds: ['l1'] }),
      'field-not-writable',
      'matchedListingIds is not writable',
    );
  });

  it('throws even when matchedListingIds is an empty array', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', matchedListingIds: [] }),
      'field-not-writable',
      'matchedListingIds is not writable',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — string length limits
// ---------------------------------------------------------------------------

describe('validateCreateLead — string length limits', () => {
  it('rejects name exceeding 200 chars', () => {
    expectThrow(
      () => validateCreateLead({ name: 'x'.repeat(201), phone: '1' }),
      'invalid-field',
      'maximum length',
    );
  });

  it('rejects phone exceeding 40 chars', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1'.repeat(41) }),
      'invalid-field',
      'maximum length',
    );
  });

  it('rejects email exceeding 200 chars', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', email: 'x'.repeat(201) }),
      'invalid-field',
      'maximum length',
    );
  });

  it('rejects notes exceeding 4000 chars', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', notes: 'x'.repeat(4001) }),
      'invalid-field',
      'maximum length',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — date validation
// ---------------------------------------------------------------------------

describe('validateCreateLead — date validation', () => {
  it('rejects invalid nextFollowUp date', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', nextFollowUp: 'not-a-date' }),
      'invalid-field',
      'nextFollowUp must be a valid date',
    );
  });

  it('rejects invalid moveInDate date', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', moveInDate: 'not-a-date' }),
      'invalid-field',
      'moveInDate must be a valid date',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCreateLead — requirements object
// ---------------------------------------------------------------------------

describe('validateCreateLead — requirements object', () => {
  it('accepts a plain object', () => {
    const result = validateCreateLead({ name: 'A', phone: '1', requirements: { bedrooms: 2 } });
    assert.deepEqual(result.requirements, { bedrooms: 2 });
  });

  it('rejects an array', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', requirements: [1, 2] }),
      'invalid-field',
      'requirements must be an object',
    );
  });

  it('rejects a string', () => {
    expectThrow(
      () => validateCreateLead({ name: 'A', phone: '1', requirements: '2BHK' }),
      'invalid-field',
      'requirements must be an object',
    );
  });
});

// ---------------------------------------------------------------------------
// validateUpdateLead — happy path
// ---------------------------------------------------------------------------

describe('validateUpdateLead — happy path', () => {
  it('accepts an empty body (no-op patch)', () => {
    const result = validateUpdateLead({});
    assert.deepEqual(result, {});
  });

  it('accepts a partial update', () => {
    const result = validateUpdateLead({ status: 'Contacted', score: 'warm' });
    assert.equal(result.status, 'Contacted');
    assert.equal(result.score, 'warm');
  });

  it('allows a follow-up date to be cleared explicitly', () => {
    assert.deepEqual(validateUpdateLead({ nextFollowUp: null }), { nextFollowUp: null });
  });

  it('accepts null to clear a field', () => {
    const result = validateUpdateLead({ email: null, notes: null });
    assert.equal(result.email, undefined);
    assert.equal(result.notes, undefined);
  });
});

// ---------------------------------------------------------------------------
// validateUpdateLead — forbidden fields
// ---------------------------------------------------------------------------

describe('validateUpdateLead — forbidden fields', () => {
  const forbidden = ['id', 'tenantId', 'tenant_id', 'createdBy', 'created_by', 'createdAt', 'created_at', 'deletedAt', 'deleted_at'];
  for (const field of forbidden) {
    it(`rejects forbidden field "${field}"`, () => {
      expectThrow(
        () => validateUpdateLead({ [field]: 'value' }),
        'forbidden-field',
        field,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// validateUpdateLead — same validation rules as create
// ---------------------------------------------------------------------------

describe('validateUpdateLead — same validation rules as create', () => {
  it('rejects invalid status', () => {
    expectThrow(
      () => validateUpdateLead({ status: 'Invalid' }),
      'invalid-enum',
      'status',
    );
  });

  it('rejects budgetMin > budgetMax', () => {
    expectThrow(
      () => validateUpdateLead({ budgetMin: 500, budgetMax: 100 }),
      'invalid-field',
      'budgetMin must be <= budgetMax',
    );
  });

  it('rejects matchedListingIds', () => {
    expectThrow(
      () => validateUpdateLead({ matchedListingIds: ['l1'] }),
      'field-not-writable',
      'matchedListingIds is not writable',
    );
  });

  it('rejects empty name', () => {
    expectThrow(
      () => validateUpdateLead({ name: '' }),
      'invalid-payload',
      'name cannot be empty',
    );
  });

  it('rejects empty phone', () => {
    expectThrow(
      () => validateUpdateLead({ phone: '' }),
      'invalid-payload',
      'phone cannot be empty',
    );
  });
});

// ---------------------------------------------------------------------------
// validateAssignLead
// ---------------------------------------------------------------------------

describe('validateAssignLead', () => {
  it('accepts a valid body', () => {
    const result = validateAssignLead({ assignedUserId: 'usr_1', reason: 'Reassigning' });
    assert.equal(result.assignedUserId, 'usr_1');
    assert.equal(result.reason, 'Reassigning');
  });

  it('accepts without reason', () => {
    const result = validateAssignLead({ assignedUserId: 'usr_1' });
    assert.equal(result.assignedUserId, 'usr_1');
    assert.equal(result.reason, undefined);
  });

  it('throws when assignedUserId is missing', () => {
    expectThrow(
      () => validateAssignLead({}),
      'invalid-payload',
      'assignedUserId is required',
    );
  });

  it('throws when assignedUserId is empty', () => {
    expectThrow(
      () => validateAssignLead({ assignedUserId: '' }),
      'invalid-payload',
      'assignedUserId is required',
    );
  });

  it('throws when body is not an object', () => {
    expectThrow(() => validateAssignLead(null), 'invalid-payload');
    expectThrow(() => validateAssignLead('string'), 'invalid-payload');
  });

  it('trims whitespace from assignedUserId', () => {
    const result = validateAssignLead({ assignedUserId: '  usr_1  ' });
    assert.equal(result.assignedUserId, 'usr_1');
  });
});
