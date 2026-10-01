// Desktop application shell. Provides the sidebar, top bar, role switcher,
// and the page container that every desktop module renders into.

import React, { useState } from 'react';
import {
  Bell,
  LayoutDashboard,
  Users,
  ShieldCheck,
  Clock3,
  Compass,
  Camera,
  MessageSquareText,
  BarChart3,
  Search,
  Menu,
  X,
  Sparkles,
  ChevronDown,
  Smartphone,
  Warehouse,
  RotateCcw,
} from 'lucide-react';
import { useStore } from '../state/store.jsx';
import { NAV_RESOURCES, hasAnyAccess } from '../data/permissions.js';
import { Avatar } from '../components/ui.jsx';
import { isDemoRoleSwitcherEnabled, isDemoMode } from '../services/demoFlags.js';
import { confirmResetDemo } from '../services/demoReset.js';

const ICONS = {
  dashboard: LayoutDashboard,
  leads: Compass,
  listings: Warehouse,
  staff: Users,
  roles: ShieldCheck,
  attendance: Clock3,
  visits: Compass,
  photos: Camera,
  comms: MessageSquareText,
  reports: BarChart3,
};

export function DesktopShell({ active, onNavigate, children }) {
  const { currentUser, roleDefinitions, state, setViewMode } = useStore();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const visibleNav = NAV_RESOURCES.filter((item) => hasAnyAccess(currentUser, item.resource));

  return (
    <div className="app-shell app-shell-desktop">
      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <img src="/joldipabo-logo.jpg" alt="Joldipabo logo" />
          </div>
          <div>
            <strong>Joldipabo</strong>
            <span>Beyond four walls</span>
          </div>
          <button
            className="btn-icon close-nav"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="nav-list">
          {visibleNav.map((item) => {
            const Icon = ICONS[item.iconKey] || LayoutDashboard;
            const isActive = active === item.resource;
            return (
              <button
                key={item.resource}
                className={isActive ? 'active' : ''}
                onClick={() => {
                  onNavigate(item.resource);
                  setMobileNavOpen(false);
                }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {isActive && <span className="nav-active-dot" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-card">
          <Sparkles size={16} />
          <strong>Today’s priority</strong>
          <p>{state.leads.filter((l) => l.score === 'hot').length} hot leads awaiting a site visit today.</p>
        </div>

        <div className="sidebar-foot">
          <Avatar name={currentUser.name} size="sm" tone="light" />
          <div>
            <strong>{currentUser.name}</strong>
            <span>{roleDefinitions[currentUser.role]?.name}</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="btn-icon mobile-menu"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <div>
              <p className="eyebrow">Operations Command Center</p>
              <h1>{prettyTitle(active)}</h1>
            </div>
          </div>

          <div className="topbar-actions">
            {/* Visible only when a demo-only affordance is actually
                enabled, so a production user is never told a demo
                feature is one click away. */}
            {isDemoMode() && (
              <span className="demo-mode-badge" title="Demo build — seeded data, demo-only controls enabled.">
                Demo mode
              </span>
            )}
            <div className="search-box">
              <Search size={16} />
              <input placeholder="Search leads, projects, staff…" />
              <kbd>⌘ K</kbd>
            </div>
            <button className="btn-icon" aria-label="Notifications">
              <Bell size={18} />
              <span className="dot dot-red" />
            </button>
            <RoleSwitcher
              open={userMenuOpen}
              onToggle={() => setUserMenuOpen((v) => !v)}
              onClose={() => setUserMenuOpen(false)}
            />
            {/* Demo-only: restores the seeded data after someone has
                explored. A production build has no seed to reset, so it
                never renders. */}
            {isDemoMode() && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={confirmResetDemo}
                title="Clear anything added this session and restore the seeded demo data"
              >
                <RotateCcw size={14} /> Reset demo
              </button>
            )}
            <a
              className="btn btn-secondary btn-sm"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setViewMode('mobile');
              }}
            >
              <Smartphone size={14} /> Mobile preview
            </a>
          </div>
        </header>

        <main className="page">{children}</main>
      </div>
    </div>
  );
}

function prettyTitle(active) {
  const found = NAV_RESOURCES.find((item) => item.resource === active);
  return found ? found.label : 'Dashboard';
}

function RoleSwitcher({ open, onToggle, onClose }) {
  const { currentUser, state, actions, roleDefinitions } = useStore();
  return (
    <div className="role-switcher">
      <button className="role-switcher-trigger" onClick={onToggle}>
        <Avatar name={currentUser.name} size="sm" />
        <span>
          <strong>{currentUser.name}</strong>
          <small>{roleDefinitions[currentUser.role]?.name}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="role-switcher-menu" onMouseLeave={onClose}>
          <div className="role-switcher-head">
            <strong>Switch role viewer</strong>
            <p>Demo only — change which user's permissions drive the UI.</p>
          </div>
          <ul>
            {/* Seeded users are only listed when the demo switcher flag
                is on. In a production build this renders an empty list
                rather than a list of users anyone could impersonate. */}
            {(isDemoRoleSwitcherEnabled() ? state.users : [])
              .map((user) => (
              <li key={user.id}>
                <button
                  className={user.id === currentUser.id ? 'active' : ''}
                  onClick={() => {
                    actions.setCurrentUser(user.id);
                    onClose();
                  }}
                >
                  <Avatar name={user.name} size="sm" />
                  <span>
                    <strong>{user.name}</strong>
                    <small>{roleDefinitions[user.role]?.name}</small>
                  </span>
                  <span className={`status-dot status-${user.status.toLowerCase()}`} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
