import { prisma } from '../lib/prisma.js';

export async function userRoutes(app) {
  app.get(
    '/me',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              role: { type: 'string' },
              name: { type: 'string' },
              avatarUrl: { type: 'string', nullable: true },
              phone: { type: 'string', nullable: true },
              timezone: { type: 'string', nullable: true },
              clientAccountIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Present only when role is CLIENT',
              },
              googleEmail: { type: 'string', nullable: true },
              googleLinkedAt: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { user } = request;
      const profile = {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        avatarUrl: user.avatarUrl ?? null,
        phone: user.phone ?? null,
        timezone: user.timezone ?? null,
      };

      if (user.role === 'CLIENT') {
        const clientUsers = await prisma.clientUser.findMany({
          where: { userId: user.id },
          select: { clientId: true },
        });
        profile.clientAccountIds = clientUsers.map((cu) => cu.clientId);
        profile.googleEmail = user.googleEmail ?? null;
        profile.googleLinkedAt = user.googleLinkedAt ?? null;
      }

      return reply.send(profile);
    }
  );
}
