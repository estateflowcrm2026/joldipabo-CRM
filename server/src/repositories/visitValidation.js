import { BadRequest } from '../utils/errors.js';

export const VISIT_STATUSES = Object.freeze([
  'Assigned', 'Accepted', 'On the way', 'Reached', 'Client assisted',
  'Client did not attend', 'Visit cancelled', 'Visit rescheduled', 'Completed',
]);

const NEXT = Object.freeze({
  Scheduled: ['Assigned', 'Visit cancelled', 'Visit rescheduled'],
  Assigned: ['Accepted', 'Visit cancelled', 'Visit rescheduled'],
  Accepted: ['On the way', 'Visit cancelled', 'Visit rescheduled'],
  'On the way': ['Reached', 'Visit cancelled', 'Visit rescheduled'],
  Reached: ['Client assisted', 'Client did not attend', 'Visit cancelled', 'Visit rescheduled'],
  'Client assisted': ['Completed', 'Visit cancelled', 'Visit rescheduled'],
  'Visit rescheduled': ['Assigned', 'Visit cancelled'],
  'In Progress': ['Reached', 'Client assisted', 'Client did not attend', 'Completed', 'Visit cancelled'],
  Cancelled: [], 'No Show': [], Completed: [], 'Client did not attend': [], 'Visit cancelled': [],
});

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequest('invalid-payload', 'Expected an object.');
  return value;
}
function text(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BadRequest('invalid-payload', `${name} is required (max ${max} characters).`);
  return value.trim();
}
function date(value, name) {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) throw new BadRequest('invalid-payload', `${name} must be a valid date and time.`);
  return parsed.toISOString();
}
function allowed(body, keys) {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new BadRequest('forbidden-field', `${key} cannot be supplied.`);
}

const VISIT_LIST_ORDERS = Object.freeze(['asc', 'desc']);

function optionalText(value, name, max = 100) {
  if (value == null || value === '') return undefined;
  return text(value, name, max);
}

// Manager tracking board filters — pure and unit-testable. Unknown keys
// are rejected so a typo'd filter fails loudly instead of silently
// returning the unfiltered list.
export function validateVisitList(query) {
  const input = object(query ?? {});
  allowed(input, ['leadId', 'status', 'assignedTo', 'from', 'to', 'order', 'limit', 'offset']);
  const order = input.order == null || input.order === '' ? 'desc' : text(input.order, 'order', 10);
  if (!VISIT_LIST_ORDERS.includes(order)) throw new BadRequest('invalid-payload', 'order must be asc or desc.');
  return {
    leadId: optionalText(input.leadId, 'leadId'),
    status: optionalText(input.status, 'status', 40),
    assignedTo: optionalText(input.assignedTo, 'assignedTo'),
    from: input.from == null || input.from === '' ? undefined : date(input.from, 'from'),
    to: input.to == null || input.to === '' ? undefined : date(input.to, 'to'),
    order,
    limit: input.limit,
    offset: input.offset,
  };
}

export function validateScheduleVisit(body) {
  const input = object(body);
  allowed(input, ['leadId', 'assignedTo', 'scheduledAt', 'listingId', 'notes']);
  return {
    leadId: text(input.leadId, 'leadId', 100),
    assignedTo: text(input.assignedTo, 'assignedTo', 100),
    scheduledAt: date(input.scheduledAt, 'scheduledAt'),
    listingId: input.listingId ? text(input.listingId, 'listingId', 100) : null,
    notes: input.notes == null || input.notes === '' ? null : text(input.notes, 'notes'),
  };
}

export function validateVisitStatus(body, previous) {
  const input = object(body);
  allowed(input, ['status', 'note', 'scheduledAt']);
  const status = text(input.status, 'status', 40);
  if (!VISIT_STATUSES.includes(status) || !(NEXT[previous] || []).includes(status)) {
    throw new BadRequest('invalid-transition', `Cannot change visit from ${previous} to ${status}.`);
  }
  if (status === 'Visit rescheduled' && !input.scheduledAt) throw new BadRequest('invalid-payload', 'A new date and time are required to reschedule.');
  return {
    status,
    note: input.note == null || input.note === '' ? null : text(input.note, 'note'),
    scheduledAt: input.scheduledAt ? date(input.scheduledAt, 'scheduledAt') : null,
  };
}

export function validateVisitViewing(body) {
  const input = object(body);
  allowed(input, ['listingId', 'shownAt', 'assistanceStatus', 'feedback']);
  const assistanceStatus = text(input.assistanceStatus, 'assistanceStatus', 30);
  if (!['assisted', 'client_no_show', 'not_shown'].includes(assistanceStatus)) throw new BadRequest('invalid-payload', 'Invalid assistanceStatus.');
  return {
    listingId: text(input.listingId, 'listingId', 100),
    shownAt: date(input.shownAt, 'shownAt'),
    assistanceStatus,
    feedback: input.feedback == null || input.feedback === '' ? null : text(input.feedback, 'feedback'),
  };
}

export function validateVisitAssignment(body) {
  const input = object(body);
  allowed(input, ['assignedTo', 'note']);
  return { assignedTo: text(input.assignedTo, 'assignedTo', 100), note: input.note == null || input.note === '' ? null : text(input.note, 'note') };
}
