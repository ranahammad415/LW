/**
 * GET /api/client/roi — Campaign ROI & value from database.
 * Middleware: verifyJwt, requireClient.
 */
import { prisma } from '../../lib/prisma.js';

export async function clientRoiRoutes(app) {
  app.get(
    '/roi',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              retainerCost: { type: 'number' },
              estimatedValueGenerated: { type: 'number' },
              leadValue: { type: 'number' },
              trafficValue: { type: 'number' },
              roiPercentage: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;

      const clientUser = await prisma.clientUser.findFirst({
        where: { userId },
        select: { clientId: true },
      });

      if (!clientUser) {
        return reply.status(404).send({ message: 'No client account linked' });
      }

      const roi = await prisma.clientROIConfig.findUnique({
        where: { clientId: clientUser.clientId },
      });

      if (!roi) {
        // Return zeros when no ROI config has been set by PM
        return reply.send({
          retainerCost: 0,
          estimatedValueGenerated: 0,
          leadValue: 0,
          trafficValue: 0,
          roiPercentage: 0,
        });
      }

      return reply.send({
        retainerCost: roi.retainerCost,
        estimatedValueGenerated: roi.estimatedValueGenerated,
        leadValue: roi.leadValue,
        trafficValue: roi.trafficValue,
        roiPercentage: roi.roiPercentage,
      });
    }
  );
}
