import { BadRequest } from '../utils/errors.js';

function object(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('invalid-payload', 'Body must be a JSON object.');
  }
  return body;
}

function string(value, field, max, required = false) {
  if (value == null || value === '') {
    if (required) throw new BadRequest('invalid-field', `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new BadRequest('invalid-field', `${field} must be 1-${max} characters.`);
  }
  return value.trim();
}

function date(value, field, required = false) {
  if (value == null) {
    if (required) throw new BadRequest('invalid-field', `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new BadRequest('invalid-field', `${field} must be an ISO date/time.`);
  }
  return new Date(value).toISOString();
}

export function validateContact(body) {
  object(body);
  const allowed = ['name', 'phone', 'alternatePhone', 'email', 'requirements', 'notes'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new BadRequest('forbidden-field', 'Unknown or server-owned contact field.');
  }
  return {
    name: string(body.name, 'name', 200, true),
    phone: string(body.phone, 'phone', 40, true),
    alternatePhone: string(body.alternatePhone, 'alternatePhone', 40),
    email: string(body.email, 'email', 200),
    requirements: string(body.requirements, 'requirements', 4000),
    notes: string(body.notes, 'notes', 4000),
  };
}

export function validateCall(body) {
  object(body);
  const allowed = ['direction', 'occurredAt', 'durationSeconds', 'outcome', 'notes', 'nextFollowUp'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new BadRequest('forbidden-field', 'Unknown or server-owned call field.');
  }
  if (!['inbound', 'outbound'].includes(body.direction)) {
    throw new BadRequest('invalid-enum', 'direction must be inbound or outbound.');
  }
  if (!['interested', 'follow_up', 'not_interested', 'no_answer', 'other'].includes(body.outcome)) {
    throw new BadRequest('invalid-enum', 'Invalid call outcome.');
  }
  if (body.durationSeconds != null && (!Number.isInteger(body.durationSeconds) || body.durationSeconds < 0)) {
    throw new BadRequest('invalid-field', 'durationSeconds must be a non-negative integer.');
  }
  return {
    direction: body.direction,
    outcome: body.outcome,
    occurredAt: date(body.occurredAt, 'occurredAt', true),
    durationSeconds: body.durationSeconds ?? null,
    notes: string(body.notes, 'notes', 4000),
    nextFollowUp: date(body.nextFollowUp, 'nextFollowUp'),
  };
}
