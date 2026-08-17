/**
 * Client picker for the staff-facing knowledge base. Owners see every client,
 * PMs only the ones they lead or second.
 */
import { prisma } from '../../lib/prisma.js';
import { listStaffKnowledgeClients } from '../../lib/knowledgeScope.js';

const STAFF_ROLES = ['OWNER', 'PM'];

async function requireStaff(request, reply) {
  if (!STAFF_ROLES.includes(request.user?.role)) {
    return reply.status(403).send({ message: 'PM or Owner access required' });
  }
}

export async function staffKnowledgeClientRoutes(app) {
  app.get('/knowledge/clients', { onRequest: [app.verifyJwt, requireStaff] }, async (request, reply) => {
    const clients = await listStaffKnowledgeClients(request);
    if (clients.length === 0) return reply.send({ clients: [] });

    // File counts come from the asset index rather than the disk so the picker
    // stays a single query no matter how many clients an owner has.
    const counts = await prisma.okfAssetIndex.groupBy({
      by: ['clientId'],
      where: { clientId: { in: clients.map((c) => c.id) } },
      _count: { _all: true },
    });
    const countByClient = new Map(counts.map((c) => [c.clientId, c._count._all]));

    return reply.send({
      clients: clients.map((c) => ({
        id: c.id,
        agencyName: c.agencyName,
        websiteUrl: c.websiteUrl,
        industry: c.industry,
        intakeStatus: c.intakeStatus,
        fileCount: countByClient.get(c.id) ?? 0,
      })),
      canWrite: request.user.role === 'OWNER',
    });
  });
}

export default staffKnowledgeClientRoutes;
