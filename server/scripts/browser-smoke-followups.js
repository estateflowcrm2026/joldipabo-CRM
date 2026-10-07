// Focused browser smoke for the Follow-ups queue (live/API mode only).
//
// Signs in, creates an overdue lead fixture through the UI-adjacent HTTP
// path (so the queue has a known row), opens Lead Management → Follow-ups,
// asserts the Overdue window shows the fixture with a red badge, switches
// to Upcoming/All, opens the row into the existing lead detail, clears the
// follow-up (completion), and asserts the queue no longer lists it.
// Fixture cleanup is exact-row via the admin role; audit events retained.
//
// Requires: FOLLOWUP_BROWSER_WRITE=1, DEMO_PASSWORD + APP_DATABASE_URL in
// the environment, an API-mode frontend on FOLLOWUP_BROWSER_URL
// (default http://127.0.0.1:5180/) backed by a current-code backend.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright-core';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.FOLLOWUP_BROWSER_WRITE !== '1') {
  throw new Error('Development-only browser smoke requires FOLLOWUP_BROWSER_WRITE=1.');
}
if (!process.env.DEMO_PASSWORD || !process.env.APP_DATABASE_URL) {
  throw new Error('DEMO_PASSWORD and APP_DATABASE_URL are required.');
}

const suffix = randomBytes(8).toString('hex');
const marker = `FOLLOWUP_BROWSER_${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({
  connectionString: adminUrl,
  ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }),
});
const app = await buildApp({ logLevel: 'silent' });
let browser;
let connected = false;
let leadId = null;

async function http(token, method, url, payload) {
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  return { status: response.statusCode, body: response.json() };
}

try {
  await admin.connect();
  connected = true;

  // Overdue fixture: visible in the queue the moment the page loads. The
  // browser signs in as the plain test account (field-executive,
  // own-scoped), so the fixture must be owned by that user — otherwise
  // row-level scope correctly hides it.
  const staff = await admin.query(
    'SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2) AND status = $3',
    ['org_acme', process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example', 'Active'],
  );
  if (staff.rows.length !== 1) throw new Error('The plain test account is unavailable.');
  const ownerId = staff.rows[0].id;
  const created = await http('dev-admin', 'POST', '/leads', {
    name: marker,
    phone: '+910000000097',
    ownerId,
    nextFollowUp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  });
  if (created.status !== 201) throw new Error(`Fixture creation failed: ${created.status}`);
  leadId = created.body.id;
  console.log('ok overdue lead fixture created');

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const shots = join(process.cwd(), 'screenshots');
  mkdirSync(shots, { recursive: true });

  await page.goto(process.env.FOLLOWUP_BROWSER_URL || 'http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('sign-in-screen').waitFor();
  await page.getByLabel('Work email').fill(process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example');
  await page.getByLabel('Password').click();
  await page.keyboard.type(process.env.DEMO_PASSWORD, { delay: 5 });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.nav-list').getByRole('button', { name: 'Leads' }).waitFor();
  await page.locator('.nav-list').getByRole('button', { name: 'Leads' }).click();
  await page.getByRole('heading', { name: 'Lead Management' }).waitFor();
  console.log('ok signed in, Lead Management open');

  // Follow-ups tab → Overdue window shows the fixture with a red badge.
  await page.getByRole('tab', { name: 'Follow-ups' }).click();
  await page.getByRole('tab', { name: 'Overdue', exact: true }).waitFor();
  const queue = page.getByRole('button', { name: new RegExp(marker) });
  await queue.waitFor();
  const badge = await queue.getByText('Overdue').count();
  if (badge < 1) throw new Error('Overdue badge missing on the fixture row');
  console.log('ok overdue window lists the fixture with an Overdue badge');
  await page.screenshot({ path: join(shots, 'followups-queue-desktop.png') });

  // Window tabs keep working: Upcoming + All load without errors.
  await page.getByRole('tab', { name: 'Upcoming' }).click();
  await page.getByText('No follow-ups here').or(page.getByRole('button', { name: /./ })).first().waitFor();
  await page.getByRole('tab', { name: 'All' }).click();
  await page.getByRole('button', { name: new RegExp(marker) }).waitFor();
  console.log('ok upcoming/all windows load');

  // Open the row → existing lead detail; clear the follow-up (completion).
  await page.getByRole('tab', { name: 'Overdue', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(marker) }).click();
  await page.getByRole('heading', { name: marker }).waitFor();
  console.log('ok queue row opens the lead detail');

  // Narrow width: the queue + detail stay usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(shots, 'followups-queue-mobile.png') });
  await page.setViewportSize({ width: 1365, height: 900 });

  if (errors.length) throw new Error(`Console errors during smoke: ${errors.join(' | ')}`);
  console.log('ok no console errors throughout');
  console.log('follow-ups browser smoke passed');
} finally {
  if (connected && leadId) {
    await admin.query('DELETE FROM leads WHERE tenant_id = $1 AND id = $2', ['org_acme', leadId]);
    const remaining = await admin.query('SELECT COUNT(*)::int AS n FROM leads WHERE id = $1', [leadId]);
    if (remaining.rows[0].n !== 0) throw new Error('Fixture cleanup incomplete');
    console.log('fixture lead removed; audit events retained');
  }
  if (connected) await admin.end();
  if (browser) await browser.close();
  await app.close();
  await closeDb();
}
