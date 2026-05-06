import { prisma } from '../../lib/prisma.js';
import { aggregateProject, aggregateAgency, monthToRange } from '../../lib/monthlyReport/aggregator.js';
import { summarize } from '../../lib/monthlyReport/summarizer.js';

/**
 * Owner-only monthly project activity reports.
 * Endpoints are mounted under /api/admin.
 */
export async function adminActivityReportRoutes(app) {
  // ── List active projects + whether a cached report exists for the month ──
  app.get(
    '/activity-reports/projects',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const month = String(request.query?.month || '').trim();
      try {
        monthToRange(month);
      } catch (err) {
        return reply.status(400).send({ message: 'Invalid month, expected YYYY-MM' });
      }

      const [projects, existing] = await Promise.all([
        prisma.project.findMany({
          where: { status: { in: ['SETUP', 'ACTIVE', 'PAUSED'] } },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            status: true,
            projectType: true,
            client: { select: { id: true, agencyName: true } },
            leadPm: { select: { id: true, name: true } },
          },
        }),
        prisma.projectActivityReport.findMany({
          where: { month },
          select: { id: true, scope: true, projectId: true, createdAt: true },
        }),
      ]);

      const cachedByProject = new Map();
      let cachedAgency = null;
      for (const r of existing) {
        if (r.scope === 'AGENCY') cachedAgency = r;
        else if (r.projectId) cachedByProject.set(r.projectId, r);
      }

      return reply.send({
        month,
        agency: cachedAgency ? { id: cachedAgency.id, createdAt: cachedAgency.createdAt } : null,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          projectType: p.projectType,
          client: p.client,
          leadPm: p.leadPm,
          cachedReport: cachedByProject.get(p.id)
            ? {
                id: cachedByProject.get(p.id).id,
                createdAt: cachedByProject.get(p.id).createdAt,
              }
            : null,
        })),
      });
    }
  );

  // ── Generate (or regenerate) a report ──
  app.post(
    '/activity-reports/generate',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const body = request.body || {};
      const month = String(body.month || '').trim();
      const projectId = body.projectId ? String(body.projectId) : null;

      let range;
      try {
        range = monthToRange(month);
      } catch (err) {
        return reply.status(400).send({ message: 'Invalid month, expected YYYY-MM' });
      }

      const scope = projectId ? 'PROJECT' : 'AGENCY';

      // Aggregate raw facts
      let facts;
      try {
        facts = projectId
          ? await aggregateProject({ projectId, from: range.from, to: range.to })
          : await aggregateAgency({ from: range.from, to: range.to });
      } catch (err) {
        if (err.message === 'Project not found') {
          return reply.status(404).send({ message: 'Project not found' });
        }
        request.log.error({ err }, 'Activity report aggregation failed');
        return reply.status(500).send({ message: 'Aggregation failed' });
      }

      // Summarize via AI (or fallback)
      const { aiJson, narrativeMd } = await summarize(facts);

      // Upsert on (scope, projectId, month)
      // Note: Prisma upsert with a composite unique on nullable column is tricky in MySQL,
      // so do find-then-update/create explicitly.
      const existing = await prisma.projectActivityReport.findFirst({
        where: { scope, projectId, month },
      });

      const data = {
        scope,
        projectId,
        month,
        factsJson: facts,
        aiJson: aiJson ?? undefined,
        narrativeMd,
        generatedBy: request.user?.id || 'system',
      };

      const saved = existing
        ? await prisma.projectActivityReport.update({
            where: { id: existing.id },
            data,
          })
        : await prisma.projectActivityReport.create({ data });

      return reply.send(saved);
    }
  );

  // ── Fetch a stored report ──
  app.get(
    '/activity-reports/:id',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const id = String(request.params.id);
      const report = await prisma.projectActivityReport.findUnique({ where: { id } });
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      return reply.send(report);
    }
  );

  // ── Export markdown ──
  app.get(
    '/activity-reports/:id/export',
    { onRequest: [app.verifyJwt, app.requireOwner] },
    async (request, reply) => {
      const id = String(request.params.id);
      const format = String(request.query?.format || 'md').toLowerCase();
      const report = await prisma.projectActivityReport.findUnique({ where: { id } });
      if (!report) return reply.status(404).send({ message: 'Report not found' });

      if (format !== 'md') {
        // PDF export is handled client-side via window.print() on the admin page,
        // so we only ship markdown from the server.
        return reply.status(400).send({
          message: 'Only format=md is supported server-side. Use print-to-PDF from the UI for PDF.',
        });
      }

      const filename = `activity-report-${report.scope.toLowerCase()}-${report.month}${
        report.projectId ? '-' + report.projectId.slice(0, 8) : ''
      }.md`;

      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(report.narrativeMd || '');
    }
  );
}
