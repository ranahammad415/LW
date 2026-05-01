import { prisma } from './prisma.js';

/**
 * Requires either a native CLIENT user OR an OWNER who has been explicitly
 * linked via ClientUser rows. Attaches client context to the request:
 *   - request.clientAccountIds:  string[] (client IDs available in this context)
 *   - request.clientUserRoles:   Array<{ clientId, role, isPrimaryContact, canApproveDeliverables }>
 *   - request.actingAsClient:    true when an OWNER is scoped to a client via X-Client-Id
 *
 * If an X-Client-Id header is present and matches one of the user's linked
 * clients, the context is narrowed to just that client. Unknown client id = 403.
 */
export async function requireClient(request, reply) {
  const role = request.user?.role;
  if (role !== 'CLIENT' && role !== 'OWNER') {
    return reply.status(403).send({ message: 'Client access required' });
  }
  const clientUsers = await prisma.clientUser.findMany({
    where: { userId: request.user.id },
    select: { clientId: true, role: true, isPrimaryContact: true, canApproveDeliverables: true },
  });
  if (clientUsers.length === 0) {
    return reply.status(403).send({ message: 'No client account linked' });
  }

  // Optional scope narrowing via X-Client-Id header (used by the OWNER switcher).
  const headerClientId = request.headers?.['x-client-id'];
  let scoped = clientUsers;
  let narrowed = false;
  if (headerClientId) {
    const match = clientUsers.find((cu) => cu.clientId === headerClientId);
    if (!match) {
      return reply.status(403).send({ message: 'Client scope not permitted' });
    }
    scoped = [match];
    narrowed = true;
  }

  request.clientAccountIds = scoped.map((cu) => cu.clientId);
  request.clientUserRoles = scoped;
  request.actingAsClient = role === 'OWNER' && narrowed;
}

/**
 * Use after requireClient. Blocks VIEWER-role client users from write operations.
 */
export async function requireClientWriter(request, reply) {
  if (!request.clientUserRoles) {
    return reply.status(403).send({ message: 'Client context not loaded' });
  }
  const isViewer = request.clientUserRoles.every((cu) => cu.role === 'VIEWER');
  if (isViewer) {
    return reply.status(403).send({ message: 'Viewer accounts cannot perform this action' });
  }
}
