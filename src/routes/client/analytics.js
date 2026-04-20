import { prisma } from '../../lib/prisma.js';

const MOCK_LOOKER_EMBEDS = [
  { id: 'mock-1', label: 'SEO Dashboard', url: 'https://lookerstudio.google.com/embed/reporting/placeholder', sortOrder: 0 },
  { id: 'mock-2', label: 'Traffic Overview', url: 'https://lookerstudio.google.com/embed/reporting/placeholder-2', sortOrder: 1 },
];

export async function clientAnalyticsRoutes(app) {
  app.get(
    '/analytics',
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
                label: { type: 'string' },
                url: { type: 'string' },
                sortOrder: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.id;

      // Look up user's Google email
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { googleEmail: true },
      });

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });

      if (clientUsers.length === 0) {
        return reply.send([]);
      }

      const clientIds = clientUsers.map((cu) => cu.clientId);

      // Check if any client account has analyticsGoogleEmail set
      const clientAccounts = await prisma.clientAccount.findMany({
        where: { id: { in: clientIds } },
        select: { analyticsGoogleEmail: true },
      });

      const requiredEmail = clientAccounts.find((c) => c.analyticsGoogleEmail)?.analyticsGoogleEmail;

      if (requiredEmail) {
        // Analytics access requires matching Google email
        if (!user?.googleEmail || user.googleEmail.toLowerCase() !== requiredEmail.toLowerCase()) {
          return reply.status(403).send({
            message: 'Google authentication required',
            code: 'GOOGLE_AUTH_REQUIRED',
            requiredEmail,
          });
        }
      }

      const embeds = await prisma.lookerEmbed.findMany({
        where: { clientId: { in: clientIds }, isActive: true },
        orderBy: { sortOrder: 'asc' },
      });

      if (embeds.length === 0) {
        return reply.send(
          MOCK_LOOKER_EMBEDS.map((e) => ({
            id: e.id,
            label: e.label,
            url: e.url,
            sortOrder: e.sortOrder,
          }))
        );
      }

      return reply.send(
        embeds.map((e) => ({
          id: e.id,
          label: e.label,
          url: e.url,
          sortOrder: e.sortOrder,
        }))
      );
    }
  );
}
