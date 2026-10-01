// Download the Supabase root CA so DB_SSL_CA_FILE can point at a real file.
//
//   node scripts/fetch-supabase-ca.js --host db.<project-ref>.supabase.co
//   node scripts/fetch-supabase-ca.js --host db.<ref>.supabase.co --out ./supabase-ca.pem
//   node scripts/fetch-supabase-ca.js --host db.<ref>.supabase.co --check
//
// WHY THIS EXISTS
// ---------------
// Supabase does not serve its CA at a stable public URL, and the
// certificate it presents is issued by a private hierarchy:
//
//     Supabase Root 2021 CA        (self-signed, isCA)
//       └─ Supabase Intermediate 2021 CA
//            └─ db.<project-ref>.supabase.co
//
// The root is not in any system trust store, so `verify-full` against a
// stock Node install fails with "self-signed certificate in certificate
// chain" — verified on 2026-09-27. The root has to be supplied.
//
// WHERE IT COMES FROM
// -------------------
// It is read from the TLS chain the Supabase endpoint itself presents,
// and the result is pinned to a known-good fingerprint before it is
// written. That is a deliberate trade-off: an operator must confirm the
// fingerprint against Supabase's published value (or the dashboard
// certificate) for the deployment they are building, because a CA
// fetched from a host an attacker controls is worthless.
//
// SECURITY OF THE FETCH
// ---------------------
// The first connection deliberately does NOT verify the certificate —
// that is the only way to read a chain whose root you do not yet have.
// Everything after that is anchored: the chain must terminate in a
// self-signed CA whose SHA-256 fingerprint is in the table below, and
// the write is refused if it is not. Without the pin this script would
// happily save an attacker's root CA.
//
// The fingerprint table must be updated when Supabase rotates. It is the
// one thing here that needs a human in the loop.

import { connect as tlsConnect } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Pinned Supabase roots.
 *
 * `sha256:<hex>` is the SHA-256 of the certificate's DER encoding — what
 * openssl calls the fingerprint and what Supabase publishes for its
 * managed certificate chain.
 *
 * Adding a root here is a deliberate act: read it from Supabase's own
 * documentation or dashboard, not from the machine running this script.
 */
const PINNED_ROOTS = new Map([
  [
    'Supabase Root 2021 CA',
    'sha256:807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa',
  ],
]);

const args = process.argv.slice(2);
const hostArg = args.includes('--host') ? args[args.indexOf('--host') + 1] : null;
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const CHECK_ONLY = args.includes('--check');

if (!hostArg) {
  console.error(
    'Usage: node scripts/fetch-supabase-ca.js --host db.<project-ref>.supabase.co\n' +
      '       node scripts/fetch-supabase-ca.js --host <host> --out <path>\n' +
      '       node scripts/fetch-supabase-ca.js --host <host> --check\n\n' +
      'Where <project-ref> is in your Supabase connection string, e.g.\n' +
      '  postgresql://postgres.abcdefghijklmnop:...@aws-0-eu-west-1.pooler.supabase.com:5432/postgres\n' +
      '                     ^^^^^^^^^^^^^^^^^^\n\n' +
      'See docs/SUPABASE_VERIFICATION.md §5.',
  );
  process.exit(2);
}

const outPath = outArg ?? resolvePath(here, '..', 'certs', 'supabase-root-2021.pem');

/** Walk a presented chain to its self-signed root. */
function rootOf(peer) {
  let cur = peer;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    const next = cur.issuerCertificate;
    if (!next || next === cur) return cur;
    cur = next;
  }
  return null;
}

console.log(`\n[ca] connecting to ${hostArg}:5432 (certificate not verified — that is how the chain is read)`);

const socket = tlsConnect({ host: hostArg, port: 5432, servername: hostArg, rejectUnauthorized: false });

const finish = (code) => {
  socket.destroy();
  process.exit(code);
};

socket.setTimeout(20_000);
socket.on('timeout', () => {
  console.error(`[ca] timed out connecting to ${hostArg}:5432.`);
  console.error('    Supabase TLS does not speak TLS on connect; the negotiation is');
  console.error('    Postgres protocol SSLRequest. If this host is a pooler, use the');
  console.error('    DIRECT hostname instead: db.<project-ref>.supabase.co');
  finish(1);
});

socket.on('error', (err) => {
  console.error(`[ca] connection failed: ${err.message}`);
  finish(1);
});

socket.on('secureConnect', () => {
  const peer = socket.getPeerCertificate(true);
  const root = rootOf(peer);

  if (!root) {
    console.error('[ca] could not find a self-signed root in the presented chain.');
    finish(1);
  }

  // `getPeerCertificate` returns subject/issuer as objects on some Node
  // builds and as strings on others, so both are read through
  // X509Certificate, which is stable.
  const rootX = new X509Certificate(root.raw);
  const leafX = new X509Certificate(peer.raw);
  const cnOf = (x) => /CN=([^\n,]+)/.exec(x.subject)?.[1]?.trim() ?? '(no CN)';
  const cn = cnOf(rootX);
  const fp = createHash('sha256').update(root.raw).digest('hex');
  const selfSigned = rootX.subject === rootX.issuer;

  console.log(`[ca] leaf CN       ${cnOf(leafX)}`);
  console.log(`[ca] leaf issuer   ${/CN=([^\n,]+)/.exec(leafX.issuer)?.[1]?.trim() ?? '(no CN)'}`);
  console.log(`[ca] leaf valid to ${leafX.validTo}`);
  console.log(`[ca] root CN       ${cn}`);
  console.log(`[ca] root valid to ${rootX.validTo}`);
  console.log(`[ca] self-signed   ${selfSigned}`);
  console.log(`[ca] root sha256   ${fp}`);

  if (!selfSigned || !rootX.ca) {
    console.error('[ca] the chain does not end in a self-signed CA. Refusing to save it.');
    finish(1);
  }

  const pinned = PINNED_ROOTS.get(cn);
  if (!pinned) {
    console.error('');
    console.error(`[ca] REFUSING: "${cn}" is not in the pinned-root table in this script.`);
    console.error('');
    console.error('    A CA downloaded from a host an attacker controls is worthless, so');
    console.error('    nothing is written until a human confirms the fingerprint against');
    console.error("    Supabase's own documentation or dashboard certificate, and adds it to");
    console.error('    PINNED_ROOTS in scripts/fetch-supabase-ca.js.');
    console.error('');
    console.error('    The fingerprint of what THIS host presented:');
    console.error(`      sha256:${fp}`);
    console.error('');
    console.error('    If you have confirmed it, add:');
    console.error(`      [${JSON.stringify(cn)}, 'sha256:${fp}'],`);
    console.error('    and re-run. See docs/SUPABASE_VERIFICATION.md §5.');
    finish(1);
  }

  if (pinned.replace('sha256:', '') !== fp) {
    console.error('');
    console.error('[ca] REFUSING: fingerprint mismatch against the pinned value.');
    console.error(`  presented  sha256:${fp}`);
    console.error(`  pinned     ${pinned}`);
    console.error('');
    console.error('    Either Supabase rotated its root and PINNED_ROOTS needs updating,');
    console.error('    or the endpoint is not the Supabase database you think it is.');
    finish(1);
  }

  console.log(`[ca] fingerprint matches the pinned value for "${cn}".`);

  if (CHECK_ONLY) {
    console.log('\n[ca] --check: nothing written.');
    finish(0);
  }

  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    root.raw.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, pem);

  console.log(`[ca] wrote ${outPath}`);
  console.log('');
  console.log('    Set these in the environment that runs the server:');
  console.log('      DB_SSL_MODE=verify-full');
  console.log(`      DB_SSL_CA_FILE=${outPath}`);
  console.log('      DB_SSL_REJECT_UNAUTHORIZED=true');
  console.log('');
  console.log('    Then: node --env-file=.env scripts/check-db-ssl.js --connect');
  finish(0);
});
