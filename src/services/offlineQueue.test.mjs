// Regression tests for the offline queue's type allow-list.
//
// Run with: `node src/services/offlineQueue.test.mjs`
// Exit code 0 = all assertions passed; non-zero = at least one failed.
//
// Why this file exists
// --------------------
// `queueAction()` rejects any type not in the internal ALLOWED_TYPES
// set, throwing before the item is ever persisted. The sync worker
// registers its own handler types independently. When those two lists
// drift apart, a user action silently loses data: the enqueue throws,
// nothing is written to storage, and the field staff member believes
// the capture was saved.
//
// That is exactly what happened with `listing.capture` — it had a
// handler in syncWorker.js and a queueing helper in offlineActions.js,
// but was missing from the allow-list. Every offline listing capture
// was lost until 2026-09-24.
//
// These tests assert the two lists cannot drift again, and that a
// rejected type fails loudly rather than vanishing.

import { queueAction, listQueuedActions, resetQueue } from './offlineQueue.js';
import { getSyncHandlers } from './syncWorker.js';

// `window` is absent under Node. The queue falls back to an in-memory
// store when storage is unavailable, so these tests run without a DOM
// and without polluting localStorage.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { localStorage: undefined };
}

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function accepts(type) {
  try {
    await queueAction(type, { probe: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// 1. Every handler the sync worker registers must be queueable
// ---------------------------------------------------------------------------

console.log('\nhandler types are allow-listed');
{
  const handlerTypes = [...getSyncHandlers().keys()].sort();
  assert('sync worker registers handlers', handlerTypes.length > 0, `got ${handlerTypes.length}`);

  for (const type of handlerTypes) {
    const result = await accepts(type);
    assert(
      `queueAction accepts "${type}"`,
      result.ok,
      result.ok ? '' : result.message
    );
  }
}

// ---------------------------------------------------------------------------
// 2. A type with no handler is refused loudly
// ---------------------------------------------------------------------------

console.log('\nunknown types are refused, not silently dropped');
{
  const result = await accepts('not.a.real.type');
  assert('unknown type throws', !result.ok, result.ok ? 'expected a throw' : '');
  assert(
    'error message names the type',
    !result.ok && result.message.includes('not.a.real.type'),
    result.ok ? 'no error' : `message was: ${result.message}`
  );
}

// ---------------------------------------------------------------------------
// 3. The documented action-type list is covered
// ---------------------------------------------------------------------------

console.log('\ndocumented action types are covered');
{
  // Mirrors docs/OFFLINE_QUEUE_CONTRACT.md §3 plus the
  // listing.capture action added with the lead↔listing phase.
  const documented = [
    'attendance.checkIn',
    'attendance.checkOut',
    'visit.update',
    'photo.upload',
    'message.send',
    'listing.capture',
  ];
  for (const type of documented) {
    const result = await accepts(type);
    assert(`"${type}" is queueable`, result.ok, result.ok ? '' : result.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Queue integrity after the probes above
// ---------------------------------------------------------------------------

console.log('\nqueue state is intact after probing');
{
  resetQueue();
  const afterReset = listQueuedActions();
  assert('resetQueue empties the queue', afterReset.length === 0, `got ${afterReset.length}`);

  await queueAction('listing.capture', {
    ownerName: 'Regression Probe',
    ownerPhone: '+91 00000 00000',
    serviceCategory: 'rent',
  });
  const items = listQueuedActions();
  assert('listing.capture round-trips', items.length === 1, `got ${items.length}`);
  assert(
    'listing.capture payload survives',
    items[0]?.payload?.serviceCategory === 'rent',
    `serviceCategory was: ${items[0]?.payload?.serviceCategory}`
  );
  resetQueue();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
