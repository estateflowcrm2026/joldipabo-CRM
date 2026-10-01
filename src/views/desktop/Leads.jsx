// Lead Management. The most data-dense module. Pipeline table with filters,
// inline detail drawer, and gated actions.

import React, { useMemo, useState } from 'react';
import {
  CalendarClock,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag,
  UserPlus,
  X,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope, can } from '../../data/permissions.js';
import { useListings } from '../../services/listingsData.jsx';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  Select,
  TextInput,
  buildTelLink,
  buildWhatsAppLink,
  formatDateTime,
  formatINR,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';
import {
  rankLeadMatches,
  rankLeadMatchesLoose,
} from '../../services/matchListings.js';

const STATUS_OPTIONS = [
  'New',
  'Follow-up',
  'Site Visit Scheduled',
  'Site Visit Done',
  'Negotiation',
  'Token Paid',
  'Booking',
  'Lost',
];

const SOURCE_OPTIONS = ['Website', 'Referral', 'Channel Partner', 'Walk-in', 'Meta Ads', 'Direct'];

export function Leads() {
  const { state, currentUser } = useStore();
  const leads = useMemo(
    () => filterByScope(currentUser, 'leads', 'view', state.leads),
    [currentUser, state.leads]
  );

  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [scoreFilter, setScoreFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(null);

  const filtered = useMemo(() => {
    const lower = query.toLowerCase();
    return leads.filter((lead) => {
      if (statusFilter !== 'all' && lead.status !== statusFilter) return false;
      if (sourceFilter !== 'all' && lead.source !== sourceFilter) return false;
      if (scoreFilter !== 'all' && lead.score !== scoreFilter) return false;
      if (projectFilter !== 'all' && lead.projectId !== projectFilter) return false;
      if (!lower) return true;
      return [lead.name, lead.email, lead.phone, lead.notes]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(lower));
    });
  }, [leads, statusFilter, sourceFilter, scoreFilter, projectFilter, query]);

  return (
    <div className="leads-page">
      <Panel
        title="Lead Pipeline"
        subtitle={`${filtered.length} of ${leads.length} leads in your scope`}
        icon={SlidersHorizontal}
        action={
          <Can resource="leads" action="create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New lead
            </Button>
          </Can>
        }
      >
        <div className="filter-bar">
          <TextInput
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, phone, notes"
          />
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All status</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="all">All sources</option>
            {SOURCE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select value={scoreFilter} onChange={(e) => setScoreFilter(e.target.value)}>
            <option value="all">All scores</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </Select>
          <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="all">All projects</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {(statusFilter !== 'all' ||
            sourceFilter !== 'all' ||
            scoreFilter !== 'all' ||
            projectFilter !== 'all' ||
            query) && (
            <Button
              variant="ghost"
              size="sm"
              icon={X}
              onClick={() => {
                setStatusFilter('all');
                setSourceFilter('all');
                setScoreFilter('all');
                setProjectFilter('all');
                setQuery('');
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={leads.length === 0 ? 'No leads in your scope' : 'No leads match these filters'}
            description={
              leads.length === 0
                ? 'Your role cannot view any leads yet. Ask your admin to update permissions.'
                : 'Try clearing some filters to see more results.'
            }
          />
        ) : (
          <div className="lead-table" role="table">
            <div className="lead-row lead-row-head" role="row">
              <span>Lead</span>
              <span>Project</span>
              <span>Status</span>
              <span>Score</span>
              <span>Budget</span>
              <span>Owner</span>
              <span>Next follow-up</span>
              <span />
            </div>
            {filtered.map((lead) => {
              const project = state.projects.find((p) => p.id === lead.projectId);
              const owner = state.users.find((u) => u.id === lead.ownerId);
              return (
                <div
                  className="lead-row"
                  role="row"
                  tabIndex={0}
                  key={lead.id}
                  onClick={() => setSelected(lead)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(lead);
                    }
                  }}
                >
                  <span className="lead-row-name">
                    <Avatar name={lead.name} size="sm" />
                    <div>
                      <strong>{lead.name}</strong>
                      <small>{lead.phone}</small>
                    </div>
                  </span>
                  <span>{project?.name || '—'}</span>
                  <span>
                    <Badge tone={statusTone(lead.status)} size="sm">
                      {lead.status}
                    </Badge>
                  </span>
                  <span>
                    <Badge tone={lead.score === 'hot' ? 'danger' : lead.score === 'warm' ? 'warning' : 'neutral'} dot size="sm">
                      {lead.score}
                    </Badge>
                  </span>
                  <span>{formatINR(lead.budgetMin)} – {formatINR(lead.budgetMax)}</span>
                  <span>
                    {owner ? (
                      <span className="inline-user">
                        <Avatar name={owner.name} size="xs" tone="light" />
                        <span>{owner.name}</span>
                      </span>
                    ) : (
                      'Unassigned'
                    )}
                  </span>
                  <span>{formatDateTime(lead.nextFollowUp)}</span>
                  <span className="lead-row-actions">
                    <Can resource="leads" action="assign" record={lead}>
                      <button
                        className="btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAssigning(lead);
                        }}
                        aria-label="Assign"
                      >
                        <UserPlus size={14} />
                      </button>
                    </Can>
                    <Can resource="leads" action="edit" record={lead}>
                      <button className="btn-icon" aria-label="More">
                        <MoreHorizontal size={14} />
                      </button>
                    </Can>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {selected && (
        <LeadDrawer
          lead={selected}
          onClose={() => setSelected(null)}
          onAssign={() => {
            setAssigning(selected);
            setSelected(null);
          }}
        />
      )}

      {creating && <NewLeadModal onClose={() => setCreating(false)} />}

      {assigning && (
        <AssignModal
          lead={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={() => setAssigning(null)}
        />
      )}
    </div>
  );
}

function statusTone(status) {
  if (status === 'Booking' || status === 'Token Paid') return 'success';
  if (status === 'Lost') return 'neutral';
  if (status === 'Negotiation') return 'warning';
  return 'info';
}

function verificationTone(verification) {
  if (verification === 'verified') return 'success';
  if (verification === 'pending') return 'warning';
  if (verification === 'rejected') return 'danger';
  return 'neutral';
}

function LeadDrawer({ lead, onClose, onAssign }) {
  const { state } = useStore();
  const project = state.projects.find((p) => p.id === lead.projectId);
  const owner = state.users.find((u) => u.id === lead.ownerId);
  const visits = state.visits.filter((v) => v.leadId === lead.id);
  const messages = state.messages.filter((m) => m.text.toLowerCase().includes(lead.name.toLowerCase()));
  const [schedulingFor, setSchedulingFor] = useState(null);

  return (
    <div className="drawer-backdrop drawer-side-backdrop" onClick={onClose}>
      <aside className="drawer-side drawer-wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-side-header">
          <div>
            <Badge tone={statusTone(lead.status)} dot>
              {lead.status}
            </Badge>
            <h2>{lead.name}</h2>
            <small>{lead.source} · created {timeAgo(lead.createdAt)}</small>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <section className="drawer-section">
          <h4>Contact</h4>
          <ul className="kv-list">
            <li><span>Phone</span><strong>{lead.phone}</strong></li>
            <li><span>Email</span><strong>{lead.email}</strong></li>
            <li><span>Unit interest</span><strong>{lead.unitType}</strong></li>
            <li><span>Budget</span><strong>{formatINR(lead.budgetMin)} – {formatINR(lead.budgetMax)}</strong></li>
            <li><span>Project</span><strong>{project?.name || '—'}</strong></li>
          </ul>
          <div className="drawer-actions">
            <a className="btn btn-secondary btn-sm" href={buildTelLink(lead.phone)}>
              Call
            </a>
            <a
              className="btn btn-secondary btn-sm"
              href={buildWhatsAppLink(lead.phone, `Hi ${lead.name.split(' ')[0]}, following up on ${project?.name}.`)}
              target="_blank"
              rel="noreferrer"
            >
              WhatsApp
            </a>
            <Can resource="leads" action="assign" record={lead}>
              <Button variant="primary" size="sm" icon={UserPlus} onClick={onAssign}>
                Reassign
              </Button>
            </Can>
          </div>
        </section>

        <section className="drawer-section">
          <h4>Owner</h4>
          {owner ? (
            <span className="inline-user">
              <Avatar name={owner.name} size="sm" />
              <div>
                <strong>{owner.name}</strong>
                <small>{owner.email}</small>
              </div>
            </span>
          ) : (
            <Badge tone="warning">Unassigned</Badge>
          )}
        </section>

        <section className="drawer-section">
          <h4>Tags</h4>
          <div className="tag-row">
            {lead.tags.length === 0 ? (
              <span className="muted">No tags yet</span>
            ) : (
              lead.tags.map((tag) => (
                <span className="tag" key={tag}>
                  <Tag size={12} /> {tag}
                </span>
              ))
            )}
          </div>
        </section>

        <section className="drawer-section">
          <h4>Site Visits</h4>
          {visits.length === 0 ? (
            <p className="muted">No visits scheduled yet.</p>
          ) : (
            <ul className="visit-list">
              {visits.map((visit) => (
                <li key={visit.id}>
                  <CalendarClock size={14} />
                  <div>
                    <strong>{formatDateTime(visit.scheduledFor)}</strong>
                    <small>{visit.notes}</small>
                  </div>
                  <Badge tone={visit.status === 'Completed' ? 'success' : 'info'} size="sm">
                    {visit.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <MatchingListings lead={lead} onScheduleVisit={setSchedulingFor} />

        <section className="drawer-section">
          <h4>Notes</h4>
          <p className="muted">{lead.notes}</p>
        </section>

        <Can resource="communications" action="view" record={lead}>
          {messages.length > 0 && (
            <section className="drawer-section">
              <h4>Recent Conversations</h4>
              <ul className="activity-feed">
                {messages.slice(0, 3).map((m) => (
                  <li key={m.id}>
                    <Avatar name={state.users.find((u) => u.id === m.fromId)?.name} size="sm" tone="light" />
                    <div>
                      <span><strong>{state.users.find((u) => u.id === m.fromId)?.name}</strong> · {m.text}</span>
                      <small>{timeAgo(m.timestamp)}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Can>
      </aside>
      {schedulingFor && (
        <MatchScheduleVisitSheet
          lead={lead}
          listing={schedulingFor}
          onClose={() => setSchedulingFor(null)}
        />
      )}
    </div>
  );
}

function NewLeadModal({ onClose }) {
  const { actions, state, currentUser } = useStore();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState('Website');
  const [projectId, setProjectId] = useState(state.projects[0]?.id || '');
  const [budgetMin, setBudgetMin] = useState(10000000);
  const [budgetMax, setBudgetMax] = useState(15000000);
  const [unitType, setUnitType] = useState('2BHK');
  const [notes, setNotes] = useState('');

  const submit = () => {
    if (!name || !phone || !projectId) {
      actions.toast('Name, phone, and project are required.', 'error');
      return;
    }
    const lead = {
      name,
      phone,
      email,
      source,
      projectId,
      budgetMin: Number(budgetMin),
      budgetMax: Number(budgetMax),
      unitType,
      notes,
      status: 'New',
      score: 'warm',
      ownerId: currentUser.id,
      teamId: currentUser.teamId,
      lastContact: new Date().toISOString(),
      nextFollowUp: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      tags: [],
    };
    const ok = actions.createLead(lead);
    if (ok !== false) {
      actions.toast(`Lead ${name} created.`, 'success');
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New lead"
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Create lead
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Name" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Lead full name" />
        </Field>
        <Field label="Phone" required>
          <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98XXX XXXXX" />
        </Field>
        <Field label="Email">
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
        </Field>
        <Field label="Source">
          <Select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCE_OPTIONS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Project" required span={2}>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Budget (Min)" required>
          <TextInput type="number" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} />
        </Field>
        <Field label="Budget (Max)" required>
          <TextInput type="number" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} />
        </Field>
        <Field label="Unit type">
          <Select value={unitType} onChange={(e) => setUnitType(e.target.value)}>
            <option>1BHK</option>
            <option>2BHK</option>
            <option>3BHK</option>
            <option>4BHK</option>
            <option>4BHK Duplex</option>
            <option>4BHK Sky Villa</option>
          </Select>
        </Field>
        <Field label="Notes" span={2}>
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Lead context, preferences, decision timeline" />
        </Field>
      </div>
    </Modal>
  );
}

function AssignModal({ lead, onClose, onAssigned }) {
  const { state, actions } = useStore();
  const [staffId, setStaffId] = useState(lead.ownerId || '');

  const submit = () => {
    const user = state.users.find((u) => u.id === staffId);
    if (!user) return;
    actions.assignLead(lead.id, user.id, user.teamId);
    actions.toast(`Lead assigned to ${user.name}.`, 'success');
    onAssigned?.();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign ${lead.name}`}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!staffId}>
            Assign
          </Button>
        </>
      }
    >
      <Field label="Reassign to" required>
        <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="" disabled>
            Choose staff member
          </option>
          {state.users
            .filter((u) => u.role !== 'super-admin' && u.status === 'Active')
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.designation}
              </option>
            ))}
        </Select>
      </Field>
      <p className="muted">
        Permissions are scoped. Field executives see only leads they own; managers
        see team-wide. The assignee will be notified instantly.
      </p>
    </Modal>
  );
}

// ---------- Matching listings (lead ↔ listing relation) ----------

// Section in the lead drawer that ranks every in-scope listing against this
// lead's requirements, surfaces a score + reason, and lets staff mark a
// match or schedule a visit pre-attached to the listing. See
// docs/LEAD_LISTING_MATCHING.md for the design rationale.
function MatchingListings({ lead, onScheduleVisit }) {
  const { state, currentUser, actions } = useStore();
  const [showLoose, setShowLoose] = useState(false);
  const { listings: apiListings } = useListings();

  // Scope the candidate pool first — never recommend a listing the user
  // can't see. rankLeadMatches then applies the hard filters (availability,
  // intent compatibility, budget cap).
  const visibleListings = useMemo(
    () => filterByScope(currentUser, 'listings', 'view', apiListings),
    [currentUser, apiListings]
  );

  const strongMatches = useMemo(
    () => rankLeadMatches(lead, visibleListings, state.projects, { topN: 10 }),
    [lead, visibleListings, state.projects]
  );

  const leadMatches = state.matches.filter((m) => m.leadId === lead.id);

  const summary = useMemo(() => {
    const tally = { recommended: 0, matched: 0, visited: 0, rejected: 0 };
    for (const m of leadMatches) {
      if (tally[m.matchStatus] != null) tally[m.matchStatus] += 1;
    }
    return tally;
  }, [leadMatches]);

  const visibleForLead = (m) => {
    const listing = apiListings.find((l) => l.id === m.listingId);
    return listing && can(currentUser, 'listings', 'view', listing);
  };

  return (
    <section className="drawer-section">
      <h4>Matching listings</h4>

      <div className="match-summary-chips">
        <Badge tone="info" size="sm">{summary.recommended} recommended</Badge>
        <Badge tone="success" size="sm">{summary.matched} matched</Badge>
        <Badge tone="neutral" size="sm">{summary.visited} visited</Badge>
        <Badge tone="danger" size="sm">{summary.rejected} rejected</Badge>
      </div>

      {leadMatches.filter(visibleForLead).length > 0 && (
        <div className="match-existing">
          {leadMatches
            .filter(visibleForLead)
            .map((m) => {
              const listing = apiListings.find((l) => l.id === m.listingId);
              return (
                <ExistingMatchRow
                  key={m.id}
                  match={m}
                  listing={listing}
                  onToggle={() => {
                    const next = m.matchStatus === 'matched' ? 'visited' : 'matched';
                    actions.updateMatchStatus(m.id, next);
                    actions.toast(`Marked as ${next}.`, 'success');
                  }}
                  onRemove={() => {
                    actions.deleteMatch(m.id);
                    actions.toast('Match removed.', 'info');
                  }}
                />
              );
            })}
        </div>
      )}

      {strongMatches.length === 0 ? (
        leadMatches.filter(visibleForLead).length === 0 ? (
          <p className="muted">No strong matches yet — try widening the budget or unit type.</p>
        ) : null
      ) : (
        <div className="match-section">
          {strongMatches.map(({ listing, score, reason }) => (
            <MatchRow
              key={listing.id}
              listing={listing}
              score={score}
              reason={reason}
              lead={lead}
              onScheduleVisit={onScheduleVisit}
            />
          ))}
        </div>
      )}

      {strongMatches.length === 0 && (
        <LooseMatchesFooter
          lead={lead}
          visibleListings={visibleListings}
          projects={state.projects}
          show={showLoose}
          onToggle={() => setShowLoose((v) => !v)}
        />
      )}
    </section>
  );
}

function MatchRow({ listing, score, reason, lead, onScheduleVisit }) {
  const { state, actions } = useStore();
  const existing = state.matches.find(
    (m) => m.leadId === lead.id && m.listingId === listing.id
  );
  const status = existing?.matchStatus || null;

  const toggle = (nextStatus) => {
    if (!existing) {
      actions.createMatch(lead.id, listing.id, nextStatus);
      actions.toast(`Matched "${listing.title}".`, 'success');
      return;
    }
    actions.updateMatchStatus(existing.id, nextStatus);
    actions.toast(`Match updated to ${nextStatus}.`, 'success');
  };

  const button = (() => {
    if (!status || status === 'recommended') {
      return (
        <Button size="sm" variant="primary" icon={Check} onClick={() => toggle('matched')}>
          Match
        </Button>
      );
    }
    if (status === 'matched') {
      return (
        <Button size="sm" variant="secondary" icon={Check} onClick={() => toggle('visited')}>
          Mark visited
        </Button>
      );
    }
    if (status === 'visited') {
      return (
        <Button size="sm" variant="ghost" onClick={() => toggle('matched')}>
          Re-match
        </Button>
      );
    }
    return (
      <Button size="sm" variant="ghost" onClick={() => toggle('recommended')}>
        Undo
      </Button>
    );
  })();

  const scoreClass = score >= 75 ? '' : score >= 50 ? 'med' : 'low';

  return (
    <div className="match-row">
      <span className={`match-score ${scoreClass}`}>{score}/100</span>
      <div className="match-row-body">
        <span className="match-row-title">{listing.title}</span>
        <span className="match-row-meta">
          {listing.location?.locality || '—'} · {listing.location?.city || '—'} ·{' '}
          {listing.listingIntent === 'sell' || listing.listingIntent === 'sell-plot'
            ? formatINR(listing.pricing?.price)
            : `${formatINR(listing.pricing?.rentMonthly)}/mo`}
          {' · '}
          <Badge tone={verificationTone(listing.status?.verification)} size="sm">
            {listing.status?.verification || 'unverified'}
          </Badge>
        </span>
        <span className="match-row-reason">{reason}</span>
      </div>
      <div className="match-row-actions">
        {button}
        <Can resource="leads" action="edit" record={lead}>
          <Button
            size="sm"
            variant="secondary"
            icon={CalendarPlus}
            onClick={() => onScheduleVisit(listing)}
          >
            Schedule visit
          </Button>
        </Can>
      </div>
    </div>
  );
}

function ExistingMatchRow({ match, listing, onToggle, onRemove }) {
  if (!listing) return null;
  const scoreClass = match.score >= 75 ? '' : match.score >= 50 ? 'med' : 'low';
  const statusTone =
    match.matchStatus === 'matched'
      ? 'success'
      : match.matchStatus === 'visited'
        ? 'neutral'
        : match.matchStatus === 'rejected'
          ? 'danger'
          : 'info';
  return (
    <div className="match-row match-row-existing">
      <span className={`match-score ${scoreClass}`}>{match.score}/100</span>
      <div className="match-row-body">
        <span className="match-row-title">{listing.title}</span>
        <span className="match-row-meta">
          <Badge tone={statusTone} dot size="sm">
            {match.matchStatus}
          </Badge>
          {' · '}
          {timeAgo(match.updatedAt)}
        </span>
      </div>
      <div className="match-row-actions">
        {match.matchStatus !== 'visited' && match.matchStatus !== 'rejected' && (
          <Button size="sm" variant="ghost" onClick={onToggle}>
            {match.matchStatus === 'matched' ? 'Mark visited' : 'Mark matched'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function LooseMatchesFooter({ lead, visibleListings, projects, show, onToggle }) {
  const loose = useMemo(
    () => rankLeadMatchesLoose(lead, visibleListings, projects, { topN: 5, minScore: 35 }),
    [lead, visibleListings, projects]
  );
  if (loose.length === 0) return null;
  return (
    <div className="match-loose-footer">
      <button className="link" onClick={onToggle}>
        {show ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {show ? 'Hide lower-confidence matches' : `Show lower-confidence matches (${loose.length})`}
      </button>
      {show && (
        <div className="match-section match-section-loose">
          {loose.map(({ listing, score, reason }) => (
            <div className="match-row match-row-loose" key={listing.id}>
              <span className="match-score low">{score}/100</span>
              <div className="match-row-body">
                <span className="match-row-title">{listing.title}</span>
                <span className="match-row-meta">
                  {listing.location?.locality || '—'} · {listing.location?.city || '—'}
                </span>
                <span className="match-row-reason">{reason}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Local scheduling sheet — see plan §7. Kept inside Leads.jsx (~70 lines)
// rather than exporting NewVisitModal from SiteVisits.jsx, to avoid global
// plumbing of pre-attached lead/listing context into a module-private modal.
function MatchScheduleVisitSheet({ lead, listing, onClose }) {
  const { actions, state, currentUser } = useStore();
  const defaultIso = useMemo(() => {
    const d = new Date();
    d.setHours(d.getHours() + 2, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  }, []);
  const [scheduledFor, setScheduledFor] = useState(defaultIso);
  const [staffId, setStaffId] = useState(currentUser?.id || '');
  const [notes, setNotes] = useState(
    `From listing match: ${listing.title} — matched score ${listing.score || ''}`.trim()
  );

  const submit = () => {
    if (!staffId) {
      actions.toast('Choose a staff member to assign.', 'error');
      return;
    }
    actions.createVisit({
      leadId: lead.id,
      projectId: listing.projectId || lead.projectId,
      staffId,
      scheduledFor: new Date(scheduledFor).toISOString(),
      notes,
      listingId: listing.id,
    });
    actions.toast(`Visit scheduled with ${listing.title}.`, 'success');
    // The visit itself flows from match → visit card via visit.listingId.
    // We also bump the match status to 'visited' so the lifecycle reflects it.
    const existingMatch = state.matches.find(
      (m) => m.leadId === lead.id && m.listingId === listing.id
    );
    if (existingMatch && existingMatch.matchStatus !== 'visited') {
      actions.updateMatchStatus(existingMatch.id, 'visited');
    } else if (!existingMatch) {
      actions.createMatch(lead.id, listing.id, 'visited');
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Schedule visit from listing match"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Schedule visit</Button>
        </>
      }
    >
      <p className="muted">
        Lead <strong>{lead.name}</strong> · Listing <strong>{listing.title}</strong>
      </p>
      <Field label="Date & time" required>
        <input
          type="datetime-local"
          className="text-input-plain"
          value={scheduledFor}
          onChange={(e) => setScheduledFor(e.target.value)}
        />
      </Field>
      <Field label="Assigned staff" required>
        <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {state.users
            .filter((u) => u.role === 'field-executive' || u.role === 'sales-manager')
            .map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
        </Select>
      </Field>
      <Field label="Notes" span={2}>
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}
