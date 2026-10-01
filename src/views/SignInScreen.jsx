import { useState, useCallback, useRef, useEffect } from 'react';
import { isDemoMode } from '../services/demoFlags.js';

// Sign-in, and the MFA challenge it can lead to.
//
// RESPONSIVE BY CONSTRUCTION
// --------------------------
// One layout, sized in `rem`, with the form column capped and centred. The
// field set is short (email, password, then six digits) so nothing needs
// a different arrangement on a phone — the only real change is the input
// mode and the key layout, both handled below. No `useMediaQuery`, no
// duplicated markup, so the two cannot drift.
//
// The MFA code field is `inputMode="numeric"` and `autocomplete="one-time-code"`
// so a phone offers the keypad and the OS autofills from an SMS or a
// push. That is the single biggest ergonomic win on mobile and it costs
// one attribute.
//
// The error surface is a live region so a screen reader announces the
// failure, and `aria-invalid` marks the offending field. A silent failure
// on a login form is indistinguishable from "it didn't work".

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Field({ id, label, inputRef, ...props }) {
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} ref={inputRef} {...props} />
    </div>
  );
}

/**
 * @param {object} props
 * @param {(creds: {email: string, password: string}) => Promise<object>} props.onSignIn
 *        resolves to a `signIn()` result: authenticated, mfa-required, error
 * @param {(input: {challengeToken: string, code: string}) => Promise<object>} props.onCompleteMfa
 * @param {(msg: string) => void} [props.onSignedOutNotice] shown after a session ends
 */
export default function SignInScreen({ onSignIn, onCompleteMfa, onSignedOutNotice }) {
  const [step, setStep] = useState('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(onSignedOutNotice ?? null);
  const codeRef = useRef(null);

  // Move focus to the code field when the challenge appears, so a
  // keyboard or switch user is not left on a hidden field.
  useEffect(() => {
    if (step === 'challenge' && codeRef.current) codeRef.current.focus();
  }, [step]);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err?.message ?? 'Something went wrong. Try again.');
      return { status: 'error', code: err?.code ?? 'unknown' };
    } finally {
      setBusy(false);
    }
  }, []);

  const submitCredentials = async (event) => {
    event.preventDefault();
    if (busy) return;

    // Client-side shape check only. The server is the authority; this
    // just avoids a pointless round trip and gives an immediate message.
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }

    const result = await run(() =>
      onSignIn({ email: email.trim(), password }),
    );

    if (result.status === 'authenticated') return;
    if (result.status === 'mfa-required') {
      setChallenge(result.challengeToken);
      setStep('challenge');
      setCode('');
      setError(null);
      return;
    }
    // A specific, non-blaming message. "Invalid email or password" is
    // what the server says on purpose, so the UI must not imply which
    // half was wrong.
    setError(result.message ?? 'Sign-in failed.');
  };

  const submitCode = async (event) => {
    event.preventDefault();
    if (busy || !challenge) return;

    const digits = code.replace(/\D/g, '');
    if (digits.length < 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    const result = await run(() =>
      onCompleteMfa({ challengeToken: challenge, code: digits }),
    );

    if (result.status === 'authenticated') return;
    if (result.code === 'mfa-attempts-exhausted' || result.code === 'invalid-challenge') {
      // The challenge is gone. Send them back to credentials rather than
      // letting them type into a field that can no longer succeed.
      setChallenge(null);
      setStep('credentials');
      setCode('');
      setError('That sign-in attempt expired. Sign in again.');
      return;
    }
    setCode('');
    setError(result.message ?? 'That code is not valid.');
  };

  const onChallenge = step === 'challenge';

  return (
    <div className="auth-screen" data-testid="sign-in-screen">
      <div className="auth-card">
        <header className="auth-card__head">
          <h1>Joldipabo CRM</h1>
          {isDemoMode() ? <p className="auth-badge">Demo mode</p> : null}
        </header>

        {notice ? (
          <p className="auth-notice" role="status">{notice}</p>
        ) : null}

        {onChallenge ? (
          <form onSubmit={submitCode} noValidate aria-labelledby="mfa-title">
            <h2 id="mfa-title">Two-factor authentication</h2>
            <p className="auth-hint">
              Enter the 6-digit code from your authenticator app, or one of
              your backup codes.
            </p>
            <Field
              id="mfa-code"
              label="Authentication code"
              inputRef={codeRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              // `enterKeyHint` is the iOS equivalent; neither harms the other.
              enterKeyHint="done"
              maxLength={14}
              pattern="[0-9]*"
              autoFocus
              disabled={busy}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'auth-error' : undefined}
            />
            <div className="auth-actions">
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setChallenge(null);
                  setStep('credentials');
                  setCode('');
                  setError(null);
                }}
                disabled={busy}
              >
                Back
              </button>
              <button type="submit" className="auth-primary" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitCredentials} noValidate aria-labelledby="signin-title">
            <h2 id="signin-title">Sign in</h2>
            <Field
              id="email"
              label="Work email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              inputMode="email"
              enterKeyHint="next"
              disabled={busy}
              required
            />
            <Field
              id="password"
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              enterKeyHint="go"
              disabled={busy}
              required
            />
            <div className="auth-actions">
              <button type="submit" className="auth-primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>
        )}

        {/*
          role="alert" so the failure is announced rather than only
          being visible. aria-live alone is not enough: the element must
          be in the DOM before the text changes for most readers to
          notice.
        */}
        {error ? (
          <p id="auth-error" className="auth-error" role="alert">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
