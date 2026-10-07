import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarClock, ChevronLeft, ChevronRight, MapPin, Plus } from 'lucide-react';
import { useStore } from '../state/store.jsx';
import { useListings } from '../services/listingsData.jsx';
import { contactIntakeApi } from '../services/contactIntakeApi.js';
import { visitsApi } from '../services/visitsApi.js';
import { Badge, Button, EmptyState, Field, LoadingState, Modal, Select, TextInput, formatDateTime, timeAgo } from '../components/ui.jsx';

const NEXT = {
  Scheduled: ['Assigned', 'Visit cancelled', 'Visit rescheduled'],
  Assigned: ['Accepted', 'Visit cancelled', 'Visit rescheduled'],
  Accepted: ['On the way', 'Visit cancelled', 'Visit rescheduled'],
  'On the way': ['Reached', 'Visit cancelled', 'Visit rescheduled'],
  Reached: ['Client assisted', 'Client did not attend', 'Visit cancelled', 'Visit rescheduled'],
  'Client assisted': ['Completed', 'Visit cancelled', 'Visit rescheduled'],
  'Visit rescheduled': ['Assigned', 'Visit cancelled'],
  'In Progress': ['Reached', 'Client assisted', 'Client did not attend', 'Completed', 'Visit cancelled'],
};
const CLOSED = new Set(['Completed', 'Client did not attend', 'Visit cancelled', 'Cancelled', 'No Show']);
const errorText = (error) => error?.message || 'The request could not be completed.';
const localDateTime = (value = new Date()) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toIso = (value) => new Date(value).toISOString();
const permit = (user, action) => user?.permissionMatrix?.visits?.[action] !== 'none' && Boolean(user?.permissionMatrix?.visits?.[action]);

export function LiveVisits({ mobile = false }) {
  const { currentUser } = useStore();
  const { listings, status: listingsStatus } = useListings();
  const [list, setList] = useState({ status: 'loading', items: [], pagination: { total: 0 }, error: null });
  const [detail, setDetail] = useState({ status: 'idle', item: null, error: null });
  const [selectedId, setSelectedId] = useState(null);
  const [offset, setOffset] = useState(0);
  const [scope, setScope] = useState('upcoming');
  const [statusFilter, setStatusFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [agents, setAgents] = useState([]);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const reload = () => setRevision((value) => value + 1);

  // Board window: Today is local-midnight to midnight (datetime-local day
  // arithmetic is local, so keep this local too); Upcoming is now → +7 days.
  const range = useMemo(() => {
    if (scope === 'all') return {};
    if (scope === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 86400000);
      return { from: start.toISOString(), to: end.toISOString() };
    }
    return { from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86400000).toISOString() };
  }, [scope]);

  useEffect(() => {
    // Gated by visits:create like the schedule form — see assignee route.
    // Hides itself when the picker returns one or zero executives.
    if (!permit(currentUser, 'create')) return;
    visitsApi.assignees().then((data) => setAgents(data.items || [])).catch(() => setAgents([]));
  }, [currentUser]);

  useEffect(() => {
    const controller = new AbortController();
    setList({ status: 'loading', items: [], pagination: { total: 0 }, error: null });
    visitsApi.list({
      limit: 25,
      offset,
      status: statusFilter || undefined,
      assignedTo: agentFilter || undefined,
      from: range.from,
      to: range.to,
      order: 'asc',
    }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setList({ status: 'ready', items: result.items || [], pagination: result.pagination || { total: 0 }, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setList({ status: 'error', items: [], pagination: { total: 0 }, error }); });
    return () => controller.abort();
  }, [offset, statusFilter, agentFilter, range, revision]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const controller = new AbortController();
    setDetail({ status: 'loading', item: null, error: null });
    visitsApi.get(selectedId, controller.signal)
      .then((item) => { if (!controller.signal.aborted) setDetail({ status: 'ready', item, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setDetail({ status: 'error', item: null, error }); });
    return () => controller.abort();
  }, [selectedId, revision]);

  const resetFilters = () => { setOffset(0); setScope('upcoming'); setStatusFilter(''); setAgentFilter(''); };

  return (
    <div className={`live-visits ${mobile ? 'live-visits-mobile' : ''}`}>
      <header className="live-visits-header">
        <h2>Site Visits</h2>
        {permit(currentUser, 'create') && <Button icon={Plus} onClick={() => setCreating(true)}>Schedule visit</Button>}
      </header>
      <div className={`live-visits-main ${selectedId ? 'has-detail' : ''}`}>
        <section className={`live-visits-list ${selectedId && mobile ? 'live-visits-list-hidden' : ''}`} aria-label="Visits">
          <div className="live-visits-toolbar">
            <div className="tabs" role="tablist" aria-label="Visit window">
              {[['upcoming', 'Upcoming'], ['today', 'Today'], ['all', 'All']].map(([key, label]) => (
                <button key={key} role="tab" aria-selected={scope === key} className={`tab ${scope === key ? 'tab-active' : ''}`} onClick={() => { setOffset(0); setScope(key); }}>{label}</button>
              ))}
            </div>
          </div>
          <div className="live-visits-toolbar live-visits-filters">
            <Field label="Status"><Select value={statusFilter} onChange={(event) => { setOffset(0); setStatusFilter(event.target.value); }}>
              <option value="">All statuses</option>
              {['Assigned', 'Accepted', 'On the way', 'Reached', 'Client assisted', 'Client did not attend', 'Visit rescheduled', 'Visit cancelled', 'Completed'].map((status) => <option key={status}>{status}</option>)}
            </Select></Field>
            {agents.length > 1 && <Field label="Executive"><Select value={agentFilter} onChange={(event) => { setOffset(0); setAgentFilter(event.target.value); }}>
              <option value="">All executives</option>
              {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
            </Select></Field>}
            {list.status === 'ready' && <small>{list.pagination.total} visits</small>}
          </div>
          {list.status === 'loading' && <LoadingState label="Loading visits" />}
          {list.status === 'error' && <div className="live-visits-error" role="alert"><p>{errorText(list.error)}</p><Button variant="secondary" size="sm" onClick={reload}>Retry</Button></div>}
          {list.status === 'ready' && list.items.length === 0 && <EmptyState icon={CalendarClock} title="No visits here" description="Try a different window or clear the filters." action={<Button variant="secondary" size="sm" onClick={resetFilters}>Clear filters</Button>} />}
          {list.status === 'ready' && <div className="live-visits-rows">{list.items.map((visit) => (
            <button className={`live-visits-row ${selectedId === visit.id ? 'selected' : ''}`} key={visit.id} onClick={() => setSelectedId(visit.id)}>
              <span><strong>{visit.leadName || 'Client'}</strong><small>{formatDateTime(visit.scheduledAt)}</small></span>
              <span><Badge tone={visit.status === 'Completed' ? 'success' : CLOSED.has(visit.status) ? 'warning' : 'info'} size="sm">{visit.status}</Badge><small>{visit.agentName} · {visit.viewingCount} shown · {timeAgo(visit.updatedAt)}</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}</div>}
          {list.status === 'ready' && list.pagination.total > 25 && <nav className="live-visits-pages" aria-label="Visit pages">
            <button className="btn-icon" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={16} /></button>
            <span>{offset + 1}-{Math.min(offset + 25, list.pagination.total)} of {list.pagination.total}</span>
            <button className="btn-icon" aria-label="Next page" disabled={offset + 25 >= list.pagination.total} onClick={() => setOffset(offset + 25)}><ChevronRight size={16} /></button>
          </nav>}
        </section>
        {selectedId && <section className="live-visits-detail" aria-label="Visit details">
          <button className="contact-back" onClick={() => setSelectedId(null)}><ArrowLeft size={16} /> Back</button>
          {detail.status === 'loading' && <LoadingState label="Loading visit" />}
          {detail.status === 'error' && <div className="live-visits-error" role="alert"><p>{errorText(detail.error)}</p><Button size="sm" onClick={reload}>Retry</Button></div>}
          {detail.status === 'ready' && <VisitDetail visit={detail.item} user={currentUser} listings={listings} listingsStatus={listingsStatus} onChanged={reload} />}
        </section>}
      </div>
      {creating && <ScheduleVisit onClose={() => setCreating(false)} onCreated={(created) => { setCreating(false); setSelectedId(created.id); reload(); }} listings={listings} />}
    </div>
  );
}

function ScheduleVisit({ onClose, onCreated, listings }) {
  const [leads, setLeads] = useState([]);
  const [agents, setAgents] = useState([]);
  const [leadSearch, setLeadSearch] = useState('');
  const [form, setForm] = useState({ leadId: '', assignedTo: '', scheduledAt: localDateTime(new Date(Date.now() + 86400000)), listingId: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    visitsApi.assignees().then((data) => setAgents(data.items || [])).catch(setError);
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => contactIntakeApi.listLeads({ q: leadSearch, limit: 50 })
      .then((data) => { if (active) setLeads(data.items || []); }).catch((err) => { if (active) setError(err); }), 200);
    return () => { active = false; clearTimeout(timer); };
  }, [leadSearch]);
  const field = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { onCreated(await visitsApi.create({ ...form, listingId: form.listingId || null, scheduledAt: toIso(form.scheduledAt) })); }
    catch (err) { setError(err); setBusy(false); }
  };
  return <Modal open title="Schedule visit" onClose={busy ? undefined : onClose} width={620} footer={
    <><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="schedule-visit-form" disabled={busy || !agents.length}>{busy ? 'Saving' : 'Schedule visit'}</Button></>
  }><form id="schedule-visit-form" className="live-visits-form" onSubmit={submit}>
    <Field label="Find lead"><TextInput value={leadSearch} onChange={(event) => { setLeadSearch(event.target.value); setForm((prev) => ({ ...prev, leadId: '' })); }} placeholder="Name or phone" /></Field>
    <Field label="Client lead" required><Select value={form.leadId} onChange={field('leadId')} required><option value="">Select lead</option>{leads.map((lead) => <option value={lead.id} key={lead.id}>{lead.name} · {lead.phone}</option>)}</Select></Field>
    <Field label="Field executive" required><Select value={form.assignedTo} onChange={field('assignedTo')} required><option value="">Select executive</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</Select></Field>
    <Field label="Date and time" required><TextInput type="datetime-local" value={form.scheduledAt} onChange={field('scheduledAt')} required /></Field>
    <Field label="Initial property"><Select value={form.listingId} onChange={field('listingId')}><option value="">Choose later</option>{listings.map((listing) => <option value={listing.id} key={listing.id}>{listing.title}</option>)}</Select></Field>
    <Field label="Instructions"><textarea value={form.notes} onChange={field('notes')} rows={3} maxLength={4000} /></Field>
    {!agents.length && !error && <p className="live-visits-muted">No active field executives available for assignment.</p>}
    {error && <p className="live-visits-error" role="alert">{errorText(error)}</p>}
  </form></Modal>;
}

function VisitDetail({ visit, user, listings, listingsStatus, onChanged }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [newTime, setNewTime] = useState(localDateTime(visit.scheduledAt));
  const [listingSearch, setListingSearch] = useState('');
  const [viewing, setViewing] = useState({ listingId: '', shownAt: localDateTime(), assistanceStatus: 'assisted', feedback: '' });
  const [agents, setAgents] = useState([]);
  const [newAgent, setNewAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setStatus(''); setNote(''); setNewTime(localDateTime(visit.scheduledAt));
  }, [visit.id, visit.status, visit.scheduledAt]);
  const next = (NEXT[visit.status] || []).filter((value) => user?.role !== 'telecaller' || ['Visit cancelled', 'Visit rescheduled'].includes(value));
  const canEdit = permit(user, 'edit') && (user?.role !== 'field-executive' || visit.assignedTo === user.id);
  const canAssign = permit(user, 'assign') && !CLOSED.has(visit.status);
  const canView = canEdit && user?.role !== 'telecaller' && ['Reached', 'Client assisted'].includes(visit.status);
  const choices = useMemo(() => listings.filter((listing) => listing.title?.toLowerCase().includes(listingSearch.toLowerCase())).slice(0, 50), [listings, listingSearch]);
  useEffect(() => {
    if (canAssign) visitsApi.assignees().then((result) => setAgents(result.items || [])).catch(setError);
  }, [canAssign]);
  const submit = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  };

  return <>
    <div className="live-visits-title"><h3>{visit.leadName || 'Client'}</h3><Badge tone={visit.status === 'Completed' ? 'success' : CLOSED.has(visit.status) ? 'warning' : 'info'}>{visit.status}</Badge></div>
    <dl className="contact-facts">
      <div><dt>Scheduled</dt><dd>{formatDateTime(visit.scheduledAt)}</dd></div>
      <div><dt>Executive</dt><dd>{visit.agentName || visit.assignedTo}</dd></div>
      {visit.leadPhone && <div><dt>Client phone</dt><dd><a href={`tel:${visit.leadPhone}`}>{visit.leadPhone}</a></dd></div>}
      {visit.notes && <div><dt>Instructions</dt><dd>{visit.notes}</dd></div>}
    </dl>
    {error && <p className="live-visits-error" role="alert">{errorText(error)}</p>}
    {canEdit && next.length > 0 && <form className="live-visits-form live-visits-action" onSubmit={(event) => { event.preventDefault(); submit(() => visitsApi.status(visit.id, { status, note, scheduledAt: status === 'Visit rescheduled' ? toIso(newTime) : undefined })); }}>
      <h4>Update visit</h4>
      <Field label="Next status"><Select value={status} onChange={(event) => setStatus(event.target.value)} required><option value="">Choose status</option>{next.map((value) => <option key={value}>{value}</option>)}</Select></Field>
      {status === 'Visit rescheduled' && <Field label="New date and time"><TextInput type="datetime-local" value={newTime} onChange={(event) => setNewTime(event.target.value)} required /></Field>}
      <Field label="Note"><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={4000} /></Field>
      {status === 'Completed' && visit.viewings.every((item) => item.assistanceStatus !== 'assisted') && <p className="live-visits-muted">Record an assisted property before completing the visit.</p>}
      <Button type="submit" disabled={busy || !status || (status === 'Completed' && visit.viewings.every((item) => item.assistanceStatus !== 'assisted'))}>Save status</Button>
    </form>}
    {canAssign && <form className="live-visits-form live-visits-action" onSubmit={(event) => { event.preventDefault(); submit(() => visitsApi.assign(visit.id, { assignedTo: newAgent })); }}>
      <h4>Reassign executive</h4><Field label="Field executive"><Select value={newAgent} onChange={(event) => setNewAgent(event.target.value)} required><option value="">Choose executive</option>{agents.filter((agent) => agent.id !== visit.assignedTo).map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</Select></Field>
      <Button variant="secondary" type="submit" disabled={busy || !newAgent}>Reassign</Button>
    </form>}
    <div className="live-visits-section"><h4>Properties shown</h4><span>{visit.viewings.length}</span></div>
    {visit.viewings.length === 0 ? <p className="live-visits-muted">No property viewing recorded yet.</p> : <ol className="live-visits-history">{visit.viewings.map((item) => <li key={item.id}>
      <strong><MapPin size={15} /> {item.listingTitle}</strong><small>{formatDateTime(item.shownAt)} · {item.agentName} · {item.assistanceStatus.replaceAll('_', ' ')}</small>{item.feedback && <p>{item.feedback}</p>}
    </li>)}</ol>}
    {canView && <form className="live-visits-form live-visits-action" onSubmit={(event) => { event.preventDefault(); submit(() => visitsApi.addViewing(visit.id, { ...viewing, shownAt: toIso(viewing.shownAt) })); }}>
      <h4>Record property viewing</h4>
      <Field label="Find property"><TextInput value={listingSearch} onChange={(event) => { setListingSearch(event.target.value); setViewing((prev) => ({ ...prev, listingId: '' })); }} placeholder="Search title" /></Field>
      <Field label="Property"><Select value={viewing.listingId} onChange={(event) => setViewing((prev) => ({ ...prev, listingId: event.target.value }))} required><option value="">Select property</option>{choices.map((listing) => <option value={listing.id} key={listing.id}>{listing.title}</option>)}</Select></Field>
      <Field label="Shown at"><TextInput type="datetime-local" value={viewing.shownAt} onChange={(event) => setViewing((prev) => ({ ...prev, shownAt: event.target.value }))} required /></Field>
      <Field label="Assistance"><Select value={viewing.assistanceStatus} onChange={(event) => setViewing((prev) => ({ ...prev, assistanceStatus: event.target.value }))}><option value="assisted">Client assisted</option><option value="client_no_show">Client did not attend</option><option value="not_shown">Not shown</option></Select></Field>
      <Field label="Client feedback"><textarea value={viewing.feedback} onChange={(event) => setViewing((prev) => ({ ...prev, feedback: event.target.value }))} rows={2} maxLength={4000} /></Field>
      {listingsStatus !== 'ready' && <p className="live-visits-muted">Properties are still loading.</p>}
      <Button type="submit" disabled={busy || !viewing.listingId}>Record viewing</Button>
    </form>}
    <div className="live-visits-section"><h4>Status history</h4><span>{visit.events.length}</span></div>
    <ol className="live-visits-history">{visit.events.map((event) => <li key={event.id}><strong>{event.status}</strong><small>{formatDateTime(event.occurredAt)} · {event.actorName || 'Staff'}</small>{event.scheduledAt && <small>Visit time: {formatDateTime(event.scheduledAt)}</small>}{event.note && <p>{event.note}</p>}</li>)}</ol>
  </>;
}
