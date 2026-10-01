// Outbound email.
//
// Transactional email is required for the account-lifecycle flows:
// without it, an invited user has no way to receive their link and a
// locked-out user has no way to recover. Sending is therefore pluggable
// and **dev-safe by default** — with no SMTP configured, messages are
// captured in memory and written to the log rather than dropped, so a
// local developer can complete the flow without a mail server.
//
// Three transports:
//
//   smtp    — a real SMTP server. `SMTP_HOST` set. Uses node:net
//             directly; no dependency added for one send path.
//   log     — the default. Captured in a ring buffer and logged.
//   none    — `MAIL_TRANSPORT=none`. Captured but not logged, so a
//             staging environment does not put reset links in its logs.
//
// The ring buffer is what `GET /auth/dev/outbox` reads in non-production.
// It is refused outright in production: a reset token in an
// unauthenticated response is a password-takeover primitive.

import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';

const MAX_OUTBOX = 100;

/** @type {Array<{to: string, subject: string, body: string, sentAt: string}>} */
const outbox = [];

/** Which transport is active, resolved once. */
function transport() {
  const explicit = (process.env.MAIL_TRANSPORT || '').toLowerCase();
  if (explicit === 'none' || explicit === 'log') return explicit;
  if (process.env.SMTP_HOST) return 'smtp';
  return 'log';
}

/**
 * Capture a message for local inspection.
 *
 * @param {object} message
 */
function capture({ to, subject, body }) {
  outbox.push({ to, subject, body, sentAt: new Date().toISOString() });
  while (outbox.length > MAX_OUTBOX) outbox.shift();
}

/**
 * The messages captured so far, oldest first.
 *
 * @returns {Array<object>} a copy — the caller cannot mutate the buffer
 */
export function getOutbox() {
  return outbox.map((m) => ({ ...m }));
}

/** Empty the outbox. Used by tests and by the dev endpoint. */
export function clearOutbox() {
  outbox.length = 0;
}

/** Build the RFC 5322 message for a single recipient. */
function buildMime({ to, subject, body, from }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

/** Minimal SMTP conversation. Enough for AUTH LOGIN + a single DATA. */
function sendViaSmtp({ host, port, from, to, subject, body, user, pass, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: Number(port) || 587 });
    let step = 0;
    let buffer = '';
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error('SMTP timeout')), timeoutMs);

    const expect = (code, next, onDone) => () => {
      if (!buffer.startsWith(code)) {
        fail(new Error(`SMTP expected ${code}, got ${buffer.slice(0, 40)}`));
        return;
      }
      buffer = '';
      step += 1;
      try {
        next(onDone);
      } catch (err) {
        fail(err);
      }
    };

    const commands = [
      // greeting
      () => socket.write('EHLO joldipabo\r\n'),
      () => {
        if (user && pass) socket.write(`AUTH LOGIN\r\n`);
        else onCommand(3);
      },
      // AUTH LOGIN: base64 user, then base64 pass (issued by the server)
      (done) => {
        if (user && pass) socket.write(`${Buffer.from(user).toString('base64')}\r\n`);
        else done();
      },
      () => {
        if (user && pass) socket.write(`${Buffer.from(pass).toString('base64')}\r\n`);
        else onCommand(5);
      },
      () => socket.write(`MAIL FROM:<${from}>\r\n`),
      () => socket.write(`RCPT TO:<${to}>\r\n`),
      () => socket.write('DATA\r\n'),
      () => {
        const message = buildMime({ to, subject, body, from });
        socket.write(`${message}\r\n.\r\n`);
      },
      () => socket.write('QUIT\r\n'),
    ];

    function onCommand(index) {
      step = index;
      commands[index - 1]?.(() => {});
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n')) return;
      if (step === 0) { const f = expect('220'); f(); onCommand(1); return; }
      if (step === 1) { buffer = ''; onCommand(2); return; }
      if (step === 2) { buffer = ''; onCommand(3); return; }
      if (step === 3) { buffer = ''; onCommand(4); return; }
      if (step === 4) { buffer = ''; onCommand(5); return; }
      if (step === 5) { buffer = ''; onCommand(6); return; }
      if (step === 6) { buffer = ''; onCommand(7); return; }
      if (step === 7) { buffer = ''; onCommand(8); return; }
      if (step === 8) { buffer = ''; onCommand(9); return; }
      if (step === 9) {
        clearTimeout(timer);
        socket.end();
        resolve();
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Send an email.
 *
 * Never throws. A failed send is logged and the message is still
 * captured, because an invite that could not be delivered must not
 * crash the request that created it — the user record is already
 * committed, and an operator can re-send.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.body
 * @returns {Promise<{ sent: boolean, transport: string, error?: string }>}
 */
export async function sendMail({ to, subject, body }) {
  const mode = transport();
  const from = process.env.MAIL_FROM || 'no-reply@joldipabo.local';

  if (mode === 'none') {
    capture({ to, subject, body });
    return { sent: false, transport: 'none' };
  }

  if (mode === 'log') {
    capture({ to, subject, body });
    // In production the log transport would put reset tokens in the log
    // stream. The dev outbox is refused there, but the log is not, so
    // the URL is redacted and the operator is told where to find it.
    if (process.env.NODE_ENV === 'production') {
      console.log(`[mail:log] to=${to} subject=${subject}\n${redactLinks(body)}`);
    } else if (process.env.MAIL_VERBOSE !== '0') {
      console.log(`[mail:log] to=${to} subject=${subject}\n${body}`);
    }
    return { sent: false, transport: 'log' };
  }

  try {
    await sendViaSmtp({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from,
      to,
      subject,
      body,
    });
    capture({ to, subject, body });
    return { sent: true, transport: 'smtp' };
  } catch (err) {
    capture({ to, subject, body });
    console.error(`[mail:smtp] delivery failed to=${to}: ${err?.message ?? err}`);
    return { sent: false, transport: 'smtp', error: String(err?.message ?? err) };
  }
}

/** Replace absolute URLs with a placeholder. */
function redactLinks(body) {
  return String(body).replace(/https?:\/\/\S+/g, '[link redacted in production logs]');
}

// ---------------------------------------------------------------------------
// Message bodies
// ---------------------------------------------------------------------------

function appUrl(path, token) {
  const base = process.env.APP_BASE_URL || 'http://localhost:5173';
  return `${base.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

/**
 * Send an invitation.
 *
 * @returns {Promise<{ sent: boolean, transport: string }>}
 */
export async function sendInviteEmail({ to, name, inviterName, token, expiresAt }) {
  return sendMail({
    to,
    subject: 'You have been invited to Joldipabo CRM',
    body: [
      `Hello ${name},`,
      '',
      `${inviterName} has invited you to join Joldipabo CRM.`,
      '',
      'Set your password here:',
      appUrl('/accept-invite', token),
      '',
      `This link expires ${expiresAt}. If you were not expecting it, ignore this message —`,
      'the account stays unusable until someone with access issues a new invite.',
      '',
      '— Joldipabo CRM',
    ].join('\n'),
  });
}

/**
 * Send a password-reset link.
 *
 * @returns {Promise<{ sent: boolean, transport: string }>}
 */
export async function sendPasswordResetEmail({ to, name, token, expiresAt }) {
  return sendMail({
    to,
    subject: 'Reset your Joldipabo CRM password',
    body: [
      `Hello ${name},`,
      '',
      'Use this link to choose a new password:',
      appUrl('/reset-password', token),
      '',
      `This link expires ${expiresAt} and can be used once.`,
      '',
      'If you did not ask for a reset, no action is needed — your current',
      'password still works and no one has been given access to your account.',
      '',
      '— Joldipabo CRM',
    ].join('\n'),
  });
}

/**
 * Tell a user their session family was revoked after a token replay.
 *
 * @returns {Promise<{ sent: boolean, transport: string }>}
 */
export async function sendSecurityAlertEmail({ to, name, when }) {
  return sendMail({
    to,
    subject: 'Sign-in to your account was detected from two places',
    body: [
      `Hello ${name},`,
      '',
      'Someone presented a sign-in token that your account had already replaced.',
      'Treating that as a possible compromise, every session for your account',
      'has been signed out.',
      '',
      `Detected: ${when}`,
      '',
      'If this was you — for example on two devices at once — sign in again.',
      'If it was not you, reset your password immediately.',
      '',
      '— Joldipabo CRM',
    ].join('\n'),
  });
}
