// Mobile Home — the field-staff command centre. Card-based, large tap targets,
// permission-aware. Shows: check-in/out, today's visits, hot follow-ups, quick
// actions, photo upload, manager messages.

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Flame,
  LogIn,
  LogOut,
  MapPin,
  MessageSquareText,
  Navigation,
  Phone,
  Plus,
  Sparkles,
  Target,
  Users,
  Warehouse,
  Zap,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope } from '../../data/permissions.js';
import { useListings } from '../../services/listingsData.jsx';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  SectionTitle,
  buildTelLink,
  buildWhatsAppLink,
  formatINR,
  formatTime,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';
import {
  isOffline,
  queueAttendanceCheckIn,
  queueAttendanceCheckOut,
} from '../../services/offlineActions.js';

export function MobileHome({ onSwitchTab, onOpenDrawer }) {
  const { state, currentUser, actions, online } = useStore();
  const { listings: apiListings } = useListings();

  const todaysAttendance = useMemo(
    () =>
      state.attendance.find(
        (a) => a.staffId === currentUser.id && a.date === new Date().toISOString().slice(0, 10)
      ),
    [state.attendance, currentUser.id]
  );

  const isOnDuty = todaysAttendance && !todaysAttendance.checkOut;

  const visits = useMemo(
    () => filterByScope(currentUser, 'visits', 'view', state.visits),
    [currentUser, state.visits]
  );

  const todayVisits = useMemo(
    () =>
      visits.filter(
        (v) => v.scheduledFor && v.scheduledFor.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ),
    [visits]
  );

  const upcomingVisits = useMemo(
    () =>
      visits
        .filter(
          (v) =>
            new Date(v.scheduledFor).getTime() > Date.now() - 12 * 3600 * 1000 &&
            v.status !== 'Completed'
        )
        .sort((a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime())
        .slice(0, 3),
    [visits]
  );

  const leads = useMemo(
    () => filterByScope(currentUser, 'leads', 'view', state.leads),
    [currentUser, state.leads]
  );

  const hotFollowUps = useMemo(
    () =>
      leads
        .filter((l) => l.score === 'hot' && l.status !== 'Lost')
        .sort((a, b) => new Date(a.nextFollowUp).getTime() - new Date(b.nextFollowUp).getTime())
        .slice(0, 4),
    [leads]
  );

  const listings = useMemo(
    () => filterByScope(currentUser, 'listings', 'view', apiListings),
    [currentUser, apiListings]
  );

  const featuredListings = useMemo(
    () =>
      listings
        .filter((l) => l.status?.availability === 'available')
        .sort(
          (a, b) =>
            new Date(b.createdAt || b.updatedAt || 0).getTime() -
            new Date(a.createdAt || a.updatedAt || 0).getTime()
        )
        .slice(0, 3),
    [listings]
  );

  const formatListingPriceInline = (listing) => {
    const { pricing } = listing;
    if (listing.listingIntent === 'sell' || listing.listingIntent === 'sell-plot') {
      return pricing?.price ? formatINR(pricing.price) : '—';
    }
    return pricing?.rentMonthly ? `${formatINR(pricing.rentMonthly)}/mo` : '—';
  };

  const managerMessages = useMemo(() => {
    const myThreads = state.threads.filter((t) =>
      t.participants?.includes(currentUser.id)
    );
    const latest = myThreads
      .flatMap((t) =>
        state.messages
          .filter((m) => m.threadId === t.id)
          .map((m) => ({ ...m, thread: t }))
      )
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 3);
    return latest;
  }, [state.threads, state.messages, currentUser.id]);

  // Resolve a location for check-in / check-out, never blocking the action.
  //
  // Geolocation is a secure-context feature: it is simply absent on a plain
  // `http://<lan-ip>` origin (a phone opening the demo over the local
  // network), and it can be denied or time out on any origin. All of those
  // paths fall back to a manual tag so the field workflow still completes —
  // a check-in that silently does nothing is worse than one tagged by hand.
  const captureLocation = (onDone) => {
    const manualTag = (label) => {
      actions.toast('GPS unavailable — saved with a manual tag.', 'info');
      onDone?.({
        lat: 12.97,
        lng: 77.59,
        accuracy: 75,
        label,
      });
    };

    if (!navigator.geolocation) {
      manualTag('Manual tag — GPS not available');
      return;
    }

    actions.toast('Capturing GPS fix…', 'info');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onDone?.({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: Math.round(position.coords.accuracy),
          label: 'Live GPS capture',
        });
      },
      () => manualTag('Manual tag — GPS denied'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const onCheckIn = () => {
    captureLocation((location) => {
      if (!location) return;
      // Online path: existing synchronous behavior.
      if (online !== false && !isOffline()) {
        actions.checkIn(location, currentUser.projectIds?.[0] || null);
        return;
      }
      // Offline path: queue and let the future sync worker replay it.
      queueAttendanceCheckIn({
        staffId: currentUser.id,
        location,
        siteId: currentUser.projectIds?.[0] || null,
      });
      actions.toast('Saved offline. Will sync when you’re back online.', 'info');
    });
  };

  const onCheckOut = () => {
    captureLocation((location) => {
      if (!location) return;
      if (online !== false && !isOffline()) {
        actions.checkOut(location, currentUser.projectIds?.[0] || null);
        return;
      }
      queueAttendanceCheckOut({
        staffId: currentUser.id,
        location,
        siteId: currentUser.projectIds?.[0] || null,
      });
      actions.toast('Saved offline. Will sync when you’re back online.', 'info');
    });
  };

  return (
    <div className="mobile-home">
      {/* Attendance hero */}
      <section className={`mobile-attendance ${isOnDuty ? 'on-duty' : 'off-duty'}`}>
        <header>
          <div>
            <span className="eyebrow">{isOnDuty ? 'You are on duty' : 'Not checked in'}</span>
            <h2>{isOnDuty ? `Since ${formatTime(todaysAttendance.checkIn)}` : 'Tap to start your day'}</h2>
            <small>
              {todaysAttendance?.checkInLocation?.label || 'No location tagged yet'}
            </small>
          </div>
          <Avatar name={currentUser.name} size="lg" tone="light" />
        </header>
        <Can
          resource="attendance"
          action="create"
          fallback={
            <div className="attendance-locked">
              <Badge tone="warning" size="sm">Restricted</Badge>
              <span>Your role can’t log attendance.</span>
            </div>
          }
        >
          <div className="attendance-actions">
            {!isOnDuty ? (
              <Button block variant="primary" icon={LogIn} onClick={onCheckIn}>
                Check in
              </Button>
            ) : (
              <Button block variant="secondary" icon={LogOut} onClick={onCheckOut}>
                Check out
              </Button>
            )}
            <Button block variant="ghost" icon={Navigation} onClick={() => actions.toast('Live GPS pinned.', 'success')}>
              Pin live location
            </Button>
          </div>
        </Can>
      </section>

      {/* Quick actions */}
      <section className="quick-actions quick-actions-mobile">
        <button className="qa" onClick={() => onSwitchTab('visits')}>
          <span className="qa-icon"><Calendar size={20} /></span>
          <strong>{todayVisits.length}</strong>
          <small>Visits today</small>
        </button>
        <button className="qa" onClick={() => onSwitchTab('leads')}>
          <span className="qa-icon"><Target size={20} /></span>
          <strong>{leads.length}</strong>
          <small>My leads</small>
        </button>
        <button className="qa" onClick={() => onSwitchTab('photos')}>
          <span className="qa-icon"><Camera size={20} /></span>
          <strong>{state.photos.filter((p) => p.staffId === currentUser.id).length}</strong>
          <small>My photos</small>
        </button>
        <button className="qa" onClick={() => onSwitchTab('comms')}>
          <span className="qa-icon"><MessageSquareText size={20} /></span>
          <strong>{state.threads.filter((t) => t.participants?.includes(currentUser.id) && t.unread).length}</strong>
          <small>Inbox</small>
        </button>
      </section>

      {/* Today's visits */}
      <SectionTitle
        eyebrow="Field agenda"
        title="Today's visits"
        action={<button className="link" onClick={() => onSwitchTab('visits')}>See all <ChevronRight size={14} /></button>}
      />
      {todayVisits.length === 0 ? (
        <EmptyState icon={Calendar} title="No visits today" description="Enjoy the calm, or schedule one." />
      ) : (
        <ul className="mobile-visit-list">
          {todayVisits.map((visit) => {
            const lead = state.leads.find((l) => l.id === visit.leadId);
            const project = state.projects.find((p) => p.id === visit.projectId);
            return (
              <li key={visit.id}>
                <article className="mobile-visit">
                  <header>
                    <span className="mobile-visit-time">{formatTime(visit.scheduledFor)}</span>
                    <Badge tone={visit.status === 'Completed' ? 'success' : 'info'} dot>
                      {visit.status}
                    </Badge>
                  </header>
                  <strong>{lead?.name}</strong>
                  <small>{project?.name} · {lead?.unitType}</small>
                  <div className="mobile-visit-actions">
                    <a className="btn-icon" href={buildTelLink(lead?.phone)} aria-label="Call"><Phone size={16} /></a>
                    <a className="btn-icon" href={buildWhatsAppLink(lead?.phone, `Hi ${lead?.name?.split(' ')[0]}, this is ${currentUser.name.split(' ')[0]} from ${project?.name}.`)} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageSquareText size={16} /></a>
                    <a className="btn-icon" href={`https://maps.google.com/?q=${project ? '' : ''}${project?.location || ''}`} target="_blank" rel="noreferrer" aria-label="Navigate"><Navigation size={16} /></a>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {/* Hot follow-ups */}
      <SectionTitle
        eyebrow="Pipeline"
        title="Hot follow-ups"
        action={<button className="link" onClick={() => onSwitchTab('leads')}>See all <ChevronRight size={14} /></button>}
      />
      {hotFollowUps.length === 0 ? (
        <EmptyState icon={Flame} title="No hot follow-ups" />
      ) : (
        <ul className="mobile-hot-list">
          {hotFollowUps.map((lead) => (
            <li key={lead.id}>
              <article className="mobile-hot">
                <div>
                  <strong>{lead.name}</strong>
                  <small>{lead.unitType} · {state.projects.find((p) => p.id === lead.projectId)?.name}</small>
                </div>
                <Badge tone="danger" dot size="sm">Hot</Badge>
                <a className="btn btn-primary btn-sm" href={buildTelLink(lead.phone)}>
                  <Phone size={14} /> Call
                </a>
              </article>
            </li>
          ))}
        </ul>
      )}

      {/* Manager messages */}
      <SectionTitle
        eyebrow="Inbox"
        title="Manager messages"
        action={<button className="link" onClick={() => onSwitchTab('comms')}>Open <ChevronRight size={14} /></button>}
      />
      {managerMessages.length === 0 ? (
        <EmptyState icon={MessageSquareText} title="No messages" description="Updates from your manager will appear here." />
      ) : (
        <ul className="mobile-message-list">
          {managerMessages.map((m) => {
            const sender = state.users.find((u) => u.id === m.fromId);
            return (
              <li key={m.id}>
                <article className="mobile-message">
                  <Avatar name={sender?.name} size="sm" tone="light" />
                  <div>
                    <strong>{sender?.name}</strong>
                    <p>{m.text}</p>
                    <small>{timeAgo(m.timestamp)}</small>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {/* Quick capture */}
      <Can resource="photos" action="create">
        <Button block variant="primary" icon={Camera} onClick={() => onSwitchTab('photos')}>
          Capture &amp; upload site photo
        </Button>
      </Can>

      {/* My listings (inventory) */}
      <Can resource="listings" action="view">
        <SectionTitle
          eyebrow="Inventory"
          title="My listings"
          action={
            <button className="link" onClick={() => onSwitchTab('listings')}>
              Open <ChevronRight size={14} />
            </button>
          }
        />
        {featuredListings.length === 0 ? (
          <EmptyState
            icon={Warehouse}
            title="No listings yet"
            description="Tap ‘Add collected property’ on the Inventory tab to capture your first listing."
          />
        ) : (
          <ul className="mobile-listing-mini-list">
            {featuredListings.map((listing) => (
              <li key={listing.id}>
                <button className="mobile-listing-mini" onClick={() => onSwitchTab('listings')}>
                  <div>
                    <strong>{listing.title}</strong>
                    <small>
                      <MapPin size={11} /> {listing.location?.locality || '—'} · {listing.location?.city || '—'}
                    </small>
                  </div>
                  <div className="mobile-listing-mini-right">
                    <span className="mobile-listing-mini-price">{formatListingPriceInline(listing)}</span>
                    <Badge
                      tone={
                        listing.status?.verification === 'verified'
                          ? 'success'
                          : listing.status?.verification === 'pending'
                            ? 'warning'
                            : listing.status?.verification === 'rejected'
                              ? 'danger'
                              : 'neutral'
                      }
                      dot
                      size="sm"
                    >
                      {listing.status?.verification || '—'}
                    </Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Can>
    </div>
  );
}
