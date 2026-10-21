/**
 * Client portal security view (plan §5.5, decision O-4). Prefix /api/client.
 * Scoped to the caller's client accounts (an OWNER acts on a client through X-Client-Id via requireClient).
 * Shown only for EmDash projects whose site reports capabilities.security; WordPress projects get {available: false}
 * (the UI shows nothing, not red). The response is an allow-list (lib/security/securityViews.js
 * buildClientSecurityView): no score, check id, evidence, remediation, log, version, host, setting or acknowledgement.
 */
import { prisma } from '../../lib/prisma.js';
import { clientSecurityView } from '../../lib/security/securityViews.js';
import { listSecurityReports, isReportMonth } from '../../lib/security/securityReport.js';
import { HTML_REPORT_VIEW_CSP } from '../../lib/htmlReportUpload.js';
import { hasSecurity, hasBackups } from '../../lib/security/securitySync.js';

async function scopedProject(request, reply) {
  const clientIds = request.clientAccountIds;
  if (!clientIds?.length) {
    reply.status(404).send({ message: 'No client account linked to this user' });
    return null;
  }
  const project = await prisma.project.findUnique({ where: { id: String(request.params.id) }, select: { id: true, clientId: true, cmsType: true, cmsCapabilities: true } });
  if (!project || !clientIds.includes(project.clientId)) {
    reply.status(404).send({ message: 'Project not found' });
    return null;
  }
  return project;
}

export async function clientSecurityRoutes(app) {
  app.get('/projects/:id/security', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const clientIds = request.clientAccountIds;
    if (!clientIds?.length) return reply.status(404).send({ message: 'No client account linked to this user' });
    const project = await prisma.project.findUnique({
      where: { id: String(request.params.id) },
      select: { id: true, clientId: true, cmsType: true, cmsCapabilities: true },
    });
    if (!project || !clientIds.includes(project.clientId)) return reply.status(404).send({ message: 'Project not found' });
    reply.header('cache-control', 'no-store');
    return reply.send(await clientSecurityView(project));
  });

  // Monthly security reports, client edition only (the admin appendix never reaches a client).
  app.get('/projects/:id/security/reports', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const project = await scopedProject(request, reply);
    if (!project) return;
    if (!hasSecurity(project) && !hasBackups(project)) return reply.send({ reports: [] });
    const rows = await listSecurityReports(project.id, { take: 12 });
    return reply.send({ reports: rows.map((r) => ({ month: r.month, state: r.overallState, generatedAt: r.generatedAt })) });
  });

  app.get('/projects/:id/security/reports/:month', { onRequest: [app.verifyJwt, app.requireClient] }, async (request, reply) => {
    const project = await scopedProject(request, reply);
    if (!project) return;
    const month = String(request.params.month);
    if (!isReportMonth(month)) return reply.status(400).send({ message: 'month must be YYYY-MM' });
    const row = await prisma.securityMonthlyReport.findUnique({ where: { projectId_month: { projectId: project.id, month } }, select: { clientHtml: true } });
    if (!row) return reply.status(404).send({ message: 'Report not found' });
    const download = request.query?.download === '1';
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', HTML_REPORT_VIEW_CSP)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff');
    if (download) reply.header('Content-Disposition', `attachment; filename="security-report-${month}.html"`);
    return reply.send(row.clientHtml);
  });
}
