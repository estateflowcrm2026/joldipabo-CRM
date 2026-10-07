// Listings (Inventory) module — desktop view.
//
// Mirrors the Leads.jsx + Visits.jsx patterns: a top-of-page Panel with stat
// cards, a filter bar, a table/card toggle for the list, and side drawers /
// modals for create, assign, and verify flows.
//
// The DTO shape mirrors the backend `013_listings.sql` schema verbatim (see
// docs/LISTINGS_MODULE.md) so the future apiRepository swap is zero-migration.
// All access goes through filterByScope + can() — the OWN-scope extension for
// listings lives in src/data/permissions.js and treats a listing as "owned"
// when assignedTo OR createdBy matches the current user.
//
// Create/edit dispatch goes through actions.createListing / updateListing.
// The verification flow uses actions.verifyListing (status.audit). Deletion
// is a soft delete via actions.deleteListing which flips
// status.availability to 'off-market' to match the backend semantics.

import { useMemo, useState } from 'react';
import {
  Building2,
  Search,
  X,
  MapPin,
  Phone,
  MessageCircle,
  UserPlus,
  CheckCircle2,
  AlertCircle,
  Clock,
  EyeOff,
  Sparkles,
  LayoutGrid,
  Rows3,
  Tag,
  Camera,
  ShieldCheck,
  Warehouse,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { can, RESOURCES } from '../../data/permissions.js';
import { useListings, resolveAssignee } from '../../services/listingsData.jsx';
import { useAssignableStaff } from '../../services/staffDirectory.js';
import { useProjectsDirectory } from '../../services/teamsProjectsDirectory.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  LoadingState,
  Modal,
  Panel,
  RestrictedState,
  SectionTitle,
  Select,
  StatTile,
  TextInput,
  formatINR,
  buildTelLink,
  buildWhatsAppLink,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

// ---------- Constants ----------
//
// The form submits backend enum values (see src/services/listingEnums.js).
// The labels are human-friendly; the values are what the backend CHECK
// constraints accept. The translation layer handles the mapping.

// The full vocabulary, in display order. The filter only renders the ones
// actually present in the visible data (see categoriesInScope), so a demo
// never shows a filter that returns an empty table.
const SERVICE_CATEGORIES = [
  { value: 'rent', label: 'Rent' },
  { value: 'pg', label: 'PG' },
  { value: 'land', label: 'Land' },
  { value: 'office', label: 'Office' },
  { value: 'resale', label: 'Resale' },
  { value: 'owner-listed', label: 'Owner-listed' },
  { value: 'sell', label: 'Sell' },
  { value: 'commercial', label: 'Commercial' },
];

const LISTING_INTENTS = [
  { value: 'available_for_rent', label: 'Rent out' },
  { value: 'available_for_sale', label: 'Sell' },
  { value: 'wanted', label: 'Wanted' },
  { value: 'client_requirement', label: 'Client requirement' },
];

const AVAILABILITY_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'booked', label: 'Booked' },
  { value: 'occupied', label: 'Occupied' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const VERIFICATION_OPTIONS = [
  { value: 'unverified', label: 'Unverified' },
  { value: 'pending', label: 'Pending' },
  { value: 'verified', label: 'Verified' },
  { value: 'rejected', label: 'Rejected' },
];

const PROPERTY_TYPES = [
  'apartment',
  'independent_house',
  'villa',
  'pg_bed',
  'pg_room',
  'land_parcel',
  'office',
  'shop',
  'warehouse',
  'plot',
];

const PROPERTY_TYPE_LABELS = {
  apartment: 'Apartment',
  independent_house: 'Independent House',
  villa: 'Villa',
  pg_bed: 'PG Bed',
  pg_room: 'PG Room',
  land_parcel: 'Land Parcel',
  office: 'Office',
  shop: 'Shop',
  warehouse: 'Warehouse',
  plot: 'Plot',
};

const FURNISHED_OPTIONS = [
  { value: 'unfurnished', label: 'Unfurnished' },
  { value: 'semi', label: 'Semi-furnished' },
  { value: 'fully', label: 'Fully furnished' },
];

// ---------- Helpers ----------

const serviceCategoryLabel = (value) =>
  SERVICE_CATEGORIES.find((s) => s.value === value)?.label || value;

const availabilityTone = (value) => {
  if (value === 'available') return 'success';
  if (value === 'reserved') return 'warning';
  if (value === 'booked') return 'info';
  return 'neutral';
};

const verificationTone = (value) => {
  if (value === 'verified') return 'success';
  if (value === 'pending') return 'warning';
  if (value === 'rejected') return 'danger';
  return 'neutral';
};

const formatPrice = (listing) => {
  const { pricing } = listing;
  if (listing.listingIntent === 'available_for_sale') {
    if (pricing.price) return `${formatINR(pricing.price)}`;
    return '—';
  }
  if (pricing.rentMonthly) return `${formatINR(pricing.rentMonthly)}/mo`;
  return '—';
};

const formatArea = (sqft) => (sqft ? `${sqft} sqft` : '—');

// ---------- Main view ----------

export function Listings() {
  const { state, currentUser } = useStore();
  const {
    listings,
    status,
    error,
    retry,
    mutating,
    createListing,
    updateListing,
    assignListing,
    verifyListing,
    removeListing,
  } = useListings();
  const assignStaff = useAssignableStaff();
  // Assignment needs a source of eligible people. In live mode that is the
  // staff directory (GET /api/v1/users); `available` is false while it loads
  // or when it fails, so the control is withheld rather than offering
  // seeded demo users (see staffDirectory.js).
  const canAssign = assignStaff.available;
  const visible = listings;
  const hasAnyViewScope = can(currentUser, RESOURCES.LISTINGS, 'view');

  // Filter state
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');
  const [verificationFilter, setVerificationFilter] = useState('all');
  const [assignedFilter, setAssignedFilter] = useState('all');

  // UI state
  const [view, setView] = useState('table');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const [editing, setEditing] = useState(null);

  if (!currentUser) return null;

  // Build dynamic option lists from the visible data so filters never show
  // options with zero records.
  const propertyTypesInScope = useMemo(() => {
    const set = new Set(visible.map((l) => l.propertyType).filter(Boolean));
    return Array.from(set).sort();
  }, [visible]);

  // Categories actually present in scope, in canonical order. Deriving this
  // (rather than rendering the static list) means the demo never offers a
  // filter that returns nothing.
  const categoriesInScope = useMemo(() => {
    const present = new Set(visible.map((l) => l.serviceCategory).filter(Boolean));
    const known = SERVICE_CATEGORIES.filter((c) => present.has(c.value));
    const extras = Array.from(present)
      .filter((v) => !SERVICE_CATEGORIES.some((c) => c.value === v))
      .sort()
      .map((v) => ({ value: v, label: v }));
    return [...known, ...extras];
  }, [visible]);

  // Assignees present in the visible set, keyed by id. Names prefer the
  // backend's own (`assignedToName`) over a seed lookup, so live mode does
  // not label a backend user with a same-id seed user's name.
  const assignedToInScope = useMemo(() => {
    const byId = new Map();
    for (const l of visible) {
      const id = typeof l.assignedTo === 'string' ? l.assignedTo : l.assignedTo?.id;
      if (!id || byId.has(id)) continue;
      const local = state.users.find((u) => u.id === id);
      byId.set(id, { id, name: l.assignedToName || local?.name || id });
    }
    return Array.from(byId.values());
  }, [visible, state.users]);

  // Apply filters
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible.filter((l) => {
      if (categoryFilter !== 'all' && l.serviceCategory !== categoryFilter) return false;
      if (typeFilter !== 'all' && l.propertyType !== typeFilter) return false;
      if (availabilityFilter !== 'all' && l.status?.availability !== availabilityFilter) return false;
      if (verificationFilter !== 'all' && l.status?.verification !== verificationFilter) return false;
      if (assignedFilter !== 'all' && l.assignedTo !== assignedFilter) return false;
      if (q) {
        const hay = [
          l.title,
          l.ownerContact?.name,
          l.ownerContact?.phone,
          l.location?.locality,
          l.location?.city,
          l.location?.address,
          l.notes,
          ...(l.tags || []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [visible, query, categoryFilter, typeFilter, availabilityFilter, verificationFilter, assignedFilter]);

  // Stats
  const totalCount = visible.length;
  const activeRent = visible.filter(
    (l) => l.serviceCategory === 'rent' && l.status?.availability === 'available'
  ).length;
  const pgAvailable = visible.filter(
    (l) => l.serviceCategory === 'pg' && l.status?.availability === 'available'
  ).length;
  const pendingVerification = visible.filter((l) => l.status?.verification === 'pending').length;

  if (!hasAnyViewScope) {
    return (
      <div className="listings-page">
        <Panel>
          <SectionTitle title="Inventory" subtitle="Listings you own or are assigned to" />
          <RestrictedState resource="listings" action="view" scope="any" role={currentUser.role} />
        </Panel>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="listings-page">
        <Panel>
          <SectionTitle title="Inventory" subtitle="Listings you own or are assigned to" />
          <LoadingState label="Loading listings" />
        </Panel>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="listings-page">
        <Panel>
          <SectionTitle title="Inventory" subtitle="Listings you own or are assigned to" />
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
        </Panel>
      </div>
    );
  }

  const clearFilters = () => {
    setQuery('');
    setCategoryFilter('all');
    setTypeFilter('all');
    setAvailabilityFilter('all');
    setVerificationFilter('all');
    setAssignedFilter('all');
  };

  const hasActiveFilter =
    query ||
    categoryFilter !== 'all' ||
    typeFilter !== 'all' ||
    availabilityFilter !== 'all' ||
    verificationFilter !== 'all' ||
    assignedFilter !== 'all';

  return (
    <div className="listings-page">
      {/* Stat cards */}
      <div className="stat-grid">
        <StatTile
          icon={Warehouse}
          tone="primary"
          label="Total listings"
          value={totalCount}
          helper={visible.length === listings.length ? 'All in scope' : 'In your scope'}
        />
        <StatTile
          icon={Building2}
          tone="info"
          label="Active rent"
          value={activeRent}
          helper="Available rentals"
        />
        <StatTile
          icon={Tag}
          tone="success"
          label="PG available"
          value={pgAvailable}
          helper="Beds / rooms ready"
        />
        <StatTile
          icon={ShieldCheck}
          tone="warning"
          label="Pending verification"
          value={pendingVerification}
          helper="Awaiting approval"
        />
      </div>

      <Panel
        title="Listings"
        subtitle={`${filtered.length} of ${totalCount} in scope`}
        action={
          <div className="panel-actions">
            <div className="view-toggle" role="tablist" aria-label="View mode">
              <button
                role="tab"
                aria-selected={view === 'table'}
                className={view === 'table' ? 'active' : ''}
                onClick={() => setView('table')}
                title="Table view"
              >
                <Rows3 size={14} />
              </button>
              <button
                role="tab"
                aria-selected={view === 'card'}
                className={view === 'card' ? 'active' : ''}
                onClick={() => setView('card')}
                title="Card view"
              >
                <LayoutGrid size={14} />
              </button>
            </div>
            <Can resource={RESOURCES.LISTINGS} action="create">
              <Button variant="primary" icon={Sparkles} onClick={() => setCreating(true)}>
                New listing
              </Button>
            </Can>
          </div>
        }
      >
        {/* Filter bar */}
        <div className="filter-bar">
          <TextInput
            icon={Search}
            placeholder="Search title, owner, locality…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">All categories</option>
            {categoriesInScope.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All property types</option>
            {propertyTypesInScope.map((t) => (
              <option key={t} value={t}>
                {PROPERTY_TYPE_LABELS[t] || t}
              </option>
            ))}
          </Select>
          <Select
            value={availabilityFilter}
            onChange={(e) => setAvailabilityFilter(e.target.value)}
          >
            <option value="all">All availability</option>
            {AVAILABILITY_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
          <Select
            value={verificationFilter}
            onChange={(e) => setVerificationFilter(e.target.value)}
          >
            <option value="all">All verification</option>
            {VERIFICATION_OPTIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select value={assignedFilter} onChange={(e) => setAssignedFilter(e.target.value)}>
            <option value="all">Any assignee</option>
            {assignedToInScope.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          {hasActiveFilter && (
            <Button variant="ghost" size="sm" icon={X} onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Warehouse}
            title={visible.length === 0 ? 'No listings in your scope' : 'No listings match these filters'}
            description={
              visible.length === 0
                ? 'No listings are assigned to or created by you yet.'
                : 'Try clearing some filters to see more results.'
            }
          />
        ) : view === 'table' ? (
          <div className="listing-table" role="table">
            <div className="listing-row listing-row-head" role="row">
              <span>Title</span>
              <span>Category</span>
              <span>Locality</span>
              <span>Price</span>
              <span>Availability</span>
              <span>Verification</span>
              <span>Assigned</span>
              <span />
            </div>
            {filtered.map((listing) => {
              const assignee = resolveAssignee(listing, state.users, assignStaff.staff);
              return (
                <div
                  key={listing.id}
                  className="listing-row"
                  role="row"
                  tabIndex={0}
                  onClick={() => setSelected(listing)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(listing);
                    }
                  }}
                >
                  <span className="listing-row-title">
                    <strong>{listing.title}</strong>
                    <small>
                      {PROPERTY_TYPE_LABELS[listing.propertyType] || listing.propertyType} · {listing.location?.city || '—'}
                    </small>
                  </span>
                  <span>
                    <Badge tone="neutral" size="sm">
                      {serviceCategoryLabel(listing.serviceCategory)}
                    </Badge>
                  </span>
                  <span>{listing.location?.locality || '—'}</span>
                  <span className="listing-row-price">{formatPrice(listing)}</span>
                  <span>
                    <Badge tone={availabilityTone(listing.status?.availability)} dot size="sm">
                      {listing.status?.availability || '—'}
                    </Badge>
                  </span>
                  <span>
                    <Badge tone={verificationTone(listing.status?.verification)} dot size="sm">
                      {listing.status?.verification || '—'}
                    </Badge>
                  </span>
                  <span>
                    {assignee ? (
                      <span className="inline-user">
                        <Avatar name={assignee.name} size="xs" tone="light" />
                        <span>{assignee.name}</span>
                      </span>
                    ) : (
                      <span className="muted">Unassigned</span>
                    )}
                  </span>
                  <span className="listing-row-actions">
                    {canAssign && (
                      <Can resource={RESOURCES.LISTINGS} action="assign" record={listing}>
                        <button
                          className="btn-icon"
                          aria-label="Assign"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAssigning(listing);
                          }}
                        >
                          <UserPlus size={14} />
                        </button>
                      </Can>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="listing-card-grid">
            {filtered.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                assignee={resolveAssignee(listing, state.users, assignStaff.staff)}
                canAssign={canAssign}
                onOpen={() => setSelected(listing)}
                onAssign={() => setAssigning(listing)}
              />
            ))}
          </div>
        )}
      </Panel>

      {selected && (
        <ListingDrawer
          listing={selected}
          canAssign={canAssign}
          directory={assignStaff.staff}
          projectName={selected.project?.name || null}
          onClose={() => setSelected(null)}
          onAssign={() => {
            setAssigning(selected);
            setSelected(null);
          }}
          onVerify={() => {
            setVerifying(selected);
            setSelected(null);
          }}
          onEdit={() => {
            setEditing(selected);
            setSelected(null);
          }}
        />
      )}

      {creating && <NewListingModal onClose={() => setCreating(false)} />}

      {assigning && (
        <AssignListingModal
          listing={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={() => setAssigning(null)}
        />
      )}

      {verifying && (
        <VerifyListingModal
          listing={verifying}
          onClose={() => setVerifying(null)}
          onVerified={() => setVerifying(null)}
        />
      )}

      {editing && (
        <EditListingModal
          listing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ---------- Card ----------

function ListingCard({ listing, assignee, canAssign, onOpen, onAssign }) {
  return (
    <article className="listing-card">
      <header>
        <div className="listing-card-chips">
          <Badge tone="neutral" size="sm">
            {serviceCategoryLabel(listing.serviceCategory)}
          </Badge>
          {listing.photoCount > 0 && (
            <span className="listing-photo-chip" title="Photos">
              <Camera size={12} /> {listing.photoCount}
            </span>
          )}
        </div>
        <Badge tone={availabilityTone(listing.status?.availability)} dot size="sm">
          {listing.status?.availability || '—'}
        </Badge>
      </header>

      <button
        type="button"
        className="listing-card-title"
        onClick={onOpen}
        aria-label={`Open ${listing.title}`}
      >
        {listing.title}
      </button>

      <div className="listing-card-meta">
        <span>
          <MapPin size={12} /> {listing.location?.locality || '—'} · {listing.location?.city || '—'}
        </span>
        <span className="muted">{PROPERTY_TYPE_LABELS[listing.propertyType] || listing.propertyType}</span>
      </div>

      <div className="listing-card-price">{formatPrice(listing)}</div>

      <div className="listing-card-tags">
        <Badge tone={verificationTone(listing.status?.verification)} dot size="sm">
          {listing.status?.verification || '—'}
        </Badge>
        {assignee && (
          <span className="inline-user">
            <Avatar name={assignee.name} size="xs" tone="light" />
            <span>{assignee.name}</span>
          </span>
        )}
      </div>

      <footer>
        {listing.ownerContact?.phone && (
          <a
            className="btn btn-secondary btn-sm"
            href={buildTelLink(listing.ownerContact.phone)}
            onClick={(e) => e.stopPropagation()}
          >
            <Phone size={14} /> Call
          </a>
        )}
        <Button variant="primary" size="sm" onClick={onOpen}>
          Open
        </Button>
        <Can resource={RESOURCES.LISTINGS} action="assign" record={listing}>
          {canAssign && (
            <Button variant="ghost" size="sm" icon={UserPlus} onClick={onAssign} aria-label="Assign">
              Assign
            </Button>
          )}
        </Can>
      </footer>
    </article>
  );
}

// ---------- Drawer ----------

function ListingDrawer({ listing, canAssign, directory, projectName, onClose, onAssign, onVerify, onEdit }) {
  const { state } = useStore();
  const assignee = resolveAssignee(listing, state.users, directory);
  const creator = state.users.find((u) => u.id === listing.createdBy);
  // Project name prefers the backend's own display name (carried on the
  // listing DTO) over a seed lookup, so live mode never shows a blank or a
  // same-id seed project's name.
  const project = projectName
    ? { name: projectName }
    : state.projects.find((p) => p.id === listing.projectId);
  const verifier = state.users.find((u) => u.id === listing.status?.verifiedBy);

  const { pricing, specs, location, ownerContact } = listing;

  const mapsHref = location?.geo
    ? `https://maps.google.com/?q=${location.geo.lat},${location.geo.lng}`
    : location?.address
      ? `https://maps.google.com/?q=${encodeURIComponent(`${location.address}, ${location.city || ''}`)}`
      : null;

  return (
    <div className="drawer-backdrop drawer-side-backdrop" onClick={onClose}>
      <aside className="drawer-side drawer-wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-side-header">
          <div>
            <div className="listing-drawer-chips">
              <Badge tone="neutral">{serviceCategoryLabel(listing.serviceCategory)}</Badge>
              <Badge tone={availabilityTone(listing.status?.availability)} dot>
                {listing.status?.availability || '—'}
              </Badge>
              <Badge tone={verificationTone(listing.status?.verification)} dot>
                {listing.status?.verification || '—'}
              </Badge>
            </div>
            <h2>{listing.title}</h2>
            <small>
              {PROPERTY_TYPE_LABELS[listing.propertyType] || listing.propertyType} · created {timeAgo(listing.createdAt)} by {creator?.name || '—'}
            </small>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

      <section className="drawer-section">
        <h4>Owner contact</h4>
        <ul className="kv-list">
          <li><span>Name</span><strong>{ownerContact?.name || '—'}</strong></li>
          <li><span>Phone</span><strong>{ownerContact?.phone || '—'}</strong></li>
          <li><span>Email</span><strong>{ownerContact?.email || '—'}</strong></li>
          <li><span>Relation</span><strong>{ownerContact?.relation || '—'}</strong></li>
        </ul>
        <div className="drawer-actions">
          {ownerContact?.phone && (
            <>
              <a className="btn btn-secondary btn-sm" href={buildTelLink(ownerContact.phone)}>
                <Phone size={14} /> Call
              </a>
              <a
                className="btn btn-secondary btn-sm"
                href={buildWhatsAppLink(
                  ownerContact.phone,
                  `Hi ${ownerContact.name?.split(' ')[0] || ''}, following up on ${listing.title}.`
                )}
                target="_blank"
                rel="noreferrer"
              >
                <MessageCircle size={14} /> WhatsApp
              </a>
            </>
          )}
        </div>
      </section>

      <section className="drawer-section">
        <h4>Pricing</h4>
        <ul className="kv-list">
          {listing.listingIntent === 'available_for_sale' ? (
            <>
              <li><span>Price</span><strong>{pricing?.price ? formatINR(pricing.price) : '—'}</strong></li>
              <li><span>Area</span><strong>{formatArea(pricing?.areaSqft)}</strong></li>
              {pricing?.pricePerSqft && (
                <li><span>Per sqft</span><strong>{formatINR(pricing.pricePerSqft)}</strong></li>
              )}
            </>
          ) : (
            <>
              <li><span>Rent</span><strong>{pricing?.rentMonthly ? `${formatINR(pricing.rentMonthly)}/mo` : '—'}</strong></li>
              <li><span>Deposit</span><strong>{pricing?.deposit ? formatINR(pricing.deposit) : '—'}</strong></li>
              {pricing?.maintenanceMonthly && (
                <li><span>Maintenance</span><strong>{formatINR(pricing.maintenanceMonthly)}/mo</strong></li>
              )}
              <li><span>Area</span><strong>{formatArea(pricing?.areaSqft)}</strong></li>
            </>
          )}
        </ul>
      </section>

      <section className="drawer-section">
        <h4>Specs</h4>
        <ul className="kv-list">
          {specs?.bedrooms != null && <li><span>Bedrooms</span><strong>{specs.bedrooms}</strong></li>}
          {specs?.bathrooms != null && <li><span>Bathrooms</span><strong>{specs.bathrooms}</strong></li>}
          {specs?.furnished && (
            <li>
              <span>Furnished</span>
              <strong>{FURNISHED_OPTIONS.find((f) => f.value === specs.furnished)?.label || specs.furnished}</strong>
            </li>
          )}
          {specs?.floor != null && (
            <li><span>Floor</span><strong>{specs.floor}{specs.totalFloors ? ` of ${specs.totalFloors}` : ''}</strong></li>
          )}
          {specs?.parking != null && <li><span>Parking</span><strong>{specs.parking}</strong></li>}
        </ul>
        {specs?.amenities?.length > 0 && (
          <div className="tag-row">
            {specs.amenities.map((a) => (
              <span className="tag" key={a}>
                {a}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="drawer-section">
        <h4>Location</h4>
        <p>{location?.address || '—'}</p>
        <p className="muted">{location?.locality ? `${location.locality}, ` : ''}{location?.city || ''}</p>
        {location?.geo?.label && <p className="muted">{location.geo.label}</p>}
        {mapsHref && (
          <a className="btn btn-secondary btn-sm" href={mapsHref} target="_blank" rel="noreferrer">
            <MapPin size={14} /> Open in Maps
          </a>
        )}
      </section>

      <section className="drawer-section">
        <h4>Verification</h4>
        <div className={`listing-verification-banner ${listing.status?.verification || 'unverified'}`}>
          {listing.status?.verification === 'verified' && <CheckCircle2 size={16} />}
          {listing.status?.verification === 'pending' && <Clock size={16} />}
          {listing.status?.verification === 'rejected' && <AlertCircle size={16} />}
          {(!listing.status?.verification || listing.status?.verification === 'unverified') && <EyeOff size={16} />}
          <span>
            {listing.status?.verification === 'verified' && 'Verified by '}
            {listing.status?.verification === 'pending' && 'Verification pending — '}
            {listing.status?.verification === 'rejected' && 'Rejected — '}
            {(!listing.status?.verification || listing.status?.verification === 'unverified') && 'Not yet verified'}
            {listing.status?.verifiedAt && ` · ${timeAgo(listing.status.verifiedAt)}`}
          </span>
        </div>
        {verifier && <p className="muted">Verifier: {verifier.name}</p>}
        {listing.status?.verificationReason && (
          <p className="muted">Reason: {listing.status.verificationReason}</p>
        )}
      </section>

      {listing.notes && (
        <section className="drawer-section">
          <h4>Notes</h4>
          <p>{listing.notes}</p>
        </section>
      )}

      <section className="drawer-section">
        <h4>Tags</h4>
        <div className="tag-row">
          {(!listing.tags || listing.tags.length === 0) ? (
            <span className="muted">No tags yet</span>
          ) : (
            listing.tags.map((t) => (
              <span className="tag" key={t}>
                <Tag size={12} /> {t}
              </span>
            ))
          )}
        </div>
      </section>

      <InterestedLeads listing={listing} />

      <section className="drawer-section drawer-section-meta">
        <h4>Assignment</h4>
        {assignee ? (
          <span className="inline-user">
            <Avatar name={assignee.name} size="sm" />
            <div>
              <strong>{assignee.name}</strong>
              <small>{assignee.email}</small>
            </div>
          </span>
        ) : (
          <Badge tone="warning">Unassigned</Badge>
        )}
        {project && (
          <p className="muted">
            Project: <strong>{project.name}</strong>
          </p>
        )}
        {!canAssign && (
          <p className="muted">
            Reassignment is unavailable: the backend has no staff directory
            endpoint yet, so there is no eligible-assignee list to offer.
          </p>
        )}
        <p className="muted">Last updated {timeAgo(listing.updatedAt)}</p>
      </section>

      <footer className="drawer-actions drawer-actions-sticky">
        <Can resource={RESOURCES.LISTINGS} action="edit" record={listing}>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
        </Can>
        <Can resource={RESOURCES.LISTINGS} action="assign" record={listing}>
          {canAssign && (
            <Button variant="secondary" size="sm" icon={UserPlus} onClick={onAssign}>
              Reassign
            </Button>
          )}
        </Can>
        <Can resource={RESOURCES.LISTINGS} action="approve" record={listing}>
          <Button variant="primary" size="sm" icon={ShieldCheck} onClick={onVerify}>
            Verify
          </Button>
        </Can>
        <Can resource={RESOURCES.LISTINGS} action="delete" record={listing}>
          <DeleteListingButton listing={listing} onDeleted={onClose} />
        </Can>
      </footer>
      </aside>
    </div>
  );
}

function DeleteListingButton({ listing, onDeleted }) {
  const { removeListing, mutating } = useListings();
  const { actions } = useStore();
  const onClick = async () => {
    if (!window.confirm(`Mark "${listing.title}" off-market? It can be re-listed later.`)) return;
    const result = await removeListing(listing.id);
    if (result.ok) {
      actions.toast(`"${listing.title}" marked off-market.`, 'success');
      onDeleted?.();
    } else {
      actions.toast(result.message || 'Could not remove listing.', 'error');
    }
  };
  return (
    <Button variant="ghost" size="sm" icon={EyeOff} onClick={onClick} disabled={mutating}>
      Mark off-market
    </Button>
  );
}

// ---------- Interested leads (read-only) ----------

// Surfaces every lead that has a match against this listing, regardless of
// matchStatus. Read-only — there is no cross-module deep-link in this phase.
// Each row is filtered through leads.view so a field executive only sees
// leads they own. See docs/LEAD_LISTING_MATCHING.md §"UI surfaces".
function InterestedLeads({ listing }) {
  const { state, currentUser } = useStore();
  const related = state.matches
    .filter((m) => m.listingId === listing.id)
    .map((m) => ({ match: m, lead: state.leads.find((l) => l.id === m.leadId) }))
    .filter(({ lead }) => lead && can(currentUser, 'leads', 'view', lead));

  const total = related.length;

  return (
    <section className="drawer-section">
      <h4>Interested leads</h4>
      {total === 0 ? (
        <p className="muted">No leads matched to this listing yet.</p>
      ) : (
        <>
          <p className="muted">{total} lead{total === 1 ? '' : 's'} matched this listing.</p>
          <ul className="interested-leads-list">
            {related.map(({ match, lead }) => (
              <li key={match.id}>
                <Avatar name={lead.name} size="sm" />
                <div className="interested-leads-body">
                  <strong>{lead.name}</strong>
                  <small>
                    {lead.unitType} · {formatINR(lead.budgetMin)}–{formatINR(lead.budgetMax)}
                  </small>
                </div>
                <Badge
                  tone={
                    match.matchStatus === 'matched'
                      ? 'success'
                      : match.matchStatus === 'visited'
                        ? 'neutral'
                        : match.matchStatus === 'rejected'
                          ? 'danger'
                          : 'info'
                  }
                  dot
                  size="sm"
                >
                  {match.matchStatus}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------- Modals ----------

function NewListingModal({ onClose }) {
  const { actions, state, currentUser } = useStore();
  const { createListing, mutating } = useListings();
  const staffDir = useAssignableStaff();
  const projectDir = useProjectsDirectory();
  // The project picker draws from the live projects directory in live mode
  // and the seed roster in demo mode. The assignee picker draws from the
  // live staff directory (staffDir) in live mode.
  const projectPickerAvailable = projectDir.available;

  // Owner
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerRelation, setOwnerRelation] = useState('owner');

  // Classification
  const [serviceCategory, setServiceCategory] = useState('rent');
  const [propertyType, setPropertyType] = useState('apartment');
  const [listingIntent, setListingIntent] = useState('available_for_rent');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  // Location
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [locality, setLocality] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');

  // Pricing
  const [price, setPrice] = useState('');
  const [rentMonthly, setRentMonthly] = useState('');
  const [deposit, setDeposit] = useState('');
  const [areaSqft, setAreaSqft] = useState('');

  // Specs
  const [bedrooms, setBedrooms] = useState(2);
  const [bathrooms, setBathrooms] = useState(2);
  const [furnished, setFurnished] = useState('semi');
  const [floor, setFloor] = useState('');
  const [parking, setParking] = useState(1);
  const [amenitiesText, setAmenitiesText] = useState('');

  // Assignment
  const [assignedTo, setAssignedTo] = useState(currentUser.id);
  const [projectId, setProjectId] = useState(
    projectDir.source === 'seed' ? state.projects[0]?.id || '' : ''
  );

  // Auto-derive listingIntent from category when the user changes category.
  // Uses backend enum values — see src/services/listingEnums.js.
  const handleCategoryChange = (next) => {
    setServiceCategory(next);
    const intentByCategory = {
      rent: 'available_for_rent',
      pg: 'available_for_rent',
      land: 'available_for_sale',
      office: 'available_for_rent',
      sell: 'available_for_sale',
      commercial: 'available_for_sale',
    };
    setListingIntent(intentByCategory[next] || 'available_for_sale');
  };

  const submit = async () => {
    if (!ownerName || !ownerPhone || !title || !serviceCategory) {
      actions.toast('Owner name, phone, title, and category are required.', 'error');
      return;
    }
    const amenities = amenitiesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const listing = {
      serviceCategory,
      propertyType,
      listingIntent,
      title,
      description,
      location: {
        address,
        city,
        locality,
        geo: lat && lng ? { lat: Number(lat), lng: Number(lng), label: title } : null,
      },
      pricing: {
        price: price ? Number(price) : null,
        rentMonthly: rentMonthly ? Number(rentMonthly) : null,
        deposit: deposit ? Number(deposit) : null,
        maintenanceMonthly: null,
        areaSqft: areaSqft ? Number(areaSqft) : null,
        pricePerSqft: null,
      },
      specs: {
        bedrooms: bedrooms ? Number(bedrooms) : null,
        bathrooms: bathrooms ? Number(bathrooms) : null,
        furnished,
        floor: floor ? Number(floor) : null,
        totalFloors: null,
        parking: parking ? Number(parking) : 0,
        amenities,
      },
      status: {
        availability: 'available',
        verification: 'unverified',
        verificationReason: null,
        verifiedBy: null,
        verifiedAt: null,
      },
      ownerContact: {
        name: ownerName,
        phone: ownerPhone,
        email: ownerEmail || null,
        relation: ownerRelation,
      },
      assignedTo,
      createdBy: currentUser.id,
      projectId: projectId || null,
      photoCount: 0,
      notes: description,
      tags: [],
    };

    const result = await createListing(listing);
    if (result.ok) {
      actions.toast('Listing created.', 'success');
      onClose();
    } else {
      actions.toast(result.message || 'Could not create listing.', 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New listing"
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Create listing
          </Button>
        </>
      }
    >
      <SectionTitle title="Owner" />
      <div className="grid-2">
        <Field label="Owner name" required>
          <TextInput value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Full name" />
        </Field>
        <Field label="Owner phone" required>
          <TextInput value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="+91 98XXX XXXXX" />
        </Field>
        <Field label="Owner email">
          <TextInput value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="Optional" />
        </Field>
        <Field label="Relation">
          <Select value={ownerRelation} onChange={(e) => setOwnerRelation(e.target.value)}>
            <option value="owner">Owner</option>
            <option value="agent">Agent</option>
            <option value="builder">Builder</option>
            <option value="family">Family member</option>
          </Select>
        </Field>
      </div>

      <SectionTitle title="Classification" />
      <div className="grid-2">
        <Field label="Service category" required>
          <Select value={serviceCategory} onChange={(e) => handleCategoryChange(e.target.value)}>
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Listing intent" required>
          <Select value={listingIntent} onChange={(e) => setListingIntent(e.target.value)}>
            {LISTING_INTENTS.map((i) => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Property type" span={2}>
          <Select value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
            {PROPERTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {PROPERTY_TYPE_LABELS[t] || t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" required span={2}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 2BHK at Orchid Heights" />
        </Field>
        <Field label="Description" span={2}>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Furnishing, facing, notable features" />
        </Field>
      </div>

      <SectionTitle title="Location" />
      <div className="grid-2">
        <Field label="Address" span={2}>
          <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Tower, street, locality" />
        </Field>
        <Field label="City">
          <TextInput value={city} onChange={(e) => setCity(e.target.value)} placeholder="Bengaluru" />
        </Field>
        <Field label="Locality">
          <TextInput value={locality} onChange={(e) => setLocality(e.target.value)} placeholder="Whitefield" />
        </Field>
        <Field label="Latitude">
          <TextInput type="number" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="12.9698" />
        </Field>
        <Field label="Longitude">
          <TextInput type="number" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="77.7500" />
        </Field>
      </div>

      <SectionTitle title="Pricing & area" />
      <div className="grid-2">
        <Field label="Sale price (₹)">
          <TextInput type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Total asking price" />
        </Field>
        <Field label="Monthly rent (₹)">
          <TextInput type="number" value={rentMonthly} onChange={(e) => setRentMonthly(e.target.value)} placeholder="Per month" />
        </Field>
        <Field label="Deposit (₹)">
          <TextInput type="number" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="Refundable" />
        </Field>
        <Field label="Area (sqft)">
          <TextInput type="number" value={areaSqft} onChange={(e) => setAreaSqft(e.target.value)} placeholder="Carpet area" />
        </Field>
      </div>

      <SectionTitle title="Specs" />
      <div className="grid-2">
        <Field label="Bedrooms">
          <TextInput type="number" value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
        </Field>
        <Field label="Bathrooms">
          <TextInput type="number" value={bathrooms} onChange={(e) => setBathrooms(e.target.value)} />
        </Field>
        <Field label="Furnished">
          <Select value={furnished} onChange={(e) => setFurnished(e.target.value)}>
            {FURNISHED_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Floor">
          <TextInput type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />
        </Field>
        <Field label="Parking">
          <TextInput type="number" value={parking} onChange={(e) => setParking(e.target.value)} />
        </Field>
        <Field label="Amenities" span={2}>
          <TextInput
            value={amenitiesText}
            onChange={(e) => setAmenitiesText(e.target.value)}
            placeholder="Comma separated — Gym, Pool, Power backup"
          />
        </Field>
      </div>

      <SectionTitle title="Assignment" />
      <div className="grid-2">
        {projectDir.loading ? (
          <p className="muted">Loading projects…</p>
        ) : projectDir.source === 'unavailable' ? (
          <p className="muted">
            {projectDir.reason}{' '}
            <button type="button" className="link" onClick={projectDir.retry}>
              Retry
            </button>
          </p>
        ) : projectPickerAvailable ? (
          <Field label="Project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— None —</option>
              {projectDir.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="muted">
            {projectDir.reason || 'No projects are visible to you.'}{' '}
            The listing will be created without a project.
          </p>
        )}
        {staffDir.loading ? (
          <p className="muted">Loading staff directory…</p>
        ) : staffDir.available ? (
          <Field label="Assigned to">
            <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              {staffDir.staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="muted">
            {staffDir.reason}{' '}
            {staffDir.source === 'unavailable' && (
              <button type="button" className="btn-link" onClick={staffDir.retry}>
                Retry
              </button>
            )}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AssignListingModal({ listing, onClose, onAssigned }) {
  const { actions, currentUser } = useStore();
  const { assignListing, mutating } = useListings();
  const staffDir = useAssignableStaff();
  const [staffId, setStaffId] = useState(listing.assignedTo || currentUser.id);

  const submit = async () => {
    const user = staffDir.staff.find((u) => u.id === staffId);
    if (!user) {
      actions.toast('Pick a team member to assign.', 'error');
      return;
    }
    const result = await assignListing(listing.id, user.id);
    if (result.ok) {
      actions.toast('Listing assigned.', 'success');
      onAssigned?.();
    } else {
      actions.toast(result.message || 'Could not assign listing.', 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Assign listing"
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={mutating || !staffDir.available}>
            Assign
          </Button>
        </>
      }
    >
      {staffDir.loading ? (
        <p className="muted">Loading staff directory…</p>
      ) : staffDir.available ? (
        <>
          <Field label="Assignee">
            <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              {staffDir.staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.role}
                </option>
              ))}
            </Select>
          </Field>
          <p className="muted">The assignee gets this listing in their scoped view.</p>
        </>
      ) : (
        <p className="muted">
          {staffDir.reason}{' '}
          {staffDir.source === 'unavailable' && (
            <button type="button" className="btn-link" onClick={staffDir.retry}>
              Retry
            </button>
          )}
        </p>
      )}
    </Modal>
  );
}

function VerifyListingModal({ listing, onClose, onVerified }) {
  const { actions } = useStore();
  const { verifyListing, mutating } = useListings();
  const [decision, setDecision] = useState('verified');
  const [reason, setReason] = useState('');

  const submit = async () => {
    if (decision === 'rejected' && !reason.trim()) {
      actions.toast('Rejection needs a short reason.', 'error');
      return;
    }
    const result = await verifyListing(listing.id, decision, reason.trim() || null);
    if (result.ok) {
      actions.toast('Listing verification updated.', 'success');
      onVerified?.();
    } else {
      actions.toast(result.message || 'Could not update verification.', 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Verify ${listing.title}`}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={mutating}>
            Save verification
          </Button>
        </>
      }
    >
      <Field label="Decision" required>
        <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
          <option value="pending">Mark pending</option>
        </Select>
      </Field>
      <Field label={decision === 'rejected' ? 'Reason (required)' : 'Reason (optional)'}>
        <TextInput
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            decision === 'rejected'
              ? 'Why is this listing being rejected?'
              : 'Optional context for the audit log'
          }
        />
      </Field>
    </Modal>
  );
}

function EditListingModal({ listing, onClose, onSaved }) {
  const { actions } = useStore();
  const { updateListing, mutating } = useListings();

  const [title, setTitle] = useState(listing.title);
  const [description, setDescription] = useState(listing.description || '');
  const [price, setPrice] = useState(listing.pricing?.price || '');
  const [rentMonthly, setRentMonthly] = useState(listing.pricing?.rentMonthly || '');
  const [deposit, setDeposit] = useState(listing.pricing?.deposit || '');
  const [areaSqft, setAreaSqft] = useState(listing.pricing?.areaSqft || '');
  const [bedrooms, setBedrooms] = useState(listing.specs?.bedrooms ?? 2);
  const [bathrooms, setBathrooms] = useState(listing.specs?.bathrooms ?? 2);
  const [furnished, setFurnished] = useState(listing.specs?.furnished || 'semi');
  const [floor, setFloor] = useState(listing.specs?.floor || '');
  const [parking, setParking] = useState(listing.specs?.parking ?? 1);
  const [amenitiesText, setAmenitiesText] = useState(
    (listing.specs?.amenities || []).join(', ')
  );
  const [availability, setAvailability] = useState(listing.status?.availability || 'available');

  const submit = async () => {
    if (!title.trim()) {
      actions.toast('Title is required.', 'error');
      return;
    }
    const amenities = amenitiesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const changes = {
      title: title.trim(),
      description,
      pricing: {
        ...listing.pricing,
        price: price ? Number(price) : null,
        rentMonthly: rentMonthly ? Number(rentMonthly) : null,
        deposit: deposit ? Number(deposit) : null,
        areaSqft: areaSqft ? Number(areaSqft) : null,
      },
      specs: {
        ...listing.specs,
        bedrooms: bedrooms ? Number(bedrooms) : null,
        bathrooms: bathrooms ? Number(bathrooms) : null,
        furnished,
        floor: floor ? Number(floor) : null,
        parking: parking ? Number(parking) : 0,
        amenities,
      },
      status: {
        ...listing.status,
        availability,
      },
    };

    const result = await updateListing(listing.id, changes);
    if (result.ok) {
      actions.toast('Listing updated.', 'success');
      onSaved?.();
    } else {
      actions.toast(result.message || 'Could not update listing.', 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${listing.title}`}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={mutating}>
            Save changes
          </Button>
        </>
      }
    >
      <SectionTitle title="Title & description" />
      <div className="grid-2">
        <Field label="Title" required span={2}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description" span={2}>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      <SectionTitle title="Pricing & area" />
      <div className="grid-2">
        <Field label="Sale price (₹)">
          <TextInput type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Monthly rent (₹)">
          <TextInput type="number" value={rentMonthly} onChange={(e) => setRentMonthly(e.target.value)} />
        </Field>
        <Field label="Deposit (₹)">
          <TextInput type="number" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        </Field>
        <Field label="Area (sqft)">
          <TextInput type="number" value={areaSqft} onChange={(e) => setAreaSqft(e.target.value)} />
        </Field>
      </div>

      <SectionTitle title="Specs" />
      <div className="grid-2">
        <Field label="Bedrooms">
          <TextInput type="number" value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
        </Field>
        <Field label="Bathrooms">
          <TextInput type="number" value={bathrooms} onChange={(e) => setBathrooms(e.target.value)} />
        </Field>
        <Field label="Furnished">
          <Select value={furnished} onChange={(e) => setFurnished(e.target.value)}>
            {FURNISHED_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Floor">
          <TextInput type="number" value={floor} onChange={(e) => setFloor(e.target.value)} />
        </Field>
        <Field label="Parking">
          <TextInput type="number" value={parking} onChange={(e) => setParking(e.target.value)} />
        </Field>
        <Field label="Amenities" span={2}>
          <TextInput
            value={amenitiesText}
            onChange={(e) => setAmenitiesText(e.target.value)}
            placeholder="Comma separated — Gym, Pool, Power backup"
          />
        </Field>
      </div>

      <SectionTitle title="Availability" />
      <div className="grid-2">
        <Field label="Status">
          <Select value={availability} onChange={(e) => setAvailability(e.target.value)}>
            {AVAILABILITY_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
