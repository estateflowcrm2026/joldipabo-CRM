// Role & Permission Management. The matrix editor and role catalogue.
// Admins can tune non-system roles. System roles (super-admin, admin) are
// read-only and protected.

import React, { useEffect, useMemo, useState } from 'react';
import {
  Lock,
  PencilLine,
  Plus,
  RotateCcw,
  Save,
  Shield,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import {
  ACTIONS,
  RESOURCES,
  ROLE_DEFINITIONS,
  SCOPE_COLORS,
  SCOPE_LABELS,
  SCOPES,
  isSystemRole,
} from '../../data/permissions.js';
import {
  Badge,
  Button,
  Field,
  Modal,
  Panel,
  Select,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

const RESOURCE_LABELS = {
  dashboard: 'Dashboard',
  leads: 'Leads',
  staff: 'Staff',
  roles: 'Roles',
  attendance: 'Attendance',
  visits: 'Site Visits',
  photos: 'Site Photos',
  communications: 'Communication',
  reports: 'Reports',
  projects: 'Projects',
};

const ACTION_LABELS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  assign: 'Assign',
  approve: 'Approve',
  export: 'Export',
  delete: 'Delete',
};

const SCOPE_ORDER = [SCOPES.NONE, SCOPES.OWN, SCOPES.TEAM, SCOPES.PROJECT, SCOPES.ALL];

export function Roles() {
  const { state, currentUser, actions } = useStore();
  const [activeRole, setActiveRole] = useState(currentUser.role);
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(null);

  // Pick up the active role's matrix from any user assigned to it.
  const baseline = useMemo(() => {
    const user = state.users.find((u) => u.role === activeRole);
    return user?.permissionMatrix || {};
  }, [state.users, activeRole]);

  useEffect(() => {
    setDraft(baseline);
  }, [baseline]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [draft, baseline]);

  const onSave = () => {
    const ok = actions.updateRoleMatrix(activeRole, draft);
    if (ok !== false) {
      actions.toast(`${ROLE_DEFINITIONS[activeRole].name} permissions updated.`, 'success');
    }
  };

  const reset = () => setDraft(baseline);

  return (
    <div className="roles-page">
      <Panel
        title="Role Catalogue"
        subtitle="8 roles · 7 actions · 5 scopes"
        icon={Shield}
      >
        <div className="role-grid">
          {Object.values(ROLE_DEFINITIONS).map((role) => {
            const memberCount = state.users.filter((u) => u.role === role.id).length;
            return (
              <button
                key={role.id}
                className={`role-card ${activeRole === role.id ? 'role-card-active' : ''}`}
                onClick={() => setActiveRole(role.id)}
              >
                <header>
                  <span
                    className="role-color"
                    style={{ background: role.accent }}
                    aria-hidden="true"
                  />
                  <strong>{role.name}</strong>
                  {role.isSystem && (
                    <Badge tone="premium" size="sm">
                      <Lock size={10} /> System
                    </Badge>
                  )}
                </header>
                <p>{role.description}</p>
                <footer>
                  <Badge tone="neutral" size="sm">{memberCount} {memberCount === 1 ? 'member' : 'members'}</Badge>
                </footer>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        title={`${ROLE_DEFINITIONS[activeRole]?.name} — Permission Matrix`}
        subtitle={
          isSystemRole(activeRole)
            ? 'System role — read only.'
            : 'Click any cell to change scope. Save to apply across all members of this role.'
        }
        icon={PencilLine}
        action={
          isSystemRole(activeRole) ? (
            <Badge tone="premium" size="md">
              <Lock size={12} /> System role — protected
            </Badge>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={RotateCcw}
                onClick={reset}
                disabled={!dirty}
              >
                Reset
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                onClick={onSave}
                disabled={!dirty}
              >
                Save changes
              </Button>
            </>
          )
        }
      >
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>Resource</th>
                {ACTIONS.map((action) => (
                  <th key={action}>{ACTION_LABELS[action]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.values(RESOURCES).map((resource) => (
                <tr key={resource}>
                  <th scope="row">{RESOURCE_LABELS[resource]}</th>
                  {ACTIONS.map((action) => {
                    const value = draft?.[resource]?.[action] || SCOPES.NONE;
                    const disabled = isSystemRole(activeRole);
                    return (
                      <td key={action}>
                        <ScopeCell
                          value={value}
                          onChange={(next) =>
                            setDraft((prev) => ({
                              ...prev,
                              [resource]: { ...(prev?.[resource] || {}), [action]: next },
                            }))
                          }
                          disabled={disabled}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="matrix-legend">
          {SCOPE_ORDER.map((scope) => (
            <span key={scope} className="matrix-legend-item">
              <span
                className="scope-swatch"
                style={{ background: SCOPE_COLORS[scope] }}
                aria-hidden="true"
              />
              {SCOPE_LABELS[scope]}
            </span>
          ))}
        </div>
      </Panel>

      <Can resource="roles" action="create">
        <Panel
          title="Create custom role"
          subtitle="Spin up a new role with a tailored permission matrix."
          icon={Plus}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setShowCreate(true)}>
              New role
            </Button>
          }
        >
          <p className="muted">
            Custom roles inherit the same permission matrix shape as system roles
            and can be edited anytime. Members assigned to a custom role will
            receive permissions instantly after save.
          </p>
        </Panel>
      </Can>

      {showCreate && <CreateRoleModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function ScopeCell({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="scope-cell">
      <button
        className="scope-pill"
        style={{ background: `${SCOPE_COLORS[value]}22`, color: SCOPE_COLORS[value] }}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-label={`Scope ${SCOPE_LABELS[value]}`}
      >
        <span className="scope-dot" style={{ background: SCOPE_COLORS[value] }} />
        {SCOPE_LABELS[value]}
        {!disabled && <PencilLine size={11} />}
      </button>
      {open && !disabled && (
        <div className="scope-menu">
          {SCOPE_ORDER.map((scope) => (
            <button
              key={scope}
              className={`scope-option ${scope === value ? 'active' : ''}`}
              onClick={() => {
                onChange(scope);
                setOpen(false);
              }}
            >
              <span className="scope-dot" style={{ background: SCOPE_COLORS[scope] }} />
              {SCOPE_LABELS[scope]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateRoleModal({ onClose }) {
  const { actions } = useStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="Create custom role"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (!name) {
                actions.toast('Role name is required.', 'error');
                return;
              }
              actions.toast(`Custom role "${name}" created with default permissions.`, 'success');
              onClose();
            }}
          >
            Create role
          </Button>
        </>
      }
    >
      <Field label="Role name" required>
        <Select defaultValue="">
          <option value="" disabled>
            Choose a starting point
          </option>
          <option value="partner">Partner Coordinator (clone of Channel Partner Manager)</option>
          <option value="audit">Audit & Compliance (read-mostly)</option>
          <option value="custom">Blank custom</option>
        </Select>
      </Field>
      <Field label="Display name" required>
        <input
          className="text-input-plain"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Partner Coordinator"
        />
      </Field>
      <Field label="Description">
        <input
          className="text-input-plain"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this role is for"
        />
      </Field>
    </Modal>
  );
}
