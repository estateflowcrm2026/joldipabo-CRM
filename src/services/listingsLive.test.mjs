// Tests for the live-mode listing path: DTO shape translation, the
// capture→DTO expansion, and the sync worker's live handlers.
//
// Run with:
//   node src/services/listingsLive.test.mjs
//
// The point of these tests is the pair of bugs that made "live mode" lie:
//
//   1. The UI builds a NESTED listing DTO but the backend's write validators
//      take a FLAT body. Posting nested verbatim is accepted (2xx) and every
//      nested field is silently dropped. toBackendCreatePayload / toBackendPatch
//      flatten it — asserted here against the exact key names the backend reads.
//   2. The sync worker used to run the demo `listing.capture` handler in live
//      mode, which validates the payload and returns — so the worker marked
//      the item synced even though no request was ever sent. The live handler
//      must only resolve after the API confirms, and must leave the item in a
//      retry state otherwise.

import assert from 'node:assert/strict';

// ---------- Browser shim (the queue uses localStorage) ----------

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

let passed = 0;
let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const {
  toBackendCreatePayload,
  toBackendPatch,
  toFrontendListing,
} = await import('./apiRepository.js');
const { listingFromCapture } = await import('./listingCapture.js');
const { setRepository, apiRepository } = await import('./index.js');
const {
  syncQueuedActions,
  registerDefaultHandlers,
  __resetHandlers,
  getSyncHandlers,
} = await import('./syncWorker.js');
const { queueAction, listQueuedActions, resetQueue } = await import('./offlineQueue.js');

// ---------- 1. Write-shape translation ----------

console.log('\ntoBackendCreatePayload flattens the nested DTO');
{
  const nested = {
    serviceCategory: 'rent',
    propertyType: 'apartment',
    listingIntent: 'available_for_rent',
    title: '2BHK at Orchid',
    description: 'Semi-furnished',
    location: { address: 'Tower B', city: 'Bengaluru', locality: 'Whitefield', geo: null },
    pricing: { price: null, rentMonthly: 45000, deposit: 150000, areaSqft: 1180 },
    specs: { bedrooms: 2, bathrooms: 2, furnished: 'semi', amenities: ['Gym'] },
    status: { availability: 'available', verification: 'unverified' },
    ownerContact: { name: 'Meera', phone: '+91 98456 11001', email: 'm@x.com' },
    assignedTo: 'u-fe-arjun',
    projectId: 'proj-orchid',
    notes: 'Pets allowed',
  };
  const flat = toBackendCreatePayload(nested);

  // No nested objects survive — the backend validator would ignore them.
  check('no nested location/pricing/specs/status/ownerContact keys', !('location' in flat) && !('pricing' in flat) && !('specs' in flat) && !('status' in flat) && !('ownerContact' in flat));
  check('address flattened', flat.address === 'Tower B');
  check('city flattened', flat.city === 'Bengaluru');
  check('locality flattened', flat.locality === 'Whitefield');
  check('rentMonthly flattened', flat.rentMonthly === 45000);
  check('deposit flattened', flat.deposit === 150000);
  check('areaSqft flattened', flat.areaSqft === 1180);
  check('bedrooms flattened', flat.bedrooms === 2);
  check('furnished flattened', flat.furnished === 'semi');
  check('amenities flattened', Array.isArray(flat.amenities) && flat.amenities[0] === 'Gym');
  check('availabilityStatus mapped from status.availability', flat.availabilityStatus === 'available');
  check('verificationStatus mapped from status.verification', flat.verificationStatus === 'unverified');
  check('ownerContactName mapped', flat.ownerContactName === 'Meera');
  check('ownerContactPhone mapped', flat.ownerContactPhone === '+91 98456 11001');
  check('assignedTo id → assignedUserId', flat.assignedUserId === 'u-fe-arjun');
  check('projectId preserved', flat.projectId === 'proj-orchid');
  check('null price omitted (not sent as null)', !('price' in flat));
}

console.log('\ntoBackendPatch flattens only the keys the caller supplied');
{
  const patch = toBackendPatch({
    title: 'Renamed',
    pricing: { price: null, rentMonthly: 55000, deposit: 150000, areaSqft: 1180 },
    specs: { bedrooms: 3, bathrooms: 2, furnished: 'semi', amenities: ['Gym', 'Pool'] },
    status: { availability: 'booked', verification: 'verified' },
  });
  check('title forwarded', patch.title === 'Renamed');
  check('rentMonthly forwarded', patch.rentMonthly === 55000);
  check('bedrooms forwarded', patch.bedrooms === 3);
  check('availabilityStatus forwarded', patch.availabilityStatus === 'booked');
  check('verificationStatus NOT forwarded (own endpoint)', !('verificationStatus' in patch));
  check('fields not mentioned are absent', !('address' in patch) && !('city' in patch) && !('ownerContactName' in patch));
}

console.log('\ntoFrontendListing normalises ownership fields');
{
  const dto = {
    id: 'l_1',
    assignedTo: { id: 'u-super', name: 'Demo Super', email: 'super@acme.example' },
    project: { id: 'p_1', name: 'Orchid' },
  };
  const out = toFrontendListing(dto);
  check('assignedTo becomes the id string', out.assignedTo === 'u-super');
  check('assignedToName carries the backend name', out.assignedToName === 'Demo Super');
  check('projectId taken from project.id', out.projectId === 'p_1');
  check('null assignedTo stays null', toFrontendListing({ assignedTo: null }).assignedTo === null);
}

// ---------- 2. Capture expansion ----------

console.log('\nlistingFromCapture expands the thin capture payload');
{
  const dto = listingFromCapture({
    ownerName: 'Ravi',
    ownerPhone: '+91 90000 00000',
    locality: 'HSR Layout',
    serviceCategory: 'rent',
    askingPrice: '42000',
    notes: '3rd floor',
    userId: 'u-fe-1',
    projectId: null,
  });
  check('title built from owner + locality', dto.title === 'Ravi — HSR Layout');
  check('rent category → rentMonthly', dto.pricing.rentMonthly === 42000 && dto.pricing.price === null);
  check('rent category → available_for_rent', dto.listingIntent === 'available_for_rent');
  check('ownerContact filled', dto.ownerContact.name === 'Ravi' && dto.ownerContact.phone === '+91 90000 00000');
  check('assignedTo + createdBy set to the capturer', dto.assignedTo === 'u-fe-1' && dto.createdBy === 'u-fe-1');

  const sale = listingFromCapture({ ownerName: 'S', ownerPhone: 'p', serviceCategory: 'sell', askingPrice: 9000000 });
  check('sell category → price, no rentMonthly', sale.pricing.price === 9000000 && sale.pricing.rentMonthly === null);
  check('sell category → available_for_sale', sale.listingIntent === 'available_for_sale');
}

// ---------- 3. Sync worker in live mode ----------

console.log('\nlive mode registers real replay handlers');
{
  // Switch the active repository to the API implementation so the worker
  // treats this as live, then rebuild the registry.
  setRepository(apiRepository);
  __resetHandlers();
  registerDefaultHandlers();

  const handlers = getSyncHandlers();
  check('a handler is registered for listing.capture', typeof handlers.get('listing.capture') === 'function');
  check('a handler is registered for attendance.checkIn', typeof handlers.get('attendance.checkIn') === 'function');
}

console.log('\nlive listing.capture only resolves after the API confirms');
{
  resetQueue();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return {
      status: 201,
      ok: true,
      statusText: 'Created',
      text: async () => JSON.stringify({ id: 'l_new', title: 'Ravi — HSR Layout' }),
    };
  };

  await queueAction('listing.capture', {
    ownerName: 'Ravi',
    ownerPhone: '+91 90000 00000',
    locality: 'HSR Layout',
    serviceCategory: 'rent',
    askingPrice: 42000,
    notes: '',
  }, { metadata: { userId: 'u-fe-1' } });

  const result = await syncQueuedActions({ trigger: 'manual' });
  check('the capture was marked synced', result.synced === 1 && result.failed === 0, JSON.stringify(result.items));
  check('the API was actually called', calls.length === 1, `${calls.length} calls`);
  check('the call was a POST to /listings', calls[0]?.method === 'POST' && /\/listings$/.test(calls[0]?.url));
  check('the body was FLAT (ownerContactName, not ownerContact)', calls[0]?.body?.ownerContactName === 'Ravi' && !('ownerContact' in (calls[0]?.body || {})));
  check('the body carried the flattened rent', calls[0]?.body?.rentMonthly === 42000);
  check('the queue is empty after a confirmed sync', listQueuedActions().length === 0);
}

console.log('\na failed API call leaves the live item queued, not synced');
{
  resetQueue();
  globalThis.fetch = async () => ({
    status: 500,
    ok: false,
    statusText: 'Internal Server Error',
    text: async () => JSON.stringify({ error: { code: 'internal-error', message: 'boom' } }),
  });

  await queueAction('listing.capture', {
    ownerName: 'Ravi',
    ownerPhone: '+91 90000 00000',
    serviceCategory: 'rent',
  }, { metadata: { userId: 'u-fe-1' } });

  const result = await syncQueuedActions({ trigger: 'manual' });
  check('nothing was marked synced', result.synced === 0);
  check('the item failed', result.failed === 1);
  check('the failure carries the server code', result.items[0]?.error?.code === 'internal-error');

  const remaining = listQueuedActions();
  check('the item is still in the queue (retry state)', remaining.length === 1 && remaining[0].status === 'failed');
  resetQueue();
}

console.log('\na type with no live endpoint fails rather than falsely syncing');
{
  resetQueue();
  let called = false;
  globalThis.fetch = async () => { called = true; return { status: 200, ok: true, text: async () => '{}' }; };

  await queueAction('attendance.checkIn', {
    staffId: 'u-field-1',
    location: { lat: 1, lng: 2 },
    clientTimestamp: new Date().toISOString(),
  });

  const result = await syncQueuedActions({ trigger: 'manual' });
  check('the item was NOT marked synced', result.synced === 0);
  check('it failed with live-replay-not-wired', result.items[0]?.error?.code === 'live-replay-not-wired');
  check('no request was made for the unwired type', called === false);
  check('it stays queued as failed', listQueuedActions()[0]?.status === 'failed');
  resetQueue();
}

// ---------- 4. Demo mode still uses the demo handlers ----------

console.log('\ndemo mode keeps the validate-only handlers');
{
  const { resetRepository } = await import('./index.js');
  resetRepository(); // back to demoRepository
  __resetHandlers();
  registerDefaultHandlers();
  resetQueue();

  let called = false;
  globalThis.fetch = async () => { called = true; return { status: 200, ok: true, text: async () => '{}' }; };

  await queueAction('listing.capture', {
    ownerName: 'Ravi',
    ownerPhone: '+91 90000 00000',
    serviceCategory: 'rent',
  }, { metadata: { userId: 'u-fe-1' } });

  const result = await syncQueuedActions({ trigger: 'manual' });
  check('demo handler validates and marks synced', result.synced === 1);
  check('demo handler makes no network call', called === false);
  resetQueue();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
