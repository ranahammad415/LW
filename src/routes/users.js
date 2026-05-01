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
                description: 'Client IDs this user has access to (CLIENT or OWNER linked via ClientUser).',
              },
              hasClientAccess: { type: 'boolean' },
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
        hasClientAccess: false,
      };

      // Populate clientAccountIds for ANY user with ClientUser rows (CLIENT or
      // OWNER acting as client manager). Admin shell uses hasClientAccess to
      // decide whether to render the client switcher.
      const clientUsers = await prisma.clientUser.findMany({
        where: { userId: user.id },
        select: { clientId: true },
      });
      if (clientUsers.length > 0) {
        profile.clientAccountIds = clientUsers.map((cu) => cu.clientId);
        profile.hasClientAccess = true;
      }

      if (user.role === 'CLIENT') {
        profile.googleEmail = user.googleEmail ?? null;
        profile.googleLinkedAt = user.googleLinkedAt ?? null;
      }

      return reply.send(profile);
    }
  );

  // List every client account this user can act on (for the OWNER switcher
  // dropdown). Any authenticated user with ClientUser rows can query this.
  app.get(
    '/me/client-accounts',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    clientId: { type: 'string' },
                    clientName: { type: 'string' },
                    role: { type: 'string' },
                    isPrimaryContact: { type: 'boolean' },
                    canApproveDeliverables: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const links = await prisma.clientUser.findMany({
        where: { userId: request.user.id },
        select: {
          clientId: true,
          role: true,
          isPrimaryContact: true,
          canApproveDeliverables: true,
          client: { select: { agencyName: true } },
        },
        orderBy: { addedAt: 'asc' },
      });
      return reply.send({
        items: links.map((cu) => ({
          clientId: cu.clientId,
          clientName: cu.client?.agencyName ?? '',
          role: cu.role,
          isPrimaryContact: !!cu.isPrimaryContact,
          canApproveDeliverables: !!cu.canApproveDeliverables,
        })),
      });
    }
  );
}
