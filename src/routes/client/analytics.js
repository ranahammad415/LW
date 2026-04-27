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

      // Check if any analytics emails are configured (multi-email table first, legacy fallback)
      const analyticsEmailEntries = await prisma.clientAnalyticsEmail.findMany({
        where: { clientId: { in: clientIds } },
        select: { email: true },
      });
      let allowedEmails = analyticsEmailEntries.map((e) => e.email);

      // Fall back to legacy single-email field
      if (allowedEmails.length === 0) {
        const clientAccounts = await prisma.clientAccount.findMany({
          where: { id: { in: clientIds } },
          select: { analyticsGoogleEmail: true },
        });
        const legacyEmail = clientAccounts.find((c) => c.analyticsGoogleEmail)?.analyticsGoogleEmail;
        if (legacyEmail) allowedEmails = [legacyEmail];
      }

      if (allowedEmails.length > 0) {
        // Analytics access requires matching Google email to ANY allowed email
        const userEmail = user?.googleEmail?.toLowerCase();
        const hasAccess = userEmail && allowedEmails.some((e) => e.toLowerCase() === userEmail);
        if (!hasAccess) {
          return reply.status(403).send({
            message: 'Google authentication required',
            code: 'GOOGLE_AUTH_REQUIRED',
            requiredEmail: allowedEmails[0],
            allowedEmails,
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
