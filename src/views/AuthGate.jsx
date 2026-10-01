import { createContext, useContext, useState, useEffect, useCallback } from 'react';

import SignInScreen from './SignInScreen.jsx';
import { isDemoMode, isDemoRoleSwitcherEnabled } from '../services/demoFlags.js';
import {
  signIn as sessionSignIn,
  completeMfa as sessionCompleteMfa,
  signOut as sessionSignOut,
  getSession,
  subscribeToSession,
  isSignedIn,
  refreshSession,
  hasSessionCookieHint,
} from '../services/authSession.js';

// Decides between the sign-in screen and the application.
//
// THE RULE THAT MATTERS
// ---------------------
// In a real (non-demo) build there is no role switcher, and the current
// user comes from the backend — never from a picker. `VITE_ENABLE_DEMO_ROLE_SWITCHER`
// is read by the shells, and this gate refuses to render the app at all
// without a session, so a missed flag cannot leave a real deployment
// sitting on the demo identity.
//
// `isDemoMode()` is the escape hatch: the seeded demo keeps working
// exactly as before, with no credentials, because that is what it is for.

const SESSION_REFRESH_MS = 60_000;

export default function AuthGate({ children }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [notice, setNotice] = useState(null);

  const demo = isDemoMode();

  // On mount: a demo build is signed in by definition. A real build has
  // no session (tokens are never persisted), so it renders sign-in.
  useEffect(() => {
    const unsubscribe = subscribeToSession((session) => {
      setSignedIn(Boolean(session));
    });
    if (demo) {
      setSignedIn(true);
      setReady(true);
      return unsubscribe;
    }

    // A reload leaves nothing in this module — the access token was
    // memory-only — but the HttpOnly session cookie is still on the
    // browser. Attempt a restore, and only show the sign-in screen once
    // that has actually failed, so a refresh does not flash the form at
    // a user who is still signed in.
    //
    // No precondition on a prior session: "was I signed in" is exactly
    // what we no longer know.
    (async () => {
      if (isSignedIn()) {
        setSignedIn(true);
        setReady(true);
        return;
      }
      if (!hasSessionCookieHint()) {
        // No cookie, so there is nothing to restore. Skip the request
        // rather than make the server return a 400.
        setSignedIn(false);
        setReady(true);
        return;
      }
      const restored = await refreshSession().catch(() => false);
      setSignedIn(restored);
      setReady(true);
      if (!restored) {
        setNotice('Your session ended. Sign in to continue.');
      }
    })();

    return unsubscribe;
  }, [demo]);

  // Keep the access token fresh while the tab is open. A short-lived token
  // with no refresh would sign the user out mid-task; a long-lived one
  // would widen the window if it leaked.
  useEffect(() => {
    if (demo || !signedIn) return undefined;
    const tick = setInterval(() => {
      refreshSession().then((ok) => {
        if (!ok) setNotice('Your session expired. Sign in again.');
      });
    }, SESSION_REFRESH_MS);
    return () => clearInterval(tick);
  }, [demo, signedIn]);

  const handleSignIn = useCallback(
    async (creds) => {
      setNotice(null);
      return sessionSignIn(creds);
    },
    [],
  );

  const handleCompleteMfa = useCallback(async (input) => {
    setNotice(null);
    return sessionCompleteMfa(input);
  }, []);

  const handleSignOut = useCallback(async () => {
    const result = await sessionSignOut();
    setNotice(
      result.revoked
        ? 'Signed out. Your session was revoked on the server.'
        : 'Signed out on this device. The server session could not be reached.',
    );
  }, []);

  if (!ready) {
    // A brief, honest loading state rather than a flash of the sign-in
    // screen for an already-signed-in user.
    return (
      <div className="auth-screen" aria-busy="true">
        <p className="auth-notice">Loading…</p>
      </div>
    );
  }

  if (demo || signedIn) {
    return (
      <AuthedApp
        onSignOut={demo ? undefined : handleSignOut}
        canSwitchRole={demo && isDemoRoleSwitcherEnabled()}
      >
        {children}
      </AuthedApp>
    );
  }

  return (
    <SignInScreen
      onSignIn={handleSignIn}
      onCompleteMfa={handleCompleteMfa}
      onSignedOutNotice={notice}
    />
  );
}

/**
 * The application plus a session context, so a view can read the identity
 * the BACKEND returned rather than picking one.
 */
function AuthedApp({ children, onSignOut, canSwitchRole }) {
  const [user, setUser] = useState(() => getSession()?.user ?? null);

  useEffect(() => subscribeToSession((session) => setUser(session?.user ?? null)), []);

  return (
    <SessionContext.Provider value={{ user, onSignOut, canSwitchRole }}>
      {children}
    </SessionContext.Provider>
  );
}

export const SessionContext = createContext({
  user: null,
  onSignOut: undefined,
  canSwitchRole: false,
});

/** The signed-in identity, as the backend reported it. */
export const useSessionUser = () => useContext(SessionContext).user;
export const useCanSignOut = () => typeof useContext(SessionContext).onSignOut === 'function';
export const useCanSwitchRole = () => useContext(SessionContext).canSwitchRole;
