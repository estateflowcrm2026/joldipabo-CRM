// Lead timeline — one chronological history per lead, read-only.
//
// Sources (all real rows, nothing synthesised):
//   * contacts.created_at            — the client first called in
//   * contact_calls                  — every logged call, with outcome/notes/follow-up
//   * leads.created_at               — the lead row (via conversion or direct intake)
//   * visit_events                   — scheduled / assigned / status transitions
//   * visit_viewings                 — properties shown, with feedback
//   * leads.next_follow_up           — the outstanding follow-up, shown as upcoming
//
// Deliberately NOT sources (documented gaps, see docs/CLIENT_TIMELINE.md):
//   * audit_log — tamper-evidence, not product history; no RLS policy by
//     design (010), so it is never read for UI purposes.
//   * Lead status-transition times — no live table stores them; the timeline
//     shows the CURRENT status via the lead row, not when it changed.
//   * Bookings / payments — no table exists; `status = 'Booked'` is the
//     conversion signal.
//
// Isolation: every query carries an explicit `tenant_id = $1` predicate AND
// runs inside withTenant (RLS tenant context). Visits are additionally
// filtered per-row through can(user, 'visits', 'view', …), and the linked
// contact through can(user, 'leads', 'view', …) — a caller with leads:view
// but no visits scope sees calls and lead events, never visits. Out-of-scope
// rows are skipped silently, never leaked as 404s inside the list (the lead
// itself 404s at the route when out of scope, same as GET /leads/:id).

import { withTenant } from '../db/client.js';
import { can } from '../rbac/permissions.js';
import { BadRequest } from '../utils/errors.js';

const OUTCOME_LABELS = Object.freeze({
  interested: 'Interested',
  follow_up: 'Follow-up',
  not_interested: 'Not interested',
  no_answer: 'No answer',
  other: 'Other',
});

// Tie-break when two items share a timestamp: the journey order
// Client → Calls → Lead → Visit → Viewings → Follow-up.
const TYPE_RANK = Object.freeze({
  contact_created: 0,
  lead_created: 1,
  call: 2,
  visit_event: 3,
  viewing: 4,
  follow_up: 5,
});

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function actorOf(id, name) {
  if (!id) return null;
  return { id, name: name ?? null };
}

/**
 * Merge raw rows into chronological timeline items. Pure (no DB) so the
 * ordering and shapes are unit-testable without Postgres.
 *
 * Rows are plain objects shaped like the queries in getLeadTimeline below
 * (pg rows with snake_case columns plus joined `*_name` fields). Rows with
 * an unparseable timestamp are skipped — a timeline that drops one corrupt
 * row is better than one that refuses to render.
 *
 * @param {object} args
 * @param {object} args.lead — lead DTO (as returned by getLeadById)
 * @param {string|null} [args.leadCreatorName]
 * @param {object|null} [args.contact]
 * @param {object[]} [args.calls]
 * @param {object[]} [args.events]
 * @param {object[]} [args.viewings]
 * @returns {object[]} items sorted oldest-first
 */
export function buildTimelineItems({
  lead,
  leadCreatorName = null,
  contact = null,
  calls = [],
  events = [],
  viewings = [],
} = {}) {
  const items = [];

  if (contact && toIso(contact.created_at)) {
    items.push({
      id: `contact_${contact.id}`,
      type: 'contact_created',
      occurredAt: toIso(contact.created_at),
      title: 'Contact created',
      detail: contact.requirements || contact.notes || null,
      actor: actorOf(contact.created_by, contact.creator_name),
      meta: { contactId: contact.id, phone: contact.phone ?? null },
    });
  }

  for (const call of calls) {
    const occurredAt = toIso(call.occurred_at);
    if (!occurredAt) continue;
    items.push({
      id: `call_${call.id}`,
      type: 'call',
      occurredAt,
      title: `Call – ${OUTCOME_LABELS[call.outcome] || call.outcome || 'Logged'}`,
      detail: call.notes || null,
      actor: actorOf(call.agent_id, call.agent_name),
      meta: {
        contactId: call.contact_id ?? null,
        direction: call.direction ?? null,
        outcome: call.outcome ?? null,
        durationSeconds: call.duration_seconds ?? null,
        nextFollowUp: toIso(call.next_follow_up),
      },
    });
  }

  if (lead && toIso(lead.createdAt)) {
    items.push({
      id: `lead_${lead.id}`,
      type: 'lead_created',
      occurredAt: lead.createdAt,
      title: lead.contactId ? 'Converted to lead' : 'Lead created',
      detail: lead.source ? `Source: ${lead.source}` : null,
      actor: actorOf(lead.createdBy, leadCreatorName),
      meta: { leadId: lead.id, status: lead.status ?? null },
    });
  }

  for (const event of events) {
    const occurredAt = toIso(event.occurred_at);
    if (!occurredAt) continue;
    items.push({
      id: `event_${event.id}`,
      type: 'visit_event',
      occurredAt,
      title: `Visit – ${event.status}`,
      detail: event.note || null,
      actor: actorOf(event.actor_id, event.actor_name),
      meta: {
        visitId: event.visit_id,
        status: event.status ?? null,
        scheduledAt: toIso(event.scheduled_at),
        assignedTo: event.assigned_to ?? null,
        assignedName: event.assigned_name ?? null,
      },
    });
  }

  for (const viewing of viewings) {
    const occurredAt = toIso(viewing.shown_at);
    if (!occurredAt) continue;
    items.push({
      id: `viewing_${viewing.id}`,
      type: 'viewing',
      occurredAt,
      title: `Shown: ${viewing.listing_title || viewing.listing_id}`,
      detail: viewing.feedback || null,
      actor: actorOf(viewing.agent_id, viewing.agent_name),
      meta: {
        visitId: viewing.visit_id,
        listingId: viewing.listing_id ?? null,
        assistanceStatus: viewing.assistance_status ?? null,
      },
    });
  }

  const followUpAt = lead ? toIso(lead.nextFollowUp) : null;
  if (followUpAt) {
    items.push({
      id: `followup_${lead.id}`,
      type: 'follow_up',
      occurredAt: followUpAt,
      title: 'Follow-up due',
      detail: null,
      actor: null,
      meta: { source: 'lead' },
    });
  }

  items.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
    const rank = (TYPE_RANK[a.type] ?? 99) - (TYPE_RANK[b.type] ?? 99);
    if (rank !== 0) return rank;
    return a.id < b.id ? -1 : 1;
  });
  return items;
}

/**
 * Load every timeline source for a visible lead and merge them.
 *
 * The lead itself is already loaded and scope-checked by the route (same
 * 404-hiding as GET /leads/:id). Everything else is filtered here:
 * out-of-scope visits and an out-of-scope linked contact are skipped.
 *
 * @param {{ id: string, tenantId: string }} user
 * @param {object} lead — lead DTO from getLeadById
 * @returns {Promise<{ leadId: string, items: object[] }>}
 */
export async function getLeadTimeline(user, lead) {
  if (!lead || !lead.id) {
    throw new BadRequest('invalid-id', 'Lead id is required.');
  }
  return withTenant(user, async (client) => {
    const [contactResult, visitResult, creatorResult] = await Promise.all([
      client.query(
        `SELECT c.*, cu.name AS creator_name
           FROM contacts c
           LEFT JOIN users cu ON cu.tenant_id = c.tenant_id AND cu.id = c.created_by
          WHERE c.tenant_id = $1 AND c.lead_id = $2 AND c.deleted_at IS NULL
          LIMIT 1`,
        [user.tenantId, lead.id],
      ),
      client.query(
        `SELECT v.*, u.name AS agent_name
           FROM visits v
           LEFT JOIN users u ON u.tenant_id = v.tenant_id AND u.id = v.assigned_to
          WHERE v.tenant_id = $1 AND v.lead_id = $2 AND v.deleted_at IS NULL
          ORDER BY v.scheduled_at ASC, v.id ASC`,
        [user.tenantId, lead.id],
      ),
      client.query('SELECT name FROM users WHERE tenant_id = $1 AND id = $2', [
        user.tenantId,
        lead.createdBy,
      ]),
    ]);

    const contactRow = contactResult.rows[0] ?? null;
    const contact =
      contactRow &&
      can(user, 'leads', 'view', {
        ownerId: contactRow.owner_id,
        teamId: contactRow.team_id,
        projectId: contactRow.project_id,
      })
        ? contactRow
        : null;

    const visibleVisits = visitResult.rows.filter((row) =>
      can(user, 'visits', 'view', {
        assignedTo: row.assigned_to,
        teamId: row.team_id,
        projectId: row.project_id,
      }),
    );
    const visitIds = visibleVisits.map((row) => row.id);

    const [callsResult, eventsResult, viewingsResult] = await Promise.all([
      contact
        ? client.query(
            `SELECT cc.*, u.name AS agent_name
               FROM contact_calls cc
               LEFT JOIN users u ON u.tenant_id = cc.tenant_id AND u.id = cc.agent_id
              WHERE cc.tenant_id = $1 AND cc.contact_id = $2
              ORDER BY cc.occurred_at ASC, cc.id ASC`,
            [user.tenantId, contact.id],
          )
        : { rows: [] },
      visitIds.length > 0
        ? client.query(
            `SELECT e.*, u.name AS actor_name, a.name AS assigned_name
               FROM visit_events e
               LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.actor_id
               LEFT JOIN users a ON a.tenant_id = e.tenant_id AND a.id = e.assigned_to
              WHERE e.tenant_id = $1 AND e.visit_id = ANY($2::text[])
              ORDER BY e.occurred_at ASC, e.id ASC`,
            [user.tenantId, visitIds],
          )
        : { rows: [] },
      visitIds.length > 0
        ? client.query(
            `SELECT w.*, li.title AS listing_title, u.name AS agent_name
               FROM visit_viewings w
               JOIN listings li ON li.tenant_id = w.tenant_id AND li.id = w.listing_id
               JOIN users u ON u.tenant_id = w.tenant_id AND u.id = w.agent_id
              WHERE w.tenant_id = $1 AND w.visit_id = ANY($2::text[])
              ORDER BY w.shown_at ASC, w.id ASC`,
            [user.tenantId, visitIds],
          )
        : { rows: [] },
    ]);

    return {
      leadId: lead.id,
      items: buildTimelineItems({
        lead,
        leadCreatorName: creatorResult.rows[0]?.name ?? null,
        contact,
        calls: callsResult.rows,
        events: eventsResult.rows,
        viewings: viewingsResult.rows,
      }),
    };
  });
}
