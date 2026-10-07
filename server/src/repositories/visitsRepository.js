import { randomBytes } from 'node:crypto';
import { tenantQuery, withTenant } from '../db/client.js';
import { can, scopeOf } from '../rbac/permissions.js';
import { scopeFilterFor } from '../rbac/scopeFilters.js';
import { BadRequest, NotFound } from '../utils/errors.js';
import { recordAudit } from '../audit/auditLog.js';

const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const record = (row) => ({ assignedTo: row.assigned_to, teamId: row.team_id, projectId: row.project_id });
const columns = `v.*, l.name AS lead_name, l.phone AS lead_phone, u.name AS agent_name,
  (SELECT COUNT(*)::int FROM visit_viewings w WHERE w.tenant_id=v.tenant_id AND w.visit_id=v.id AND w.assistance_status='assisted') AS viewing_count`;
const joins = `LEFT JOIN leads l ON l.tenant_id=v.tenant_id AND l.id=v.lead_id
  LEFT JOIN users u ON u.tenant_id=v.tenant_id AND u.id=v.assigned_to`;
const dto = (row) => ({
  id: row.id, leadId: row.lead_id, leadName: row.lead_name, leadPhone: row.lead_phone,
  assignedTo: row.assigned_to, agentName: row.agent_name, teamId: row.team_id,
  projectId: row.project_id, listingId: row.listing_id, scheduledAt: row.scheduled_at,
  viewingCount: row.viewing_count,
  status: row.status, notes: row.notes, createdBy: row.created_by,
  completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at,
});
const pageOf = (input = {}) => ({
  limit: Math.min(Math.max(Number.parseInt(input.limit, 10) || 25, 1), 100),
  offset: Math.max(Number.parseInt(input.offset, 10) || 0, 0),
});

export function leadVisitSummary(statuses) {
  const values = new Set(statuses);
  if ([...values].some((status) => !['Completed', 'Cancelled', 'No Show', 'Visit cancelled', 'Client did not attend'].includes(status))) return 'visit_planned';
  if (values.has('Completed')) return 'visit_completed';
  if (values.has('No Show') || values.has('Client did not attend')) return 'no_show';
  if (values.has('Cancelled') || values.has('Visit cancelled')) return 'visit_cancelled';
  return 'no_visit_planned';
}

async function syncLeadVisitStatus(client, user, leadId) {
  const result = await client.query('SELECT status FROM visits WHERE tenant_id=$1 AND lead_id=$2 AND deleted_at IS NULL', [user.tenantId, leadId]);
  await client.query('UPDATE leads SET visit_status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
    [user.tenantId, leadId, leadVisitSummary(result.rows.map((row) => row.status))]);
}

export async function listVisits(user, filters = {}) {
  const scope = scopeFilterFor(user, 'visits', 'view', { table: 'v' });
  const values = [...scope.params];
  const where = [`v.deleted_at IS NULL`, scope.sql];
  if (filters.leadId) { values.push(filters.leadId); where.push(`v.lead_id=$${values.length}`); }
  if (filters.status) { values.push(filters.status); where.push(`v.status=$${values.length}`); }
  if (filters.assignedTo) { values.push(filters.assignedTo); where.push(`v.assigned_to=$${values.length}`); }
  if (filters.from) { values.push(filters.from); where.push(`v.scheduled_at >= $${values.length}`); }
  if (filters.to) { values.push(filters.to); where.push(`v.scheduled_at < $${values.length}`); }
  const page = pageOf(filters);
  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  const clause = where.join(' AND ');
  const data = await tenantQuery(user, `SELECT ${columns} FROM visits v ${joins} WHERE ${clause}
    ORDER BY v.scheduled_at ${order}, v.id ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
  [...values, page.limit, page.offset]);
  const count = await tenantQuery(user, `SELECT COUNT(*)::int AS total FROM visits v WHERE ${clause}`, values);
  return { items: data.rows.map(dto), pagination: { ...page, total: count.rows[0].total } };
}

async function visibleVisit(client, user, visitId, action = 'view', lock = false) {
  const result = await client.query(`SELECT ${columns} FROM visits v ${joins}
    WHERE v.tenant_id=$1 AND v.id=$2 AND v.deleted_at IS NULL ${lock ? 'FOR UPDATE OF v' : ''}`, [user.tenantId, visitId]);
  const row = result.rows[0];
  if (!row || !can(user, 'visits', action, record(row))) throw new NotFound('not-found', 'Visit not found.');
  return row;
}

export async function getVisit(user, visitId) {
  return withTenant(user, async (client) => {
    const row = await visibleVisit(client, user, visitId);
    const [events, viewings] = await Promise.all([
      client.query(`SELECT e.id,e.status,e.note,e.actor_id,e.occurred_at,e.scheduled_at,e.assigned_to,u.name AS actor_name
        FROM visit_events e LEFT JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.actor_id
        WHERE e.tenant_id=$1 AND e.visit_id=$2 ORDER BY e.occurred_at,e.id`, [user.tenantId, visitId]),
      client.query(`SELECT w.id,w.listing_id,w.agent_id,w.shown_at,w.assistance_status,w.feedback,
        li.title AS listing_title,u.name AS agent_name
        FROM visit_viewings w JOIN listings li ON li.tenant_id=w.tenant_id AND li.id=w.listing_id
        JOIN users u ON u.tenant_id=w.tenant_id AND u.id=w.agent_id
        WHERE w.tenant_id=$1 AND w.visit_id=$2 ORDER BY w.shown_at,w.id`, [user.tenantId, visitId]),
    ]);
    return {
      ...dto(row),
      events: events.rows.map((e) => ({ id: e.id, status: e.status, note: e.note, actorId: e.actor_id, actorName: e.actor_name, occurredAt: e.occurred_at, scheduledAt: e.scheduled_at, assignedTo: e.assigned_to })),
      viewings: viewings.rows.map((w) => ({ id: w.id, listingId: w.listing_id, listingTitle: w.listing_title, agentId: w.agent_id, agentName: w.agent_name, shownAt: w.shown_at, assistanceStatus: w.assistance_status, feedback: w.feedback })),
    };
  });
}

async function eligibleAgent(client, user, agentId, projectId = null) {
  const result = await client.query(`SELECT u.id,u.name,u.team_id FROM users u
    WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='Active' AND u.deleted_at IS NULL
      AND u.role_id='field-executive'`, [user.tenantId, agentId]);
  const agent = result.rows[0];
  if (!agent) throw new BadRequest('invalid-assignee', 'Choose an active field executive.');
  const scope = scopeOf(user, 'visits', 'assign');
  if (scope === 'team' && agent.team_id !== user.teamId) throw new BadRequest('invalid-assignee', 'Choose an executive on your team.');
  if (scope === 'project' && projectId) {
    const access = await client.query('SELECT 1 FROM user_project_ids WHERE user_id=$1 AND project_id=$2', [agentId, projectId]);
    if (!access.rows.length) throw new BadRequest('invalid-assignee', 'The executive is not assigned to this project.');
  }
  return agent;
}

export async function listVisitAssignees(user) {
  const scope = scopeOf(user, 'visits', 'assign');
  const values = [user.tenantId];
  let extra = '';
  if (scope === 'none') {
    if (scopeOf(user, 'visits', 'create') !== 'own') return { items: [] };
    values.push(user.id); extra = 'AND u.id=$2';
  }
  if (scope === 'team') { values.push(user.teamId); extra = 'AND u.team_id=$2'; }
  if (scope === 'project') { values.push(user.projectIds || []); extra = 'AND EXISTS (SELECT 1 FROM user_project_ids up WHERE up.user_id=u.id AND up.project_id=ANY($2::text[]))'; }
  const result = await tenantQuery(user, `SELECT u.id,u.name,u.team_id FROM users u WHERE u.tenant_id=$1
    AND u.role_id='field-executive' AND u.status='Active' AND u.deleted_at IS NULL ${extra}
    ORDER BY u.name,u.id LIMIT 200`, values);
  return { items: result.rows.map((row) => ({ id: row.id, name: row.name, teamId: row.team_id })) };
}

export async function createVisit(user, input, req) {
  return withTenant(user, async (client) => {
    const lead = await client.query('SELECT id,owner_id,team_id,project_id FROM leads WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [user.tenantId, input.leadId]);
    const leadRow = lead.rows[0];
    if (!leadRow || !can(user, 'leads', 'view', { ownerId: leadRow.owner_id, teamId: leadRow.team_id, projectId: leadRow.project_id })) {
      throw new NotFound('not-found', 'Lead not found.');
    }
    if (input.listingId) {
      const listing = await client.query('SELECT id,assigned_to,team_id,project_id FROM listings WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [user.tenantId, input.listingId]);
      const item = listing.rows[0];
      if (!item || !can(user, 'listings', 'view', { assignedTo: item.assigned_to, teamId: item.team_id, projectId: item.project_id })) {
        throw new NotFound('not-found', 'Listing not found.');
      }
    }
    const agent = await eligibleAgent(client, user, input.assignedTo, leadRow.project_id);
    const scope = scopeOf(user, 'visits', 'create');
    if (scope === 'own' && agent.id !== user.id) throw new BadRequest('invalid-assignee', 'You can schedule only your own visits.');
    if (!can(user, 'visits', 'create', { assignedTo: agent.id, teamId: agent.team_id, projectId: leadRow.project_id })) {
      throw new NotFound('not-found', 'Lead not found.');
    }
    const visitId = id('visit');
    await client.query(`INSERT INTO visits (id,tenant_id,lead_id,project_id,listing_id,assigned_to,team_id,created_by,scheduled_at,status,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Assigned',$10)`,
    [visitId, user.tenantId, input.leadId, leadRow.project_id, input.listingId, agent.id, agent.team_id, user.id, input.scheduledAt, input.notes]);
    await client.query('INSERT INTO visit_events (id,tenant_id,visit_id,actor_id,status,note,scheduled_at,assigned_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('ve'), user.tenantId, visitId, user.id, 'Assigned', input.notes, input.scheduledAt, agent.id]);
    await syncLeadVisitStatus(client, user, input.leadId);
    await recordAudit(client, { req, action: 'scheduled-visit', entity: 'visit', entityId: visitId, metadata: { leadId: input.leadId, agentId: agent.id } });
    return { id: visitId, status: 'Assigned' };
  });
}

export async function updateVisitStatus(user, visitId, validate, req) {
  return withTenant(user, async (client) => {
    const row = await visibleVisit(client, user, visitId, 'edit', true);
    const input = validate(row.status);
    if (user.role === 'telecaller' && !['Visit cancelled', 'Visit rescheduled'].includes(input.status)) {
      throw new BadRequest('agent-update-required', 'The assigned executive must record on-site progress.');
    }
    if (input.status === 'Completed') {
      const count = await client.query(`SELECT COUNT(*)::int AS total FROM visit_viewings WHERE tenant_id=$1 AND visit_id=$2 AND assistance_status='assisted'`, [user.tenantId, visitId]);
      if (!count.rows[0].total) throw new BadRequest('viewing-required', 'Record at least one assisted property before completing the visit.');
    }
    await client.query(`UPDATE visits SET status=$3,scheduled_at=COALESCE($4,scheduled_at),
      completed_at=CASE WHEN $3='Completed' THEN now() ELSE completed_at END,updated_at=now()
      WHERE tenant_id=$1 AND id=$2`, [user.tenantId, visitId, input.status, input.scheduledAt]);
    await client.query('INSERT INTO visit_events (id,tenant_id,visit_id,actor_id,status,note,scheduled_at,assigned_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('ve'), user.tenantId, visitId, user.id, input.status, input.note, input.scheduledAt || row.scheduled_at, row.assigned_to]);
    await syncLeadVisitStatus(client, user, row.lead_id);
    await recordAudit(client, { req, action: 'visit-status', entity: 'visit', entityId: visitId, metadata: { from: row.status, to: input.status } });
    return { id: visitId, status: input.status };
  });
}

export async function reassignVisit(user, visitId, input, req) {
  return withTenant(user, async (client) => {
    const row = await visibleVisit(client, user, visitId, 'assign', true);
    if (['Completed', 'Cancelled', 'No Show', 'Visit cancelled', 'Client did not attend'].includes(row.status)) throw new BadRequest('visit-closed', 'A closed visit cannot be reassigned.');
    const agent = await eligibleAgent(client, user, input.assignedTo, row.project_id);
    await client.query('UPDATE visits SET assigned_to=$3,team_id=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2', [user.tenantId, visitId, agent.id, agent.team_id]);
    await client.query('INSERT INTO visit_events (id,tenant_id,visit_id,actor_id,status,note,scheduled_at,assigned_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('ve'), user.tenantId, visitId, user.id, row.status, input.note || `Reassigned to ${agent.name}`, row.scheduled_at, agent.id]);
    await recordAudit(client, { req, action: 'reassigned-visit', entity: 'visit', entityId: visitId, metadata: { from: row.assigned_to, to: agent.id } });
    return { id: visitId, assignedTo: agent.id, agentName: agent.name };
  });
}

export async function addVisitViewing(user, visitId, input, req) {
  return withTenant(user, async (client) => {
    const row = await visibleVisit(client, user, visitId, 'edit', true);
    if (user.role === 'telecaller') throw new BadRequest('agent-update-required', 'The assigned executive must record property viewings.');
    if (user.role === 'field-executive' && row.assigned_to !== user.id) throw new NotFound('not-found', 'Visit not found.');
    if (!['Reached', 'Client assisted'].includes(row.status)) throw new BadRequest('invalid-visit-status', 'Reach the client before recording a property viewing.');
    const listing = await client.query('SELECT id,title,assigned_to,team_id,project_id FROM listings WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [user.tenantId, input.listingId]);
    const item = listing.rows[0];
    if (!item || !can(user, 'listings', 'view', { assignedTo: item.assigned_to, teamId: item.team_id, projectId: item.project_id })) {
      throw new NotFound('not-found', 'Listing not found.');
    }
    const viewingId = id('viewing');
    await client.query(`INSERT INTO visit_viewings (id,tenant_id,visit_id,listing_id,agent_id,shown_at,assistance_status,feedback)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [viewingId, user.tenantId, visitId, input.listingId, row.assigned_to, input.shownAt, input.assistanceStatus, input.feedback]);
    await recordAudit(client, { req, action: 'recorded-viewing', entity: 'visit', entityId: visitId, metadata: { viewingId, listingId: input.listingId } });
    return { id: viewingId, listingId: input.listingId, listingTitle: item.title,
      agentId: row.assigned_to, agentName: row.agent_name, shownAt: input.shownAt,
      assistanceStatus: input.assistanceStatus, feedback: input.feedback };
  });
}
