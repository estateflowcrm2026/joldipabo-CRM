import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { chromium } from 'playwright-core';
import { adminDatabaseUrl } from '../src/db/client.js';
import { resolveSsl } from '../src/db/sslConfig.js';
import { config } from '../src/config/index.js';

if (process.env.NODE_ENV === 'production' || process.env.CONTACT_BROWSER_WRITE !== '1') {
  throw new Error('Development-only browser smoke requires CONTACT_BROWSER_WRITE=1.');
}
if (!process.env.DEMO_PASSWORD || !process.env.APP_DATABASE_URL) {
  throw new Error('DEMO_PASSWORD and APP_DATABASE_URL are required.');
}

const marker = `CONTACT_BROWSER_${randomBytes(8).toString('hex')}`;
const adminUrl = adminDatabaseUrl();
const admin = new Client({
  connectionString: adminUrl,
  ssl: resolveSsl({ databaseUrl: adminUrl, ssl: config.dbSsl }),
});
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const shots = join(process.cwd(), 'screenshots');
mkdirSync(shots, { recursive: true });

try {
  await admin.connect();
  await page.goto(process.env.CONTACT_BROWSER_URL || 'http://localhost:5180/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('sign-in-screen').waitFor();
  await page.getByLabel('Work email').fill(process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example');
  await page.getByLabel('Password').click();
  await page.keyboard.type(process.env.DEMO_PASSWORD, { delay: 5 });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.nav-list').getByRole('button', { name: 'Leads' }).waitFor();
  await page.locator('.nav-list').getByRole('button', { name: 'Leads' }).click();
  await page.getByRole('heading', { name: 'Lead Management' }).waitFor();
  await page.getByRole('button', { name: 'New contact' }).click();
  const contactDialog = page.getByRole('dialog', { name: 'New contact' });
  await contactDialog.getByLabel('Name').fill(marker);
  await contactDialog.getByLabel('Phone*', { exact: true }).fill('+910000000098');
  await contactDialog.getByLabel('Requirements').fill('2 BHK near transit');
  await contactDialog.getByRole('button', { name: 'Save contact' }).click();
  await page.getByRole('heading', { name: marker }).waitFor();
  console.log('ok desktop contact creation');

  await page.getByRole('button', { name: 'Log call' }).click();
  const callDialog = page.getByRole('dialog', { name: 'Log call' });
  await callDialog.getByLabel('Outcome').selectOption('interested');
  await callDialog.getByLabel('Notes').fill(marker);
  await callDialog.getByRole('button', { name: 'Save call' }).click();
  await page.locator('.contact-call-list').getByText(marker).waitFor();
  console.log('ok desktop call log and history');

  await page.getByRole('button', { name: 'Convert to lead' }).click();
  await page.locator('.contact-lead-form').waitFor();
  await page.locator('.contact-lead-form').getByLabel('Status').selectOption('Contacted');
  await page.locator('.contact-lead-form').getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'View call history' }).click();
  await page.locator('.contact-call-list').getByText(marker).waitFor();
  await page.screenshot({ path: join(shots, 'contact-live-desktop.png'), fullPage: true });
  console.log('ok conversion, lead update, and contact history link');

  await page.getByRole('link', { name: 'Mobile preview' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Leads' }).click();
  await page.getByRole('heading', { name: 'Lead Management' }).waitFor();
  await page.getByRole('tab', { name: 'Contacts' }).click();
  await page.getByRole('textbox', { name: 'Search contacts' }).fill(marker);
  await page.locator('.contact-directory-row').getByText(marker).waitFor();
  await page.locator('.contact-directory-row').filter({ hasText: marker }).click();
  await page.getByRole('heading', { name: marker }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('Mobile contact detail overflows horizontally.');
  await page.screenshot({ path: join(shots, 'contact-live-mobile.png'), fullPage: true });
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log('ok mobile contact detail, no horizontal overflow or page errors');
} finally {
  try {
    const rows = await admin.query('SELECT id, lead_id FROM contacts WHERE tenant_id=$1 AND name=$2', ['org_acme', marker]);
    for (const row of rows.rows) {
      await admin.query('DELETE FROM contact_calls WHERE tenant_id=$1 AND contact_id=$2 AND notes=$3', ['org_acme', row.id, marker]);
      await admin.query('DELETE FROM contacts WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', row.id, marker]);
      if (row.lead_id) await admin.query('DELETE FROM leads WHERE tenant_id=$1 AND id=$2 AND name=$3', ['org_acme', row.lead_id, marker]);
    }
    const remaining = await admin.query(`SELECT
      (SELECT COUNT(*)::int FROM contacts WHERE tenant_id=$1 AND name=$2) AS contacts,
      (SELECT COUNT(*)::int FROM leads WHERE tenant_id=$1 AND name=$2) AS leads,
      (SELECT COUNT(*)::int FROM contact_calls WHERE tenant_id=$1 AND notes=$2) AS calls`, ['org_acme', marker]);
    if (Object.values(remaining.rows[0]).some(Boolean)) {
      throw new Error(`Browser fixture cleanup incomplete: ${JSON.stringify(remaining.rows[0])}`);
    }
    if (rows.rows.length) console.log('browser fixture removed; audit events retained');
  } finally {
    await admin.end().catch(() => {});
    await browser.close();
  }
}
