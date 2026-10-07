import { randomBytes } from 'node:crypto';
import { tenantQuery, withTenant } from '../db/client.js';
import { scopeFilterFor } from '../rbac/scopeFilters.js';
import { can } from '../rbac/permissions.js';
import { NotFound } from '../utils/errors.js';
import { recordAudit } from '../audit/auditLog.js';
import { followUpSortActive } from './followUpValidation.js';

const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const record = (row) => ({ ownerId: row.owner_id, teamId: row.team_id, projectId: row.project_id });
const dto = (row) => ({
  id: row.id, name: row.name, phone: row.phone, alternatePhone: row.alternate_phone,
  email: row.email, requirements: row.requirements, notes: row.notes,
  ownerId: row.owner_id, teamId: row.team_id, projectId: row.project_id,
  leadId: row.lead_id, createdAt: row.created_at, updatedAt: row.updated_at,
});

// List DTO: base fields plus the effective follow-up (MAX over calls),
// null when no call set one. Serialised as ISO like the lead DTO so the
// frontend renders both sources with one formatter.
const dtoWithFollowUp = (row) => {
  const base = dto(row);
  const raw = row.effective_follow_up;
  base.nextFollowUp = raw ? new Date(raw).toISOString() : null;
  return base;
};

export async function listContacts(user, { q = '', ownerId, followUpFrom, followUpTo, followUpSet, limit: rawLimit, offset: rawOffset } = {}) {
  const scope = scopeFilterFor(user, 'leads', 'view', { table: 'c' });
  const values = [...scope.params];
  const search = typeof q === 'string' ? q.trim().slice(0, 100) : '';
  const limit = Math.min(Math.max(Number.parseInt(rawLimit, 10) || 25, 1), 100);
  const offset = Math.max(Number.parseInt(rawOffset, 10) || 0, 0);
  let searchSql = '';
  if (search) {
    values.push(`%${search}%`);
    searchSql = `AND (c.name ILIKE $${values.length} OR c.phone ILIKE $${values.length})`;
  }
  // Owner predicate — the due-list "my queue" filter. Scope still applies
  // first: an own-scoped caller passing another owner's id gets zero rows,
  // never someone else's contacts.
  let ownerSql = '';
  if (typeof ownerId === 'string' && ownerId.trim()) {
    values.push(ownerId.trim());
    ownerSql = `AND c.owner_id = $${values.length}`;
  }
  // Effective follow-up = MAX(next_follow_up) over the contact's calls —
  // the same MAX semantics convertContactToLead uses. A correlated
  // subquery keeps this to one query and needs no schema change.
  let followUpSql = '';
  if (followUpFrom) {
    values.push(followUpFrom);
    followUpSql += ` AND (SELECT MAX(cc.next_follow_up) FROM contact_calls cc WHERE cc.tenant_id = c.tenant_id AND cc.contact_id = c.id) >= $${values.length}`;
  }
  if (followUpTo) {
    values.push(followUpTo);
    followUpSql += ` AND (SELECT MAX(cc.next_follow_up) FROM contact_calls cc WHERE cc.tenant_id = c.tenant_id AND cc.contact_id = c.id) < $${values.length}`;
  }
  if (followUpSet === 'set') {
    followUpSql += ' AND EXISTS (SELECT 1 FROM contact_calls cc WHERE cc.tenant_id = c.tenant_id AND cc.contact_id = c.id AND cc.next_follow_up IS NOT NULL)';
  }
  if (followUpSet === 'unset') {
    followUpSql += ' AND NOT EXISTS (SELECT 1 FROM contact_calls cc WHERE cc.tenant_id = c.tenant_id AND cc.contact_id = c.id AND cc.next_follow_up IS NOT NULL)';
  }
  const where = `c.deleted_at IS NULL AND ${scope.sql} ${searchSql} ${ownerSql} ${followUpSql}`;
  // Follow-up-filtered lists sort oldest-due-first via the same MAX
  // expression, so the most overdue contact is on top. Unfiltered lists
  // keep the existing newest-first order.
  const orderBy = followUpSortActive({ followUpFrom, followUpTo, followUpSet })
    ? 'ORDER BY (SELECT MAX(cc.next_follow_up) FROM contact_calls cc WHERE cc.tenant_id = c.tenant_id AND cc.contact_id = c.id) ASC, c.id ASC'
    : 'ORDER BY c.created_at DESC, c.id DESC';
  const result = await tenantQuery(user, `SELECT c.*,
    (SELECT MAX(cc.next_follow_up) FROM contact_calls cc WHERE cc.tenant_id = c.tenant_id AND cc.contact_id = c.id) AS effective_follow_up
    FROM contacts c WHERE ${where} ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
  const count = await tenantQuery(user, `SELECT COUNT(*)::int AS total FROM contacts c WHERE ${where}`, values);
  return { items: result.rows.map(dtoWithFollowUp), pagination: { limit, offset, total: count.rows[0].total } };
}

async function visibleContact(client, user, contactId, action = 'view', lock = false) {
  const result = await client.query(`SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [user.tenantId, contactId]);
  const row = result.rows[0];
  if (!row || !can(user, 'leads', action, record(row))) throw new NotFound('not-found', 'Contact not found.');
  return row;
}

export async function getContact(user, contactId) {
  return withTenant(user, async (client) => {
    const contact = await visibleContact(client, user, contactId);
    return dto(contact);
  });
}

export async function listContactCalls(user, contactId, page = {}) {
  const limit = Math.min(Math.max(Number.parseInt(page.limit, 10) || 25, 1), 100);
  const offset = Math.max(Number.parseInt(page.offset, 10) || 0, 0);
  return withTenant(user, async (client) => {
    await visibleContact(client, user, contactId);
    const calls = await client.query('SELECT id, direction, occurred_at, duration_seconds, outcome, notes, next_follow_up, agent_id FROM contact_calls WHERE tenant_id = $1 AND contact_id = $2 ORDER BY occurred_at DESC, id DESC LIMIT $3 OFFSET $4', [user.tenantId, contactId, limit, offset]);
    const count = await client.query('SELECT COUNT(*)::int AS total FROM contact_calls WHERE tenant_id = $1 AND contact_id = $2', [user.tenantId, contactId]);
    return { items: calls.rows.map((row) => ({
      id: row.id, direction: row.direction, occurredAt: row.occurred_at,
      durationSeconds: row.duration_seconds, outcome: row.outcome, notes: row.notes,
      nextFollowUp: row.next_follow_up, agentId: row.agent_id,
    })), pagination: { limit, offset, total: count.rows[0].total } };
  });
}

export async function createContact(user, input, req) {
  return withTenant(user, async (client) => {
    const contactId = id('ct');
    const result = await client.query(`INSERT INTO contacts (id, tenant_id, name, phone, alternate_phone, email, requirements, notes, owner_id, team_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [contactId, user.tenantId, input.name, input.phone, input.alternatePhone, input.email, input.requirements, input.notes, user.id, user.teamId ?? null, user.id]);
    await recordAudit(client, { req, action: 'created-contact', entity: 'contact', entityId: contactId });
    return dto(result.rows[0]);
  });
}

export async function logContactCall(user, contactId, input, req) {
  return withTenant(user, async (client) => {
    await visibleContact(client, user, contactId, 'edit', true);
    const callId = id('call');
    const result = await client.query(`INSERT INTO contact_calls (id, tenant_id, contact_id, agent_id, direction, occurred_at, duration_seconds, outcome, notes, next_follow_up)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [callId, user.tenantId, contactId, user.id, input.direction, input.occurredAt, input.durationSeconds, input.outcome, input.notes, input.nextFollowUp]);
    await recordAudit(client, { req, action: 'logged-call', entity: 'contact', entityId: contactId, metadata: { callId, outcome: input.outcome } });
    const row = result.rows[0];
    return { id: row.id, contactId, agentId: row.agent_id, direction: row.direction, occurredAt: row.occurred_at, durationSeconds: row.duration_seconds, outcome: row.outcome, notes: row.notes, nextFollowUp: row.next_follow_up };
  });
}

export async function convertContactToLead(user, contactId, req) {
  return withTenant(user, async (client) => {
    const contact = await visibleContact(client, user, contactId, 'edit', true);
    if (contact.lead_id) return { leadId: contact.lead_id, created: false };
    const leadId = id('ld');
    await client.query(`INSERT INTO leads (id, tenant_id, name, phone, email, source, notes, owner_id, team_id, created_by, requirements, next_follow_up)
      VALUES ($1,$2,$3,$4,$5,'Direct',$6,$7,$8,$9,$10::jsonb,
        (SELECT MAX(next_follow_up) FROM contact_calls WHERE tenant_id=$2 AND contact_id=$11))`,
      [leadId, user.tenantId, contact.name, contact.phone, contact.email, contact.notes,
        contact.owner_id, contact.team_id, user.id, JSON.stringify({ details: contact.requirements ?? '' }), contactId]);
    await client.query('UPDATE contacts SET lead_id=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2', [user.tenantId, contactId, leadId]);
    await recordAudit(client, { req, action: 'converted-contact', entity: 'contact', entityId: contactId, metadata: { leadId } });
    return { leadId, created: true };
  });
}
