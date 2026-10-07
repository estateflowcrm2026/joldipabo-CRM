// Agent performance reporting, derived from visit/viewing records.
//
// There are no manual counters or seed values anywhere in this path: every
// metric is aggregated at query time from `visits` (one row per scheduled
// site visit) joined to `visit_viewings` (one row per property shown).
//
// Metric definitions (fixed by this module, documented in
// docs/AGENT_PERFORMANCE.md):
//   * siteVisits        — distinct visits scheduled in range, per assignee
//   * clientsAssisted   — distinct leads on visits having >= 1 assisted viewing
//   * propertiesShown   — viewings with assistance_status='assisted'
//   * completedVisits   — visits with status='Completed'
//   * cancelledNoShows  — visits with status in ('Cancelled','No Show',
//                         'Visit cancelled','Client did not attend')
// The window filters `visits.scheduled_at`; a viewing counts with its
// visit, not by its own `shown_at`.
//
// Isolation: the query runs through `tenantQuery` (RLS tenant context) AND
// an explicit `scopeFilterFor(user, 'visits', 'view')` predicate, so a
// manager with team scope sees only their team's agents and an executive
// with own scope sees only themself. Soft-deleted visits are excluded.

import { tenantQuery } from '../db/client.js';
import { scopeFilterFor } from '../rbac/scopeFilters.js';
import { BadRequest } from '../utils/errors.js';

const CANCELLED_STATUSES = Object.freeze([
  'Cancelled',
  'No Show',
  'Visit cancelled',
  'Client did not attend',
]);

const PRESETS = Object.freeze({
  weekly: 7,
  monthly: 30,
  yearly: 365,
});

const MAX_RANGE_DAYS = 366;

function isoDate(value, name) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new BadRequest('invalid-payload', `${name} must be a valid date.`);
  }
  return parsed;
}

/**
 * Resolve the reporting window to a half-open [from, to) UTC range.
 *
 * `preset` is one of weekly (last 7 days), monthly (last 30 days), yearly
 * (last 365 days), or `custom` which requires ISO `from`/`to` dates — `to`
 * is inclusive of the whole calendar day. Defaults to monthly.
 *
 * Pure (no DB); unit-tested directly.
 *
 * @param {{ preset?: string, from?: string, to?: string }} [filters]
 * @param {Date} [now]
 * @returns {{ from: string, to: string }} ISO bounds, to exclusive
 */
export function resolveDateRange(filters = {}, now = new Date()) {
  const preset = (filters.preset || 'monthly').trim().toLowerCase();
  const end = isoDate(now, 'now');
  if (PRESETS[preset]) {
    const from = new Date(end.getTime() - PRESETS[preset] * 86_400_000);
    return { from: from.toISOString(), to: end.toISOString() };
  }
  if (preset !== 'custom') {
    throw new BadRequest('invalid-payload', 'preset must be weekly, monthly, yearly or custom.');
  }
  if (!filters.from || !filters.to) {
    throw new BadRequest('invalid-payload', 'Custom range requires from and to dates.');
  }
  const from = isoDate(filters.from, 'from');
  const toDay = isoDate(filters.to, 'to');
  // Whole-day inclusive: the window ends at the next midnight UTC.
  const to = new Date(Date.UTC(toDay.getUTCFullYear(), toDay.getUTCMonth(), toDay.getUTCDate() + 1));
  if (from.getTime() >= to.getTime()) {
    throw new BadRequest('invalid-payload', 'from must be before to.');
  }
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new BadRequest('invalid-payload', `Custom range must not exceed ${MAX_RANGE_DAYS} days.`);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Validate the query string for GET /reports/agent-performance.
 * Pure (no DB); unit-tested directly.
 *
 * @param {object} [query]
 * @param {Date} [now]
 */
export function validatePerformanceFilters(query = {}, now) {
  if (query !== null && typeof query !== 'object') {
    throw new BadRequest('invalid-payload', 'Expected filter parameters.');
  }
  const range = resolveDateRange(
    { preset: query.preset, from: query.from, to: query.to },
    now,
  );
  const agentId =
    query.agentId == null || query.agentId === ''
      ? null
      : String(query.agentId).trim() || null;
  if (agentId && agentId.length > 100) {
    throw new BadRequest('invalid-payload', 'agentId is too long.');
  }
  return { ...range, agentId };
}

/**
 * Ranked per-agent performance for the caller's visits scope.
 *
 * @param {{ id: string, tenantId: string }} user
 * @param {{ from: string, to: string, agentId?: string|null }} range
 */
export async function getAgentPerformance(user, range) {
  const scope = scopeFilterFor(user, 'visits', 'view', { table: 'v' });
  // $1 is reserved for the tenant predicate on the viewings join; the
  // scope's own placeholders shift by one.
  const scopeSql = scope.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`);
  const values = [user.tenantId, ...scope.params];
  const where = ['v.deleted_at IS NULL', `(${scopeSql})`];
  values.push(range.from, range.to);
  where.push(`v.scheduled_at >= $${values.length - 1} AND v.scheduled_at < $${values.length}`);
  if (range.agentId) {
    values.push(range.agentId);
    where.push(`v.assigned_to = $${values.length}`);
  }
  const clause = where.join(' AND ');
  const result = await tenantQuery(
    user,
    `SELECT u.id AS agent_id, u.name AS agent_name, u.team_id AS team_id,
      COUNT(DISTINCT v.id)::int AS site_visits,
      COUNT(DISTINCT CASE WHEN w.id IS NOT NULL THEN v.lead_id END)::int AS clients_assisted,
      COUNT(w.id)::int AS properties_shown,
      COUNT(DISTINCT CASE WHEN v.status = 'Completed' THEN v.id END)::int AS completed_visits,
      COUNT(DISTINCT CASE WHEN v.status = ANY($${values.length + 1}::text[]) THEN v.id END)::int AS cancelled_no_show_visits
    FROM visits v
    JOIN users u ON u.tenant_id = v.tenant_id AND u.id = v.assigned_to
    LEFT JOIN visit_viewings w
      ON w.tenant_id = $1 AND w.visit_id = v.id AND w.assistance_status = 'assisted'
    WHERE ${clause}
    GROUP BY u.id, u.name, u.team_id
    ORDER BY site_visits DESC, properties_shown DESC, u.name ASC, u.id ASC`,
    [...values, [...CANCELLED_STATUSES]],
  );
  return {
    items: result.rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      teamId: row.team_id,
      siteVisits: row.site_visits,
      clientsAssisted: row.clients_assisted,
      propertiesShown: row.properties_shown,
      completedVisits: row.completed_visits,
      cancelledNoShows: row.cancelled_no_show_visits,
    })),
    range: { from: range.from, to: range.to },
  };
}
