import { prisma } from '../../lib/prisma.js';

export async function clientReportRoutes(app) {
  app.get(
    '/reports',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                clientId: { type: 'string' },
                month: { type: 'integer' },
                year: { type: 'integer' },
                status: { type: 'string' },
                aiContent: { type: 'object', nullable: true },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;

      if (!clientIds?.length) {
        return reply.send([]);
      }

      const reports = await prisma.monthlyReport.findMany({
        where: {
          clientId: { in: clientIds },
          status: 'DELIVERED',
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      });

      return reply.send(
        reports.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          month: r.month,
          year: r.year,
          status: r.status,
          aiContent: r.aiContent,
          createdAt: r.createdAt.toISOString(),
        }))
      );
    }
  );
}
