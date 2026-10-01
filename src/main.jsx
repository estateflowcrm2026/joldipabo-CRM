// Entry point. Wraps the app in the StoreProvider and routes between
// desktop and mobile shells based on the viewMode in the store.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { StoreProvider, useStore } from './state/store.jsx';
import { DesktopShell } from './layout/DesktopShell.jsx';
import { MobileShell, MobileDrawer, PreviewSwitch } from './layout/MobileShell.jsx';
import { Button } from './components/ui.jsx';
import { ToastHost } from './components/ui.jsx';
import { RESOURCES, ROLE_DEFINITIONS } from './data/permissions.js';
import { syncQueuedActions } from './services/syncWorker.js';
import { getSyncStatus } from './services/syncStatus.js';
import { isDemoRoleSwitcherEnabled, isDemoMode } from './services/demoFlags.js';
import { confirmResetDemo } from './services/demoReset.js';
import { ListingsProvider } from './services/listingsData.jsx';
import AuthGate, { useCanSignOut, useSessionUser } from './views/AuthGate.jsx';
import { signOut as sessionSignOut } from './services/authSession.js';

import { Dashboard } from './views/desktop/Dashboard.jsx';
import { Leads } from './views/desktop/Leads.jsx';
import { Listings } from './views/desktop/Listings.jsx';
import { Staff } from './views/desktop/Staff.jsx';
import { Roles } from './views/desktop/Roles.jsx';
import { Attendance } from './views/desktop/Attendance.jsx';
import { SiteVisits } from './views/desktop/SiteVisits.jsx';
import { SitePhotos } from './views/desktop/SitePhotos.jsx';
import { Comms } from './views/desktop/Comms.jsx';
import { Reports } from './views/desktop/Reports.jsx';

import { MobileHome } from './views/mobile/Home.jsx';
import {
  MobileVisits,
  MobileLeads,
  MobilePhotos,
  MobileComms,
  MobileListings,
} from './views/mobile/MobileModules.jsx';

import './styles.css';

function App() {
  const { state } = useStore();
  return state.viewMode === 'mobile' ? <MobileApp /> : <DesktopApp />;
}

function DesktopApp() {
  const [active, setActive] = useState(RESOURCES.DASHBOARD);
  return (
    <>
      <DesktopShell active={active} onNavigate={setActive}>
        {active === RESOURCES.DASHBOARD && <Dashboard />}
        {active === RESOURCES.LEADS && <Leads />}
        {active === RESOURCES.LISTINGS && <Listings />}
        {active === RESOURCES.STAFF && <Staff />}
        {active === RESOURCES.ROLES && <Roles />}
        {active === RESOURCES.ATTENDANCE && <Attendance />}
        {active === RESOURCES.VISITS && <SiteVisits />}
        {active === RESOURCES.PHOTOS && <SitePhotos />}
        {active === RESOURCES.COMMS && <Comms />}
        {active === RESOURCES.REPORTS && <Reports />}
      </DesktopShell>
      <ToastHost />
    </>
  );
}

function MobileApp() {
  const [tab, setTab] = useState('home');
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <MobileShell
        activeTab={tab}
        onTabChange={setTab}
        onOpenDrawer={() => setDrawerOpen(true)}
      >
        {tab === 'home' && (
          <MobileHome onSwitchTab={setTab} onOpenDrawer={() => setDrawerOpen(true)} />
        )}
        {tab === 'visits' && <MobileVisits />}
        {tab === 'leads' && <MobileLeads />}
        {tab === 'listings' && <MobileListings />}
        {tab === 'photos' && <MobilePhotos />}
        {tab === 'comms' && <MobileComms />}
      </MobileShell>
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <MobileMenuContents onClose={() => setDrawerOpen(false)} />
      </MobileDrawer>
      <ToastHost />
    </>
  );
}

function MobileMenuContents({ onClose }) {
  const { state, currentUser, actions, roleDefinitions } = useStore();
  // Mirror MobileShell's storage/online/offline listener pattern so the
  // count here can't disagree with the top-bar chip. No second setInterval.
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const refresh = () => {
      try {
        const status = getSyncStatus();
        setPendingCount(status.pending || 0);
        setFailedCount(status.failed || 0);
        setLastSyncAt(status.lastSyncAt);
      } catch {
        setPendingCount(0);
        setFailedCount(0);
      }
    };
    refresh();
    const onStorage = (e) => {
      if (e.key && e.key.startsWith('estateflow:offline-queue')) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  const refreshNow = () => {
    try {
      const status = getSyncStatus();
      setPendingCount(status.pending || 0);
      setFailedCount(status.failed || 0);
      setLastSyncAt(status.lastSyncAt);
    } catch {
      // ignore
    }
  };

  const onSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncQueuedActions({ trigger: 'manual' });
      const summary = formatSyncSummary(result);
      const tone = result.failed > 0 ? 'error' : 'success';
      actions.toast(summary, tone);
    } catch (err) {
      actions.toast('Sync could not start. Try again.', 'error');
      // eslint-disable-next-line no-console
      console.warn('[syncWorker] manual flush threw:', err);
    } finally {
      setSyncing(false);
      refreshNow();
      onClose();
    }
  };

  const hasQueue = pendingCount > 0 || failedCount > 0;

  return (
    <div className="mobile-menu">
      <header>
        <span className="brand-mark mobile-menu-logo">
          <img src="/joldipabo-logo.jpg" alt="Joldipabo logo" />
        </span>
        <div>
          <strong>Joldipabo</strong>
          <small>{roleDefinitions[currentUser.role]?.name} workspace</small>
        </div>
      </header>

      {/* The role switcher is a demo-only affordance. When the flag is
          off, the section is not rendered at all — a production user
          must not be able to assume the identity of any seeded user,
          including super-admin. Desktop obeys the same flag; see
          src/services/demoFlags.js. */}
      {isDemoRoleSwitcherEnabled() && (
        <Section title="Switch role viewer">
          <ul className="role-pick">
            {state.users.map((user) => (
              <li key={user.id}>
                <button
                  className={user.id === currentUser.id ? 'active' : ''}
                  onClick={() => {
                    actions.setCurrentUser(user.id);
                    onClose();
                  }}
                >
                  <strong>{user.name}</strong>
                  <small>{roleDefinitions[user.role]?.name}</small>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {isDemoMode() && (
        <p className="demo-mode-note">
          Demo mode — seeded data. Controls that switch identity are enabled for
          demonstration only.
        </p>
      )}

      <Section title="Sync queue">
        {hasQueue ? (
          <>
            <p className="muted sync-queue-summary">
              {pendingCount} pending · {failedCount} need attention
              {lastSyncAt ? ` · last synced ${formatTimeAgo(lastSyncAt)}` : ''}
            </p>
            <Button
              block
              variant="secondary"
              icon={RefreshCw}
              disabled={syncing}
              onClick={onSyncNow}
            >
              {syncing ? 'Syncing…' : 'Sync pending actions'}
            </Button>
          </>
        ) : (
          <p className="muted">All queued actions are synced.</p>
        )}
      </Section>

      <Section title="Demo info">
        <p className="muted">
          Joldipabo is a multi-vertical real estate operations CRM with
          role-based permissions. Switch roles to see how the UI adapts.
        </p>
        <PreviewSwitch>Switch to desktop view</PreviewSwitch>
        {isDemoMode() && (
          <Button
            block
            variant="secondary"
            icon={RotateCcw}
            onClick={confirmResetDemo}
          >
            Reset demo
          </Button>
        )}
      </Section>
    </div>
  );
}

// Helper for the toast summary. Kept inside main.jsx because it's UI-facing
// and the worker stays dumb.
//
// Auto-sync note: src/services/syncWorker.js exports startAutoSync() /
// stopAutoSync() / isAutoSyncOn(). No entry point calls startAutoSync() in
// this phase — the queue is drained only when the user taps "Sync pending
// actions" in the drawer below. The wiring decision is intentionally manual
// for now; see docs/SYNC_WORKER_PLAN.md §"Auto-sync" for the rationale.
function formatSyncSummary(result) {
  if (!result || result.items.length === 0) return 'Nothing to sync.';
  const { synced, failed } = result;
  if (failed === 0) return `${synced} item${synced === 1 ? '' : 's'} synced.`;
  if (synced === 0) return `${failed} item${failed === 1 ? '' : 's'} needs attention.`;
  return `${synced} synced, ${failed} needs attention.`;
}

// Tiny time-ago for the "last synced" line. Pure JS, no Intl.RelativeTimeFormat
// because we want a compact one-liner that reads naturally in a menu.
function formatTimeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function Section({ title, children }) {
  return (
    <section className="mobile-menu-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/**
 * The signed-in identity, shown in the topbar.
 *
 * In a real build this is whatever the BACKEND returned on sign-in or on
 * /auth/me — never a value the user picked. The role switcher below is
 * gated behind the demo flag, and this label is not: it reports the
 * session, so a reviewer can tell at a glance whether they are looking at
 * a real account.
 */
function SessionBar() {
  const user = useSessionUser();
  const canSignOut = useCanSignOut();
  if (!user || !canSignOut) return null;
  return (
    <div className="session-bar" data-testid="session-bar">
      <span data-testid="session-user">
        {user.name} &lt;{user.email}&gt; · {user.role}
      </span>
      <button
        type="button"
        className="auth-link"
        onClick={() => sessionSignOut()}
        data-testid="sign-out"
      >
        Sign out
      </button>
    </div>
  );
}

function Root() {
  return (
    <AuthGate>
      <StoreProvider>
        <ListingsProvider>
          <SessionBar />
          <App />
        </ListingsProvider>
      </StoreProvider>
    </AuthGate>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
