// Site Visit Management — the second-most active operational module.

import React, { useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Filter,
  Link2,
  MapPin,
  Plus,
  Star,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope, can } from '../../data/permissions.js';
import { useListings } from '../../services/listingsData.jsx';
import { isApiRepositoryActive } from '../../services/index.js';
import { LiveVisits } from '../LiveVisits.jsx';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  Select,
  StatTile,
  TextInput,
  formatDate,
  formatDateTime,
  formatTime,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

export function SiteVisits() {
  if (isApiRepositoryActive()) return <LiveVisits />;
  return <DemoSiteVisits />;
}

function DemoSiteVisits() {
  const { state, currentUser, actions } = useStore();
  const { listings: apiListings } = useListings();
  const [tab, setTab] = useState('upcoming'); // upcoming | today | completed
  const [statusFilter, setStatusFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [staffFilter, setStaffFilter] = useState('all');
  const [creating, setCreating] = useState(false);

  const visits = useMemo(
    () => filterByScope(currentUser, 'visits', 'view', state.visits),
    [currentUser, state.visits]
  );

  const todayIso = new Date().toISOString().slice(0, 10);
  const filtered = useMemo(() => {
    return visits.filter((visit) => {
      if (tab === 'today') {
        const scheduledIso = visit.scheduledFor?.slice(0, 10);
        if (scheduledIso !== todayIso) return false;
      } else if (tab === 'upcoming') {
        if (!visit.scheduledFor) return false;
        const scheduled = new Date(visit.scheduledFor).getTime();
        if (scheduled < Date.now() - 12 * 3600 * 1000) return false;
        if (visit.status === 'Completed') return false;
      } else if (tab === 'completed') {
        if (visit.status !== 'Completed') return false;
      }
      if (statusFilter !== 'all' && visit.status !== statusFilter) return false;
      if (projectFilter !== 'all' && visit.projectId !== projectFilter) return false;
      if (staffFilter !== 'all' && visit.staffId !== staffFilter) return false;
      return true;
    });
  }, [visits, tab, statusFilter, projectFilter, staffFilter, todayIso]);

  const todayVisits = visits.filter((v) => v.scheduledFor?.slice(0, 10) === todayIso);
  const completed = todayVisits.filter((v) => v.status === 'Completed').length;
  const avgRating = (() => {
    const rated = todayVisits.filter((v) => v.rating);
    if (rated.length === 0) return '—';
    return (rated.reduce((s, v) => s + v.rating, 0) / rated.length).toFixed(1);
  })();

  return (
    <div className="visits-page">
      <section className="stat-grid">
        <StatTile label="Today's visits" value={todayVisits.length} tone="info" icon={CalendarClock} />
        <StatTile label="Completed today" value={completed} tone="success" icon={CheckCircle2} />
        <StatTile label="Avg rating" value={avgRating} tone="premium" icon={Star} />
        <StatTile label="Upcoming this week" value={visits.filter((v) => new Date(v.scheduledFor).getTime() > Date.now() && new Date(v.scheduledFor).getTime() < Date.now() + 7 * 86400000).length} tone="warning" icon={Clock3} />
      </section>

      <Panel
        title="Site Visits"
        subtitle={`${filtered.length} visits in your scope`}
        icon={CalendarClock}
        action={
          <Can resource="visits" action="create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Schedule visit
            </Button>
          </Can>
        }
      >
        <div className="tabs">
          {[
            ['upcoming', 'Upcoming'],
            ['today', 'Today'],
            ['completed', 'Completed'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`tab ${tab === key ? 'tab-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
              <Badge tone="neutral" size="sm">{visits.filter((v) => {
                if (key === 'today') return v.scheduledFor?.slice(0, 10) === todayIso;
                if (key === 'completed') return v.status === 'Completed';
                return new Date(v.scheduledFor).getTime() > Date.now() - 12 * 3600 * 1000 && v.status !== 'Completed';
              }).length}</Badge>
            </button>
          ))}
        </div>

        <div className="filter-bar">
          <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="all">All projects</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)}>
            <option value="all">All staff</option>
            {state.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No visits match"
            description="Try switching tabs or clearing filters."
          />
        ) : (
          <div className="visit-grid">
            {filtered.map((visit) => {
              const lead = state.leads.find((l) => l.id === visit.leadId);
              const project = state.projects.find((p) => p.id === visit.projectId);
              const staff = state.users.find((u) => u.id === visit.staffId);
              return (
                <article className="visit-card" key={visit.id}>
                  <header>
                    <div className="visit-time">
                      <strong>{formatTime(visit.scheduledFor)}</strong>
                      <small>{formatDate(visit.scheduledFor)}</small>
                    </div>
                    <Badge tone={visit.status === 'Completed' ? 'success' : 'info'} dot>
                      {visit.status}
                    </Badge>
                  </header>
                  <div className="visit-card-body">
                    {visit.listingId && (() => {
                      const listing = apiListings.find((l) => l.id === visit.listingId);
                      if (!listing) return null;
                      if (!can(currentUser, 'listings', 'view', listing)) return null;
                      return (
                        <div className="match-listing-source-chip">
                          <Link2 size={12} />
                          <span>Matched from &ldquo;{listing.title}&rdquo;</span>
                        </div>
                      );
                    })()}
                    <div className="visit-card-lead">
                      <Avatar name={lead?.name} size="sm" />
                      <div>
                        <strong>{lead?.name}</strong>
                        <small>{lead?.phone}</small>
                      </div>
                    </div>
                    <ul className="kv-list kv-list-tight">
                      <li><span>Project</span><strong>{project?.name}</strong></li>
                      <li><span>Unit interest</span><strong>{lead?.unitType}</strong></li>
                      <li><span>Assigned to</span><strong>{staff?.name}</strong></li>
                    </ul>
                    <p className="visit-notes">{visit.notes}</p>
                    {visit.status === 'Completed' && (
                      <div className="visit-feedback">
                        <div>
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              size={14}
                              className={i < (visit.rating || 0) ? 'star-on' : 'star-off'}
                            />
                          ))}
                        </div>
                        <small>{visit.feedback}</small>
                      </div>
                    )}
                  </div>
                  <footer>
                    {visit.status !== 'Completed' && (
                      <Can resource="visits" action="edit" record={visit}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            actions.updateVisit(visit.id, {
                              status: 'Completed',
                              completedAt: new Date().toISOString(),
                              rating: 4,
                              feedback: 'Marked completed from desk.',
                            })
                          }
                        >
                          Mark complete
                        </Button>
                      </Can>
                    )}
                    <Can resource="visits" action="edit" record={visit}>
                      <Button size="sm" variant="ghost">Edit</Button>
                    </Can>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      {creating && <NewVisitModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewVisitModal({ onClose }) {
  const { actions, state, currentUser } = useStore();
  const [leadId, setLeadId] = useState(state.leads[0]?.id || '');
  const [projectId, setProjectId] = useState(state.leads[0]?.projectId || state.projects[0]?.id || '');
  const [staffId, setStaffId] = useState(currentUser.id);
  const [scheduledFor, setScheduledFor] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 2, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [notes, setNotes] = useState('');

  const submit = () => {
    actions.createVisit({
      leadId,
      projectId,
      staffId,
      scheduledFor: new Date(scheduledFor).toISOString(),
      notes,
    });
    actions.toast('Visit scheduled.', 'success');
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Schedule a site visit"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>Schedule</Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Lead" required>
          <Select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            {state.leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.phone}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project" required>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned staff" required>
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            {state.users
              .filter((u) => u.role === 'field-executive' || u.role === 'sales-manager')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Date & time" required>
          <input
            type="datetime-local"
            className="text-input-plain"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
          />
        </Field>
        <Field label="Notes" span={2}>
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Special instructions, sample units, materials to carry" />
        </Field>
      </div>
    </Modal>
  );
}
