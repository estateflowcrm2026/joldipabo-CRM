import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScheduleVisit, validateVisitAssignment, validateVisitList, validateVisitStatus, validateVisitViewing } from './visitValidation.js';
import { scopeFilterFor } from '../rbac/scopeFilters.js';
import { can, DEFAULT_PERMISSION_MATRIX } from '../rbac/permissions.js';
import { leadVisitSummary } from './visitsRepository.js';

test('visit creation requires a lead, active assignee identifier and valid time', () => {
  assert.equal(validateScheduleVisit({ leadId: 'ld_1', assignedTo: 'u_1', scheduledAt: '2026-10-04T10:00:00Z' }).listingId, null);
  assert.throws(() => validateScheduleVisit({ leadId: 'ld_1', assignedTo: 'u_1', scheduledAt: 'bad' }), /scheduledAt/);
  assert.throws(() => validateScheduleVisit({ leadId: 'ld_1', assignedTo: 'u_1', scheduledAt: '2026-10-04T10:00:00Z', tenantId: 'other' }), /tenantId/);
});

test('status changes follow the visit lifecycle and rescheduling needs a new time', () => {
  assert.equal(validateVisitStatus({ status: 'Accepted' }, 'Assigned').status, 'Accepted');
  assert.equal(validateVisitStatus({ status: 'Completed' }, 'Client assisted').status, 'Completed');
  assert.throws(() => validateVisitStatus({ status: 'Completed' }, 'Assigned'), /Cannot change/);
  assert.throws(() => validateVisitStatus({ status: 'Visit rescheduled' }, 'Assigned'), /new date/);
  assert.throws(() => validateVisitStatus({ status: 'Accepted' }, 'Completed'), /Cannot change/);
  assert.throws(() => validateVisitStatus({ status: 'Accepted', actorId: 'u_2' }, 'Assigned'), /actorId/);
});

test('viewing and reassignment bodies reject client-controlled agent and tenant fields', () => {
  assert.equal(validateVisitViewing({ listingId: 'ls_1', shownAt: '2026-10-04T10:00:00Z', assistanceStatus: 'assisted' }).feedback, null);
  assert.throws(() => validateVisitViewing({ listingId: 'ls_1', shownAt: '2026-10-04T10:00:00Z', assistanceStatus: 'assisted', agentId: 'u_2' }), /agentId/);
  assert.throws(() => validateVisitViewing({ listingId: 'ls_1', shownAt: '2026-10-04T10:00:00Z', assistanceStatus: 'made_up' }), /assistanceStatus/);
  assert.equal(validateVisitAssignment({ assignedTo: 'u_1' }).assignedTo, 'u_1');
  assert.throws(() => validateVisitAssignment({ assignedTo: 'u_1', teamId: 'other' }), /teamId/);
});

test('own visit scope is the assigned executive, in SQL and in memory', () => {
  const user = { id: 'u_1', tenantId: 'org_1', permissionMatrix: DEFAULT_PERMISSION_MATRIX['field-executive'] };
  assert.deepEqual(scopeFilterFor(user, 'visits', 'view', { table: 'v' }), {
    sql: 'v.tenant_id = $1 AND v.assigned_to = $2', params: ['org_1', 'u_1'],
  });
  assert.equal(can(user, 'visits', 'view', { assignedTo: 'u_1' }), true);
  assert.equal(can(user, 'visits', 'view', { assignedTo: 'u_2' }), false);
});

test('telecaller may coordinate their team visits, not another team', () => {
  const user = { id: 'u_1', tenantId: 'org_1', teamId: 't_1', permissionMatrix: DEFAULT_PERMISSION_MATRIX.telecaller };
  assert.equal(can(user, 'visits', 'create', { teamId: 't_1', assignedTo: 'u_2' }), true);
  assert.equal(can(user, 'visits', 'create', { teamId: 't_2', assignedTo: 'u_3' }), false);
});

test('lead visit summary reflects all visits, not whichever visit changed last', () => {
  assert.equal(leadVisitSummary(['Completed', 'Assigned']), 'visit_planned');
  assert.equal(leadVisitSummary(['Completed', 'Visit cancelled']), 'visit_completed');
  assert.equal(leadVisitSummary(['Client did not attend', 'Visit cancelled']), 'no_show');
  assert.equal(leadVisitSummary(['Visit cancelled']), 'visit_cancelled');
  assert.equal(leadVisitSummary([]), 'no_visit_planned');
});

test('visit list filters default to newest-first and reject unknown keys', () => {
  const defaults = validateVisitList({});
  assert.equal(defaults.order, 'desc');
  assert.equal(defaults.leadId, undefined);
  const board = validateVisitList({
    status: 'Assigned', assignedTo: 'u_1', from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z', order: 'asc',
  });
  assert.equal(board.status, 'Assigned');
  assert.equal(board.assignedTo, 'u_1');
  assert.equal(board.from, '2026-10-04T00:00:00.000Z');
  assert.equal(board.to, '2026-10-05T00:00:00.000Z');
  assert.equal(board.order, 'asc');
  assert.throws(() => validateVisitList({ unknown: 'x' }), /unknown/);
  assert.throws(() => validateVisitList({ order: 'random' }), /order/);
  assert.throws(() => validateVisitList({ from: 'bad' }), /from/);
});
