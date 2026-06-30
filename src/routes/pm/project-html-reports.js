import {
  canPmAccessProject,
  deleteProjectHtmlReport,
  findHtmlReportByProjectMonth,
  getHtmlReportWithRelations,
  serializeHtmlReport,
  upsertProjectHtmlReport,
} from '../../lib/projectHtmlReport.js';
import { isValidReportMonth } from '../../lib/htmlReportUpload.js';
import { parseHtmlReportMultipart } from '../../lib/parseHtmlReportMultipart.js';

export async function pmProjectHtmlReportRoutes(app) {
  app.get(
    '/project-html-reports',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const projectId = String(request.query?.projectId || '').trim();
      const month = String(request.query?.month || '').trim();
      if (!projectId || !isValidReportMonth(month)) {
        return reply.status(400).send({ message: 'projectId and month (YYYY-MM) are required' });
      }
      if (!(await canPmAccessProject(request.user, projectId))) {
        return reply.status(403).send({ message: 'Access denied' });
      }
      const report = await findHtmlReportByProjectMonth(projectId, month);
      if (!report) return reply.send(null);
      return reply.send(serializeHtmlReport(report));
    },
  );

  app.post(
    '/project-html-reports',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      try {
        const { buffer, fileName, mimetype, projectId, month } = await parseHtmlReportMultipart(request);
        if (!(await canPmAccessProject(request.user, projectId))) {
          return reply.status(403).send({ message: 'Access denied' });
        }
        const report = await upsertProjectHtmlReport({
          projectId,
          month,
          fileName,
          mimetype,
          buffer,
          uploadedById: request.user.id,
        });
        return reply.status(201).send(serializeHtmlReport(report));
      } catch (err) {
        const code = err.statusCode || 500;
        return reply.status(code).send({ message: err.message || 'Upload failed' });
      }
    },
  );

  app.delete(
    '/project-html-reports/:id',
    { onRequest: [app.verifyJwt, app.requirePM] },
    async (request, reply) => {
      const existing = await getHtmlReportWithRelations(request.params.id);
      if (!existing) return reply.status(404).send({ message: 'Report not found' });
      if (!(await canPmAccessProject(request.user, existing.projectId))) {
        return reply.status(403).send({ message: 'Access denied' });
      }
      await deleteProjectHtmlReport(existing.id);
      return reply.send({ ok: true });
    },
  );
}
