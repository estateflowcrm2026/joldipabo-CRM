// Follow-up window filters — shared by GET /leads and GET /contacts.
//
// Pure validators (no I/O, no DB). Both list routes accept the same three
// query keys so the frontend Follow-ups panel drives either source with one
// window computation:
//
//   followUpFrom  ISO datetime, inclusive lower bound on the due time
//   followUpTo    ISO datetime, exclusive upper bound on the due time
//   followUpSet   'set' (has an outstanding follow-up) | 'unset' (none)
//
// Leads filter on `leads.next_follow_up` directly (partial index
// `idx_leads_tenant_followup` backs it). Contacts filter on the effective
// follow-up — MAX(next_follow_up) over the contact's calls, the same MAX
// semantics `convertContactToLead` already uses — so no contacts-column
// migration is needed.
//
// A from/to window implies "set": NULL dues never satisfy a comparison, so
// `followUpSet=unset` combined with from/to is rejected as contradictory
// instead of silently returning zero rows (fail loudly, like the visit
// list filters). Unknown keys are ignored here — each route owns its own
// allow-list; this validator only normalises the keys it understands.

import { BadRequest } from '../utils/errors.js';

export const FOLLOW_UP_SET = Object.freeze(['set', 'unset']);

function pickString(value) {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function isoDate(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequest('invalid-field', `${field} must be a valid date/time.`);
  }
  return parsed.toISOString();
}

/**
 * Normalise the follow-up window out of a query object. Returns {} when
 * none of the three keys is present, so routes can spread the result over
 * their own filters unconditionally.
 *
 * @param {Record<string, unknown>=} query
 * @returns {{ followUpFrom?: string, followUpTo?: string, followUpSet?: string }}
 */
export function validateFollowUpFilters(query = {}) {
  if (!query || typeof query !== 'object') return {};
  const out = {};

  const rawSet = pickString(query.followUpSet);
  if (rawSet !== undefined) {
    if (!FOLLOW_UP_SET.includes(rawSet)) {
      throw new BadRequest(
        'invalid-enum',
        `followUpSet must be one of: ${FOLLOW_UP_SET.join(', ')}.`,
      );
    }
    out.followUpSet = rawSet;
  }

  const rawFrom = pickString(query.followUpFrom);
  if (rawFrom !== undefined) out.followUpFrom = isoDate(rawFrom, 'followUpFrom');

  const rawTo = pickString(query.followUpTo);
  if (rawTo !== undefined) out.followUpTo = isoDate(rawTo, 'followUpTo');

  if (out.followUpSet === 'unset' && (out.followUpFrom || out.followUpTo)) {
    throw new BadRequest(
      'invalid-payload',
      'followUpSet=unset cannot be combined with followUpFrom/followUpTo.',
    );
  }
  return out;
}

/**
 * True when any follow-up predicate is active. Used by repositories to
 * decide whether follow-up clauses belong in the WHERE.
 */
export function isFollowUpFiltered(filters = {}) {
  if (!filters || typeof filters !== 'object') return false;
  return Boolean(filters.followUpFrom || filters.followUpTo || filters.followUpSet);
}

/**
 * True when the list should be ordered oldest-due-first. A pure
 * `followUpSet=unset` list keeps the default newest-first order — there is
 * no due time to sort by.
 */
export function followUpSortActive(filters = {}) {
  if (!filters || typeof filters !== 'object') return false;
  return Boolean(
    filters.followUpFrom || filters.followUpTo || filters.followUpSet === 'set',
  );
}
