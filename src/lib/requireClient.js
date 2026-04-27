import { prisma } from './prisma.js';

/**
 * Requires request.user.role === 'CLIENT' and attaches client context.
 * After this middleware, request has:
 *   - request.clientAccountIds: string[] (all client IDs for this user)
 *   - request.clientUserRoles: Array<{ clientId, role, isPrimaryContact, canApproveDeliverables }>
 */
export async function requireClient(request, reply) {
  if (request.user?.role !== 'CLIENT') {
    return reply.status(403).send({ message: 'Client access required' });
  }
  const clientUsers = await prisma.clientUser.findMany({
    where: { userId: request.user.id },
    select: { clientId: true, role: true, isPrimaryContact: true, canApproveDeliverables: true },
  });
  if (clientUsers.length === 0) {
    return reply.status(403).send({ message: 'No client account linked' });
  }
  request.clientAccountIds = clientUsers.map((cu) => cu.clientId);
  request.clientUserRoles = clientUsers;
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
