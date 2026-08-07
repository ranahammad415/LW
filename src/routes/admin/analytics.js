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
  buildLeadsView,
} from '../../lib/analytics/sectionBuilders.js';
import { generateAiHtmlReport } from '../../lib/analytics/aiHtmlReport/index.js';
import {
  startAiVisibilityRun,
  getLatestAiVisibilityRun,
} from '../../lib/analytics/aiVisibilityRunner.js';
import { createAiVisibilityDemoRun } from '../../lib/analytics/aiVisibilityDemoSnapshot.js';
import {
  extractSiteFocusKeywords,
  loadProjectForSiteKeywords,
  normalizeProbeList,
} from '../../lib/analytics/aiVisibilitySiteKeywords.js';

/**
 * OWNER-scoped native analytics. Mirrors the client-facing native section
 * endpoints (routes/client/analytics.js) but keyed by an explicit :clientId so
 * an admin can view any client's Data-Bloo-style dashboard from the Analytics
 * tab. Uses the same section builders — no data-shape divergence.
 */
async function assertClientExists(clientId, reply) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) {
    reply.status(404).send({ message: 'Client not found' });
    return false;
  }
  return true;
}

function sendSection(reply, result) {
  if (result?.status && result?.message) {
    return reply.status(result.status).send({ message: result.message });
  }
  return reply.send(result);
}

export async function adminAnalyticsRoutes(app) {
  const requireOwner = app.requireOwner;

  app.get(
    '/analytics/:clientId/overview',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildOverview([clientId], request.query));
    }
  );

  app.get(
    '/analytics/:clientId/native',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;

      const { cycle: cycleId, month, year } = request.query ?? {};
      const cycle = await resolveCycle({ cycleId, month, year });
      if (!cycle) return reply.status(404).send({ message: 'Work cycle not found' });

      const cycleMeta = {
        id: cycle.id,
        month: cycle.month,
        year: cycle.year,
        label: cycle.label,
        status: cycle.status,
      };

      if (cycle.status === 'CLOSED') {
        const snapshot = await prisma.workCycleAnalyticsSnapshot.findUnique({
          where: { workCycleId_clientId: { workCycleId: cycle.id, clientId } },
        });
        if (snapshot) {
          return reply.send({ cycle: cycleMeta, data: snapshot.data, source: 'frozen' });
        }
        const data = await buildClientAnalytics(clientId, cycle);
        return reply.send({ cycle: cycleMeta, data, source: 'computed' });
      }

      const data = await buildClientAnalytics(clientId, cycle);
      return reply.send({ cycle: cycleMeta, data, source: 'live' });
    }
  );

  app.get(
    '/analytics/:clientId/gsc/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildGscView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/ga4/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildGa4View([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/gmb/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildGmbView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/seo/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildSeoView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/llm/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildLlmView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/leads/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildLeadsView([clientId], view, request.query));
    }
  );

  /**
   * Crawl site + Claude: preview 10–15 focus keywords (no OpenRouter run).
   */
  app.post(
    '/analytics/:clientId/projects/:projectId/ai-visibility/preview-queries',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, projectId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;

      const project = await loadProjectForSiteKeywords(projectId, clientId);
      if (!project) return reply.status(404).send({ message: 'Project not found for this client' });

      try {
        const preview = await extractSiteFocusKeywords(project);
        return reply.send({
          siteUrl: preview.siteUrl,
          targetMarket: preview.targetMarket,
          marketSource: preview.marketSource,
          pagesSource: preview.pagesSource,
          pagesCrawled: preview.pagesCrawled,
          pageUrls: preview.pageUrls,
          queries: preview.queries,
        });
      } catch (err) {
        request.log.error({ err }, 'AI Visibility preview-queries failed');
        return reply.status(err.status || 500).send({ message: err.message || 'Keyword preview failed' });
      }
    }
  );

  /**
   * Start OpenRouter + DataForSEO AI Visibility regenerate for a project.
   * Body: { probes: string[] } — confirmed queries from preview modal.
   * Persists until the next regenerate. 409 if a run is already in progress.
   */
  app.post(
    '/analytics/:clientId/projects/:projectId/ai-visibility/run',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, projectId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;

      const project = await prisma.project.findFirst({
        where: { id: projectId, clientId },
        select: { id: true, gscSiteUrl: true, dataforseoDomain: true },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found for this client' });

      const probes = normalizeProbeList(request.body?.probes || [], { min: 1, max: 20 });
      if (probes.length === 0) {
        return reply.status(400).send({
          message: 'probes array is required (confirm keywords from the preview modal)',
        });
      }

      try {
        const { run, started, conflict, probeCount, reused, partialReuse } = await startAiVisibilityRun({
          projectId,
          clientId,
          triggeredById: request.user?.id || null,
          probes,
        });

        if (conflict) {
          return reply.status(409).send({
            message: 'An AI Visibility run is already in progress for this project',
            run: {
              id: run.id,
              status: run.status,
              startedAt: run.startedAt,
              createdAt: run.createdAt,
            },
          });
        }

        if (reused) {
          return reply.status(200).send({
            message: 'Reusing AI Visibility results from the last 7 days (same queries)',
            run: {
              id: run.id,
              status: run.status,
              projectId: run.projectId,
              createdAt: run.createdAt,
              finishedAt: run.finishedAt,
              isDemo: !!run.isDemo,
            },
            probeCount,
            reused: true,
            costHint: 'No OpenRouter calls — same probe list cached for 7 days',
          });
        }

        return reply.status(202).send({
          message: started ? 'AI Visibility run started' : 'AI Visibility run queued',
          run: {
            id: run.id,
            status: run.status,
            projectId: run.projectId,
            createdAt: run.createdAt,
          },
          probeCount,
          partialReuse: !!partialReuse,
          costHint: partialReuse
            ? `Partial re-probe — unchanged queries reused; OpenRouter only for new/edited + DataForSEO`
            : `~${(probeCount || probes.length) * 4} OpenRouter calls + DataForSEO mentions pull`,
        });
      } catch (err) {
        return reply.status(err.status || 500).send({ message: err.message || 'Failed to start run' });
      }
    }
  );

  /**
   * Labeled sample/demo snapshot (no OpenRouter / DataForSEO).
   * Body: { probes: string[] }
   */
  app.post(
    '/analytics/:clientId/projects/:projectId/ai-visibility/demo',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, projectId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;

      const project = await prisma.project.findFirst({
        where: { id: projectId, clientId },
        select: { id: true },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found for this client' });

      const probes = normalizeProbeList(request.body?.probes || [], { min: 1, max: 20 });
      if (probes.length === 0) {
        return reply.status(400).send({
          message: 'probes array is required (confirm keywords from the preview modal)',
        });
      }

      try {
        const { run, probeCount, citationRate, targetRate } = await createAiVisibilityDemoRun({
          projectId,
          clientId,
          triggeredById: request.user?.id || null,
          probes,
        });
        return reply.status(201).send({
          message: 'Sample demo snapshot loaded',
          run: {
            id: run.id,
            status: run.status,
            projectId: run.projectId,
            createdAt: run.createdAt,
            finishedAt: run.finishedAt,
            isDemo: true,
          },
          probeCount,
          citationRate,
          targetRate,
          isDemo: true,
        });
      } catch (err) {
        if (err.status === 409) {
          return reply.status(409).send({
            message: err.message,
            run: err.run
              ? { id: err.run.id, status: err.run.status, createdAt: err.run.createdAt }
              : undefined,
          });
        }
        return reply.status(err.status || 500).send({ message: err.message || 'Failed to create demo' });
      }
    }
  );

  /** Poll latest AI Visibility run status for a project. */
  app.get(
    '/analytics/:clientId/projects/:projectId/ai-visibility/latest',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, projectId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;

      const project = await prisma.project.findFirst({
        where: { id: projectId, clientId },
        select: { id: true },
      });
      if (!project) return reply.status(404).send({ message: 'Project not found for this client' });

      const run = await getLatestAiVisibilityRun(projectId);
      if (!run) {
        return reply.send({ run: null, message: 'No AI Visibility run yet' });
      }

      return reply.send({
        run: {
          id: run.id,
          status: run.status,
          projectId: run.projectId,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          queryCount: run.queryCount,
          modelCount: run.modelCount,
          error: run.error,
          isDemo: !!run.isDemo,
          resultCount: run._count?.results || 0,
          hasDfs: !!run.dfs,
          createdAt: run.createdAt,
        },
      });
    }
  );

  /**
   * Generate a downloadable AI HTML performance report for a client + period.
   * Body: { start, end, compare?, compareYoY? } — download only (no ProjectHtmlReport publish).
   */
  app.post(
    '/analytics/:clientId/ai-html-report',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      const body = request.body || {};
      const start = typeof body.start === 'string' ? body.start.slice(0, 10) : null;
      const end = typeof body.end === 'string' ? body.end.slice(0, 10) : null;
      const compare = body.compare !== false && body.compare !== '0' && body.compare !== 'false';
      const compareYoY =
        body.compareYoY !== false && body.compareYoY !== '0' && body.compareYoY !== 'false';

      const result = await generateAiHtmlReport({
        clientIds: [clientId],
        start,
        end,
        compare,
        compareYoY,
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
