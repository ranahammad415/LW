import { prisma } from '../../lib/prisma.js';
import {
  canClientAccessHtmlReport,
  getHtmlReportContent,
  getHtmlReportWithRelations,
  serializeHtmlReport,
} from '../../lib/projectHtmlReport.js';
import { HTML_REPORT_VIEW_CSP } from '../../lib/htmlReportUpload.js';
import { readMonthlyReportPdf } from '../../lib/monthlyReport/renderFormalPdf.js';

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
                hasPdf: { type: 'boolean' },
                pdfFileName: { type: 'string', nullable: true },
                pdfFileSize: { type: 'integer', nullable: true },
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
          hasPdf: Boolean(r.pdfStoredPath),
          pdfFileName: r.pdfFileName ?? null,
          pdfFileSize: r.pdfFileSize ?? null,
        })),
      );
    },
  );

  app.get(
    '/reports/:id/pdf',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const clientIds = request.clientAccountIds || [];
      const report = await prisma.monthlyReport.findUnique({ where: { id: request.params.id } });
      if (!report || report.status !== 'DELIVERED') {
        return reply.status(404).send({ message: 'Report not found' });
      }
      if (!clientIds.includes(report.clientId)) {
        return reply.status(403).send({ message: 'Access denied' });
      }
      if (!report.pdfStoredPath) {
        return reply.status(404).send({ message: 'PDF not available' });
      }
      const buf = readMonthlyReportPdf(report.pdfStoredPath);
      if (!buf) return reply.status(404).send({ message: 'PDF file missing' });
      const safeName = (report.pdfFileName || 'report.pdf').replace(/[^\w.\-() ]+/g, '_');
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${safeName}"`)
        .send(buf);
    },
  );

  app.get(
    '/html-reports',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientIds = request.clientAccountIds || [];
      if (!clientIds.length) return reply.send([]);

      const projects = await prisma.project.findMany({
        where: { clientId: { in: clientIds } },
        select: { id: true },
      });
      const projectIds = projects.map((p) => p.id);
      if (!projectIds.length) return reply.send([]);

      const reports = await prisma.projectHtmlReport.findMany({
        where: {
          status: 'DELIVERED',
          projectId: { in: projectIds },
        },
        orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
        include: {
          project: { select: { id: true, name: true } },
          uploadedBy: { select: { id: true, name: true } },
        },
      });

      return reply.send(reports.map(serializeHtmlReport));
    },
  );

  app.get(
    '/html-reports/:id/view',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const report = await getHtmlReportWithRelations(request.params.id);
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await canClientAccessHtmlReport(request.clientAccountIds, report))) {
        return reply.status(403).send({ message: 'Access denied' });
      }
      const html = getHtmlReportContent(report);
      if (!html) return reply.status(404).send({ message: 'Report file not found' });
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Security-Policy', HTML_REPORT_VIEW_CSP)
        .send(html);
    },
  );

  app.get(
    '/html-reports/:id/download',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const report = await getHtmlReportWithRelations(request.params.id);
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await canClientAccessHtmlReport(request.clientAccountIds, report))) {
        return reply.status(403).send({ message: 'Access denied' });
      }
      const html = getHtmlReportContent(report);
      if (!html) return reply.status(404).send({ message: 'Report file not found' });
      const safeName = report.fileName.replace(/[^\w.\-() ]+/g, '_') || 'report.html';
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${safeName}"`)
        .send(html);
    },
  );
}
