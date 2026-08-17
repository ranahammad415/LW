/**
 * Access control for staff (Owner / PM) reaching into a client's knowledge base.
 *
 * The client-facing knowledge routes resolve their client from the caller's own
 * ClientUser links. Staff have no such link, so they address a client by id in
 * the path and these guards decide whether that is allowed:
 *
 *   - OWNER: any client, read and write.
 *   - PM:    read-only, and only clients they lead or second.
 *
 * Both guards attach request.knowledgeClientId, which the route handlers read
 * instead of deriving a client themselves.
 */
import { prisma } from './prisma.js';

const STAFF_ROLES = ['OWNER', 'PM'];

async function resolveStaffScope(request, reply, { write }) {
  const role = request.user?.role;
  if (!STAFF_ROLES.includes(role)) {
    return reply.status(403).send({ message: 'PM or Owner access required' });
  }

  const clientId = request.params?.clientId;
  if (!clientId) {
    return reply.status(400).send({ message: 'A client id is required' });
  }

  if (role === 'PM') {
    if (write) {
      return reply
        .status(403)
        .send({ message: 'PMs have read-only access to a client knowledge base' });
    }
    const owned = await prisma.clientAccount.findFirst({
      where: {
        id: clientId,
        OR: [{ leadPmId: request.user.id }, { secondaryPmId: request.user.id }],
      },
      select: { id: true },
    });
    if (!owned) {
      return reply.status(403).send({ message: 'No access to this client' });
    }
  } else {
    const exists = await prisma.clientAccount.findUnique({
      where: { id: clientId },
      select: { id: true },
    });
    if (!exists) {
      return reply.status(404).send({ message: 'Client not found' });
    }
  }

  request.knowledgeClientId = clientId;
}

export async function requireStaffKnowledgeRead(request, reply) {
  return resolveStaffScope(request, reply, { write: false });
}

export async function requireStaffKnowledgeWrite(request, reply) {
  return resolveStaffScope(request, reply, { write: true });
}

/**
 * Clients a staff user may open a knowledge base for. Owners get everything.
 */
export async function listStaffKnowledgeClients(request) {
  const role = request.user?.role;
  if (!STAFF_ROLES.includes(role)) return [];

  const where =
    role === 'OWNER'
      ? {}
      : { OR: [{ leadPmId: request.user.id }, { secondaryPmId: request.user.id }] };

  return prisma.clientAccount.findMany({
    where,
    select: { id: true, agencyName: true, websiteUrl: true, industry: true, intakeStatus: true },
    orderBy: { agencyName: 'asc' },
  });
}
