// Readiness probe for GET /ready.
//
// Contract (docs/BACKEND_SCAFFOLD_STATUS.md, task spec):
// - DATABASE_URL missing            -> { status: 'ok', database: 'not-configured' } (200)
// - configured and reachable        -> { status: 'ok', database: 'connected' }      (200)
// - configured but down/unreachable -> 503 with the standard error envelope.

import { DB_NOT_CONFIGURED, isDbConfigured, query } from './client.js';
import { HttpError } from '../utils/errors.js';

/**
 * @returns {Promise<{ status: 'ok', database: 'not-configured' | 'connected' }>}
 * @throws {HttpError} 503 when the database is configured but unreachable.
 */
export async function checkReadiness() {
  if (!isDbConfigured()) {
    return { status: 'ok', database: 'not-configured' };
  }
  try {
    await query('SELECT 1 AS ok');
    return { status: 'ok', database: 'connected' };
  } catch (err) {
    if (err?.code === DB_NOT_CONFIGURED) {
      return { status: 'ok', database: 'not-configured' };
    }
    throw new HttpError(
      503,
      'database-unavailable',
      'Database is configured but unreachable.',
      { detail: err?.message ?? String(err) },
    );
  }
}
