// Browser smoke for the Joldipabo demo build.
//
//   npm run demo:build
//   npm run demo:preview            # serves dist/ on http://localhost:4173
//   node scripts/browser-smoke-demo.mjs
//
// Drives real Chrome through the guided demo journey on a desktop and a
// phone viewport and fails on anything the presenter would see: a console
// error, a horizontal overflow, an empty screen, or a broken step.
//
// The build under test must be a DEMO build (VITE_USE_API_REPOSITORY=false,
// VITE_ENABLE_DEMO_ROLE_SWITCHER=true). The script asserts the role switcher
// and the Reset demo control are present, which is how it tells.

import { chromium, devices } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.DEMO_URL || 'http://localhost:4173';
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.DEMO_SCREENSHOTS_DIR || join(ROOT, 'screenshots', 'demo');

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

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

// Shared across the desktop sections.
let desktopPage;
let desktopErrs = [];
let desktopCtx;

/** Collect console errors + page errors for a page. */
function watch(page) {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}

const overflowOf = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function section(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name} threw: ${err?.message || err}`);
  }
}

// ===========================================================================
// Desktop
// ===========================================================================

await section('desktop: loads with no sign-in and no console errors', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = watch(page);
  await page.goto(APP, { waitUntil: 'networkidle' });

  assert('no sign-in screen (demo needs no credentials)', (await page.locator('[data-testid=sign-in-screen]').count()) === 0);
  assert('the app shell rendered', (await page.locator('.app-shell').count()) > 0);
  assert('the role switcher is present', (await page.locator('.role-switcher-trigger').count()) > 0);
  assert('a "Reset demo" control is present', (await page.getByRole('button', { name: /Reset demo/i }).count()) > 0);
  assert('no horizontal overflow', (await overflowOf(page)) <= 0);
  await page.screenshot({ path: join(SHOTS, 'dash-desktop.png') });

  desktopPage = page;
  desktopErrs = errs;
  desktopCtx = ctx;
});

const nav = async (page, name) => {
  await page.getByRole('button', { name, exact: true }).first().click();
  await page.waitForTimeout(500);
};

await section('desktop: every module renders something (no blank screens)', async () => {
  const page = desktopPage;
  const modules = [
    ['Dashboard', '.stat-grid'],
    ['Leads', '.lead-table, .empty-state'],
    ['Inventory', '.listing-table, .empty-state'],
    ['Staff', 'table, .empty-state, .staff-page, .panel'],
    ['Attendance', '.page'],
    ['Site Visits', '.visit-grid, .empty-state'],
    ['Site Photos', '.page'],
    ['Communication', '.page'],
    ['Reports', '.page'],
  ];
  for (const [name, sel] of modules) {
    await nav(page, name);
    const n = await page.locator(sel).count();
    assert(`${name} renders`, n > 0, sel);
  }
  await nav(page, 'Inventory');
  await page.screenshot({ path: join(SHOTS, 'inventory-desktop.png') });
});

await section('desktop: inventory covers rent, PG, land, office and sales', async () => {
  const page = desktopPage;
  const opts = await page.locator('.filter-bar select').nth(0).locator('option').allTextContents();
  for (const want of ['Rent', 'PG', 'Land', 'Office']) {
    assert(`category filter offers ${want}`, opts.includes(want), JSON.stringify(opts));
  }
  assert(
    'category filter offers a residential-sale option',
    opts.includes('Resale') || opts.includes('Owner-listed') || opts.includes('Sell'),
    JSON.stringify(opts),
  );
  // Every offered category must return rows — a filter that shows nothing
  // is the first thing a client will click.
  for (let i = 1; i < opts.length; i += 1) {
    await page.locator('.filter-bar select').nth(0).selectOption({ index: i });
    await page.waitForTimeout(200);
    const rows = await page.locator('.listing-row:not(.listing-row-head)').count();
    assert(`"${opts[i]}" returns rows`, rows > 0, `${rows}`);
  }
  await page.locator('.filter-bar select').nth(0).selectOption('all');
});

await section('desktop: add a property', async () => {
  const page = desktopPage;
  await page.getByRole('button', { name: 'New listing' }).click();
  await page.waitForSelector('.modal', { timeout: 8000 });
  const fill = async (label, value) => {
    const c = page.locator('.field', { hasText: label }).first().locator('input, select, textarea').first();
    const tag = await c.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') await c.selectOption(value); else await c.fill(value);
  };
  await fill('Owner name', 'Client Demo Owner');
  await fill('Owner phone', '+91 90000 11111');
  await fill('Title', 'Client demo property');
  await fill('Locality', 'Whitefield');
  await fill('Monthly rent', '38000');
  await page.locator('.modal').getByRole('button', { name: 'Create listing' }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 }).catch(() => {});
  const n = await page.locator('.listing-row', { hasText: 'Client demo property' }).count();
  assert('the new property appears', n > 0);
});

await section('desktop: lead enquiry and site visit', async () => {
  const page = desktopPage;
  await nav(page, 'Leads');
  assert('leads are listed', (await page.locator('.lead-row:not(.lead-row-head)').count()) > 0);
  await page.screenshot({ path: join(SHOTS, 'leads-desktop.png') });

  await nav(page, 'Site Visits');
  assert('visits are listed', (await page.locator('.visit-card').count()) > 0);
  await page.screenshot({ path: join(SHOTS, 'visits-desktop.png') });
});

await section('desktop: field check-in and photo (mobile preview)', async () => {
  const page = desktopPage;
  // Switch to a field executive, then open the mobile preview.
  await page.locator('.role-switcher-trigger').click();
  await page.waitForTimeout(250);
  await page.locator('.role-switcher-menu button', { hasText: 'Field Executive' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('.topbar-actions a').filter({ hasText: 'Mobile' }).first().click();
  await page.waitForTimeout(700);

  assert('the mobile shell opened', (await page.locator('.app-shell-mobile').count()) > 0);
  const checkIn = page.getByRole('button', { name: /Check in/i });
  assert('the field exec starts off duty with a Check in button', (await checkIn.count()) > 0);
  await checkIn.first().click();
  await page.waitForTimeout(1200);
  assert('check-in puts them on duty', (await page.locator('.mobile-attendance.on-duty').count()) > 0);
  await page.screenshot({ path: join(SHOTS, 'mobile-checkin.png') });

  // Photo capture.
  await page.locator('button, a').filter({ hasText: 'Capture & upload site photo' }).first().click();
  await page.waitForTimeout(500);
  const before = await page.locator('.mobile-photo-grid figure').count();
  await page.locator('.upload-zone input[type=file]').setInputFiles(join(ROOT, 'public', 'estate-hero.png'));
  await page.waitForTimeout(200);
  await page.locator('.mobile-upload button').last().click();
  await page.waitForTimeout(700);
  const after = await page.locator('.mobile-photo-grid figure').count();
  assert('the uploaded photo appears in the gallery', after === before + 1, `${before} → ${after}`);
  await page.screenshot({ path: join(SHOTS, 'mobile-photo.png') });

  // Back to desktop, manager view.
  await page.locator('.mobile-tab', { hasText: 'Home' }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.waitForSelector('.mobile-menu', { timeout: 6000 });
  await page.getByRole('button', { name: /Switch to desktop/i }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.role-switcher-trigger').click();
  await page.waitForTimeout(250);
  await page.locator('.role-switcher-menu button', { hasText: 'Sales Manager' }).first().click();
  await page.waitForTimeout(300);
  await nav(page, 'Attendance');
  assert('the manager attendance view renders', (await page.locator('.page').count()) > 0);
  await page.screenshot({ path: join(SHOTS, 'attendance-manager.png') });
});

await section('desktop: no console errors across the journey', async () => {
  assert('zero console/page errors', desktopErrs.length === 0, desktopErrs.slice(0, 3).join(' | '));
  await desktopCtx.close();
});

// ===========================================================================
// Mobile (real device profile)
// ===========================================================================

await section('mobile: every tab renders, no overflow, no console errors', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = watch(page);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  for (const tab of ['Home', 'Visits', 'Leads', 'Listings', 'Inbox']) {
    await page.locator('.mobile-tab', { hasText: tab }).first().click();
    await page.waitForTimeout(500);
    const over = await overflowOf(page);
    assert(`${tab}: renders and fits the screen`, over <= 0, `${over}px overflow`);
  }
  assert('zero console/page errors on mobile', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.locator('.mobile-tab', { hasText: 'Listings' }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'listings-mobile.png') });
  await ctx.close();
});

// ===========================================================================
// Reset
// ===========================================================================

await section('reset demo restores the seeded state', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(APP, { waitUntil: 'networkidle' });
  // Plant something that only a reload can clear.
  await page.evaluate(() => {
    localStorage.setItem('estateflow:offline-queue:v1', JSON.stringify([
      { id: 'x', type: 'listing.capture', payload: {}, status: 'pending', createdAt: '', updatedAt: '' },
    ]));
  });
  await page.getByRole('button', { name: /Reset demo/i }).first().click();
  await page.waitForLoadState('networkidle');
  const left = await page.evaluate(() => localStorage.getItem('estateflow:offline-queue:v1'));
  assert('the offline queue is cleared', left === null || left === '[]', String(left));
  assert('the app is back on the seeded dashboard', (await page.locator('.stat-grid').count()) > 0);
  await ctx.close();
});

console.log(`\n${passed} passed, ${failed} failed.`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
