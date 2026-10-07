import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright-core';
import { buildApp } from '../src/app.js';
import { adminDatabaseUrl, closeDb } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.VISIT_BROWSER_WRITE !== '1') {
  throw new Error('Development-only browser smoke requires VISIT_BROWSER_WRITE=1.');
}
if (!process.env.DEMO_PASSWORD || !process.env.APP_DATABASE_URL) throw new Error('Test password and application DB URL are required.');

const suffix = randomBytes(8).toString('hex');
const marker = `VISIT_BROWSER_${suffix}`;
const leadId = `ld_vbrowser_${suffix}`;
const listingId = `ls_vbrowser_${suffix}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({ connectionString: adminUrl, ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }) });
const app = await buildApp({ logLevel: 'silent' });
let browser;
let connected = false;
let fixtureInserted = false;
let visitId;
try {
  await admin.connect(); connected = true;
  const staff = await admin.query('SELECT id,team_id FROM users WHERE tenant_id=$1 AND email=$2 AND role_id=$3 AND status=$4',
    ['org_acme', process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example', 'field-executive', 'Active']);
  if (staff.rows.length !== 1) throw new Error('The active field-executive test account is unavailable.');
  const executive = staff.rows[0];
  await admin.query(`INSERT INTO leads (id,tenant_id,name,phone,owner_id,team_id,created_by)
    VALUES ($1,'org_acme',$2,'+910000000099',$3,$4,$3)`, [leadId, marker, executive.id, executive.team_id]);
  fixtureInserted = true;
  await admin.query(`INSERT INTO listings (id,tenant_id,title,service_category,property_type,listing_intent,created_by,assigned_to,team_id)
    VALUES ($1,'org_acme',$2,'rent','apartment','available_for_rent',$3,$3,$4)`, [listingId, marker, executive.id, executive.team_id]);
  const scheduled = await app.inject({ method: 'POST', url: '/api/v1/visits', headers: { authorization: 'Bearer dev-admin' },
    payload: { leadId, assignedTo: executive.id, listingId, scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
  if (scheduled.statusCode !== 201) throw new Error(`Scheduling failed: ${scheduled.statusCode} ${scheduled.body}`);
  visitId = scheduled.json().id;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.VISIT_BROWSER_URL || 'http://localhost:5180/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('sign-in-screen').waitFor();
  await page.getByLabel('Work email').fill(process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example');
  await page.getByLabel('Password').click();
  await page.keyboard.type(process.env.DEMO_PASSWORD, { delay: 5 });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Mobile preview' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Visits' }).click();
  await page.getByRole('heading', { name: 'Site Visits' }).waitFor();
  await page.locator('.live-visits-row').filter({ hasText: marker }).click();
  await page.getByRole('heading', { name: marker }).waitFor();
  for (const status of ['Accepted', 'On the way', 'Reached']) {
    await page.getByLabel('Next status').selectOption(status);
    await page.getByRole('button', { name: 'Save status' }).click();
    await page.locator('.live-visits-title').getByText(status, { exact: true }).waitFor();
    console.log(`ok mobile status ${status}`);
  }
  await page.getByLabel('Find property').fill(marker);
  const viewingForm = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Record property viewing' }) });
  await viewingForm.locator('select').first().selectOption(listingId);
  await page.getByLabel('Client feedback').fill('Helpful layout');
  await page.getByRole('button', { name: 'Record viewing' }).click();
  await page.locator('.live-visits-history').getByText('Helpful layout').waitFor();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Leads' }).click();
  await page.getByRole('tab', { name: 'Leads' }).click();
  await page.getByRole('textbox', { name: 'Search leads' }).fill(marker);
  await page.locator('.contact-directory-row').filter({ hasText: marker }).click();
  await page.getByRole('heading', { name: marker }).waitFor();
  await page.locator('.contact-visit-item > button').click();
  await page.locator('.contact-visit-viewings').getByText('Helpful layout').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow || errors.length) throw new Error(`Mobile visit UI error: overflow=${overflow}; ${errors.join(' | ')}`);
  const shots = join(process.cwd(), 'screenshots'); mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'visits-live-mobile.png'), fullPage: true });
  console.log('ok property viewing appears in client lead history, no overflow or page errors');
} finally {
  if (connected && fixtureInserted) {
    if (visitId) {
      await admin.query('DELETE FROM visit_viewings WHERE tenant_id=$1 AND visit_id=$2', ['org_acme', visitId]);
      await admin.query('DELETE FROM visit_events WHERE tenant_id=$1 AND visit_id=$2', ['org_acme', visitId]);
      await admin.query('DELETE FROM visits WHERE tenant_id=$1 AND id=$2', ['org_acme', visitId]);
    }
    await admin.query('DELETE FROM listings WHERE tenant_id=$1 AND id=$2 AND title=$3', ['org_acme', listingId, marker]);
    await admin.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', leadId, marker]);
    console.log('browser visit fixture removed; audit events retained');
  }
  if (browser) await browser.close();
  if (connected) await admin.end();
  await app.close(); await closeDb();
}
