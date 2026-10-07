import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Clock3, Phone, Plus, Search,
} from 'lucide-react';
import { contactIntakeApi } from '../services/contactIntakeApi.js';
import { leadTimelineApi } from '../services/leadTimelineApi.js';
import {
  Badge, Button, EmptyState, Field, LoadingState, Modal, Select, TextInput,
  buildTelLink, buildWhatsAppLink, formatDateTime,
} from '../components/ui.jsx';

const LEAD_STATUSES = [
  'New', 'Contacted', 'Follow-up', 'Site Visit Scheduled', 'Visit Done',
  'Negotiation', 'Booked', 'Lost',
];
const CALL_OUTCOMES = [
  ['interested', 'Interested'], ['follow_up', 'Follow-up'],
  ['not_interested', 'Not interested'], ['no_answer', 'No answer'], ['other', 'Other'],
];

function localDateTime(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function message(error) {
  return error?.message || 'The request could not be completed.';
}

function usePagedList(kind, query, offset, revision) {
  const [result, setResult] = useState({ status: 'loading', items: [], pagination: { total: 0 }, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setResult({ status: 'loading', items: [], pagination: { total: 0 }, error: null });
    const timer = setTimeout(async () => {
      try {
        const page = { q: query.trim(), limit: 25, offset };
        const response = kind === 'contacts'
          ? await contactIntakeApi.listContacts(page, controller.signal)
          : await contactIntakeApi.listLeads(page, controller.signal);
        if (!controller.signal.aborted) {
          setResult({ status: 'ready', items: response.items || [], pagination: response.pagination || { total: 0 }, error: null });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult({ status: 'error', items: [], pagination: { total: 0 }, error });
        }
      }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [kind, query, offset, revision]);
  return result;
}

// Daily follow-up queue: overdue / today / upcoming windows over the same
// list endpoints. Leads filter on leads.next_follow_up; contacts filter on
// the effective follow-up (MAX over the contact's calls). Clicking a row
// opens the existing detail view, where the outcome is logged (call or
// lead save) and the next follow-up is set — the queue itself stays
// read-only so there is exactly one write path per record type.
function useFollowUpQueue(source, window, query, offset, revision) {
  const [result, setResult] = useState({ status: 'loading', items: [], pagination: { total: 0 }, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setResult({ status: 'loading', items: [], pagination: { total: 0 }, error: null });
    const timer = setTimeout(async () => {
      try {
        const params = { q: query.trim(), limit: 25, offset, ...followUpWindowParams(window) };
        const response = source === 'contacts'
          ? await contactIntakeApi.listContacts(params, controller.signal)
          : await contactIntakeApi.listLeads(params, controller.signal);
        if (!controller.signal.aborted) {
          setResult({ status: 'ready', items: response.items || [], pagination: response.pagination || { total: 0 }, error: null });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult({ status: 'error', items: [], pagination: { total: 0 }, error });
        }
      }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, window, query, offset, revision]);
  return result;
}

// Window key → query params. Overdue is everything strictly before now;
// Today is local-midnight to midnight (same convention as the visits
// board); Upcoming is now → +7 days; All is every record with a due set.
function followUpWindowParams(window) {
  const now = new Date();
  if (window === 'overdue') return { followUpTo: now.toISOString() };
  if (window === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { followUpFrom: start.toISOString(), followUpTo: new Date(start.getTime() + 86400000).toISOString() };
  }
  if (window === 'upcoming') return { followUpFrom: now.toISOString(), followUpTo: new Date(now.getTime() + 7 * 86400000).toISOString() };
  return { followUpSet: 'set' };
}

const FOLLOW_UP_WINDOWS = [
  ['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['all', 'All'],
];

function FollowUpsPanel({ onOpen }) {
  const [source, setSource] = useState('leads');
  const [window, setWindow] = useState('overdue');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const result = useFollowUpQueue(source, window, query, offset, revision);
  const reload = () => setRevision((value) => value + 1);

  const resetWindow = (next) => { setWindow(next); setOffset(0); };
  const resetSource = (next) => { setSource(next); setQuery(''); setOffset(0); };

  return (
    <div className="contact-workspace-main">
      <section className="contact-directory" aria-label="Follow-up queue">
        <div className="contact-workspace-subtabs">
          <div className="contact-segments" role="tablist" aria-label="Follow-up source">
            <button role="tab" aria-selected={source === 'leads'} className={source === 'leads' ? 'active' : ''} onClick={() => resetSource('leads')}>Leads</button>
            <button role="tab" aria-selected={source === 'contacts'} className={source === 'contacts' ? 'active' : ''} onClick={() => resetSource('contacts')}>Contacts</button>
          </div>
          <div className="tabs" role="tablist" aria-label="Follow-up window">
            {FOLLOW_UP_WINDOWS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={window === key} className={`tab ${window === key ? 'tab-active' : ''}`} onClick={() => resetWindow(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="contact-directory-tools">
          <TextInput icon={Search} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder={source === 'contacts' ? 'Search name or phone' : 'Search leads'} aria-label="Search follow-ups" />
          <span>{result.status === 'ready' ? `${result.pagination.total} due` : ''}</span>
        </div>
        {result.status === 'loading' && <LoadingState label="Loading follow-ups" />}
        {result.status === 'error' && (
          <div className="contact-request-error" role="alert">
            <p>{message(result.error)}</p><Button variant="secondary" size="sm" onClick={reload}>Retry</Button>
          </div>
        )}
        {result.status === 'ready' && result.items.length === 0 && (
          <EmptyState title={window === 'overdue' ? 'Nothing overdue' : 'No follow-ups here'} description="Try another window or clear the search." />
        )}
        {result.status === 'ready' && result.items.length > 0 && (
          <div className="contact-directory-list">
            {result.items.map((item) => {
              const due = item.nextFollowUp ? new Date(item.nextFollowUp) : null;
              const overdue = due ? due.getTime() < Date.now() : false;
              return (
                <button key={item.id} className="contact-directory-row" onClick={() => onOpen({ kind: source, id: item.id })}>
                  <span className="contact-directory-name"><strong>{item.name}</strong><small>{item.phone}{source === 'leads' && item.status ? ` · ${item.status}` : ''}</small></span>
                  <Badge tone={overdue ? 'danger' : 'info'} size="sm">{overdue ? 'Overdue' : 'Due'}</Badge>
                  <small>{item.nextFollowUp ? formatDateTime(item.nextFollowUp) : 'No due date'}</small>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {result.status === 'ready' && result.pagination.total > 25 && (
          <nav className="contact-pagination" aria-label="Follow-up pages">
            <button className="btn-icon" title="Previous page" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={17} /></button>
            <span>{offset + 1}-{Math.min(offset + 25, result.pagination.total)} of {result.pagination.total}</span>
            <button className="btn-icon" title="Next page" aria-label="Next page" disabled={offset + 25 >= result.pagination.total} onClick={() => setOffset(offset + 25)}><ChevronRight size={17} /></button>
          </nav>
        )}
      </section>
    </div>
  );
}

export function ContactWorkspace({ mobile = false }) {
  const [kind, setKind] = useState('contacts');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const result = usePagedList(kind, query, offset, revision);
  const reload = () => setRevision((value) => value + 1);

  const switchKind = (next) => {
    setKind(next);
    setQuery('');
    setOffset(0);
    setSelected(null);
  };

  const openFollowUp = ({ kind: source, id }) => {
    setKind(source);
    setQuery('');
    setOffset(0);
    setSelected({ kind: source, id });
    reload();
  };

  return (
    <div className={`contact-workspace ${mobile ? 'contact-workspace-mobile' : ''}`}>
      <header className="contact-workspace-header">
        <div>
          <h2>Lead Management</h2>
          <div className="contact-segments" role="tablist" aria-label="Lead management views">
            <button role="tab" aria-selected={kind === 'contacts'} className={kind === 'contacts' ? 'active' : ''} onClick={() => switchKind('contacts')}>Contacts</button>
            <button role="tab" aria-selected={kind === 'leads'} className={kind === 'leads' ? 'active' : ''} onClick={() => switchKind('leads')}>Leads</button>
            <button role="tab" aria-selected={kind === 'followups'} className={kind === 'followups' ? 'active' : ''} onClick={() => switchKind('followups')}>Follow-ups</button>
          </div>
        </div>
        {kind === 'contacts' && <Button icon={Plus} onClick={() => setCreating(true)}>New contact</Button>}
      </header>

      {kind === 'followups' ? (
        <FollowUpsPanel onOpen={openFollowUp} />
      ) : (
      <div className={`contact-workspace-main ${selected ? 'has-detail' : ''}`}>
        <section className={`contact-directory ${selected && mobile ? 'contact-directory-hidden' : ''}`} aria-label={kind}>
          <div className="contact-directory-tools">
            <TextInput icon={Search} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder={kind === 'contacts' ? 'Search name or phone' : 'Search leads'} aria-label={kind === 'contacts' ? 'Search contacts' : 'Search leads'} />
            <span>{result.status === 'ready' ? `${result.pagination.total} ${kind}` : ''}</span>
          </div>
          {result.status === 'loading' && <LoadingState label={`Loading ${kind}`} />}
          {result.status === 'error' && (
            <div className="contact-request-error" role="alert">
              <p>{message(result.error)}</p><Button variant="secondary" size="sm" onClick={reload}>Retry</Button>
            </div>
          )}
          {result.status === 'ready' && result.items.length === 0 && (
            <EmptyState title={query ? 'No matches' : `No ${kind} yet`} description={query ? 'Try another search.' : undefined} />
          )}
          {result.status === 'ready' && result.items.length > 0 && (
            <div className="contact-directory-list">
              {result.items.map((item) => (
                <button key={item.id} className={`contact-directory-row ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => setSelected({ kind, id: item.id })}>
                  <span className="contact-directory-name"><strong>{item.name}</strong><small>{item.phone}</small></span>
                  {kind === 'contacts'
                    ? <Badge tone={item.leadId ? 'success' : 'neutral'} size="sm">{item.leadId ? 'Lead' : 'Contact'}</Badge>
                    : <Badge tone={item.status === 'Booked' ? 'success' : 'info'} size="sm">{item.status}</Badge>}
                  <small>{kind === 'contacts' ? formatDateTime(item.createdAt) : formatDateTime(item.nextFollowUp)}</small>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          {result.status === 'ready' && result.pagination.total > 25 && (
            <nav className="contact-pagination" aria-label={`${kind} pages`}>
              <button className="btn-icon" title="Previous page" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={17} /></button>
              <span>{offset + 1}-{Math.min(offset + 25, result.pagination.total)} of {result.pagination.total}</span>
              <button className="btn-icon" title="Next page" aria-label="Next page" disabled={offset + 25 >= result.pagination.total} onClick={() => setOffset(offset + 25)}><ChevronRight size={17} /></button>
            </nav>
          )}
        </section>

        {selected && (
          <section className="contact-detail" aria-label={`${selected.kind === 'contacts' ? 'Contact' : 'Lead'} details`}>
            <button className="contact-back" onClick={() => setSelected(null)}><ArrowLeft size={16} /> Back</button>
            {selected.kind === 'contacts' ? (
              <ContactDetail
                id={selected.id}
                onConverted={(leadId) => { setKind('leads'); setQuery(''); setOffset(0); setSelected({ kind: 'leads', id: leadId }); reload(); }}
              />
            ) : <LeadDetail id={selected.id} onSaved={reload} onOpenContact={(contactId) => {
              setKind('contacts'); setQuery(''); setOffset(0);
              setSelected({ kind: 'contacts', id: contactId }); reload();
            }} />}
          </section>
        )}
      </div>
      )}
      {creating && (
        <NewContactModal onClose={() => setCreating(false)} onCreated={(contact) => {
          setCreating(false); setKind('contacts'); setQuery(''); setOffset(0);
          setSelected({ kind: 'contacts', id: contact.id }); reload();
        }} />
      )}
    </div>
  );
}

function NewContactModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', phone: '', alternatePhone: '', email: '', requirements: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = (name) => (event) => setForm((prev) => ({ ...prev, [name]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { onCreated(await contactIntakeApi.createContact(form)); }
    catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal open onClose={busy ? undefined : onClose} title="New contact" footer={
      <><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="new-contact-form" disabled={busy}>{busy ? 'Saving' : 'Save contact'}</Button></>
    }>
      <form id="new-contact-form" onSubmit={submit} className="contact-form">
        <Field label="Name" required><TextInput value={form.name} onChange={field('name')} required maxLength={200} autoFocus /></Field>
        <Field label="Phone" required><TextInput type="tel" value={form.phone} onChange={field('phone')} required maxLength={40} /></Field>
        <Field label="Alternate phone"><TextInput type="tel" value={form.alternatePhone} onChange={field('alternatePhone')} maxLength={40} /></Field>
        <Field label="Email"><TextInput type="email" value={form.email} onChange={field('email')} maxLength={200} /></Field>
        <Field label="Requirements"><textarea value={form.requirements} onChange={field('requirements')} maxLength={4000} rows={3} /></Field>
        <Field label="Notes"><textarea value={form.notes} onChange={field('notes')} maxLength={4000} rows={3} /></Field>
        {error && <p className="contact-request-error" role="alert">{message(error)}</p>}
      </form>
    </Modal>
  );
}

function ContactDetail({ id, onConverted }) {
  const [contact, setContact] = useState(null);
  const [calls, setCalls] = useState({ items: [], pagination: { total: 0 } });
  const [callOffset, setCallOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [logging, setLogging] = useState(false);
  const [converting, setConverting] = useState(false);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading'); setError(null); setContact(null);
    Promise.all([
      contactIntakeApi.getContact(id, controller.signal),
      contactIntakeApi.listCalls(id, { limit: 25, offset: callOffset }, controller.signal),
    ]).then(([detail, history]) => {
      if (!controller.signal.aborted) { setContact(detail); setCalls(history); setStatus('ready'); }
    }).catch((err) => {
      if (!controller.signal.aborted) { setError(err); setStatus('error'); }
    });
    return () => controller.abort();
  }, [id, callOffset, revision]);

  const convert = async () => {
    setConverting(true); setError(null);
    try { const result = await contactIntakeApi.convert(id); onConverted(result.leadId); }
    catch (err) { setError(err); setConverting(false); }
  };

  if (status === 'loading') return <LoadingState label="Loading contact" />;
  if (status === 'error') return <div className="contact-request-error" role="alert"><p>{message(error)}</p><Button variant="secondary" size="sm" onClick={refresh}>Retry</Button></div>;
  return (
    <>
      <div className="contact-detail-title"><h3>{contact.name}</h3><Badge tone={contact.leadId ? 'success' : 'neutral'}>{contact.leadId ? 'Lead' : 'Contact'}</Badge></div>
      <div className="contact-detail-actions">
        <a className="btn btn-secondary btn-sm" href={buildTelLink(contact.phone)}><Phone size={14} /> Call</a>
        <a className="btn btn-secondary btn-sm" href={buildWhatsAppLink(contact.phone)} target="_blank" rel="noreferrer">WhatsApp</a>
        <Button variant="secondary" size="sm" icon={Plus} onClick={() => setLogging(true)}>Log call</Button>
      </div>
      <dl className="contact-facts">
        <div><dt>Phone</dt><dd>{contact.phone}</dd></div>
        {contact.alternatePhone && <div><dt>Alternate</dt><dd>{contact.alternatePhone}</dd></div>}
        {contact.email && <div><dt>Email</dt><dd>{contact.email}</dd></div>}
        {contact.requirements && <div><dt>Requirements</dt><dd>{contact.requirements}</dd></div>}
        {contact.notes && <div><dt>Notes</dt><dd>{contact.notes}</dd></div>}
      </dl>
      {!contact.leadId && <Button onClick={convert} disabled={converting}>{converting ? 'Converting' : 'Convert to lead'}</Button>}
      {contact.leadId && <p className="contact-linked">Lead ID: {contact.leadId}</p>}
      {error && <p className="contact-request-error" role="alert">{message(error)}</p>}
      <div className="contact-history-heading"><h4>Call history</h4><span>{calls.pagination.total} calls</span></div>
      {calls.items.length === 0 ? <p className="contact-muted">No calls recorded.</p> : (
        <ol className="contact-call-list">
          {calls.items.map((call) => (
            <li key={call.id}>
              <div><strong>{CALL_OUTCOMES.find(([value]) => value === call.outcome)?.[1] || call.outcome}</strong><span>{call.direction} · {formatDateTime(call.occurredAt)}</span></div>
              {call.notes && <p>{call.notes}</p>}
              {call.nextFollowUp && <small>Follow-up: {formatDateTime(call.nextFollowUp)}</small>}
            </li>
          ))}
        </ol>
      )}
      {calls.pagination.total > 25 && <div className="contact-pagination">
        <button className="btn-icon" title="Newer calls" aria-label="Newer calls" disabled={callOffset === 0} onClick={() => setCallOffset(Math.max(0, callOffset - 25))}><ChevronLeft size={17} /></button>
        <span>{callOffset + 1}-{Math.min(callOffset + 25, calls.pagination.total)} of {calls.pagination.total}</span>
        <button className="btn-icon" title="Older calls" aria-label="Older calls" disabled={callOffset + 25 >= calls.pagination.total} onClick={() => setCallOffset(callOffset + 25)}><ChevronRight size={17} /></button>
      </div>}
      {logging && <LogCallModal id={id} onClose={() => setLogging(false)} onLogged={() => { setLogging(false); setCallOffset(0); refresh(); }} />}
    </>
  );
}

function LogCallModal({ id, onClose, onLogged }) {
  const [form, setForm] = useState({ direction: 'outbound', outcome: 'follow_up', occurredAt: localDateTime(), durationSeconds: '', notes: '', nextFollowUp: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = (name) => (event) => setForm((prev) => ({ ...prev, [name]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await contactIntakeApi.logCall(id, {
        direction: form.direction, outcome: form.outcome,
        occurredAt: new Date(form.occurredAt).toISOString(),
        durationSeconds: form.durationSeconds === '' ? null : Number(form.durationSeconds),
        notes: form.notes, nextFollowUp: form.nextFollowUp ? new Date(form.nextFollowUp).toISOString() : null,
      });
      onLogged();
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal open onClose={busy ? undefined : onClose} title="Log call" footer={
      <><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="log-contact-call" disabled={busy}>{busy ? 'Saving' : 'Save call'}</Button></>
    }>
      <form id="log-contact-call" onSubmit={submit} className="contact-form">
        <Field label="Direction"><Select value={form.direction} onChange={field('direction')}><option value="inbound">Incoming</option><option value="outbound">Outgoing</option></Select></Field>
        <Field label="Outcome"><Select value={form.outcome} onChange={field('outcome')}>{CALL_OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field label="Call time" required><TextInput type="datetime-local" value={form.occurredAt} onChange={field('occurredAt')} required /></Field>
        <Field label="Duration (seconds)"><TextInput type="number" min="0" step="1" value={form.durationSeconds} onChange={field('durationSeconds')} /></Field>
        <Field label="Next follow-up"><TextInput type="datetime-local" value={form.nextFollowUp} onChange={field('nextFollowUp')} /></Field>
        <Field label="Notes"><textarea value={form.notes} onChange={field('notes')} rows={3} maxLength={4000} /></Field>
        {error && <p className="contact-request-error" role="alert">{message(error)}</p>}
      </form>
    </Modal>
  );
}

function LeadDetail({ id, onSaved, onOpenContact }) {
  const [lead, setLead] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState({ status: 'New', nextFollowUp: '', notes: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading'); setError(null);
    contactIntakeApi.getLead(id, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setLead(value);
      setForm({ status: value.status, nextFollowUp: value.nextFollowUp ? localDateTime(value.nextFollowUp) : '', notes: value.notes || '' });
      setStatus('ready');
    }).catch((err) => { if (!controller.signal.aborted) { setError(err); setStatus('error'); } });
    return () => controller.abort();
  }, [id, revision]);
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const updated = await contactIntakeApi.updateLead(id, {
        status: form.status, notes: form.notes,
        nextFollowUp: form.nextFollowUp ? new Date(form.nextFollowUp).toISOString() : null,
      });
      setLead(updated);
      setForm({ status: updated.status, nextFollowUp: updated.nextFollowUp ? localDateTime(updated.nextFollowUp) : '', notes: updated.notes || '' });
      setBusy(false); onSaved();
    } catch (err) { setError(err); setBusy(false); }
  };
  if (status === 'loading') return <LoadingState label="Loading lead" />;
  if (status === 'error') return <div className="contact-request-error" role="alert"><p>{message(error)}</p><Button variant="secondary" size="sm" onClick={() => setRevision((value) => value + 1)}>Retry</Button></div>;
  return (
    <>
      <div className="contact-detail-title"><h3>{lead.name}</h3><Badge tone={lead.status === 'Booked' ? 'success' : 'info'}>{lead.status}</Badge></div>
      <div className="contact-detail-actions">
        <a className="btn btn-secondary btn-sm" href={buildTelLink(lead.phone)}><Phone size={14} /> Call</a>
        <a className="btn btn-secondary btn-sm" href={buildWhatsAppLink(lead.phone)} target="_blank" rel="noreferrer">WhatsApp</a>
      </div>
      <dl className="contact-facts">
        <div><dt>Phone</dt><dd>{lead.phone}</dd></div>
        {lead.email && <div><dt>Email</dt><dd>{lead.email}</dd></div>}
        {lead.requirements?.details && <div><dt>Requirements</dt><dd>{lead.requirements.details}</dd></div>}
        {lead.serviceNeed && <div><dt>Service</dt><dd>{lead.serviceNeed}</dd></div>}
      </dl>
      <form className="contact-lead-form" onSubmit={save}>
        <h4>Follow-up</h4>
        <Field label="Status"><Select value={form.status} onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))}>{LEAD_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
        <Field label="Next follow-up"><TextInput type="datetime-local" value={form.nextFollowUp} onChange={(event) => setForm((prev) => ({ ...prev, nextFollowUp: event.target.value }))} /></Field>
        <Field label="Notes"><textarea rows={4} maxLength={4000} value={form.notes} onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))} /></Field>
        {error && <p className="contact-request-error" role="alert">{message(error)}</p>}
        <Button type="submit" disabled={busy}>{busy ? 'Saving' : 'Save changes'}</Button>
      </form>
      {lead.contactId && <button className="contact-history-link" onClick={() => onOpenContact(lead.contactId)}><Clock3 size={14} /> View call history</button>}
      <LeadTimeline leadId={id} onOpenContact={onOpenContact} />
    </>
  );
}

const TIMELINE_LABELS = {
  contact_created: 'Contact',
  call: 'Call',
  lead_created: 'Lead',
  visit_event: 'Visit',
  viewing: 'Viewing',
  follow_up: 'Follow-up',
};

function LeadTimeline({ leadId, onOpenContact }) {
  const [state, setState] = useState({ status: 'loading', items: [], error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', items: [], error: null });
    leadTimelineApi.get(leadId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setState({ status: 'ready', items: result.items || [], error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setState({ status: 'error', items: [], error }); });
    return () => controller.abort();
  }, [leadId, revision]);
  return <section className="contact-visit-history" aria-label="Client timeline">
    <div className="contact-history-heading"><h4>Timeline</h4><span>{state.status === 'ready' ? `${state.items.length} events` : ''}</span></div>
    {state.status === 'loading' && <LoadingState label="Loading timeline" />}
    {state.status === 'error' && (
      <div className="contact-request-error" role="alert">
        <p>{message(state.error)}</p><Button variant="secondary" size="sm" onClick={() => setRevision((value) => value + 1)}>Retry</Button>
      </div>
    )}
    {state.status === 'ready' && state.items.length === 0 && <p className="contact-muted">No history recorded yet.</p>}
    {state.status === 'ready' && state.items.length > 0 && (
      <ol className="contact-timeline-list">
        {state.items.map((item) => <li key={item.id} className={`contact-timeline-item contact-timeline-${item.type}`}>
          <div className="contact-timeline-row">
            <Badge tone={item.type === 'follow_up' ? 'info' : 'neutral'} size="sm">{TIMELINE_LABELS[item.type] || item.type}</Badge>
            <small>{formatDateTime(item.occurredAt)}</small>
          </div>
          <strong>{item.title}</strong>
          {item.detail && <p>{item.detail}</p>}
          {item.actor?.name && <small>By {item.actor.name}</small>}
          {item.meta?.phone && <small>{item.meta.phone}</small>}
          {item.type === 'call' && item.meta?.contactId && onOpenContact && (
            <button className="contact-history-link" onClick={() => onOpenContact(item.meta.contactId)}><Clock3 size={14} /> View call history</button>
          )}
        </li>)}
      </ol>
    )}
  </section>;
}
