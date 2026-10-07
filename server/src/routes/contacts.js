import { authMiddleware } from '../auth/authMiddleware.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { BadRequest } from '../utils/errors.js';
import { Forbidden } from '../utils/errors.js';
import { scopeOf } from '../rbac/permissions.js';
import { validateContact, validateCall } from '../repositories/contactValidation.js';
import { validateFollowUpFilters } from '../repositories/followUpValidation.js';
import { createContact, getContact, listContacts, listContactCalls, logContactCall, convertContactToLead } from '../repositories/contactsRepository.js';

export default async function contactRoutes(app) {
  const auth = [authMiddleware];
  const id = (req) => {
    if (!req.params?.id) throw new BadRequest('invalid-id', 'Contact id is required.');
    return req.params.id;
  };
  const canCreateWithoutProject = (req) => {
    if (scopeOf(req.user, 'leads', 'create') === 'project') {
      throw new Forbidden('project-required', 'Project-scoped contact intake is not available yet.');
    }
  };

  app.get('/contacts', { preHandler: [...auth, requirePermission('leads', 'view')] },
    (req) => {
      // Follow-up window filters power the daily queue (overdue / today /
      // upcoming). ownerId powers "my queue". Unknown query keys are
      // ignored here — the strict validator only governs the keys it
      // understands, matching the leads route's extractFilters contract.
      const query = req.query && typeof req.query === 'object' ? req.query : {};
      const pickString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      return listContacts(req.user, {
        q: pickString(query.q) ?? '',
        ownerId: pickString(query.ownerId),
        limit: query.limit,
        offset: query.offset,
        ...validateFollowUpFilters(query),
      });
    });

  app.get('/contacts/:id', { preHandler: [...auth, requirePermission('leads', 'view')] },
    (req) => getContact(req.user, id(req)));

  app.get('/contacts/:id/calls', { preHandler: [...auth, requirePermission('leads', 'view')] },
    (req) => listContactCalls(req.user, id(req), req.query));

  app.post('/contacts', { preHandler: [...auth, requirePermission('leads', 'create')] },
    async (req, reply) => {
      canCreateWithoutProject(req);
      return reply.code(201).send(await createContact(req.user, validateContact(req.body), req));
    });

  app.post('/contacts/:id/calls', { preHandler: [...auth, requirePermission('leads', 'edit')] },
    async (req, reply) => reply.code(201).send(await logContactCall(req.user, id(req), validateCall(req.body), req)));

  app.post('/contacts/:id/convert', { preHandler: [...auth, requirePermission('leads', 'create'), requirePermission('leads', 'edit')] },
    async (req) => {
      canCreateWithoutProject(req);
      return convertContactToLead(req.user, id(req), req);
    });
}
