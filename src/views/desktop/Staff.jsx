// Staff Management. Directory of users with role, attendance state, and
// scoped edits.

import React, { useMemo, useState } from 'react';
import {
  KeyRound,
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
import { isApiRepositoryActive } from '../../services/index.js';
import { staffApi } from '../../services/staffApi.js';
import { useAssignableStaff } from '../../services/staffDirectory.js';

function apiMessage(error) {
  return error?.data?.error?.message || error?.message || 'The request could not be completed.';
}

export function Staff() {
  const { state, actions, currentUser, roleDefinitions } = useStore();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);

  // Live mode reads the backend directory; demo mode keeps the seed roster.
  const live = isApiRepositoryActive();
  const directory = useAssignableStaff();
  const liveStaff = useMemo(
    () => (live && directory.source === 'live' ? directory.staff : null),
    [live, directory],
  );

  const users = useMemo(
    () => (liveStaff ?? filterByScope(currentUser, 'staff', 'view', state.users)),
    [liveStaff, currentUser, state.users]
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

  const refreshDirectory = () => {
    directory.retry();
  };

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

        {live && directory.loading ? (
          <p className="muted">Loading staff directory…</p>
        ) : live && directory.source === 'unavailable' ? (
          <EmptyState
            icon={UsersIcon}
            title="Staff directory unavailable"
            description={directory.reason || 'Could not load the staff directory.'}
          />
        ) : filtered.length === 0 ? (
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
                    <li><span>Team</span><strong>{team?.name || user.teamName || '—'}</strong></li>
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
                    {user.phone ? (
                      <a className="btn btn-secondary btn-sm" href={`tel:${String(user.phone).replace(/\s/g, '')}`}>
                        <Phone size={14} /> Call
                      </a>
                    ) : null}
                    <Can resource="staff" action="edit" record={user}>
                      {live ? (
                        <Button variant="ghost" size="sm" icon={KeyRound} onClick={() => setResetting(user)}>
                          Reset password
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setEditing(user)}>
                          Edit
                        </Button>
                      )}
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
      {creating && (
        live
          ? <CreateStaffLiveModal onClose={() => setCreating(false)} onCreated={refreshDirectory} />
          : <CreateStaffModal onClose={() => setCreating(false)} />
      )}
      {resetting && (
        <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
      )}
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

// Live-mode creation: POST /users with an admin-typed initial password.
// The password is sent once, hashed server-side, and never shown again —
// the success state is a confirmation naming the account, not the secret.
function CreateStaffLiveModal({ onClose, onCreated }) {
  const { actions, roleDefinitions, state } = useStore();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [designation, setDesignation] = useState('');
  const [role, setRole] = useState('field-executive');
  const [teamId, setTeamId] = useState('');
  const [initialPassword, setInitialPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!name.trim() || !email.trim()) {
      setError('Name and email are required.');
      return;
    }
    if (!initialPassword) {
      setError('Set an initial password to share with the new staff member.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await staffApi.create({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        roleId: role,
        teamId: teamId || undefined,
        designation: designation.trim() || undefined,
        initialPassword,
      });
      // The password field is cleared before anything else happens, so the
      // secret does not linger in component state after the request.
      setInitialPassword('');
      actions.toast(`Staff account created for ${created.email}. Share the password with them directly.`, 'success');
      onCreated?.();
      onClose();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add new staff"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create staff'}
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
        <Field label="Team" span={2} hint="Optional. Must be a team in your organisation.">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">No team</option>
            {(state.teams || []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Initial password"
          span={2}
          required
          hint="Password will not be shown again. Share it with the staff member directly."
        >
          <TextInput
            type="password"
            value={initialPassword}
            onChange={(e) => setInitialPassword(e.target.value)}
            placeholder="At least 10 characters"
            autoComplete="new-password"
          />
        </Field>
        {error && (
          <p className="form-error" span={2} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// Live-mode reset: POST /users/:id/reset-password. Confirmation only — the
// new password is never echoed back, so the admin must share out of band
// what they just typed.
function ResetPasswordModal({ user, onClose }) {
  const { actions } = useStore();
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!newPassword) {
      setError('Type the new password to set.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await staffApi.resetPassword(user.id, { newPassword });
      setNewPassword('');
      actions.toast(`Password reset for ${user.name}. Their other sessions were signed out.`, 'success');
      onClose();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset password — ${user.name}`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? 'Resetting…' : 'Reset password'}
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field
          label="New password"
          span={2}
          required
          hint="Password will not be shown again. This signs the staff member out everywhere."
        >
          <TextInput
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 10 characters"
            autoComplete="new-password"
          />
        </Field>
        {error && (
          <p className="form-error" span={2} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
