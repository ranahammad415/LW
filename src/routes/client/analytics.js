import { prisma } from '../../lib/prisma.js';
import { resolveCycle } from '../../lib/workCycle.js';
import { buildClientAnalytics } from '../../lib/analytics/freezeSnapshot.js';
import {
  buildOverview,
  buildGscView,
  buildGa4View,
  buildGmbView,
  buildSeoView,
  buildLlmView,
} from '../../lib/analytics/sectionBuilders.js';
import { generateAiHtmlReport } from '../../lib/analytics/aiHtmlReport/index.js';

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

      const clientIds = request.clientAccountIds;

      if (!clientIds?.length) {
        return reply.send([]);
      }

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

  // Native, cycle-aware analytics (replaces Looker embeds). Returns chart-ready
  // series from our own data (GSC time-series, tracked-keyword rankings, AI
  // visibility). Current session = live; past sessions = frozen snapshot.
  app.get(
    '/analytics/native',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.send({ cycle: null, data: null, source: 'none' });
      }
      // Primary client account drives the charts (most clients have one).
      const clientId = clientIds[0];

      const { cycle: cycleId, month, year } = request.query ?? {};
      const cycle = await resolveCycle({ cycleId, month, year });
      if (!cycle) {
        return reply.status(404).send({ message: 'Work cycle not found' });
      }

      const cycleMeta = {
        id: cycle.id,
        month: cycle.month,
        year: cycle.year,
        label: cycle.label,
        status: cycle.status,
      };

      // Past (closed) cycle → serve the frozen snapshot if one exists.
      if (cycle.status === 'CLOSED') {
        const snapshot = await prisma.workCycleAnalyticsSnapshot.findUnique({
          where: { workCycleId_clientId: { workCycleId: cycle.id, clientId } },
        });
        if (snapshot) {
          return reply.send({ cycle: cycleMeta, data: snapshot.data, source: 'frozen' });
        }
        // No snapshot was frozen — compute historical figures on the fly.
        const data = await buildClientAnalytics(clientId, cycle);
        return reply.send({ cycle: cycleMeta, data, source: 'computed' });
      }

      // Current (open) cycle → live figures.
      const data = await buildClientAnalytics(clientId, cycle);
      return reply.send({ cycle: cycleMeta, data, source: 'live' });
    }
  );

  async function sendSection(reply, result) {
    if (result?.status && result?.message) {
      return reply.status(result.status).send({ message: result.message });
    }
    return reply.send(result);
  }

  app.get('/analytics/overview', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.send({ linked: false, data: null, source: 'none' });
    return sendSection(reply, await buildOverview(clientIds, request.query));
  });

  app.get('/analytics/gsc/:view', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.send({ linked: false, data: null, source: 'none' });
    return sendSection(reply, await buildGscView(clientIds, request.params.view, request.query));
  });

  app.get('/analytics/ga4/:view', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.send({ linked: false, data: null, source: 'none' });
    return sendSection(reply, await buildGa4View(clientIds, request.params.view, request.query));
  });

  app.get('/analytics/gmb/:view', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.send({ linked: false, data: null, source: 'none' });
    return sendSection(reply, await buildGmbView(clientIds, request.params.view, request.query));
  });

  app.get('/analytics/seo/:view', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.send({ linked: false, data: null, source: 'none' });
    return sendSection(reply, await buildSeoView(clientIds, request.params.view, request.query));
  });

  app.get('/analytics/llm/:view', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.send({ linked: false, data: null, source: 'none' });
    return sendSection(reply, await buildLlmView(clientIds, request.params.view, request.query));
  });

  /**
   * Generate a downloadable AI HTML performance report for the selected period.
   * Body: { start, end, compare? } — does not publish to ProjectHtmlReport.
   */
  app.post(
    '/analytics/ai-html-report',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds;
      if (!clientIds?.length) {
        return reply.status(400).send({ message: 'No client in scope' });
      }
      const body = request.body || {};
      const start = typeof body.start === 'string' ? body.start.slice(0, 10) : null;
      const end = typeof body.end === 'string' ? body.end.slice(0, 10) : null;
      const compare = body.compare !== false && body.compare !== '0' && body.compare !== 'false';

      const result = await generateAiHtmlReport({
        clientIds,
        start,
        end,
        compare,
        userId: request.user?.id,
      });
      if (result.error) {
        return reply.status(result.error.status || 500).send({
          message: result.error.message,
          emptyReason: result.error.emptyReason,
        });
      }
      return reply.send({
        html: result.html,
        fileName: result.fileName,
        range: result.range,
        meta: result.meta,
      });
    }
  );
}
