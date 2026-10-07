// Session state for the real sign-in flow.
//
// WHY NOTHING IS PERSISTED
// -------------------------
// The backend issues a short-lived access token (minutes) and a rotating
// refresh token (days, single-use, family-revoked on replay). Neither is
// written to `localStorage` or `sessionStorage`.
//
//   localStorage   readable by any script on the origin, indefinitely, and
//                  included in nothing that gets cleared. An XSS on this
//                  origin would be a persistent credential theft.
//   sessionStorage same XSS exposure, but per-tab — a marginally better
//                  fallback than nothing, still not a defence.
//
// So the tokens live in module scope and the tab. Reloading the page
// therefore signs the user out, and the app recovers by calling
// `POST /auth/refresh` with a refresh token it held in memory — and if
// that is gone too, the user signs in again. That is the trade: a reload
// costs a re-authentication, and a stolen XSS payload gets a token that
// dies with the tab.
//
// `withBroadcast` below is the escape hatch for keeping a session across
// a reload without storage: a `BroadcastChannel` (or the storage event as
// a fallback) lets one tab publish a token to its siblings. That is a
// deliberate, explicit opt-in, and it is still memory-only within each
// tab.
//
// The demo build is unaffected: it has no real session, and
// `isDemoMode()` decides which experience renders.

import { apiRequest, ApiError, setAuthToken, clearAuthToken } from './apiClient.js';

const REFRESH_MARGIN_SECONDS = 60;

/**
 * The access token, in memory only.
 *
 * There is deliberately NO refreshToken field. The refresh token now
 * lives in an HttpOnly cookie the browser attaches automatically, so
 * there is nothing for this module to hold and nothing for a reload to
 * lose. A reload calls refreshSession(), the browser sends the cookie,
 * and a new access token comes back.
 *
 * @type {{accessToken: string, expiresAt: number, user: object}|null}
 */
let session = null;
let inFlight = null;
const listeners = new Set();
let channel = null;

/** The CSRF cookie, mirrored so we can send the header without a second read. */
let csrfToken = null;

/** Notified on every session change. */
function emit() {
  for (const fn of listeners) {
    try {
      fn(session);
    } catch (err) {
      console.error('[auth] listener threw', err);
    }
  }
}

export function subscribeToSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getSession = () => session;
export const isSignedIn = () => Boolean(session?.accessToken);

/**
 * Whether a session cookie appears to exist.
 *
 * Not a security check and not a substitute for refreshSession() — the
 * refresh cookie is HttpOnly, so JavaScript cannot see it. This reads the
 * CSRF pair, which exists exactly when the session cookie does, purely to
 * decide whether a restore is worth attempting on startup.
 *
 * @returns {boolean}
 */
export const hasSessionCookieHint = () => Boolean(readCsrfToken());
export const getCurrentUser = () => session?.user ?? null;

/**
 * A cross-tab channel so a sign-in in one tab can be adopted by another
 * without either tab writing a token to disk.
 *
 * Opt-in: nothing is shared until `enableCrossTabSync()` is called, so
 * the default stays strictly tab-local.
 *
 * @returns {void}
 */
export function enableCrossTabSync() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel('joldipabo-auth');
    channel.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'session') return;
      if (data.payload === null) {
        // A sign-out elsewhere signs this tab out too.
        if (session) setSession(null);
        return;
      }
      // Adopt a session issued in another tab, but only if we have none:
      // adopting over a live session could silently swap identities.
      if (!session) setSession(data.payload, { silent: true });
    };
  } catch {
    // A browser that refuses the channel just stays tab-local.
    channel = null;
  }
}

function broadcast(payload) {
  if (!channel) return;
  try {
    channel.postMessage({ type: 'session', payload });
  } catch {
    /* ignore */
  }
}

/**
 * Replace the session, or clear it with `null`.
 *
 * @param {object|null} next
 * @param {{silent?: boolean}} [opts] `silent` does not broadcast — used
 *   when adopting a session published by another tab, which must not
 *   bounce back.
 */
export function setSession(next, { silent = false } = {}) {
  session = next && next.accessToken ? next : null;
  if (session) setAuthToken(session.accessToken);
  else clearAuthToken();
  if (!silent) broadcast(session);
  emit();
}

/**
 * The CSRF token, read from the cookie the backend set.
 *
 * Readable by JavaScript on purpose: it is only half the credential, and
 * without the HttpOnly refresh cookie a cross-origin script that reads
 * this still cannot authenticate. Read once per page and cached, so a
 * cookie write does not force a re-read on every request.
 *
 * @returns {string|null}
 */
export function readCsrfToken() {
  if (csrfToken) return csrfToken;
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'jrp_csrf') {
      csrfToken = decodeURIComponent(part.slice(eq + 1).trim());
      return csrfToken;
    }
  }
  return null;
}

/**
 * The CSRF header, built from the cookie the backend set.
 *
 * Sent on every cookie-authenticated request. The server compares it
 * against the cookie in constant time, so a cross-origin request — which
 * can make the browser attach the cookie but cannot READ it — has no way
 * to produce a matching value.
 *
 * @returns {Record<string, string>}
 */
function csrfHeader() {
  const token = readCsrfToken();
  return token ? { 'x-csrf-token': token } : {};
}

function userFrom(payload) {
  return payload?.user
    ? payload.user
    : // Some responses omit the user; fall back to /auth/me below.
      null;
}

async function fetchMe(accessToken) {
  const res = await apiRequest('/auth/me', { token: accessToken });
  return res?.user ?? null;
}

/**
 * Sign in with a password.
 *
 * Returns one of three shapes, and the caller has to handle all three:
 *
 *   { status: 'authenticated', user }
 *   { status: 'mfa-required', challengeToken, reason }   — no tokens yet
 *   { status: 'error', code, message }
 *
 * The backend deliberately issues nothing on the first factor, so a
 * client that only looks for `accessToken` will treat a correct password
 * as a failed sign-in.
 *
 * @param {{email: string, password: string, tenantSlug?: string}} input
 * @returns {Promise<object>}
 */
export async function signIn({ email, password, tenantSlug }) {
  let res;
  try {
    res = await apiRequest('/auth/login', {
      method: 'POST',
      // Required, not optional. The frontend and the API are different
      // ORIGINS in development (localhost:5173 vs localhost:4000), and
      // a cross-origin fetch omits credentials by default — so without
      // this the browser DISCARDS the Set-Cookie from a successful
      // login and the session never starts. The failure is invisible:
      // the user is signed in, and then every reload signs them out.
      credentials: 'include',
      body: { email, password, tenantSlug: tenantSlug || null },
    });
  } catch (err) {
    // apiRequest THROWS ApiError on any non-2xx, and on a network
    // failure. Assuming it returns the error body is how a client ends
    // up treating a 401 as a malformed success.
    return { status: 'error', code: err?.code ?? 'unknown', message: err?.message ?? 'Sign-in failed.' };
  }

  if (res?.mfaRequired === true) {
    return {
      status: 'mfa-required',
      challengeToken: res.challengeToken,
      reason: res.mfaReason ?? 'enabled',
      expiresIn: res.expiresIn,
    };
  }

  if (res?.accessToken) {
    setSession({
      accessToken: res.accessToken,
      expiresAt: Date.now() + (res.expiresIn ?? 900) * 1000,
      user: userFrom(res),
    });
    return { status: 'authenticated', user: getCurrentUser() };
  }

  return { status: 'error', code: 'unknown', message: 'Sign-in failed.' };
}

/**
 * Complete an MFA challenge and, on success, adopt the session.
 *
 * @param {{challengeToken: string, code: string}} input
 * @returns {Promise<object>}
 */
export async function completeMfa({ challengeToken, code }) {
  let res;
  try {
    res = await apiRequest('/auth/mfa/challenge', {
      method: 'POST',
      credentials: 'include',
      body: { challengeToken, code },
    });
  } catch (err) {
    return {
      status: 'error',
      code: err?.code ?? 'unknown',
      message: err?.message ?? 'That code is not valid.',
    };
  }

  if (res?.accessToken) {
    setSession({
      accessToken: res.accessToken,
      expiresAt: Date.now() + (res.expiresIn ?? 900) * 1000,
      user: userFrom(res),
    });
    return { status: 'authenticated', user: getCurrentUser() };
  }

  return { status: 'error', code: 'unknown', message: 'That code is not valid.' };
}

/**
 * Exchange the refresh token for a new pair.
 *
 * Concurrent callers share one in-flight request: a refresh token is
 * single-use, so two parallel refreshes would spend it twice and the
 * second would be treated as a replay, revoking the whole family.
 *
 * @returns {Promise<boolean>} whether a session is now held
 */
export async function refreshSession() {
  if (inFlight) return inFlight;
  // No precondition on the session. The refresh token is a cookie now,
  // so this is exactly what a RELOAD does: the browser still has it even
  // though this module has no session at all. Requiring a session here
  // would make restoring after a reload impossible, which is the whole
  // point of the cookie.
  inFlight = (async () => {
    try {
      // `credentials: 'include'` so the cookie is attached cross-origin,
      // plus the CSRF header the server checks.
      const res = await apiRequest('/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeader(),
      });
      if (!res?.accessToken) {
        // Expired, revoked, or the family was killed. Signed out.
        setSession(null);
        return false;
      }
      setSession({
        accessToken: res.accessToken,
        expiresAt: Date.now() + (res.expiresIn ?? 900) * 1000,
        user: res.user ?? session?.user ?? null,
      });
      return true;
    } catch (err) {
      // A CSRF refusal (403) is not the same as an invalid session: the
      // cookie may still be good and the request simply was not ours.
      // Signing out there would destroy a working session because of a
      // proxy that dropped a header.
      if (err instanceof ApiError && err.code === 'csrf-rejected') {
        return false;
      }
      setSession(null);
      return false;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Ensure a usable access token, refreshing when it is about to expire.
 *
 * @returns {Promise<boolean>}
 */
export async function ensureFreshToken() {
  if (!session?.accessToken) return false;
  const remaining = session.expiresAt - Date.now();
  if (remaining > REFRESH_MARGIN_SECONDS * 1000) return true;
  return refreshSession();
}

/** True when the access token is within the refresh margin. */
export function isAboutToExpire() {
  if (!session?.expiresAt) return false;
  return session.expiresAt - Date.now() <= REFRESH_MARGIN_SECONDS * 1000;
}

/**
 * Sign out.
 *
 * The refresh token is revoked server-side so the session is genuinely
 * dead rather than merely forgotten here. A failure is reported, but the
 * local session is cleared either way: leaving a signed-in UI behind
 * because the network was down is worse than an orphaned server-side
 * session that expires on its own.
 *
 * @returns {Promise<{revoked: boolean}>}
 */
export async function signOut() {
  // Clear locally FIRST, so a network failure cannot strand the user in
  // a signed-in-looking interface. The cookie is cleared by the server's
  // Set-Cookie on the response, not by this module — there is nothing
  // here that CAN clear it, which is the point of HttpOnly.
  setSession(null);

  try {
    const res = await apiRequest('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: csrfHeader(),
    });
    return { revoked: res?.revoked === true };
  } catch {
    return { revoked: false };
  }
}

/** Load the user record for a token that we hold but have no user for. */
export async function loadIdentity() {
  if (!session?.accessToken || session.user) return getCurrentUser();
  const user = await fetchMe(session.accessToken).catch(() => null);
  if (user) {
    session = { ...session, user };
    emit();
  }
  return user;
}

/** Test seam: drop everything without touching the network. */
export function resetSessionForTests() {
  session = null;
  inFlight = null;
  csrfToken = null;
  clearAuthToken();
  emit();
}
