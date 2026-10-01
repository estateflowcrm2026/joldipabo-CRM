// Desktop Dashboard — the operations command center a real-estate admin sees
// when they log in. Pulls scoped data through the store, so the same view
// looks different per role.

import React, { useMemo } from 'react';
import {
  Activity,
  ArrowUpRight,
  Briefcase,
  CalendarClock,
  ChevronRight,
  Flame,
  MapPin,
  Phone,
  Target,
  Wallet,
  Zap,
  Building2,
  Users,
  ShieldCheck,
  Warehouse,
  Tag,
  Sparkles,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import {
  Panel,
  Avatar,
  Badge,
  Button,
  StatTile,
  timeAgo,
  buildTelLink,
  EmptyState,
  formatINR,
} from '../../components/ui.jsx';
import { Sparkline, BarList, PipelineFunnel } from '../../components/Sparkline.jsx';
import { Can } from '../../components/Can.jsx';
import { filterByScope } from '../../data/permissions.js';
import { useListings } from '../../services/listingsData.jsx';

export function Dashboard() {
  const { state, currentUser, roleDefinitions } = useStore();
  const { listings: apiListings } = useListings();

  // Each dataset is permission-scoped through the same helper.
  // If a role lacks the right scope, this returns [] and the section fades to empty.
  const leads = useMemo(
    () => filterByScope(currentUser, 'leads', 'view', state.leads),
    [currentUser, state.leads]
  );
  const visits = useMemo(
    () => filterByScope(currentUser, 'visits', 'view', state.visits),
    [currentUser, state.visits]
  );
  const attendanceToday = useMemo(
    () => filterByScope(currentUser, 'attendance', 'view', state.attendance)
      .filter((a) => a.date === new Date().toISOString().slice(0, 10)),
    [currentUser, state.attendance]
  );
  const listings = useMemo(
    () => filterByScope(currentUser, 'listings', 'view', apiListings),
    [currentUser, apiListings]
  );

  const hotLeads = leads.filter((l) => l.score === 'hot');
  const todaysVisits = visits.filter((v) =>
    v.scheduledFor && new Date(v.scheduledFor).toDateString() === new Date().toDateString()
  );
  const completedVisitsToday = visits.filter(
    (v) => v.completedAt && new Date(v.completedAt).toDateString() === new Date().toDateString()
  );
  const todayCheckIns = attendanceToday.filter((a) => a.status === 'Checked In' || a.status === 'On Field');
  const tokensThisWeek = leads.filter((l) => l.status === 'Token Paid' || l.status === 'Booking').length;

  const totalValue = useMemo(
    () => leads.reduce((sum, l) => sum + (l.budgetMax || 0), 0),
    [leads]
  );

  const pipelineStages = useMemo(() => {
    const groups = ['New', 'Follow-up', 'Site Visit Scheduled', 'Site Visit Done', 'Negotiation', 'Token Paid', 'Booking'];
    return groups.map((label) => ({
      label,
      value: leads.filter((l) => l.status === label).length,
      tone: label.includes('Site Visit') ? 'info' : label === 'Booking' || label === 'Token Paid' ? 'success' : 'neutral',
    }));
  }, [leads]);

  const sourceBreakdown = useMemo(() => {
    const sources = ['Website', 'Referral', 'Channel Partner', 'Walk-in', 'Meta Ads', 'Direct'];
    return sources.map((source) => ({
      label: source,
      value: leads.filter((l) => l.source === source).length,
    }));
  }, [leads]);

  const weeklyTrend = useMemo(() => {
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return d.toISOString().slice(0, 10);
    });
    return buckets.map((iso) => {
      const visitsOnDay = visits.filter(
        (v) => v.scheduledFor && v.scheduledFor.slice(0, 10) === iso
      ).length;
      return visitsOnDay;
    });
  }, [visits]);

  const recentActivity = useMemo(() => {
    return state.activity.slice(0, 6);
  }, [state.activity]);

  // Inventory pulse — scoped to the same view scope as Leads/Visits above.
  const inventoryStats = useMemo(() => {
    const availableRent = listings.filter(
      (l) => l.serviceCategory === 'rent' && l.status?.availability === 'available'
    ).length;
    const availablePg = listings.filter(
      (l) => l.serviceCategory === 'pg' && l.status?.availability === 'available'
    ).length;
    const pendingVerification = listings.filter((l) => l.status?.verification === 'pending').length;
    const totalActive = listings.filter((l) => l.status?.availability === 'available').length;
    return { availableRent, availablePg, pendingVerification, totalActive };
  }, [listings]);

  const recentlyListed = useMemo(() => {
    return listings
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt || b.updatedAt || 0).getTime() -
          new Date(a.createdAt || a.updatedAt || 0).getTime()
      )
      .slice(0, 3);
  }, [listings]);

  const verificationPipeline = useMemo(() => {
    const buckets = ['verified', 'pending', 'unverified', 'rejected'];
    const tones = {
      verified: 'success',
      pending: 'warning',
      unverified: 'neutral',
      rejected: 'danger',
    };
    return buckets
      .map((bucket) => ({
        label: bucket,
        value: listings.filter((l) => l.status?.verification === bucket).length,
        tone: tones[bucket],
      }))
      .filter((b) => b.value > 0);
  }, [listings]);

  const formatListingPrice = (listing) => {
    const { pricing } = listing;
    if (listing.listingIntent === 'sell' || listing.listingIntent === 'sell-plot') {
      return pricing?.price ? formatINR(pricing.price) : '—';
    }
    return pricing?.rentMonthly ? `${formatINR(pricing.rentMonthly)}/mo` : '—';
  };

  return (
    <div className="dashboard dashboard-desktop">
      {/* Stat row */}
      <section className="stat-grid">
        <StatTile
          label="Active Pipeline"
          value={leads.length}
          delta={`${hotLeads.length} hot`}
          tone="success"
          icon={Target}
        />
        <StatTile
          label="Site Visits Today"
          value={todaysVisits.length}
          delta={`${completedVisitsToday.length} completed`}
          tone="info"
          icon={CalendarClock}
        />
        <StatTile
          label="On Field Now"
          value={todayCheckIns.length}
          delta={`${attendanceToday.length} records today`}
          tone="warning"
          icon={MapPin}
        />
        <StatTile
          label="Pipeline Value"
          value={`₹ ${(totalValue / 10000000).toFixed(1)} Cr`}
          delta={`${tokensThisWeek} tokens / bookings`}
          tone="premium"
          icon={Wallet}
        />
      </section>

      {/* Pipeline + lead source */}
      <section className="grid-2">
        <Panel
          title="Lead Pipeline"
          subtitle="Funnel by lead status (scoped to your access)"
          icon={Activity}
          action={<Badge tone="neutral" size="sm">Live</Badge>}
        >
          {leads.length === 0 ? (
            <EmptyState
              icon={Target}
              title="No pipeline data"
              description="You don't have access to any leads yet, or the pipeline is empty."
            />
          ) : (
            <PipelineFunnel stages={pipelineStages} />
          )}
          <div className="pipeline-foot">
            <Sparkline values={weeklyTrend} width={180} height={36} />
            <span>7-day scheduled-visits trend</span>
          </div>
        </Panel>

        <Panel
          title="Lead Sources"
          subtitle="Where your hot leads come from"
          icon={Flame}
        >
          {leads.length === 0 ? (
            <EmptyState title="No sources to compare" />
          ) : (
            <BarList items={sourceBreakdown.filter((s) => s.value > 0)} />
          )}
        </Panel>
      </section>

      {/* Hot leads + Today's visits */}
      <section className="grid-2">
        <Panel
          title="Hot Leads"
          subtitle="High-intent prospects awaiting action"
          icon={Flame}
          action={
            <Can resource="leads" action="view">
              <a className="btn btn-ghost btn-sm" href="#leads">
                View all <ChevronRight size={14} />
              </a>
            </Can>
          }
        >
          {hotLeads.length === 0 ? (
            <EmptyState
              icon={Flame}
              title="No hot leads in your scope"
              description="Once managers flag leads as hot, they'll surface here."
            />
          ) : (
            <ul className="dashboard-list">
              {hotLeads.slice(0, 5).map((lead) => (
                <li key={lead.id}>
                  <Avatar name={lead.name} size="sm" />
                  <div>
                    <strong>{lead.name}</strong>
                    <span>{lead.source} · {lead.unitType}</span>
                  </div>
                  <Badge tone={lead.status === 'Booking' ? 'success' : 'info'} dot>
                    {lead.status}
                  </Badge>
                  <a className="btn btn-icon" href={buildTelLink(lead.phone)} aria-label={`Call ${lead.name}`}>
                    <Phone size={16} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Today's Site Visits"
          subtitle="Scheduled and completed visits"
          icon={CalendarClock}
        >
          {todaysVisits.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No visits scheduled for today"
              description="Once staff book visits, they'll appear here with full context."
            />
          ) : (
            <ul className="dashboard-list dashboard-visit-list">
              {todaysVisits.slice(0, 5).map((visit) => {
                const lead = state.leads.find((l) => l.id === visit.leadId);
                const project = state.projects.find((p) => p.id === visit.projectId);
                return (
                  <li key={visit.id}>
                    <span className="dashboard-list-time">
                      {new Date(visit.scheduledFor).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <div>
                      <strong>{lead?.name || 'Unknown lead'}</strong>
                      <span>{project?.name}</span>
                    </div>
                    <Badge tone={visit.status === 'Completed' ? 'success' : 'info'} dot>
                      {visit.status}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </section>

      {/* Project performance + activity feed */}
      <section className="grid-2">
        <Panel
          title="Project Performance"
          subtitle="Inventory absorption and visit conversion"
          icon={Building2}
        >
          <ul className="project-tiles">
            {state.projects.map((project) => {
              const absorbed = project.totalUnits - project.availableUnits;
              const percent = Math.round((absorbed / project.totalUnits) * 100);
              return (
                <li key={project.id}>
                  <div className="project-tile">
                    <img src={project.image} alt="" />
                    <div className="project-tile-body">
                      <strong>{project.name}</strong>
                      <span>{project.location}</span>
                      <span className="project-tile-meta">
                        {absorbed}/{project.totalUnits} units sold · {percent}%
                      </span>
                    </div>
                  </div>
                  <div className="project-tile-bar">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel
          title="Recent Activity"
          subtitle="Audit trail across the organisation"
          icon={Zap}
          action={
            <Can resource="reports" action="view">
              <a className="btn btn-ghost btn-sm" href="#reports">
                Open reports <ArrowUpRight size={14} />
              </a>
            </Can>
          }
        >
          <ul className="activity-feed">
            {recentActivity.length === 0 ? (
              <EmptyState title="No activity yet" icon={Activity} />
            ) : (
              recentActivity.map((entry) => {
                const user = state.users.find((u) => u.id === entry.userId);
                return (
                  <li key={entry.id}>
                    <Avatar name={user?.name} size="sm" tone="light" />
                    <div>
                      <span>
                        <strong>{user?.name || 'Someone'}</strong> {entry.action.replaceAll('-', ' ')}
                      </span>
                      <small>{timeAgo(entry.timestamp)} · {entry.entity}</small>
                    </div>
                    <Badge tone="neutral" size="sm">{entry.action.replaceAll('-', ' ')}</Badge>
                  </li>
                );
              })
            )}
          </ul>
        </Panel>
      </section>

      {/* Quick action ribbon */}
      <section className="quick-actions">
        <Can resource="leads" action="create">
          <Button variant="primary" icon={Target}>
            New lead
          </Button>
        </Can>
        <Can resource="listings" action="create">
          <Button variant="primary" icon={Warehouse}>
            New listing
          </Button>
        </Can>
        <Can resource="leads" action="assign">
          <Button variant="secondary" icon={Users}>
            Assign leads
          </Button>
        </Can>
        <Can resource="visits" action="create">
          <Button variant="secondary" icon={CalendarClock}>
            Schedule visit
          </Button>
        </Can>
        <Can resource="reports" action="export">
          <Button variant="ghost" icon={Briefcase}>
            Export daily report
          </Button>
        </Can>
      </section>

      {/* Inventory pulse — visible to anyone who can view any listing. */}
      <Can resource="listings" action="view">
        <section className="grid-2">
          <Panel
            title="Inventory pulse"
            subtitle="Available units across the categories you oversee"
            icon={Warehouse}
            action={
              <Can resource="listings" action="view">
                <a className="btn btn-ghost btn-sm" href="#listings">
                  Open inventory <ChevronRight size={14} />
                </a>
              </Can>
            }
          >
            {listings.length === 0 ? (
              <EmptyState
                icon={Warehouse}
                title="No listings in scope"
                description="Listings assigned to or created by you will surface here."
              />
            ) : (
              <>
                <div className="stat-grid stat-grid-mini">
                  <StatTile
                    label="Active rent"
                    value={inventoryStats.availableRent}
                    helper="Available rentals"
                    tone="info"
                    icon={Building2}
                  />
                  <StatTile
                    label="PG available"
                    value={inventoryStats.availablePg}
                    helper="Beds / rooms ready"
                    tone="success"
                    icon={Tag}
                  />
                  <StatTile
                    label="Awaiting verification"
                    value={inventoryStats.pendingVerification}
                    helper="Action required"
                    tone="warning"
                    icon={ShieldCheck}
                  />
                </div>
                {recentlyListed.length > 0 && (
                  <ul className="dashboard-list">
                    {recentlyListed.map((listing) => (
                      <li key={listing.id}>
                        <Warehouse size={14} />
                        <div>
                          <strong>{listing.title}</strong>
                          <span>{listing.location?.locality || '—'} · {listing.propertyType}</span>
                        </div>
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
                        <span className="dashboard-list-price">{formatListingPrice(listing)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Panel>

          <Panel
            title="Listing verification pipeline"
            subtitle="How inventory is faring against the audit checklist"
            icon={ShieldCheck}
          >
            {verificationPipeline.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No listings yet"
                description="Once staff add listings, verification counts will appear here."
              />
            ) : (
              <BarList items={verificationPipeline} />
            )}
          </Panel>
        </section>
      </Can>
    </div>
  );
}
