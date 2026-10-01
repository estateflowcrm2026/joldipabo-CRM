// /api/v1/sync — offline-queue replay endpoint.
//
// Accepts the same five action types as the frontend queue
// (docs/OFFLINE_QUEUE_CONTRACT.md §3):
//   * attendance.checkIn
//   * attendance.checkOut
//   * visit.update
//   * photo.upload
//   * message.send
//
// Each request is expected to carry an `Idempotency-Key` header so the
// server can dedupe replayed items. The handler runs the matching
// route's handler inline — auth + scope check + audit — and returns
// the same shape the equivalent REST endpoint would.
//
// See docs/SYNC_WORKER_PLAN.md §3.

import { authMiddleware } from '../auth/authMiddleware.js';
import { BadRequest, NotImplemented } from '../utils/errors.js';

const SUPPORTED_TYPES = new Set([
  'attendance.checkIn',
  'attendance.checkOut',
  'visit.update',
  'photo.upload',
  'message.send',
]);

/** @param {import('fastify').FastifyInstance} fastify */
export default async function syncRoutes(fastify) {
  fastify.post('/sync', { preHandler: authMiddleware }, async (req) => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.length === 0) {
      throw new BadRequest('missing-field', 'Idempotency-Key header is required.');
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) {
      throw new BadRequest('invalid-payload', 'Body must include an `items` array.');
    }
    for (const it of items) {
      if (!it || typeof it.type !== 'string' || !SUPPORTED_TYPES.has(it.type)) {
        throw new BadRequest('invalid-payload', `Unsupported sync action type: ${it?.type}`);
      }
    }

    // TODO: For each item, run the same handler as the corresponding
    // REST endpoint, inside one DB transaction per item. Reuse
    // Idempotency-Key for dedupe (24h cache).

    throw new NotImplemented('not-implemented', 'Sync replay is not wired yet.');
  });
}
