// Mobile application shell. Field-staff experience: native-app feel, large
// tap targets, bottom navigation, gesture-friendly sheets. The shell does
// NOT encode permission logic — it just renders the active page.

import React, { useEffect, useState } from 'react';
import {
  Home,
  Compass,
  Users,
  Camera,
  MessageSquareText,
  Menu,
  Bell,
  Monitor,
  CloudOff,
  Inbox,
  Warehouse,
} from 'lucide-react';
import { useStore } from '../state/store.jsx';
import { Avatar } from '../components/ui.jsx';
import { getQueueStats, listQueuedActions } from '../services/offlineQueue.js';

// 5 tabs at 540px = ~108px each. Photos drops from bottom-nav to keep the
// inventory surface one tap away for field execs; it's still reachable via
// the MobileHome quick-action tile ("My photos").
export const MOBILE_TABS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'visits', label: 'Visits', icon: Compass },
  { id: 'leads', label: 'Leads', icon: Users },
  { id: 'listings', label: 'Listings', icon: Warehouse },
  { id: 'comms', label: 'Inbox', icon: MessageSquareText },
];

export function MobileShell({ activeTab, onTabChange, onOpenDrawer, children }) {
  const { currentUser, roleDefinitions, state, online } = useStore();
  const unread = state.threads.filter((t) => t.unread).length;

  // Lightweight queue status indicator. Re-reads the queue on a coarse
  // interval so the badge stays in sync without forcing every view to
  // subscribe to localStorage events. The interval is cheap (one JSON
  // parse every 4 s) and clears on unmount.
  const [queueCount, setQueueCount] = useState(0);
  useEffect(() => {
    const refresh = () => {
      try {
        const pending = listQueuedActions({ status: 'pending' }).length;
        const failed = listQueuedActions({ status: 'failed' }).length;
        setQueueCount(pending + failed);
      } catch {
        setQueueCount(0);
      }
    };
    refresh();
    const id = window.setInterval(refresh, 4000);
    const onStorage = (e) => {
      if (e.key && e.key.startsWith('estateflow:offline-queue')) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  return (
    <div className="app-shell app-shell-mobile">
      <header className="mobile-topbar">
        <button className="btn-icon" onClick={onOpenDrawer} aria-label="Open menu">
          <Menu size={22} />
        </button>
        <div className="mobile-topbar-brand">
          <span className="brand-mark-mini">
            <img src="/joldipabo-logo.jpg" alt="Joldipabo logo" />
          </span>
          <strong>Joldipabo</strong>
        </div>
        <div className="mobile-topbar-actions">
          {online === false && (
            <span
              className="mobile-status-chip mobile-status-offline"
              role="status"
              aria-label="Offline"
              title="Offline — changes will be queued"
            >
              <CloudOff size={14} />
              <span>Offline</span>
            </span>
          )}
          {queueCount > 0 && (
            <span
              className="mobile-status-chip mobile-status-queue"
              role="status"
              aria-label={`${queueCount} queued actions`}
              title={`${queueCount} queued action${queueCount === 1 ? '' : 's'} pending sync`}
            >
              <Inbox size={14} />
              <span>{queueCount}</span>
            </span>
          )}
          <button className="btn-icon" aria-label="Notifications">
            <Bell size={20} />
            {unread > 0 && <span className="dot dot-red" />}
          </button>
          <Avatar name={currentUser.name} size="sm" />
        </div>
      </header>

      <main className="mobile-page">
        <div className="mobile-greeting">
          <p className="eyebrow">Hi {currentUser.name.split(' ')[0]}</p>
          <h2>{roleDefinitions[currentUser.role]?.name}</h2>
        </div>
        {children}
      </main>

      <nav className="mobile-tabbar" aria-label="Primary">
        {MOBILE_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={`mobile-tab ${isActive ? 'active' : ''}`}
              onClick={() => onTabChange(tab.id)}
            >
              <span className="mobile-tab-icon">
                <Icon size={20} />
                {tab.id === 'comms' && unread > 0 && <span className="dot dot-red dot-on-icon" />}
              </span>
              <span className="mobile-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// Slide-in side drawer used by the mobile menu.
export function MobileDrawer({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop drawer-side-backdrop" onClick={onClose}>
      <aside className="drawer-side" onClick={(e) => e.stopPropagation()}>
        {children}
      </aside>
    </div>
  );
}

// Inline button used in the drawer to switch between mobile/desktop preview.
export function PreviewSwitch({ children }) {
  const { setViewMode } = useStore();
  return (
    <button className="btn btn-secondary btn-block" onClick={() => setViewMode('desktop')}>
      <Monitor size={16} />
      <span>{children || 'Switch to desktop view'}</span>
    </button>
  );
}
