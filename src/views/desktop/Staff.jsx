// Staff Management. Directory of users with role, attendance state, and
// scoped edits.

import React, { useMemo, useState } from 'react';
import {
  Mail,
  Phone,
  Plus,
  Search,
  Users as UsersIcon,
  ShieldCheck,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope } from '../../data/permissions.js';
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
  formatDate,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

export function Staff() {
  const { state, currentUser, roleDefinitions } = useStore();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const users = useMemo(
    () => filterByScope(currentUser, 'staff', 'view', state.users),
    [currentUser, state.users]
  );

  const filtered = useMemo(() => {
    const lower = query.toLowerCase();
    return users.filter((user) => {
      if (roleFilter !== 'all' && user.role !== roleFilter) return false;
      if (teamFilter !== 'all' && user.teamId !== teamFilter) return false;
      if (!lower) return true;
      return [user.name, user.email, user.phone, user.designation]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(lower));
    });
  }, [users, query, roleFilter, teamFilter]);

  return (
    <div className="staff-page">
      <Panel
        title="Staff Directory"
        subtitle={`${filtered.length} of ${users.length} members in your scope`}
        icon={UsersIcon}
        action={
          <Can resource="staff" action="create">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Add staff
            </Button>
          </Can>
        }
      >
        <div className="filter-bar">
          <TextInput
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, designation"
          />
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="all">All roles</option>
            {Object.values(roleDefinitions).map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
          <Select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
            <option value="all">All teams</option>
            {state.teams ? (
              state.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))
            ) : (
              <option value="team-east">East Zone Sales</option>
            )}
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={UsersIcon}
            title={users.length === 0 ? 'No staff in your scope' : 'No staff match these filters'}
            description={
              users.length === 0
                ? 'Your role cannot view any staff members yet. Ask your admin to update permissions.'
                : 'Try clearing filters.'
            }
          />
        ) : (
          <div className="staff-grid">
            {filtered.map((user) => {
              const team = (state.teams || []).find((t) => t.id === user.teamId);
              const projects = state.projects.filter((p) => user.projectIds?.includes(p.id));
              const isActive = user.status === 'Active';
              return (
                <article className="staff-card" key={user.id}>
                  <header>
                    <Avatar name={user.name} size="lg" />
                    <div>
                      <strong>{user.name}</strong>
                      <small>{user.designation}</small>
                      <span className="staff-card-meta">
                        <Badge tone={isActive ? 'success' : 'neutral'} dot size="sm">
                          {user.status}
                        </Badge>
                        <Badge tone="info" size="sm">
                          <ShieldCheck size={12} /> {roleDefinitions[user.role]?.name}
                        </Badge>
                      </span>
                    </div>
                  </header>
                  <ul className="kv-list">
                    <li><span>Email</span><strong>{user.email}</strong></li>
                    <li><span>Phone</span><strong>{user.phone}</strong></li>
                    <li><span>Team</span><strong>{team?.name || '—'}</strong></li>
                    <li><span>Joined</span><strong>{formatDate(user.joinedAt)}</strong></li>
                    <li>
                      <span>Projects</span>
                      <strong>{projects.length === 0 ? 'None' : projects.map((p) => p.code).join(', ')}</strong>
                    </li>
                  </ul>
                  <footer>
                    <a className="btn btn-secondary btn-sm" href={`mailto:${user.email}`}>
                      <Mail size={14} /> Mail
                    </a>
                    <a className="btn btn-secondary btn-sm" href={`tel:${user.phone.replace(/\s/g, '')}`}>
                      <Phone size={14} /> Call
                    </a>
                    <Can resource="staff" action="edit" record={user}>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(user)}>
                        Edit
                      </Button>
                    </Can>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      {editing && (
        <EditStaffModal user={editing} onClose={() => setEditing(null)} />
      )}
      {creating && <CreateStaffModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function EditStaffModal({ user, onClose }) {
  const { actions, state, roleDefinitions } = useStore();
  const [status, setStatus] = useState(user.status);
  const [designation, setDesignation] = useState(user.designation);
  const [role, setRole] = useState(user.role);
  const [projectIds, setProjectIds] = useState(user.projectIds || []);

  const submit = () => {
    actions.updateUser(user.id, { status, designation, role, projectIds });
    actions.toast(`${user.name} updated.`, 'success');
    onClose();
  };

  const toggleProject = (id) => {
    setProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.name}`}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>Active</option>
            <option>Inactive</option>
            <option>On Leave</option>
          </Select>
        </Field>
        <Field label="Designation">
          <TextInput value={designation} onChange={(e) => setDesignation(e.target.value)} />
        </Field>
        <Field label="Role" span={2}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.values(roleDefinitions).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project access" span={2} hint="Toggle the projects this staff member can operate in.">
          <div className="chip-group">
            {state.projects.map((project) => (
              <button
                key={project.id}
                className={`chip ${projectIds.includes(project.id) ? 'chip-active' : ''}`}
                type="button"
                onClick={() => toggleProject(project.id)}
              >
                {project.name}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function CreateStaffModal({ onClose }) {
  const { actions, roleDefinitions } = useStore();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [designation, setDesignation] = useState('');
  const [role, setRole] = useState('field-executive');

  const submit = () => {
    if (!name || !email) {
      actions.toast('Name and email are required.', 'error');
      return;
    }
    // For the demo, we surface the action via toast since we don't want to
    // duplicate a real mutator. In production this would dispatch a CREATE_USER action.
    actions.toast(`Invite sent to ${email}. They will receive a welcome email.`, 'success');
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add new staff"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Send invite
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Full name" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Staff full name" />
        </Field>
        <Field label="Email" required>
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </Field>
        <Field label="Phone">
          <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98XXX XXXXX" />
        </Field>
        <Field label="Designation">
          <TextInput value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="e.g. Field Executive" />
        </Field>
        <Field label="Role" span={2}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.values(roleDefinitions).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
