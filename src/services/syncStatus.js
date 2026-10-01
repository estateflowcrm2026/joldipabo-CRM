// Sync status facade.
//
// Thin layer over the offline queue + sync worker that exposes a single
// snapshot for the mobile shell, the drawer button, and any future
// "Sync queue" page. Today this is just a re-export + lastSyncAt +
// lastSyncResult; it does not own state.

import { getQueueStats } from './offlineQueue.js';

let lastSyncAt = null;
let lastSyncResult = null;

// Called by syncWorker after each flush. Module-private — callers should
// read via getSyncStatus, not write directly.
export const recordSync = (result) => {
  lastSyncAt = new Date().toISOString();
  lastSyncResult = result;
};

export const getSyncStatus = () => ({
  ...getQueueStats(),
  lastSyncAt,
  lastSyncResult,
});

export { getQueueStats };
