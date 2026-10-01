// Browser smoke for the Phase 9C Listings work.
//
//   node scripts/browser-smoke-listings.mjs
//
// Drives a REAL Chrome against running Vite dev servers and the real backend,
// on a desktop and a phone viewport.
//
//   LIVE mode (VITE_USE_API_REPOSITORY=true, demo role switcher off)
//     1. sign in, open Inventory, listings load from the backend
//     2. create a listing → success → the row appears
//     3. reload → the listing is still there (backend-persisted)
//     4. edit it → the change round-trips
//     5. a manager can verify; assignment is withheld (no staff endpoint)
//     6. a field executive is denied verify / delete (controls absent)
//     7. an API failure keeps the form open with an error
//     8. mobile: capture a listing; reassign withheld; off-market works
//     9. mobile offline capture queues, then replays against the API
//
//   DEMO mode (VITE_USE_API_REPOSITORY=false, role switcher on)
//    10. listings come from seed; the role switcher is present
//
// Two dev servers are expected:
//   LIVE  http://localhost:5180   (vite --mode e2e)
//   DEMO  http://localhost:5181   (vite --mode demo)
//
// Credentials come from the environment, never the command line.

import { chromium, devices } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LIVE_APP = process.env.SMOKE_LIVE_URL || 'http://localhost:5180';
const DEMO_APP = process.env.SMOKE_DEMO_URL || 'http://localhost:5181';
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = join(process.cwd(), 'screenshots');

const ADMIN = { email: 'admin@acme.example', password: process.env.DEMO_PASSWORD_ADMIN || 'DemoJoldipabo!2026' };
const FIELD = { email: 'mfa-off@acme.example', password: process.env.DEMO_PASSWORD || 'Kamal121213' };

let passed = 0;
let failed = 0;
const assert = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const runId = Date.now().toString(36);

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

// ---------- helpers ----------

async function signIn(page, app, { email, password }) {
  await page.goto(app, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password:enabled', { timeout: 20000 });
  await page.fill('#email', '');
  await page.fill('#password', '');
  await page.fill('#email', email);
  await page.focus('#password');
  await page.keyboard.type(password, { delay: 3 });
  await page.waitForSelector('button[type=submit]:not([disabled])', { timeout: 20000 });
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=session-bar]', { timeout: 20000 });
}

/** Open the Inventory module from the desktop sidebar. */
async function openInventory(page) {
  await page.getByRole('button', { name: 'Inventory' }).click();
  await page.waitForSelector('.listings-page', { timeout: 15000 });
  await page.waitForSelector('.listing-table, .listing-card-grid, .empty-state', { timeout: 15000 });
}

/** Fill a Field-wrapped input or select by its label text. */
async function fillField(page, label, value) {
  const control = page.locator('.field', { hasText: label }).first().locator('input, select, textarea').first();
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') await control.selectOption(value);
  else await control.fill(value);
}

/** Count toasts whose text contains `needle` (after giving them a moment). */
async function toastCount(page, needle, timeout = 8000) {
  await page.waitForFunction(
    (n) => Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes(n)),
    needle,
    { timeout },
  ).catch(() => {});
  return page.locator('.toast', { hasText: needle }).count();
}

const countWithText = (page, needle) =>
  page.locator('.listing-row, .listing-card, .mobile-listing', { hasText: needle }).count();

const section = async (name, fn) => {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name} threw: ${err?.message || err}`);
  }
};

// Shared across the LIVE desktop sections.
let liveDesktopCtx = null;
let liveDesktopPage = null;
const createdTitle = `E2E live ${runId}`;
let liveCreatedTitle = createdTitle;

// Click a bottom-nav tab on the mobile shell by its label.
const mobileTab = (page, label) =>
  page.locator('.mobile-tab', { hasText: label }).first().click();

// ===========================================================================
// LIVE — desktop
// ===========================================================================

await section('LIVE desktop: sign in and load listings from the backend', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, LIVE_APP, ADMIN);
  const who = await page.textContent('[data-testid=session-user]');
  assert('signed in as the admin account', who?.includes(ADMIN.email), who ?? '');

  await openInventory(page);
  assert('Inventory loaded', await page.locator('.listings-page').isVisible());
  const rows = await page.locator('.listing-row:not(.listing-row-head)').count();
  assert('the backend returned at least one listing', rows > 0, `${rows} rows`);
  await page.screenshot({ path: join(SHOTS, 'listings-live-desktop.png'), fullPage: true });

  // Stash the page for the next sections via a shared context list.
  liveDesktopCtx = ctx;
  liveDesktopPage = page;
});

await section('LIVE desktop: create a listing', async () => {
  const page = liveDesktopPage;
  await page.getByRole('button', { name: 'New listing' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });

  await fillField(page, 'Owner name', 'E2E Owner');
  await fillField(page, 'Owner phone', '+91 90000 11111');
  await fillField(page, 'Title', createdTitle);
  await fillField(page, 'Locality', 'Whitefield');
  await fillField(page, 'City', 'Bengaluru');
  await fillField(page, 'Monthly rent', '41000');

  // Live mode: the project + assignee pickers must be withheld.
  const modalText = await page.locator('.modal').innerText();
  assert('project picker withheld in live mode', !/Project\b/.test(modalText) || /unavailable in live mode/.test(modalText));
  assert('assignee picker withheld in live mode', /unavailable in live mode/.test(modalText), modalText.slice(0, 160));

  await page.locator('.modal').getByRole('button', { name: 'Create listing' }).click();
  const okToasts = await toastCount(page, 'Listing created');
  assert('a success toast appears after the server confirms', okToasts > 0);
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 });
  assert('the modal closes only after success', true);

  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('.listing-row')).some((r) => r.textContent.includes(t)),
    createdTitle,
    { timeout: 10000 },
  ).catch(() => {});
  assert('the new listing appears in the table', (await countWithText(page, createdTitle)) > 0);
  await page.screenshot({ path: join(SHOTS, 'listings-live-created.png'), fullPage: true });
});

await section('LIVE desktop: reload and find the listing', async () => {
  const page = liveDesktopPage;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=session-bar]', { timeout: 20000 });
  await openInventory(page);
  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('.listing-row')).some((r) => r.textContent.includes(t)),
    createdTitle,
    { timeout: 12000 },
  ).catch(() => {});
  assert('the listing survives a reload (backend-persisted)', (await countWithText(page, createdTitle)) > 0);
});

await section('LIVE desktop: update the listing', async () => {
  const page = liveDesktopPage;
  const updatedTitle = `${createdTitle} updated`;
  await page.locator('.listing-row', { hasText: createdTitle }).first().click();
  await page.waitForSelector('.drawer-side', { timeout: 10000 });
  await page.locator('.drawer-side').getByRole('button', { name: 'Edit' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fillField(page, 'Title', updatedTitle);
  await page.locator('.modal').getByRole('button', { name: 'Save changes' }).click();
  const okToasts = await toastCount(page, 'Listing updated');
  assert('an update toast appears after the server confirms', okToasts > 0);
  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('.listing-row')).some((r) => r.textContent.includes(t)),
    updatedTitle,
    { timeout: 10000 },
  ).catch(() => {});
  assert('the updated title shows in the table', (await countWithText(page, updatedTitle)) > 0);
  // Persisted? reload again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=session-bar]', { timeout: 20000 });
  await openInventory(page);
  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('.listing-row')).some((r) => r.textContent.includes(t)),
    updatedTitle,
    { timeout: 12000 },
  ).catch(() => {});
  assert('the update survived a reload', (await countWithText(page, updatedTitle)) > 0);
  liveCreatedTitle = updatedTitle;
});

await section('LIVE desktop: permitted manager action (verify) and withheld assignment', async () => {
  const page = liveDesktopPage;
  await page.locator('.listing-row', { hasText: liveCreatedTitle }).first().click();
  await page.waitForSelector('.drawer-side', { timeout: 10000 });

  const drawerText = await page.locator('.drawer-side').innerText();
  assert('the manager sees an Edit control', /Edit/.test(drawerText));
  assert('the manager sees a Verify control', /Verify/.test(drawerText));
  const reassignBtn = await page.locator('.drawer-side').getByRole('button', { name: 'Reassign' }).count();
  assert('assignment is withheld (no Reassign button)', reassignBtn === 0);
  assert('the drawer explains the withheld assignment', /no staff directory/i.test(drawerText));

  await page.locator('.drawer-side').getByRole('button', { name: 'Verify' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.locator('.modal').getByRole('button', { name: 'Save verification' }).click();
  const okToasts = await toastCount(page, 'verification updated');
  assert('verify succeeds for the manager', okToasts > 0);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.listing-verification-banner');
      return el && /Verified by/.test(el.textContent);
    },
    { timeout: 8000 },
  ).catch(() => {});
  await page.screenshot({ path: join(SHOTS, 'listings-live-verified.png'), fullPage: true });
});

await section('LIVE desktop: API failure keeps the form open with an error', async () => {
  const page = liveDesktopPage;
  // Fail the create request only.
  await page.route('**/api/v1/listings', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal-error', message: 'Simulated failure' } }),
      });
    } else {
      await route.continue();
    }
  });

  await page.getByRole('button', { name: 'New listing' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fillField(page, 'Owner name', 'E2E Fail');
  await fillField(page, 'Owner phone', '+91 90000 22222');
  await fillField(page, 'Title', `E2E failure ${runId}`);
  await page.locator('.modal').getByRole('button', { name: 'Create listing' }).click();

  const errToasts = await toastCount(page, 'Simulated failure', 10000);
  assert('an error toast reports the server failure', errToasts > 0);
  assert('the modal stays open on failure', await page.locator('.modal').isVisible());
  await page.screenshot({ path: join(SHOTS, 'listings-live-create-failed.png'), fullPage: true });

  await page.unroute('**/api/v1/listings');
  await page.keyboard.press('Escape');
});

await section('LIVE desktop: field executive is denied verify and delete', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, LIVE_APP, FIELD);
  await openInventory(page);

  // Create a listing as the field exec (they can create; it lands in own scope).
  const feTitle = `E2E fe ${runId}`;
  await page.getByRole('button', { name: 'New listing' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fillField(page, 'Owner name', 'FE Owner');
  await fillField(page, 'Owner phone', '+91 90000 33333');
  await fillField(page, 'Title', feTitle);
  await page.locator('.modal').getByRole('button', { name: 'Create listing' }).click();
  await toastCount(page, 'Listing created');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 }).catch(() => {});

  await page.locator('.listing-row', { hasText: feTitle }).first().click();
  await page.waitForSelector('.drawer-side', { timeout: 10000 });
  const drawerText = await page.locator('.drawer-side').innerText();
  assert('the field executive sees their own listing', /FE Owner/.test(drawerText));
  assert('the field executive gets an Edit control (own scope)', /Edit/.test(drawerText));
  assert('the field executive is DENIED Verify', !/Verify/.test(drawerText));
  assert('the field executive is DENIED Mark off-market', !/Mark off-market/.test(drawerText));
  await page.screenshot({ path: join(SHOTS, 'listings-live-fe-denied.png'), fullPage: true });
  await ctx.close();
});

// ===========================================================================
// LIVE — mobile
// ===========================================================================

await section('LIVE mobile: capture a listing and withhold reassignment', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await signIn(page, LIVE_APP, ADMIN);
  await mobileTab(page, 'Listings');
  await page.waitForSelector('.mobile-tab-page', { timeout: 15000 });

  const mobileTitle = `E2E mobile ${runId}`;
  await page.getByRole('button', { name: 'Add collected property' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fillField(page, 'Owner name', 'Mobile Owner');
  await fillField(page, 'Owner phone', '+91 90000 44444');
  await fillField(page, 'Locality', 'Indiranagar');
  await page.locator('.modal').getByRole('button', { name: 'Save listing' }).click({ force: true });
  const okToasts = await toastCount(page, 'captured');
  assert('mobile capture succeeds after the server confirms', okToasts > 0);
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 }).catch(() => {});

  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('.mobile-listing')).some((c) => c.textContent.includes(t)),
    'Mobile Owner',
    { timeout: 10000 },
  ).catch(() => {});
  assert('the captured listing appears in the mobile list', (await countWithText(page, 'Mobile Owner')) > 0);
  await page.screenshot({ path: join(SHOTS, 'listings-live-mobile.png'), fullPage: true });

  // Open the sheet: reassign must be withheld in live mode.
  await page.locator('.mobile-listing', { hasText: 'Mobile Owner' }).first().click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  const sheetText = await page.locator('.modal').innerText();
  const sheetReassign = await page.locator('.modal').getByRole('button', { name: 'Reassign' }).count();
  assert('mobile reassignment is withheld in live mode', sheetReassign === 0);
  assert('the mobile sheet explains why', /no staff directory/i.test(sheetText));
  await page.screenshot({ path: join(SHOTS, 'listings-live-mobile-sheet.png'), fullPage: true });
  await ctx.close();
});

await section('LIVE mobile: offline capture queues, then replays against the API', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await signIn(page, LIVE_APP, ADMIN);
  await mobileTab(page, 'Listings');
  await page.waitForSelector('.mobile-tab-page', { timeout: 15000 });

  // Go offline at the network layer for the API, and flip navigator.onLine.
  await ctx.setOffline(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
  });

  await page.getByRole('button', { name: 'Add collected property' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fillField(page, 'Owner name', 'Offline Owner');
  await fillField(page, 'Owner phone', '+91 90000 55555');
  await fillField(page, 'Locality', 'Jayanagar');
  await page.locator('.modal').getByRole('button', { name: 'Save listing' }).click({ force: true });
  const offlineToast = await toastCount(page, 'Saved offline');
  assert('the offline capture is queued with a clear message', offlineToast > 0);

  const queued = await page.evaluate(() => {
    const raw = localStorage.getItem('estateflow:offline-queue:v1');
    const items = raw ? JSON.parse(raw) : [];
    return items.map((i) => ({ type: i.type, status: i.status }));
  });
  assert('one listing.capture is queued as pending', queued.some((i) => i.type === 'listing.capture' && i.status === 'pending'), JSON.stringify(queued));

  // Back online, then flush from the drawer.
  await ctx.setOffline(false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
  });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForSelector('.mobile-menu', { timeout: 10000 });
  await page.getByRole('button', { name: 'Sync pending actions' }).click();
  const syncToast = await toastCount(page, 'synced', 12000);
  assert('the sync reports a successful replay', syncToast > 0);

  const after = await page.evaluate(() => {
    const raw = localStorage.getItem('estateflow:offline-queue:v1');
    return raw ? JSON.parse(raw).map((i) => i.status) : [];
  });
  assert('the queue is empty after the confirmed replay', after.length === 0, JSON.stringify(after));
  await page.screenshot({ path: join(SHOTS, 'listings-live-mobile-offline-synced.png'), fullPage: true });
  await ctx.close();
});

await section('LIVE mobile: mark a listing off-market (awaits the server)', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  // Accept the confirm() dialog the off-market action raises.
  page.on('dialog', (d) => d.accept());
  await signIn(page, LIVE_APP, ADMIN);
  await mobileTab(page, 'Listings');
  await page.waitForSelector('.mobile-tab-page', { timeout: 15000 });

  const offTitle = `Offmarket Owner ${runId}`;
  await page.getByRole('button', { name: 'Add collected property' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fillField(page, 'Owner name', offTitle);
  await fillField(page, 'Owner phone', '+91 90000 66666');
  await fillField(page, 'Locality', 'Koramangala');
  await page.locator('.modal').getByRole('button', { name: 'Save listing' }).click({ force: true });
  await toastCount(page, 'captured');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 }).catch(() => {});

  await page.locator('.mobile-listing', { hasText: offTitle }).first().click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  const sheet = page.locator('.modal');
  const offBtn = sheet.getByRole('button', { name: 'Mark off-market' });
  assert('the admin sees the off-market control on mobile', (await offBtn.count()) > 0);
  await offBtn.click({ force: true });
  const offToast = await toastCount(page, 'off-market', 10000);
  assert('off-market reports success after the server confirms', offToast > 0);
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForFunction(
    (t) => !Array.from(document.querySelectorAll('.mobile-listing')).some((c) => c.textContent.includes(t)),
    offTitle,
    { timeout: 8000 },
  ).catch(() => {});
  assert('the off-market listing leaves the mobile list', (await countWithText(page, offTitle)) === 0);
  await page.screenshot({ path: join(SHOTS, 'listings-live-mobile-offmarket.png'), fullPage: true });
  await ctx.close();
});

if (liveDesktopCtx) await liveDesktopCtx.close();

// ===========================================================================
// DEMO mode
// ===========================================================================

await section('DEMO mode: seed listings and the role switcher are present', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(DEMO_APP, { waitUntil: 'domcontentloaded' });
  // Demo mode has no sign-in gate.
  await page.waitForSelector('.nav-list', { timeout: 20000 });
  const switcher = await page.locator('.role-switcher-trigger').count();
  assert('the role switcher is present in demo mode', switcher > 0);

  await openInventory(page);
  const seedRow = await page.locator('.listing-row', { hasText: 'Orchid Heights' }).count();
  assert('listings come from the seed', seedRow > 0, `${seedRow} seed rows`);
  await page.screenshot({ path: join(SHOTS, 'listings-demo-desktop.png'), fullPage: true });
  await ctx.close();
});

console.log(`\n${passed} passed, ${failed} failed.`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
