// Mobile tab content modules. Each is a vertically scrolling list of cards.
// Designed for one-handed thumb operation: large tap targets, minimal typing.

import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Building2,
  CalendarClock,
  CalendarPlus,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Flame,
  ImagePlus,
  Link2,
  MapPin,
  MessageSquareText,
  Navigation,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Tag,
  UploadCloud,
  Warehouse,
  X,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope, can } from '../../data/permissions.js';
import { useListings, resolveAssignee } from '../../services/listingsData.jsx';
import { useAssignableStaff } from '../../services/staffDirectory.js';
import { listingFromCapture } from '../../services/listingCapture.js';
import { rankLeadMatches } from '../../services/matchListings.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  LoadingState,
  Modal,
  SectionTitle,
  Select,
  TextInput,
  buildTelLink,
  buildWhatsAppLink,
  formatDateTime,
  formatTime,
  formatINR,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';
import {
  isOffline,
  queueMessageSend,
  queuePhotoUpload,
  queueVisitUpdate,
  queueListingCapture,
} from '../../services/offlineActions.js';

const CATEGORIES = ['Progress', 'Amenities', 'Inventory', 'Handover', 'Marketing'];

// ----------------- Mobile Visits -----------------

export function MobileVisits() {
  const { state, currentUser, actions, online } = useStore();
  const { listings: apiListings } = useListings();
  const visits = useMemo(
    () => filterByScope(currentUser, 'visits', 'view', state.visits),
    [currentUser, state.visits]
  );
  const [tab, setTab] = useState('today');

  const todayIso = new Date().toISOString().slice(0, 10);
  const filtered = useMemo(() => {
    if (tab === 'today') {
      return visits.filter((v) => v.scheduledFor?.slice(0, 10) === todayIso);
    }
    if (tab === 'upcoming') {
      return visits
        .filter((v) => new Date(v.scheduledFor).getTime() > Date.now() && v.status !== 'Completed')
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime());
    }
    return visits.filter((v) => v.status === 'Completed');
  }, [visits, tab, todayIso]);

  return (
    <div className="mobile-tab-page">
      <div className="mobile-tab-pills">
        {[['today', 'Today'], ['upcoming', 'Upcoming'], ['completed', 'Done']].map(([key, label]) => (
          <button
            key={key}
            className={`pill ${tab === key ? 'pill-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing here yet" />
      ) : (
        <ul className="mobile-visit-list mobile-visit-list-full">
          {filtered.map((visit) => {
            const lead = state.leads.find((l) => l.id === visit.leadId);
            const project = state.projects.find((p) => p.id === visit.projectId);
            const listing = visit.listingId
              ? apiListings.find((l) => l.id === visit.listingId)
              : null;
            return (
              <li key={visit.id}>
                <article className="mobile-visit mobile-visit-large">
                  <header>
                    <span className="mobile-visit-time">{formatTime(visit.scheduledFor)}</span>
                    <Badge tone={visit.status === 'Completed' ? 'success' : 'info'} dot>
                      {visit.status}
                    </Badge>
                  </header>
                  <strong>{lead?.name}</strong>
                  <small>{project?.name} · {lead?.unitType}</small>
                  {listing && can(currentUser, 'listings', 'view', listing) && (
                    <div className="match-listing-source-chip">
                      <Link2 size={12} />
                      <span>Matched from &ldquo;{listing.title}&rdquo;</span>
                    </div>
                  )}
                  {visit.notes && <p className="mobile-visit-notes">{visit.notes}</p>}
                  <div className="mobile-visit-actions">
                    <a className="btn btn-secondary btn-sm" href={buildTelLink(lead?.phone)}>
                      <Phone size={14} /> Call
                    </a>
                    <a
                      className="btn btn-secondary btn-sm"
                      href={buildWhatsAppLink(lead?.phone, `Hi ${lead?.name?.split(' ')[0]}, following up on ${project?.name}.`)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MessageSquareText size={14} /> WhatsApp
                    </a>
                  </div>
                  {visit.status !== 'Completed' && (
                    <Can resource="visits" action="edit" record={visit}>
                      <Button
                        block
                        variant="primary"
                        icon={CheckCircle2}
                        onClick={() => {
                          const patch = {
                            status: 'Completed',
                            completedAt: new Date().toISOString(),
                            rating: 5,
                            feedback: 'Completed via mobile app.',
                          };
                          if (online === false || isOffline()) {
                            queueVisitUpdate({
                              visitId: visit.id,
                              patch,
                              userId: currentUser.id,
                            });
                            actions.toast(
                              'Visit completion saved offline. Will sync later.',
                              'info'
                            );
                            return;
                          }
                          actions.updateVisit(visit.id, patch);
                        }}
                      >
                        Mark complete
                      </Button>
                    </Can>
                  )}
                  {visit.status === 'Completed' && (
                    <div className="visit-feedback">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} size={14} className={i < (visit.rating || 0) ? 'star-on' : 'star-off'} />
                      ))}
                      <small>{visit.feedback}</small>
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ----------------- Mobile Leads -----------------

export function MobileLeads() {
  const { state, currentUser, actions } = useStore();
  const leads = useMemo(
    () => filterByScope(currentUser, 'leads', 'view', state.leads),
    [currentUser, state.leads]
  );
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(() => {
    const lower = query.toLowerCase();
    if (!lower) return leads;
    return leads.filter((l) =>
      [l.name, l.phone, l.email, l.status, l.source].some((v) =>
        (v || '').toLowerCase().includes(lower)
      )
    );
  }, [leads, query]);

  const open = openId ? leads.find((l) => l.id === openId) : null;

  return (
    <div className="mobile-tab-page">
      <div className="mobile-search">
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads" />
        <Can resource="leads" action="create">
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add</Button>
        </Can>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No leads in scope"
          description="Your role can only see leads assigned to you or your team."
        />
      ) : (
        <ul className="mobile-lead-list">
          {filtered.map((lead) => {
            const project = state.projects.find((p) => p.id === lead.projectId);
            return (
              <li key={lead.id}>
                <button className="mobile-lead mobile-lead-tappable" onClick={() => setOpenId(lead.id)}>
                  <header>
                    <Avatar name={lead.name} size="md" />
                    <div>
                      <strong>{lead.name}</strong>
                      <small>{lead.source} · {lead.unitType}</small>
                    </div>
                    <Badge tone={lead.score === 'hot' ? 'danger' : lead.score === 'warm' ? 'warning' : 'neutral'} dot size="sm">
                      {lead.score}
                    </Badge>
                  </header>
                  <ul className="kv-list kv-list-tight">
                    <li><span>Project</span><strong>{project?.name}</strong></li>
                    <li><span>Status</span><strong>{lead.status}</strong></li>
                    <li><span>Next follow-up</span><strong>{formatDateTime(lead.nextFollowUp)}</strong></li>
                  </ul>
                  <div className="mobile-lead-actions">
                    <a className="btn btn-secondary btn-sm" href={buildTelLink(lead.phone)}>
                      <Phone size={14} /> Call
                    </a>
                    <a className="btn btn-secondary btn-sm" href={buildWhatsAppLink(lead.phone)} target="_blank" rel="noreferrer">
                      <MessageSquareText size={14} /> WhatsApp
                    </a>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <NewLeadSheet onClose={() => setCreating(false)} />}
      {open && <MobileLeadSheet lead={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function NewLeadSheet({ onClose }) {
  const { actions, state, currentUser } = useStore();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [projectId, setProjectId] = useState(state.projects[0]?.id || '');
  const [source, setSource] = useState('Walk-in');

  const submit = () => {
    if (!name || !phone) {
      actions.toast('Name and phone are required.', 'error');
      return;
    }
    actions.createLead({
      name,
      phone,
      projectId,
      source,
      status: 'New',
      score: 'warm',
      ownerId: currentUser.id,
      teamId: currentUser.teamId,
      unitType: '2BHK',
      budgetMin: 10000000,
      budgetMax: 15000000,
      lastContact: new Date().toISOString(),
      nextFollowUp: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      notes: 'Added from mobile',
      tags: [],
    });
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add new lead"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Save lead</Button>
        </>
      }
    >
      <Field label="Name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Lead name" /></Field>
      <Field label="Phone" required><TextInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91" /></Field>
      <Field label="Project" required>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
      <Field label="Source">
        <Select value={source} onChange={(e) => setSource(e.target.value)}>
          {['Walk-in', 'Referral', 'Website', 'Meta Ads', 'Channel Partner', 'Direct'].map((s) => <option key={s}>{s}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}

// ----------------- Mobile Photos -----------------

export function MobilePhotos() {
  const { state, currentUser, actions, online } = useStore();
  const [projectId, setProjectId] = useState(state.projects[0]?.id || '');
  const [category, setCategory] = useState('Progress');
  const [caption, setCaption] = useState('');
  const [files, setFiles] = useState([]);
  const [gallery, setGallery] = useState('mine'); // mine | all

  const photos = useMemo(() => {
    const visible = filterByScope(currentUser, 'photos', 'view', state.photos);
    if (gallery === 'mine') return visible.filter((p) => p.staffId === currentUser.id);
    return visible;
  }, [state.photos, currentUser, gallery]);

  const upload = () => {
    if (files.length === 0) {
      actions.toast('Add at least one photo.', 'error');
      return;
    }
    if (online === false || isOffline()) {
      // Offline path: queue metadata only. The file Blob itself is not
      // persisted (deferred — see docs/OFFLINE_WIRING_NOTES.md). Each
      // photo becomes one queued item.
      files.forEach((file, index) => {
        queuePhotoUpload({
          userId: currentUser.id,
          blobKey: null,
          metadata: {
            projectId,
            category,
            caption: caption || file.name,
            sourceFilename: file.name,
            // Note: file.url is an object-URL string and is not durable —
            // the sync worker will need the user to re-pick the file.
            durable: false,
            queueIndex: index,
          },
        });
      });
      actions.toast(
        `${files.length} photo${files.length === 1 ? '' : 's'} queued offline. File upload needs Blob persistence — sync worker will re-request the photo.`,
        'info'
      );
      setFiles([]);
      setCaption('');
      return;
    }
    files.forEach((file) => {
      actions.addPhoto({
        projectId,
        category,
        caption: caption || file.name,
        url: file.url,
        geo: { lat: 12.97, lng: 77.59 },
      });
    });
    actions.toast(`Uploaded ${files.length} photo${files.length === 1 ? '' : 's'}.`, 'success');
    setFiles([]);
    setCaption('');
  };

  return (
    <div className="mobile-tab-page">
      <Can
        resource="photos"
        action="create"
        fallback={<EmptyState icon={Camera} title="Photo upload disabled" description="Your role cannot upload photos." />}
      >
        <section className="mobile-upload">
          <div className="grid-2">
            <Field label="Project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Caption" span={2}>
              <TextInput value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Brief description" />
            </Field>
          </div>
          <label className="upload-zone">
            <input
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              onChange={(e) => {
                const list = Array.from(e.target.files || []);
                setFiles(list.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })));
              }}
            />
            <Camera size={28} />
            <strong>Tap to take photo</strong>
            <span>{files.length === 0 ? 'Camera or library · up to 10 MB each' : `${files.length} file${files.length === 1 ? '' : 's'} ready`}</span>
          </label>
          <Button block variant="primary" icon={UploadCloud} onClick={upload}>
            Upload {files.length} photo{files.length === 1 ? '' : 's'}
          </Button>
        </section>
      </Can>

      <SectionTitle
        eyebrow="Gallery"
        title={gallery === 'mine' ? 'My uploads' : 'All visible photos'}
        action={
          <div className="mobile-tab-pills mobile-tab-pills-mini">
            {[['mine', 'Mine'], ['all', 'All']].map(([key, label]) => (
              <button
                key={key}
                className={`pill ${gallery === key ? 'pill-active' : ''}`}
                onClick={() => setGallery(key)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {photos.length === 0 ? (
        <EmptyState icon={Camera} title="No photos yet" />
      ) : (
        <div className="mobile-photo-grid">
          {photos.map((photo) => (
            <figure key={photo.id}>
              <img src={photo.url} alt={photo.caption} />
              <figcaption>
                <strong>{photo.caption}</strong>
                <small>{timeAgo(photo.uploadedAt)} · {photo.category}</small>
                <Badge tone={photo.approved ? 'success' : 'warning'} size="sm">
                  {photo.approved ? 'Approved' : 'Pending'}
                </Badge>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------- Mobile Comms -----------------

export function MobileComms() {
  const { state, currentUser } = useStore();
  const [activeId, setActiveId] = useState(null);

  const threads = useMemo(
    () =>
      state.threads
        .filter((t) => t.participants?.includes(currentUser.id))
        .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()),
    [state.threads, currentUser.id]
  );

  const active = threads.find((t) => t.id === activeId) || threads[0];

  if (active) {
    return (
      <div className="mobile-tab-page">
        <button className="link mobile-back" onClick={() => setActiveId(null)}>← Threads</button>
        <MobileThread thread={active} />
      </div>
    );
  }

  return (
    <div className="mobile-tab-page">
      <SectionTitle eyebrow="Inbox" title="Conversations" />
      {threads.length === 0 ? (
        <EmptyState icon={MessageSquareText} title="No threads" />
      ) : (
        <ul className="mobile-thread-list">
          {threads.map((thread) => {
            const lastMessage = state.messages
              .filter((m) => m.threadId === thread.id)
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
            const other = state.users.find((u) => u.id === thread.participants.find((p) => p !== currentUser.id));
            return (
              <li key={thread.id}>
                <button className="mobile-thread" onClick={() => setActiveId(thread.id)}>
                  <Avatar name={other?.name} size="md" />
                  <div>
                    <strong>{other?.name || thread.subject}</strong>
                    <small>{lastMessage?.text?.slice(0, 80)}</small>
                    <span>{timeAgo(thread.lastMessageAt)}</span>
                  </div>
                  {thread.unread && <span className="dot dot-red" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MobileThread({ thread }) {
  const { state, currentUser, actions, online } = useStore();
  const [draft, setDraft] = useState('');
  const messages = state.messages
    .filter((m) => m.threadId === thread.id)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const other = state.users.find((u) => u.id === thread.participants.find((p) => p !== currentUser.id));

  const send = () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    if (online === false || isOffline()) {
      queueMessageSend({
        threadId: thread.id,
        fromId: currentUser.id,
        body: text,
      });
      actions.toast('Message queued offline. Will send when you’re back online.', 'info');
      setDraft('');
      return;
    }
    actions.sendMessage({ threadId: thread.id, text });
    setDraft('');
  };

  return (
    <section className="mobile-thread-view">
      <header>
        <Avatar name={other?.name} size="md" />
        <div>
          <strong>{other?.name || thread.subject}</strong>
          <small>{other?.designation}</small>
        </div>
        <a className="btn-icon" href={`tel:${other?.phone?.replace(/\s/g, '')}`}>
          <Phone size={16} />
        </a>
      </header>
      <div className="mobile-thread-messages">
        {messages.map((message) => {
          const mine = message.fromId === currentUser.id;
          return (
            <div key={message.id} className={`message-bubble ${mine ? 'mine' : 'theirs'}`}>
              <div className="message-bubble-body">
                <p>{message.text}</p>
                <small>{formatTime(message.timestamp)}</small>
              </div>
            </div>
          );
        })}
      </div>
      <Can
        resource="communications"
        action="create"
        fallback={<div className="thread-composer thread-composer-locked">Your role cannot send messages here.</div>}
      >
        <div className="mobile-composer">
          <TextInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a message"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button variant="primary" icon={Send} onClick={send} />
        </div>
      </Can>
    </section>
  );
}

// ----------------- Mobile Listings -----------------

// Full vocabulary, in display order. The category pills only render the ones
// present in the visible data (see categoriesInScope) so a demo never offers
// a filter that returns nothing. 'resale' / 'owner-listed' are seed values
// that the backend maps to 'sell' (see src/services/listingEnums.js).
const MOBILE_LISTING_CATEGORIES = [
  { value: 'rent', label: 'Rent' },
  { value: 'pg', label: 'PG' },
  { value: 'land', label: 'Land' },
  { value: 'office', label: 'Office' },
  { value: 'resale', label: 'Resale' },
  { value: 'owner-listed', label: 'Owner' },
  { value: 'sell', label: 'Sell' },
  { value: 'commercial', label: 'Commercial' },
];

const MOBILE_AVAILABILITY_TONE = {
  available: 'success',
  reserved: 'warning',
  booked: 'info',
  'off-market': 'neutral',
};

const MOBILE_VERIFICATION_TONE = {
  verified: 'success',
  pending: 'warning',
  rejected: 'danger',
  unverified: 'neutral',
};

const formatListingPrice = (listing) => {
  const { pricing } = listing;
  if (listing.listingIntent === 'available_for_sale') {
    return pricing?.price ? `${formatINR(pricing.price)}` : '—';
  }
  return pricing?.rentMonthly ? `${formatINR(pricing.rentMonthly)}/mo` : '—';
};

export function MobileListings() {
  const { state, currentUser, actions, online } = useStore();
  const { listings: apiListings, status, error, retry } = useListings();
  const listings = useMemo(
    () => filterByScope(currentUser, 'listings', 'view', apiListings),
    [currentUser, apiListings]
  );
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [capturing, setCapturing] = useState(false);
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(
    () =>
      categoryFilter === 'all'
        ? listings
        : listings.filter((l) => l.serviceCategory === categoryFilter),
    [listings, categoryFilter]
  );

  // Only offer categories that exist in scope, in canonical order.
  const categoriesInScope = useMemo(() => {
    const present = new Set(listings.map((l) => l.serviceCategory).filter(Boolean));
    const known = MOBILE_LISTING_CATEGORIES.filter((c) => present.has(c.value));
    const extras = Array.from(present)
      .filter((v) => !MOBILE_LISTING_CATEGORIES.some((c) => c.value === v))
      .sort()
      .map((v) => ({ value: v, label: v }));
    return [...known, ...extras];
  }, [listings]);

  const open = openId ? listings.find((l) => l.id === openId) : null;

  if (status === 'loading') {
    return (
      <div className="mobile-tab-page">
        <LoadingState label="Loading listings" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mobile-tab-page">
        <EmptyState
          icon={AlertCircle}
          title="Could not load listings"
          description={error?.message || 'Something went wrong while fetching listings.'}
          action={
            <Button variant="primary" onClick={retry}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mobile-tab-page">
      <div className="mobile-tab-pills">
        <button
          className={`pill ${categoryFilter === 'all' ? 'pill-active' : ''}`}
          onClick={() => setCategoryFilter('all')}
        >
          All
        </button>
        {categoriesInScope.map((c) => (
          <button
            key={c.value}
            className={`pill ${categoryFilter === c.value ? 'pill-active' : ''}`}
            onClick={() => setCategoryFilter(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <Can resource="listings" action="create">
        <Button
          block
          variant="primary"
          icon={Plus}
          onClick={() => setCapturing(true)}
          style={{ marginBottom: 14 }}
        >
          Add collected property
        </Button>
      </Can>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title="No listings in scope"
          description={
            categoryFilter === 'all'
              ? 'Listings assigned to or created by you will appear here.'
              : `No ${categoryFilter} listings in your scope. Switch categories or add one.`
          }
        />
      ) : (
        <ul className="mobile-listing-list">
          {filtered.map((listing) => {
            const assignee = resolveAssignee(listing, state.users);
            return (
              <li key={listing.id}>
                <button className="mobile-listing" onClick={() => setOpenId(listing.id)}>
                  <header>
                    <span className="mobile-listing-cat">
                      {MOBILE_LISTING_CATEGORIES.find((c) => c.value === listing.serviceCategory)?.label || listing.serviceCategory}
                    </span>
                    <Badge
                      tone={MOBILE_AVAILABILITY_TONE[listing.status?.availability] || 'neutral'}
                      dot
                      size="sm"
                    >
                      {listing.status?.availability || '—'}
                    </Badge>
                  </header>
                  <strong>{listing.title}</strong>
                  <small>
                    <MapPin size={11} /> {listing.location?.locality || '—'} · {listing.location?.city || '—'}
                  </small>
                  <div className="mobile-listing-price">{formatListingPrice(listing)}</div>
                  <div className="mobile-listing-tags">
                    <Badge
                      tone={MOBILE_VERIFICATION_TONE[listing.status?.verification] || 'neutral'}
                      dot
                      size="sm"
                    >
                      {listing.status?.verification || '—'}
                    </Badge>
                    {assignee && (
                      <span className="inline-user">
                        <Avatar name={assignee.name} size="xs" tone="light" />
                        <span>{assignee.name}</span>
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && <MobileListingSheet listing={open} onClose={() => setOpenId(null)} />}

      {capturing && <NewListingSheet onClose={() => setCapturing(false)} />}
    </div>
  );
}

function MobileListingSheet({ listing, onClose }) {
  const { state, actions, currentUser } = useStore();
  const { assignListing, removeListing } = useListings();
  const staffDir = useAssignableStaff();
  const assignee = resolveAssignee(listing, state.users);
  const verifier = state.users.find((u) => u.id === listing.status?.verifiedBy);
  const mapsHref = listing.location?.geo
    ? `https://maps.google.com/?q=${listing.location.geo.lat},${listing.location.geo.lng}`
    : null;

  // One in-flight mutation at a time; disables both action buttons so a
  // double-tap cannot fire two requests.
  const [busy, setBusy] = useState(null); // 'assign' | 'remove' | null
  const [assignOpen, setAssignOpen] = useState(false);
  const [staffId, setStaffId] = useState(listing.assignedTo || currentUser.id);
  const [error, setError] = useState(null);

  const doAssign = async () => {
    if (busy) return;
    if (!staffId) {
      setError('Choose a team member to assign.');
      return;
    }
    setError(null);
    setBusy('assign');
    const result = await assignListing(listing.id, staffId);
    setBusy(null);
    if (result.ok) {
      actions.toast('Listing reassigned.', 'success');
      onClose();
    } else {
      setError(result.message || 'Could not reassign this listing.');
    }
  };

  const doRemove = async () => {
    if (busy) return;
    if (!window.confirm(`Mark "${listing.title}" off-market?`)) return;
    setError(null);
    setBusy('remove');
    const result = await removeListing(listing.id);
    setBusy(null);
    if (result.ok) {
      actions.toast(`"${listing.title}" marked off-market.`, 'success');
      onClose();
    } else {
      setError(result.message || 'Could not mark this listing off-market.');
    }
  };

  // Read-only "interested leads" footer. Limits to first 3 to stay
  // mobile-friendly. Each row passes through leads.view so the FE
  // only sees their own leads.
  const interestedLeads = state.matches
    .filter((m) => m.listingId === listing.id)
    .map((m) => ({ match: m, lead: state.leads.find((l) => l.id === m.leadId) }))
    .filter(({ lead }) => lead && can(currentUser, 'leads', 'view', lead))
    .slice(0, 3);

  return (
    <Modal
      open
      onClose={onClose}
      title={listing.title}
      width={520}
      footer={
        <>
          {listing.ownerContact?.phone && (
            <>
              <a className="btn btn-secondary btn-sm" href={buildTelLink(listing.ownerContact.phone)}>
                <Phone size={14} /> Call
              </a>
              <a
                className="btn btn-secondary btn-sm"
                href={buildWhatsAppLink(
                  listing.ownerContact.phone,
                  `Hi ${listing.ownerContact.name?.split(' ')[0] || ''}, following up on ${listing.title}.`
                )}
                target="_blank"
                rel="noreferrer"
              >
                <MessageSquareText size={14} /> WhatsApp
              </a>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="mobile-listing-chips">
        <Badge tone="neutral">
          {MOBILE_LISTING_CATEGORIES.find((c) => c.value === listing.serviceCategory)?.label || listing.serviceCategory}
        </Badge>
        <Badge tone={MOBILE_AVAILABILITY_TONE[listing.status?.availability] || 'neutral'} dot>
          {listing.status?.availability || '—'}
        </Badge>
        <Badge tone={MOBILE_VERIFICATION_TONE[listing.status?.verification] || 'neutral'} dot>
          {listing.status?.verification || '—'}
        </Badge>
      </div>

      <ul className="kv-list kv-list-tight">
        <li><span>Type</span><strong>{listing.propertyType}</strong></li>
        <li><span>Address</span><strong>{listing.location?.address || '—'}</strong></li>
        <li>
          <span>Price</span>
          <strong>
            {formatListingPrice(listing)}
          </strong>
        </li>
        {listing.pricing?.deposit && (
          <li><span>Deposit</span><strong>{formatINR(listing.pricing.deposit)}</strong></li>
        )}
        {listing.specs?.bedrooms != null && (
          <li><span>Config</span><strong>{listing.specs.bedrooms} BR · {listing.specs.bathrooms} BA</strong></li>
        )}
        {listing.specs?.furnished && (
          <li><span>Furnished</span><strong>{listing.specs.furnished}</strong></li>
        )}
        <li><span>Owner</span><strong>{listing.ownerContact?.name || '—'}</strong></li>
        <li><span>Phone</span><strong>{listing.ownerContact?.phone || '—'}</strong></li>
        <li><span>Assigned</span><strong>{assignee?.name || 'Unassigned'}</strong></li>
      </ul>

      {listing.specs?.amenities?.length > 0 && (
        <div className="tag-row">
          {listing.specs.amenities.map((a) => (
            <span className="tag" key={a}>{a}</span>
          ))}
        </div>
      )}

      <div className={`listing-verification-banner ${listing.status?.verification || 'unverified'}`}>
        {listing.status?.verification === 'verified' && <CheckCircle2 size={16} />}
        {listing.status?.verification === 'pending' && <Clock3 size={16} />}
        {listing.status?.verification === 'rejected' && <ShieldCheck size={16} />}
        {(!listing.status?.verification || listing.status?.verification === 'unverified') && (
          <Sparkles size={16} />
        )}
        <span>
          Verified by {verifier?.name || '—'}{listing.status?.verifiedAt ? ` · ${timeAgo(listing.status.verifiedAt)}` : ''}
        </span>
      </div>

      {mapsHref && (
        <a className="btn btn-secondary btn-sm" href={mapsHref} target="_blank" rel="noreferrer">
          <MapPin size={14} /> Open in Maps
        </a>
      )}

      {listing.notes && <p className="muted">{listing.notes}</p>}

      {interestedLeads.length > 0 && (
        <div className="mobile-listing-interested">
          <strong>Interested leads</strong>
          <ul>
            {interestedLeads.map(({ match, lead }) => (
              <li key={match.id}>
                <Avatar name={lead.name} size="xs" tone="light" />
                <span>{lead.name}</span>
                <Badge
                  tone={match.matchStatus === 'matched' ? 'success' : match.matchStatus === 'visited' ? 'neutral' : 'info'}
                  dot
                  size="sm"
                >
                  {match.matchStatus}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="inline-error" role="alert">
          <AlertCircle size={14} /> <span>{error}</span>
        </div>
      )}

      <div className="mobile-listing-actions">
        {staffDir.available ? (
          <>
            <Can resource="listings" action="assign" record={listing}>
              {assignOpen ? (
                <div className="mobile-assign-block">
                  <Field label="Assign to">
                    <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                      {staffDir.staff.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} · {u.role}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="mobile-assign-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={doAssign}
                    >
                      {busy === 'assign' ? 'Assigning…' : 'Confirm assign'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        setAssignOpen(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  block
                  variant="secondary"
                  icon={Tag}
                  disabled={busy !== null}
                  onClick={() => {
                    setAssignOpen(true);
                    setError(null);
                  }}
                >
                  Reassign
                </Button>
              )}
            </Can>
          </>
        ) : (
          <Can resource="listings" action="assign" record={listing}>
            <p className="muted mobile-assign-unavailable">{staffDir.reason}</p>
          </Can>
        )}
        <Can resource="listings" action="delete" record={listing}>
          <Button
            block
            variant="ghost"
            icon={ShieldCheck}
            disabled={busy !== null}
            onClick={doRemove}
          >
            {busy === 'remove' ? 'Working…' : 'Mark off-market'}
          </Button>
        </Can>
      </div>
    </Modal>
  );
}

function NewListingSheet({ onClose }) {
  const { state, currentUser, actions, online } = useStore();
  const { createListing } = useListings();
  const staffDir = useAssignableStaff();
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [locality, setLocality] = useState('');
  const [serviceCategory, setServiceCategory] = useState('rent');
  const [askingPrice, setAskingPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const offline = online === false || isOffline();

  const submit = async () => {
    if (saving) return;
    if (!ownerName || !ownerPhone || !serviceCategory) {
      setError('Owner name, phone, and category are required.');
      return;
    }
    setError(null);

    if (offline) {
      // Offline: queue the thin capture. In live mode the sync worker replays
      // it against POST /listings; in demo mode the demo handler validates it.
      queueListingCapture({
        ownerName,
        ownerPhone,
        locality,
        serviceCategory,
        askingPrice: askingPrice ? Number(askingPrice) : null,
        notes,
        userId: currentUser.id,
      });
      actions.toast('Saved offline. Will sync when you’re back online.', 'info');
      onClose();
      return;
    }

    // Online: build the full record and await the repository. In live mode
    // this resolves only after the backend confirms creation, so the sheet
    // closes on success and stays open (with the error) otherwise.
    const listing = listingFromCapture({
      ownerName,
      ownerPhone,
      locality,
      serviceCategory,
      askingPrice,
      notes,
      userId: currentUser.id,
      // Seed project ids do not exist in the backend, so only attach a
      // project when the seed directory is the active source (demo mode).
      projectId: staffDir.available ? state.projects[0]?.id || null : null,
    });

    setSaving(true);
    const result = await createListing(listing);
    setSaving(false);

    if (result.ok) {
      actions.toast(`Listing for ${ownerName} captured.`, 'success');
      onClose();
    } else {
      setError(result.message || 'Could not save this listing. Please try again.');
    }
  };

  return (
    <Modal
      open
      onClose={saving ? undefined : onClose}
      title="Add collected property"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save listing'}
          </Button>
        </>
      }
    >
      {error && (
        <div className="inline-error" role="alert">
          <AlertCircle size={14} /> <span>{error}</span>
        </div>
      )}
      <Field label="Owner name" required>
        <TextInput value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Full name" />
      </Field>
      <Field label="Owner phone" required>
        <TextInput value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="+91 98XXX XXXXX" />
      </Field>
      <Field label="Locality">
        <TextInput value={locality} onChange={(e) => setLocality(e.target.value)} placeholder="Whitefield" />
      </Field>
      <Field label="Service category" required>
        <Select value={serviceCategory} onChange={(e) => setServiceCategory(e.target.value)}>
          {MOBILE_LISTING_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </Select>
      </Field>
      <Field label={serviceCategory === 'rent' || serviceCategory === 'pg' ? 'Asking rent (₹/mo)' : 'Asking price (₹)'}>
        <TextInput
          type="number"
          value={askingPrice}
          onChange={(e) => setAskingPrice(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bedrooms, facing, parking…" />
      </Field>
      <p className="muted">
        {offline
          ? 'You are offline — this capture will be queued and synced later.'
          : 'This listing will be saved to the server and appear in your scoped view.'}
      </p>
    </Modal>
  );
}

// ----------------- Mobile matching additions -----------------

// Lead-detail bottom sheet. Tapping a lead card on the mobile Leads tab
// opens this — it surfaces the lead summary, then the top-3 matching
// listings with field actions only (Call / WhatsApp / Navigate / Schedule).
// No match-management buttons: this is a field-execute view, not a CRM
// editing surface.
function MobileLeadSheet({ lead, onClose }) {
  const { state, currentUser, actions } = useStore();
  const project = state.projects.find((p) => p.id === lead.projectId);
  const [schedulingFor, setSchedulingFor] = useState(null);

  const { listings: apiListings } = useListings();
  const visibleListings = useMemo(
    () => filterByScope(currentUser, 'listings', 'view', apiListings),
    [currentUser, apiListings]
  );
  // Same matcher as the desktop lead drawer, but the mobile presentation
  // is intentionally capped to the top 3 so field execs see only what
  // fits one thumb-scroll.
  const topMatches = useMemo(
    () => rankLeadMatches(lead, visibleListings, state.projects, { topN: 3 }),
    [lead, visibleListings, state.projects]
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={lead.name}
      width={520}
      footer={
        <>
          <a className="btn btn-secondary btn-sm" href={buildTelLink(lead.phone)}>
            <Phone size={14} /> Call
          </a>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="mobile-listing-chips">
        <Badge tone={lead.score === 'hot' ? 'danger' : lead.score === 'warm' ? 'warning' : 'neutral'} dot>
          {lead.score}
        </Badge>
        <Badge tone="neutral">{lead.status}</Badge>
        <Badge tone="info">{lead.unitType}</Badge>
      </div>
      <ul className="kv-list kv-list-tight">
        <li><span>Project</span><strong>{project?.name || '—'}</strong></li>
        <li>
          <span>Budget</span>
          <strong>{formatINR(lead.budgetMin)} – {formatINR(lead.budgetMax)}</strong>
        </li>
        <li><span>Next follow-up</span><strong>{formatDateTime(lead.nextFollowUp)}</strong></li>
      </ul>

      <SectionTitle eyebrow="Top matching listings" title={`${topMatches.length} recommendation${topMatches.length === 1 ? '' : 's'}`} />
      {topMatches.length === 0 ? (
        <p className="muted">No strong matches yet — try widening the budget or unit type.</p>
      ) : (
        <div className="mobile-match-list">
          {topMatches.map(({ listing, score, reason }) => {
            const mapsHref = listing.location?.geo
              ? `https://maps.google.com/?q=${listing.location.geo.lat},${listing.location.geo.lng}`
              : null;
            const price =
              listing.listingIntent === 'available_for_sale'
                ? formatINR(listing.pricing?.price)
                : `${formatINR(listing.pricing?.rentMonthly)}/mo`;
            return (
              <article className="mobile-match-card" key={listing.id}>
                <header>
                  <span className={`match-score ${score >= 75 ? '' : score >= 50 ? 'med' : 'low'}`}>
                    {score}/100
                  </span>
                  <strong>{listing.title}</strong>
                  <small>
                    <MapPin size={11} /> {listing.location?.locality || '—'} · {listing.location?.city || '—'} · {price}
                  </small>
                </header>
                <small className="mobile-match-reason">{reason}</small>
                <div className="mobile-match-card-actions">
                  <a className="btn btn-secondary btn-sm" href={buildTelLink(listing.ownerContact?.phone)}>
                    <Phone size={12} /> Call owner
                  </a>
                  <a
                    className="btn btn-secondary btn-sm"
                    href={buildWhatsAppLink(
                      listing.ownerContact?.phone,
                      `Hi ${listing.ownerContact?.name?.split(' ')[0] || ''}, sharing details of ${listing.title}.`
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageSquareText size={12} /> WhatsApp
                  </a>
                  {mapsHref && (
                    <a className="btn btn-secondary btn-sm" href={mapsHref} target="_blank" rel="noreferrer">
                      <Navigation size={12} /> Navigate
                    </a>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    icon={CalendarPlus}
                    onClick={() => setSchedulingFor(listing)}
                  >
                    Schedule visit
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {schedulingFor && (
        <MobileNewVisitSheet
          lead={lead}
          listing={schedulingFor}
          onClose={() => setSchedulingFor(null)}
          onScheduled={onClose}
        />
      )}
    </Modal>
  );
}

// Mobile variant of MatchScheduleVisitSheet — inline-rendered inside the
// lead sheet rather than its own modal stack. Submits the same
// actions.createVisit payload so the visit card lands with listingId set.
function MobileNewVisitSheet({ lead, listing, onClose, onScheduled }) {
  const { actions, state, currentUser } = useStore();
  const defaultIso = useMemo(() => {
    const d = new Date();
    d.setHours(d.getHours() + 2, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  }, []);
  const [scheduledFor, setScheduledFor] = useState(defaultIso);
  const [staffId, setStaffId] = useState(currentUser?.id || '');
  const [notes, setNotes] = useState(
    `Visit from listing match: ${listing.title}`
  );

  const submit = () => {
    if (!staffId) {
      actions.toast('Choose a staff member.', 'error');
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
    // Mirror desktop behaviour: bump the match to 'visited' so the lifecycle
    // advances. createMatch is idempotent on (leadId, listingId).
    const existing = state.matches.find(
      (m) => m.leadId === lead.id && m.listingId === listing.id
    );
    if (existing && existing.matchStatus !== 'visited') {
      actions.updateMatchStatus(existing.id, 'visited');
    } else if (!existing) {
      actions.createMatch(lead.id, listing.id, 'visited');
    }
    actions.toast('Visit scheduled.', 'success');
    onClose();
    onScheduled?.();
  };

  return (
    <div className="mobile-visit-sheet">
      <div className="mobile-visit-sheet-header">
        <strong>Schedule visit</strong>
        <button className="btn-icon" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <p className="muted">
        <Link2 size={12} /> From match with <strong>{listing.title}</strong>
      </p>
      <Field label="When" required>
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
      <Field label="Notes">
        <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Button block variant="primary" icon={CalendarPlus} onClick={submit}>
        Schedule visit
      </Button>
    </div>
  );
}
