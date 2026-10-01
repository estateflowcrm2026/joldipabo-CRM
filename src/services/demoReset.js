// Demo reset.
//
// The demo's data lives in two places:
//
//   1. The React store, which is seeded from `src/data/seed.js` at load and
//      mutated in memory. Nothing about it is persisted, so a page reload
//      restores the seed exactly.
//   2. The offline action queue in localStorage
//      (`estateflow:offline-queue:v1`). This DOES survive a reload, so a
//      visitor who queued an offline capture would still see it afterwards.
//
// `resetDemo()` clears the queue and reloads, which together return the app
// to the state it had on first open. That is the whole reset: there is no
// server, no database, and no account to clean up.
//
// Gated by `isDemoMode()` at the call site — a production build has no
// seeded store to reset and no reason to expose a button that reloads the
// page.

import { resetQueue } from './offlineQueue.js';

/**
 * Clear demo-local state and reload. Safe to call when localStorage is
 * unavailable (private windows) — the reload still restores the seed.
 */
export function resetDemo() {
  try {
    resetQueue();
  } catch (err) {
    // A restricted browser may refuse storage access. The reload below
    // still resets the in-memory store, which is the part that matters.
    // eslint-disable-next-line no-console
    console.warn('[demo] could not clear the offline queue:', err);
  }
  if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
    window.location.reload();
  }
}

/**
 * Confirm-then-reset. Used by the visible "Reset demo" buttons so a stray
 * tap during a presentation cannot wipe what is on screen.
 */
export function confirmResetDemo() {
  if (typeof window === 'undefined') return;
  const ok = window.confirm(
    'Reset the demo? Any properties, leads, visits or photos added in this ' +
      'session will be cleared and the seeded data restored.',
  );
  if (ok) resetDemo();
}
