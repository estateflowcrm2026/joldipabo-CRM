// Reports — performance dashboards and exports. All data is scoped to the
// current user's permissions; sections without scope render as restricted.

import React, { useMemo } from 'react';
import {
  BarChart3,
  CalendarClock,
  CheckCircle2,
  DollarSign,
  Download,
  MapPin,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope } from '../../data/permissions.js';
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  StatTile,
} from '../../components/ui.jsx';
import { BarList, Donut, PipelineFunnel } from '../../components/Sparkline.jsx';
import { Can } from '../../components/Can.jsx';

export function Reports() {
  const { state, currentUser } = useStore();
  const leads = useMemo(
    () => filterByScope(currentUser, 'leads', 'view', state.leads),
    [currentUser, state.leads]
  );
  const visits = useMemo(
    () => filterByScope(currentUser, 'visits', 'view', state.visits),
    [currentUser, state.visits]
  );
  const attendance = useMemo(
    () => filterByScope(currentUser, 'attendance', 'view', state.attendance),
    [currentUser, state.attendance]
  );

  const totalLeads = leads.length;
  const hotLeads = leads.filter((l) => l.score === 'hot').length;
  const tokens = leads.filter((l) => l.status === 'Token Paid' || l.status === 'Booking').length;
  const visitConversion = visits.length === 0
    ? 0
    : Math.round((visits.filter((v) => v.status === 'Completed').length / visits.length) * 100);

  const pipeline = useMemo(() => {
    const stages = ['New', 'Follow-up', 'Site Visit Scheduled', 'Site Visit Done', 'Negotiation', 'Token Paid', 'Booking'];
    return stages.map((label) => ({
      label,
      value: leads.filter((l) => l.status === label).length,
      tone: label.includes('Site Visit') ? 'info' : label === 'Booking' || label === 'Token Paid' ? 'success' : 'neutral',
    }));
  }, [leads]);

  const projectPerformance = useMemo(() => {
    return state.projects.map((project) => {
      const projectLeads = leads.filter((l) => l.projectId === project.id);
      const projectVisits = visits.filter((v) => v.projectId === project.id);
      const completedVisits = projectVisits.filter((v) => v.status === 'Completed').length;
      const converted = projectLeads.filter((l) => l.status === 'Token Paid' || l.status === 'Booking').length;
      return {
        label: project.name,
        value: projectLeads.length,
        detail: `${converted} tokens · ${completedVisits}/${projectVisits.length} visits completed`,
      };
    });
  }, [state.projects, leads, visits]);

  const staffPerformance = useMemo(() => {
    return state.users
      .filter((u) => u.role === 'field-executive' || u.role === 'sales-manager' || u.role === 'channel-partner-manager')
      .map((user) => {
        const userLeads = leads.filter((l) => l.ownerId === user.id);
        const tokens = userLeads.filter((l) => l.status === 'Token Paid' || l.status === 'Booking').length;
        const userVisits = visits.filter((v) => v.staffId === user.id);
        return {
          label: user.name,
          value: userLeads.length,
          detail: `${tokens} tokens · ${userVisits.length} visits`,
        };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [state.users, leads, visits]);

  const sourceBreakdown = useMemo(() => {
    const sources = ['Website', 'Referral', 'Channel Partner', 'Walk-in', 'Meta Ads', 'Direct'];
    const total = leads.length || 1;
    return sources
      .map((source) => ({
        label: source,
        value: leads.filter((l) => l.source === source).length,
        color: source === 'Referral' ? '#0F1A1F'
          : source === 'Website' ? '#3F7B6F'
          : source === 'Channel Partner' ? '#C49B4A'
          : source === 'Walk-in' ? '#6F7BB3'
          : source === 'Meta Ads' ? '#9D6FA3'
          : '#5E8C5A',
      }))
      .filter((s) => s.value > 0);
  }, [leads]);

  const attendancePunctuality = useMemo(() => {
    const total = attendance.length || 1;
    const late = attendance.filter((a) => a.status === 'Late').length;
    const onTime = total - late;
    return [
      { label: 'On time', value: onTime, color: '#3F7B6F' },
      { label: 'Late', value: late, color: '#C49B4A' },
    ];
  }, [attendance]);

  return (
    <div className="reports-page">
      <Panel
        title="Performance Reports"
        subtitle="Snapshot across all modules in your scope"
        icon={BarChart3}
        action={
          <Can resource="reports" action="export">
            <Button variant="primary" icon={Download}>
              Export PDF
            </Button>
          </Can>
        }
      >
        <section className="stat-grid">
          <StatTile label="Total leads" value={totalLeads} tone="info" icon={Target} />
          <StatTile label="Hot leads" value={hotLeads} tone="danger" icon={Sparkles} />
          <StatTile label="Tokens & bookings" value={tokens} tone="success" icon={DollarSign} />
          <StatTile label="Visit conversion" value={`${visitConversion}%`} tone="premium" icon={CalendarClock} />
        </section>
      </Panel>

      <section className="grid-2">
        <Panel title="Lead Pipeline Funnel" subtitle="Distribution of lead status" icon={Target}>
          {pipeline.every((s) => s.value === 0) ? (
            <EmptyState title="No pipeline data" description="Your role does not have access to any leads." />
          ) : (
            <PipelineFunnel stages={pipeline} />
          )}
        </Panel>

        <Panel title="Lead Sources" subtitle="Where your leads originate" icon={Sparkles}>
          {sourceBreakdown.length === 0 ? (
            <EmptyState title="No source data" />
          ) : (
            <div className="donut-row">
              <Donut segments={sourceBreakdown} size={160} thickness={22} />
              <ul className="donut-legend">
                {sourceBreakdown.map((seg) => (
                  <li key={seg.label}>
                    <span className="scope-dot" style={{ background: seg.color }} />
                    <strong>{seg.label}</strong>
                    <small>{seg.value} leads</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </section>

      <section className="grid-2">
        <Panel title="Project Performance" subtitle="Leads and conversions by project" icon={MapPin}>
          {projectPerformance.every((p) => p.value === 0) ? (
            <EmptyState title="No project data" />
          ) : (
            <ul className="report-list">
              {projectPerformance.map((project) => (
                <li key={project.label}>
                  <div>
                    <strong>{project.label}</strong>
                    <small>{project.detail}</small>
                  </div>
                  <Badge tone="info" size="sm">{project.value} leads</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Top Performers" subtitle="Lead generation across staff" icon={Users}>
          {staffPerformance.length === 0 ? (
            <EmptyState title="No performer data" />
          ) : (
            <BarList items={staffPerformance.map((p) => ({ label: p.label, value: p.value }))} />
          )}
        </Panel>
      </section>

      <Panel title="Attendance Punctuality" subtitle="On-time vs late check-ins" icon={CheckCircle2}>
        {attendance.length === 0 ? (
          <EmptyState title="No attendance data in your scope" />
        ) : (
          <div className="donut-row">
            <Donut segments={attendancePunctuality} size={140} thickness={20} />
            <ul className="donut-legend">
              {attendancePunctuality.map((seg) => (
                <li key={seg.label}>
                  <span className="scope-dot" style={{ background: seg.color }} />
                  <strong>{seg.label}</strong>
                  <small>{Math.round((seg.value / attendance.length) * 100)}%</small>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  );
}
