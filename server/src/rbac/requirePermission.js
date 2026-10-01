// Permission Fastify hook factory.
//
// Usage:
//   import { requirePermission } from '../rbac/requirePermission.js';
//   fastify.get('/api/v1/leads', {
//     preHandler: requirePermission('leads', 'view'),
//   }, handler);
//
// Behaviour:
//   * On a request without req.user (auth middleware did not run), reply 401.
//   * On scope NONE, reply 403 with code 'forbidden'.
//   * On any other scope, attach req.scope to the request and continue.
//   * Fail-closed — never defaults to allow.
//
// The handler is still responsible for calling `can(user, resource, action, record)`
// on row-level operations. This hook only enforces the coarse, route-level
// "may this user attempt this action at all" check.

import { Forbidden, Unauthorized } from '../utils/errors.js';
import { can, scopeOf } from './permissions.js';

/**
 * Returns a Fastify preHandler that checks the user's matrix for
 * (resource, action). Attach `req.user` before this hook runs.
 *
 * @param {string} resource
 * @param {string} action
 * @returns {(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
export function requirePermission(resource, action) {
  return async function preHandler(req, reply) {
    const user = req.user;
    if (!user) {
      throw new Unauthorized('unauthorized', 'Authentication required.');
    }

    const scope = scopeOf(user, resource, action);
    if (scope === 'none') {
      throw new Forbidden('forbidden', `Missing permission for ${resource}.${action}.`, {
        resource, action,
      });
    }

    // Stash on the request so handlers and the response shaper can read it
    // without re-computing.
    req.permission = { resource, action, scope };
  };
}

/**
 * Row-level guard. Call from a handler after loading the target record.
 *
 * @param {import('fastify').FastifyRequest} req
 * @param {string} resource
 * @param {string} action
 * @param {object} record
 */
export function assertCanOnRecord(req, resource, action, record) {
  const user = req.user;
  if (!user) {
    throw new Unauthorized('unauthorized', 'Authentication required.');
  }
  if (!can(user, resource, action, record)) {
    throw new Forbidden('forbidden', `Cannot ${action} this ${resource}.`, {
      resource, action, recordId: record?.id ?? null,
    });
  }
}
