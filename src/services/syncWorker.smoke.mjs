// Smoke test for src/services/syncWorker.js.
//
// Run with:
//   node src/services/syncWorker.smoke.mjs
//
// What it asserts:
//   1. syncQueuedActions returns { synced: 4, failed: 1 } for a queue with
//      5 items (the photo with blobPersistence: 'deferred' fails).
//   2. After the first flush the queue is empty of synced items and has
//      exactly one failed photo item.
//   3. The photo failure carries code 'photo-repick-required'.
//   4. Idempotency: queueing the same attendance.checkIn twice via the
//      offlineActions helper yields one item (deduped at queueAction time)
//      and the flush reports it once.
//   5. The in-flight guard returns the same promise for two simultaneous
//      syncQueuedActions() calls.
//   6. registerSyncHandler / unregisterSyncHandler mutate the registry and
//      affect subsequent flushes.
//
// Exits with code 0 on success, 1 on failure. Prints a summary at the end.

import assert from 'node:assert/strict';

// ---------- Browser shim ----------

const memStore = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
    setItem: (k, v) => memStore.set(k, String(v)),
    removeItem: (k) => memStore.delete(k),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true, serviceWorker: undefined },
  configurable: true,
  writable: true,
});

// ---------- Imports under test ----------

const { syncQueuedActions, registerSyncHandler, unregisterSyncHandler, getSyncHandlers, syncOneAction } =
  await import('./syncWorker.js');
const { queueAction, listQueuedActions, resetQueue, markActionPending, getQueueStats } =
  await import('./offlineQueue.js');
const { recordSync, getSyncStatus } = await import('./syncStatus.js');

// ---------- Helpers ----------

const pass = (label) => console.log(`  ✓ ${label}`);
const fail = (label, err) => {
  console.error(`  ✗ ${label}`);
  console.error(err);
  process.exitCode = 1;
};

const runTest = async (label, fn) => {
  try {
    await fn();
    pass(label);
  } catch (err) {
    fail(label, err);
  }
};

// ---------- Test 1: end-to-end flush of one of each type ----------

await runTest('syncQueuedActions drains one of each type; photo with deferred blob fails', async () => {
  resetQueue();

  await queueAction('attendance.checkIn', {
    staffId: 'u-field-1',
    siteId: 'proj-orchid',
    location: { lat: 12.97, lng: 77.59, accuracy: 12, label: 'GPS' },
    clientTimestamp: new Date().toISOString(),
  });
  await queueAction('attendance.checkOut', {
    staffId: 'u-field-1',
    siteId: 'proj-orchid',
    location: { lat: 12.97, lng: 77.59, accuracy: 12, label: 'GPS' },
    clientHoursWorked: 8.5,
    clientTimestamp: new Date().toISOString(),
  });
  await queueAction('visit.update', {
    visitId: 'vis-1',
    patch: { status: 'Completed', rating: 5, feedback: 'Met lead on site' },
  });
  await queueAction('message.send', {
    threadId: 'thr-1',
    fromId: 'u-field-1',
    body: 'On site, customer wants Sunday visit',
    channel: 'in-app',
  });
  await queueAction('photo.upload', {
    blobKey: null,
    metadata: {
      projectId: 'proj-orchid',
      category: 'Progress',
      caption: 'Site progress day 12',
      sourceFilename: 'site-day-12.jpg',
      capturedAt: new Date().toISOString(),
      blobPersistence: 'deferred',
    },
  });

  const result = await syncQueuedActions({ trigger: 'manual' });

  assert.equal(result.synced, 4, 'four items should be marked synced');
  assert.equal(result.failed, 1, 'photo with deferred blob should fail');
  assert.equal(result.items.length, 5, 'items array should report every outcome');

  const photoOutcome = result.items.find((i) => i.type === 'photo.upload');
  assert.equal(photoOutcome.status, 'failed');
  assert.equal(photoOutcome.error.code, 'photo-repick-required');
  assert.equal(photoOutcome.error.detail.caption, 'Site progress day 12');
  assert.equal(photoOutcome.error.detail.blobKey, null);

  // After flush, only the failed item should remain in the queue.
  const remaining = listQueuedActions();
  assert.equal(remaining.length, 1, 'synced items should be cleared');
  assert.equal(remaining[0].type, 'photo.upload');
  assert.equal(remaining[0].status, 'failed');
  assert.ok(remaining[0].attempts >= 1, 'attempts should have incremented');

  // Stats should match.
  const stats = getQueueStats();
  assert.equal(stats.failed, 1);
  assert.equal(stats.pending, 0);
  assert.equal(stats.synced, 0);

  // syncStatus should report the latest result.
  const status = getSyncStatus();
  assert.ok(status.lastSyncAt, 'lastSyncAt should be populated');
  assert.equal(status.lastSyncResult.synced, 4);
  assert.equal(status.lastSyncResult.failed, 1);

  pass('  end-to-end: 4 synced, 1 failed, queue cleaned');
});

// ---------- Test 2: re-flush fails the same item again, no duplicates ----------

await runTest('second syncQueuedActions run does not duplicate the failed photo', async () => {
  const before = listQueuedActions();
  assert.equal(before.length, 1, 'still exactly one failed item from test 1');

  const result = await syncQueuedActions({ trigger: 'manual' });

  // Pending queue is empty (the failed item is not 'pending'), so the flush
  // should be a no-op.
  assert.equal(result.synced, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.items.length, 0);

  const after = listQueuedActions();
  assert.equal(after.length, 1, 'failed photo is still there, untouched');

  pass('  re-flush is idempotent on already-failed items');
});

// ---------- Test 3: validation failures ----------

await runTest('invalid payload fails with code invalid-payload', async () => {
  resetQueue();

  await queueAction('attendance.checkIn', { location: { lat: 1, lng: 2 } }); // missing staffId
  await queueAction('message.send', { threadId: 'thr-1', fromId: 'u-field-1' }); // missing body
  await queueAction('visit.update', { visitId: 'vis-1' }); // missing patch.status

  const result = await syncQueuedActions({ trigger: 'manual' });

  assert.equal(result.synced, 0);
  assert.equal(result.failed, 3);
  for (const r of result.items) {
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'invalid-payload');
  }

  resetQueue();
  pass('  three invalid items all failed with invalid-payload code');
});

// ---------- Test 4: idempotency dedup at queueAction time ----------

await runTest('queueAction idempotency key prevents duplicates', async () => {
  resetQueue();

  const payload = {
    staffId: 'u-field-1',
    location: { lat: 1, lng: 2, accuracy: 10, label: 'GPS' },
    clientTimestamp: new Date().toISOString(),
  };
  const id1 = await queueAction(
    'attendance.checkIn',
    payload,
    { metadata: { idempotencyKey: 'test:checkin:u-field-1:today' } }
  );
  const id2 = await queueAction(
    'attendance.checkIn',
    payload,
    { metadata: { idempotencyKey: 'test:checkin:u-field-1:today' } }
  );

  assert.equal(id1, id2, 'same idempotencyKey should return existing id');

  const result = await syncQueuedActions({ trigger: 'manual' });
  assert.equal(result.items.length, 1, 'flush should report one item, not two');
  assert.equal(result.synced, 1);
  assert.equal(result.failed, 0);

  resetQueue();
  pass('  idempotency dedup at queue time, single item flushed');
});

// ---------- Test 5: in-flight guard ----------

await runTest('concurrent syncQueuedActions calls coalesce to one flush', async () => {
  resetQueue();

  for (let i = 0; i < 3; i += 1) {
    await queueAction('message.send', {
      threadId: 'thr-1',
      fromId: 'u-field-1',
      body: `msg ${i}`,
      channel: 'in-app',
    });
  }

  const [a, b] = await Promise.all([
    syncQueuedActions({ trigger: 'manual' }),
    syncQueuedActions({ trigger: 'manual' }),
  ]);

  // Same promise → same items array reference. (Different objects would
  // mean a second flush ran.)
  assert.equal(a, b, 'two concurrent calls should resolve to the same result');
  assert.equal(a.items.length, 3);
  assert.equal(a.synced, 3);

  resetQueue();
  pass('  in-flight guard coalesces concurrent calls');
});

// ---------- Test 6: registerSyncHandler overrides the default ----------

await runTest('registerSyncHandler replaces the demo handler; unregister falls back to no-handler', async () => {
  resetQueue();

  // First, the default handler should sync a valid item.
  await queueAction('attendance.checkIn', {
    staffId: 'u-field-1',
    location: { lat: 1, lng: 2, accuracy: 10, label: 'GPS' },
    clientTimestamp: new Date().toISOString(),
  });
  const baseline = await syncQueuedActions({ trigger: 'manual' });
  assert.equal(baseline.synced, 1, 'default handler syncs the item');

  // Replace with a failing handler.
  registerSyncHandler('attendance.checkIn', async () => {
    const err = new Error('simulated upstream failure');
    err.code = 'upstream-503';
    throw err;
  });

  await queueAction('attendance.checkIn', {
    staffId: 'u-field-1',
    location: { lat: 1, lng: 2, accuracy: 10, label: 'GPS' },
    clientTimestamp: new Date().toISOString(),
  });
  const failing = await syncQueuedActions({ trigger: 'manual' });
  assert.equal(failing.synced, 0);
  assert.equal(failing.failed, 1);
  assert.equal(failing.items[0].error.code, 'upstream-503');

  // Unregister: items should now fail with 'no-handler'.
  unregisterSyncHandler('attendance.checkIn');
  await queueAction('attendance.checkIn', {
    staffId: 'u-field-1',
    location: { lat: 1, lng: 2, accuracy: 10, label: 'GPS' },
    clientTimestamp: new Date().toISOString(),
  });
  const noHandler = await syncQueuedActions({ trigger: 'manual' });
  assert.equal(noHandler.failed, 1);
  assert.equal(noHandler.items[0].error.code, 'no-handler');

  // Restore the default via the exposed registerDefaultHandlers helper
  // (only fills empty slots, so the unregister above is required first).
  const { registerDefaultHandlers } = await import('./syncWorker.js');
  registerDefaultHandlers();
  const handlersAfter = getSyncHandlers();
  assert.equal(typeof handlersAfter.get('attendance.checkIn'), 'function', 'demo handler restored');

  resetQueue();
  pass('  custom handler overrides; unregister yields no-handler; default restores via helper');
});

// ---------- Test 7: syncOneAction works on a single item ----------

await runTest('syncOneAction handles a single item id', async () => {
  resetQueue();

  const id = await queueAction('message.send', {
    threadId: 'thr-1',
    fromId: 'u-field-1',
    body: 'hi',
    channel: 'in-app',
  });

  const outcome = await syncOneAction(id, { trigger: 'manual' });
  assert.equal(outcome.id, id);
  assert.equal(outcome.type, 'message.send');
  assert.equal(outcome.status, 'synced');

  resetQueue();
  pass('  syncOneAction(id) resolves a single item to synced');
});

// ---------- Done ----------

resetQueue();
if (process.exitCode === 1) {
  console.error('\nSmoke test FAILED.');
  process.exit(1);
} else {
  console.log('\nSmoke test PASSED.');
}
