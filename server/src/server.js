// Server entry point.

import { buildApp } from './app.js';
import { config, assertSafeToStart, assertDatabaseTlsUsable } from './config/index.js';

// Fail closed before binding a port. A misconfigured production
// deploy (dev auth on, or no JWT secret) must stop rather than serve.
// See docs/ENVIRONMENT.md and docs/PRODUCTION_LAUNCH_CHECKLIST.md §0.3.
assertSafeToStart();

// Resolve the database TLS settings now rather than on the first query.
// Without this a bad DB_SSL_CA_FILE — a typo'd path, a bundle that was
// never mounted into the container — would let the server boot, bind a
// port and report itself healthy on /health, then fail every request that
// touched the database. resolveSsl() is what turns those into the
// operator-facing errors, and it is pure, so this costs nothing.
//
// Only validated when a database is configured: a deployment with no
// DATABASE_URL is a supported degraded mode, not an error.
assertDatabaseTlsUsable();

const app = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { host: config.host, port: config.port, env: process.env.NODE_ENV ?? 'development' },
    'Joldipabo backend listening',
  );
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}

// Graceful shutdown — close the server and drain the DB pool
// on SIGTERM / SIGINT.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      const { closeDb } = await import('./db/client.js');
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  });
}
