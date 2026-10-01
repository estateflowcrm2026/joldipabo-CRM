// Attendance module. Shows check-in/out records with geo coordinates,
// hours worked, and approval queue.

import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  Filter,
  MapPin,
  Search,
  ShieldCheck,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope } from '../../data/permissions.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Panel,
  Select,
  StatTile,
  TextInput,
  formatDate,
  formatTime,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

export function Attendance() {
  const { state, currentUser, actions } = useStore();
  const [scope, setScope] = useState('today'); // today | week | all
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');

  const records = useMemo(
    () => filterByScope(currentUser, 'attendance', 'view', state.attendance),
    [currentUser, state.attendance]
  );

  const filtered = useMemo(() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const weekAgo = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10);
    })();

    return records
      .filter((record) => {
        if (scope === 'today') return record.date === todayIso;
        if (scope === 'week') return record.date >= weekAgo;
        return true;
      })
      .filter((record) => statusFilter === 'all' || record.status === statusFilter)
      .filter((record) => {
        if (!query) return true;
        const user = state.users.find((u) => u.id === record.staffId);
        const haystack = [user?.name, user?.designation, record.checkInLocation?.label, record.checkOutLocation?.label]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(query.toLowerCase());
      })
      .sort((a, b) => new Date(b.checkIn).getTime() - new Date(a.checkIn).getTime());
  }, [records, scope, statusFilter, query, state.users]);

  const todayIso = new Date().toISOString().slice(0, 10);
  const todayRecords = records.filter((r) => r.date === todayIso);
  const present = todayRecords.filter((r) => r.status === 'Checked In' || r.status === 'On Field').length;
  const late = todayRecords.filter((r) => r.status === 'Late').length;
  const flagged = todayRecords.filter((r) => !r.checkInLocation || (r.checkInLocation.accuracy || 0) > 50).length;
  const hours = todayRecords.reduce((sum, r) => sum + (r.hoursWorked || 0), 0);

  return (
    <div className="attendance-page">
      <section className="stat-grid">
        <StatTile label="Present today" value={present} tone="success" icon={CheckCircle2} />
        <StatTile label="Late check-ins" value={late} tone="warning" icon={AlertTriangle} />
        <StatTile label="Geo flagged" value={flagged} tone="danger" icon={MapPin} />
        <StatTile label="Hours logged" value={hours.toFixed(1)} tone="info" icon={Clock3} />
      </section>

      <Panel
        title="Attendance Records"
        subtitle={`${filtered.length} records in your scope`}
        icon={Clock3}
        action={
          <Can resource="attendance" action="export">
            <Button variant="ghost" size="sm">Export CSV</Button>
          </Can>
        }
      >
        <div className="filter-bar">
          <TextInput
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, designation, location"
          />
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="today">Today</option>
            <option value="week">Last 7 days</option>
            <option value="all">All time</option>
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All status</option>
            <option value="Checked In">Checked In</option>
            <option value="On Field">On Field</option>
            <option value="Late">Late</option>
            <option value="Checked Out">Checked Out</option>
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Clock3}
            title={records.length === 0 ? 'No attendance in your scope' : 'No records match these filters'}
            description={
              records.length === 0
                ? 'Your role cannot view attendance yet. Ask your admin to update permissions.'
                : 'Try widening the date range or clearing filters.'
            }
          />
        ) : (
          <div className="attendance-table" role="table">
            <div className="attendance-row attendance-row-head" role="row">
              <span>Staff</span>
              <span>Date</span>
              <span>Check-in</span>
              <span>Check-out</span>
              <span>Hours</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            {filtered.map((record) => {
              const user = state.users.find((u) => u.id === record.staffId);
              const statusTone = record.status === 'Checked Out' ? 'success' : record.status === 'Late' ? 'warning' : 'info';
              const flagged = record.checkInLocation && (record.checkInLocation.accuracy || 0) > 50;
              return (
                <div className="attendance-row" role="row" key={record.id}>
                  <span>
                    {user ? (
                      <span className="inline-user">
                        <Avatar name={user.name} size="sm" />
                        <span>
                          <strong>{user.name}</strong>
                          <small>{user.designation}</small>
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span>{formatDate(record.date)}</span>
                  <span>
                    {record.checkIn ? (
                      <span className="time-cell">
                        <strong>{formatTime(record.checkIn)}</strong>
                        <small>{record.checkInLocation?.label || '—'}</small>
                      </span>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span>
                    {record.checkOut ? (
                      <span className="time-cell">
                        <strong>{formatTime(record.checkOut)}</strong>
                        <small>{record.checkOutLocation?.label || '—'}</small>
                      </span>
                    ) : (
                      <Badge tone="info" dot>On duty</Badge>
                    )}
                  </span>
                  <span>
                    {record.hoursWorked != null ? (
                      <strong>{record.hoursWorked.toFixed(1)} h</strong>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span>
                    <Badge tone={statusTone} dot>{record.status}</Badge>
                    {flagged && (
                      <Badge tone="danger" size="sm" >
                        Geo flagged
                      </Badge>
                    )}
                  </span>
                  <span className="attendance-actions">
                    <Can resource="attendance" action="approve" record={record}>
                      {record.status !== 'Checked Out' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => actions.approveAttendance(record.id, 'Approved')}
                        >
                          Approve
                        </Button>
                      )}
                      {record.status === 'Late' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => actions.approveAttendance(record.id, 'Checked In')}
                        >
                          Clear
                        </Button>
                      )}
                    </Can>
                    <Can resource="attendance" action="view" record={record}>
                      <a className="btn btn-icon" href={`https://maps.google.com/?q=${record.checkInLocation?.lat},${record.checkInLocation?.lng}`} target="_blank" rel="noreferrer" aria-label="View on map">
                        <MapPin size={14} />
                      </a>
                    </Can>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
