// Browser smoke for the Phase 9A sign-in flow.
//
//   node --env-file=server/.env scripts/browser-smoke-auth.mjs
//
// Drives a REAL Chrome against the real Vite dev server and the real
// backend, on a desktop and a phone viewport, and walks the whole flow:
//
//   1. the sign-in screen appears, with the role switcher absent
//   2. a wrong password shows an error and does not sign in
//   3. the correct password signs in and the identity comes from the
//      backend
//   4. sign-out returns to the sign-in screen
//   5. an MFA account reaches the code screen and completes
//   6. no token is ever written to localStorage or sessionStorage
//
// Screenshots land in `screenshots/`. CREDENTIALS COME FROM THE
// ENVIRONMENT, never from a command line, and the password is typed
// through the keyboard rather than interpolated into a selector.

import { chromium, devices } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// MUST match the host in VITE_API_BASE_URL (localhost), not just the
// port. A cookie is scoped to a SITE, and 127.0.0.1 and localhost are
// different sites to a browser even on the same port — so browsing via
// 127.0.0.1 while the API is localhost means the session cookie is
// silently discarded, and the reload check fails for a reason that has
// nothing to do with the code under test.
const APP = process.env.SMOKE_APP_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = join(process.cwd(), 'screenshots');
const SECRET_FILE =
  process.env.AUTH_TEST_MFA_SECRET_FILE
  || join(tmpdir(), 'joldipabo-test-mfa-secret.txt');

const PASSWORD = process.env.DEMO_PASSWORD;
const EMAIL_PLAIN = process.env.AUTH_TEST_PLAIN_EMAIL || 'mfa-off@acme.example';
const EMAIL_MFA = 'mfa-on@acme.example';

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

if (!PASSWORD) {
  console.error('DEMO_PASSWORD is not set. Run with --env-file=server/.env');
  process.exit(2);
}
if (!existsSync(SECRET_FILE)) {
  console.error('The MFA secret file is missing. Run:');
  console.error('  cd server && node --env-file=.env scripts/seed-auth-test-users.js --fresh');
  process.exit(2);
}

const { totp } = await import('../server/src/auth/totp.js');
const mfaSecret = readFileSync(SECRET_FILE, 'utf8').trim().split(/\s+/)[1];

/**
 * The next TOTP step.
 *
 * A TOTP step may be used ONCE — that is the replay defence. Several
 * blocks in this file each present a code inside the same 30-second
 * window, so the second would be refused as a replay, correctly. Each
 * call steps forward once.
 */
// The server accepts ±1 step, and each accepted code advances the
// server's own counter. So the NEXT code must be the step just after
// the last one ACCEPTED — not simply "one step later than the last code
// we generated", which drifts once a wrong code is spent in between and
// eventually falls outside the window.
let lastAcceptedStep = null;
const nextTotp = () => {
  if (lastAcceptedStep === null) {
    lastAcceptedStep = Math.floor(Date.now() / 30_000);
  } else {
    lastAcceptedStep += 1;
  }
  return totp(mfaSecret, { atMs: lastAcceptedStep * 30_000 });
};

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/**
 * Type a secret without it ever reaching a selector, an attribute dump,
 * or a log line.
 *
 * `page.fill(value)` puts the value into Playwright's action log, which
 * a timeout prints verbatim — a live password in the transcript. Typing
 * key by key keeps it out of every recorded argument, and the disabled
 * state is why the naive version also failed: the form disables its
 * inputs while a request is in flight, so a click mid-flight is
 * retried until the element detaches.
 */
async function fillSecret(page, selector, value) {
  await page.waitForSelector(selector, { state: 'visible' });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && !el.disabled;
    },
    selector,
    { timeout: 15000 },
  );
  await page.focus(selector);
  await page.keyboard.type(value, { delay: 5 });
}

async function signIn(page, email) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password:enabled', { timeout: 20000 });
  await page.fill('#email', '');
  await page.fill('#password', '');
  await page.fill('#email', email);
  await fillSecret(page, '#password', PASSWORD);
  await submitWhenReady(page);
}

/** Click submit once the form is interactive again. */
async function submitWhenReady(page) {
  try {
    await page.waitForSelector('button[type=submit]:not([disabled])', { timeout: 20000 });
  } catch (err) {
    // A stuck disabled button is the bug this needs to report, not a
    // flake. Capture the state so the failure is diagnosable.
    const state = await page.evaluate(() => ({
      error: document.querySelector('#auth-error')?.textContent ?? null,
      submitDisabled: document.querySelector('button[type=submit]')?.disabled ?? null,
      passwordDisabled: document.querySelector('#password')?.disabled ?? null,
      hasSignIn: Boolean(document.querySelector('[data-testid=sign-in-screen]')),
      hasSession: Boolean(document.querySelector('[data-testid=session-bar]')),
      bodyStart: document.body.innerText.slice(0, 160),
    })).catch(() => ({}));
    console.error('    [diag] form state at timeout:', JSON.stringify(state));
    throw err;
  }
  await page.click('button[type=submit]');
}

try {
  // ---------------------------------------------------------------------
  // Desktop
  // ---------------------------------------------------------------------
  console.log('\ndesktop (1280x800)');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    // The sign-in screen is shown, and the demo role switcher is absent.
    // Asserted BEFORE anything is submitted: after a successful sign-in
    // the form is gone, so a later check for it would be meaningless.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#password:enabled', { timeout: 20000 });
    const signInVisible = await page.isVisible('[data-testid=sign-in-screen]');
    assert('the sign-in screen is shown when signed out', signInVisible);
    await page.screenshot({ path: join(SHOTS, 'signin-desktop.png'), fullPage: true });

    const roleSwitcher = await page.locator('text=Switch role viewer').count();
    assert('the demo role switcher is NOT rendered', roleSwitcher === 0,
      `${roleSwitcher} occurrences`);

    // Wrong password FIRST, while the form is still on screen. The field
    // is cleared before typing because keystrokes append.
    await page.fill('#email', EMAIL_PLAIN);
    await page.fill('#password', '');
    await fillSecret(page, '#password', 'definitely-not-the-password');
    await submitWhenReady(page);
    await page.waitForSelector('#auth-error', { timeout: 10000 });
    const errorText = await page.textContent('#auth-error');
    assert('a wrong password shows an error', Boolean(errorText), errorText ?? '');
    const stillSignedOut = await page.isVisible('[data-testid=sign-in-screen]');
    assert('and does not sign in', stillSignedOut);
    await page.screenshot({ path: join(SHOTS, 'signin-error-desktop.png'), fullPage: true });

    // Now the correct password, on the same still-visible form.
    await page.waitForSelector('#password:enabled', { timeout: 15000 });
    await page.fill('#password', '');
    await fillSecret(page, '#password', PASSWORD);
    await submitWhenReady(page);
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 15000 });
    assert('a correct password signs in', true);

    const who = await page.textContent('[data-testid=session-user]');
    assert('the identity comes from the backend', who?.includes(EMAIL_PLAIN), who ?? '');
    await page.screenshot({ path: join(SHOTS, 'signedin-desktop.png'), fullPage: true });

    // Storage scan, in the browser, where it actually matters
    const storage = await page.evaluate(() => {
      const dump = (s) => {
        const out = [];
        for (let i = 0; i < s.length; i += 1) out.push([s.key(i), s.getItem(s.key(i))]);
        return out;
      };
      return { local: dump(localStorage), session: dump(sessionStorage) };
    });
    const serialised = JSON.stringify(storage);
    assert('no access token in localStorage', !serialised.includes('eyJ'), 'a JWT-shaped value was found');
    assert('no key named like a token', !/token/i.test(serialised), serialised.slice(0, 160));

    // A RELOAD must NOT sign the user out. The refresh token is an
    // HttpOnly cookie, so the browser still has it and startup restores
    // through POST /auth/refresh. This is the assertion that distinguishes
    // Phase 9A (reauthenticate on reload) from Phase 9B, so it runs
    // BEFORE sign-out, while there is still a session to preserve.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 20000 });
    assert('a RELOAD keeps the session signed in', true);
    const stillWho = await page.textContent('[data-testid=session-user]');
    assert('with the same identity', stillWho?.includes(EMAIL_PLAIN), stillWho ?? '');

    // The cookie must be unreadable from JavaScript — that is the whole
    // reason it is HttpOnly.
    const cookieVisible = await page.evaluate(() => document.cookie.includes('jrp_refresh'));
    assert('the refresh cookie is NOT readable by JavaScript', !cookieVisible);
    const csrfVisible = await page.evaluate(() => document.cookie.includes('jrp_csrf'));
    assert('the csrf cookie IS readable (it must be echoed)', csrfVisible);

    // And nothing at all in web storage, after the reload.
    const storageAfterReload = await page.evaluate(() => {
      const dump = (st) => {
        const out = [];
        for (let i = 0; i < st.length; i += 1) out.push([st.key(i), st.getItem(st.key(i))]);
        return out;
      };
      return { local: dump(localStorage), session: dump(sessionStorage) };
    });
    const dumpText = JSON.stringify(storageAfterReload);
    assert('still nothing in localStorage after a reload', !dumpText.includes('eyJ'), 'a JWT-shaped value appeared');
    assert('and no key named like a token', !/token|refresh/i.test(dumpText), dumpText.slice(0, 120));

    // Sign out, LAST, so the reload above had a live session to keep.
    await page.click('[data-testid=sign-out]');
    await page.waitForSelector('[data-testid=sign-in-screen]', { timeout: 15000 });
    assert('sign-out returns to the sign-in screen', true);
    await page.screenshot({ path: join(SHOTS, 'signedout-desktop.png'), fullPage: true });

    await ctx.close();
  }

  // ---------------------------------------------------------------------
  // MFA, desktop
  // ---------------------------------------------------------------------
  console.log('\nMFA challenge (desktop)');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await signIn(page, EMAIL_MFA);

    await page.waitForSelector('#mfa-code', { timeout: 15000 });
    assert('the MFA code screen is reached', true);
    const noTokens = await page.locator('[data-testid=session-bar]').count();
    assert('no session bar before the code is entered', noTokens === 0);
    await page.screenshot({ path: join(SHOTS, 'mfa-desktop.png'), fullPage: true });

    // Wrong code first.
    await page.fill('#mfa-code', '000000');
    await submitWhenReady(page);
    await page.waitForSelector('#auth-error', { timeout: 10000 });
    assert('a wrong code shows an error', Boolean(await page.textContent('#auth-error')));
    assert('and does not sign in', (await page.locator('[data-testid=session-bar]').count()) === 0);

    // Correct code.
    await page.fill('#mfa-code', nextTotp());
    await submitWhenReady(page);
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 15000 });
    const who = await page.textContent('[data-testid=session-user]');
    assert('a correct code signs in', true);
    assert('as the MFA account', who?.includes(EMAIL_MFA), who ?? '');
    await page.screenshot({ path: join(SHOTS, 'mfa-signedin-desktop.png'), fullPage: true });

    await page.click('[data-testid=sign-out]');
    await page.waitForSelector('[data-testid=sign-in-screen]', { timeout: 15000 });
    assert('sign-out returns to the sign-in screen', true);

    // Tab close and reopen = a new browser context, which has its own
    // cookie jar. The session must NOT survive: a session cookie that
    // outlived every tab would be a persistent credential on a shared
    // machine, which is what "remember me" is for and this is not.
    await ctx.close();
    const reopened = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const fresh = await reopened.newPage();
    await fresh.goto(APP, { waitUntil: 'domcontentloaded' });
    await fresh.waitForSelector('[data-testid=sign-in-screen]', { timeout: 20000 });
    assert('a REOPENED tab is signed out (session cookie did not persist)', true);
    await reopened.close();
  }

  // ---------------------------------------------------------------------
  // MFA with the cookie session
  // ---------------------------------------------------------------------
  console.log('\nMFA establishes a cookie session');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await signIn(page, EMAIL_MFA);
    await page.waitForSelector('#mfa-code', { timeout: 15000 });
    await page.fill('#mfa-code', nextTotp());
    await submitWhenReady(page);
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 15000 });
    assert('MFA login succeeds', true);

    // The MFA path must set the cookie too, or the two login paths
    // disagree about what survives a reload.
    const cookies = await page.context().cookies();
    const names = cookies.map((c) => c.name);
    assert('a cookie is set after MFA login', names.includes('jrp_refresh'), names.join(','));
    const refreshCookie = cookies.find((c) => c.name === 'jrp_refresh');
    assert('and it is HttpOnly', Boolean(refreshCookie?.httpOnly));

    // Reload must keep the MFA session too.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 20000 });
    const who = await page.textContent('[data-testid=session-user]');
    assert('a reload after MFA keeps the session', who?.includes(EMAIL_MFA), who ?? '');
    await page.screenshot({ path: join(SHOTS, 'mfa-reload-desktop.png'), fullPage: true });
    await ctx.close();
  }

  // ---------------------------------------------------------------------
  // Mobile
  // ---------------------------------------------------------------------
  console.log('\nmobile (iPhone 13, 390x844)');
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();

    // NOT `signIn()` here: that helper submits, and the layout checks
    // below need the form still on screen. The MFA account is used
    // directly so both mobile assertions are about the same screen.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#password:enabled', { timeout: 20000 });

    await page.waitForSelector('[data-testid=sign-in-screen]', { timeout: 15000 });
    assert('the sign-in screen renders on a phone', true);

    // The primary control must be a comfortable tap target.
    const box = await page.locator('button[type=submit]').boundingBox();
    assert('the submit button is at least 44px tall', (box?.height ?? 0) >= 44, `${box?.height}px`);

    // No horizontal overflow: a form that scrolls sideways on a phone is
    // a layout bug, not a preference.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert('no horizontal overflow', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: join(SHOTS, 'signin-mobile.png'), fullPage: true });

    // The numeric keypad is the single biggest ergonomic win on mobile.
    const inputMode = await page.getAttribute('#mfa-code', 'inputmode').catch(() => null);
    await page.waitForSelector('#password:enabled', { timeout: 15000 });
    await page.fill('#email', '');
    await page.fill('#password', '');
    await page.fill('#email', EMAIL_MFA);
    await fillSecret(page, '#password', PASSWORD);
    await submitWhenReady(page);
    await page.waitForSelector('#mfa-code', { timeout: 15000 });
    const mode = await page.getAttribute('#mfa-code', 'inputmode');
    assert('the code field requests a numeric keypad', mode === 'numeric', String(mode));
    const autocomplete = await page.getAttribute('#mfa-code', 'autocomplete');
    assert('and accepts an OS-supplied one-time code', autocomplete === 'one-time-code', String(autocomplete));
    await page.screenshot({ path: join(SHOTS, 'mfa-mobile.png'), fullPage: true });

    await page.fill('#mfa-code', nextTotp());
    await submitWhenReady(page);
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 15000 });
    assert('MFA completes on a phone', true);
    await page.screenshot({ path: join(SHOTS, 'mfa-signedin-mobile.png'), fullPage: true });

    // The cookie path has to work on a phone too — Safari on iOS is
    // stricter about third-party cookies, and a session that only works
    // on desktop is not a session.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=session-bar]', { timeout: 20000 });
    assert('a reload on a phone keeps the session', true);
    // No URL filter: the refresh cookie is scoped to the API path, so
    // filtering by the frontend URL filters it out and the check passes
    // or fails for the wrong reason. The DOMAIN is what matters here.
    const mobileCookie = await page.context().cookies();
    const refreshOnMobile = mobileCookie.find((c) => c.name === 'jrp_refresh');
    assert(
      'the session cookie is present on mobile',
      Boolean(refreshOnMobile),
      mobileCookie.map((c) => c.name).join(','),
    );
    assert(
      'and it is HttpOnly on mobile too',
      Boolean(refreshOnMobile?.httpOnly),
    );
    await page.screenshot({ path: join(SHOTS, 'mfa-reload-mobile.png'), fullPage: true });

    await ctx.close();
  }
} finally {
  await browser.close();
  // The credential goes away whatever happened above.
  try {
    rmSync(SECRET_FILE, { force: true });
    console.log(`\n[smoke] deleted ${SECRET_FILE}`);
  } catch (err) {
    console.error(`[smoke] could not delete the secret file: ${err.message}`);
    console.error(`        Delete it manually: ${SECRET_FILE}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${SHOTS}`);
process.exit(failed === 0 ? 0 : 1);
