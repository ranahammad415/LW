/**
 * EmDash v1.5.0 §26.1–26.2: leads (PII) and site reports in the PM portal.
 * Leads: OWNER and the project's PMs (ensureProjectAccess) only; erasure is OWNER only. Responses are no-store; the
 * routes never log lead data. Photos stream from private storage after an access check.
 * Reports: read-only views of the stored pulls; OWNER / PM can refresh (live pull).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { prisma } from '../../lib/prisma.js';
import { ensureProjectAccess } from '../../lib/ensureProjectAccess.js';
import { CmsBridgeError } from '../../lib/siteAdapters/emdash.js';
import { eraseLead, photoPath, parseErasedReason, SITE_ERASE_PENDING, SITE_ERASE_FAILED } from '../../lib/cmsLeads.js';
import { pullSiteReports, listSiteReports } from '../../lib/cmsReports.js';
import { staffAttribution } from '../../lib/signals/attribution.js';

const LEAD_ROLES = ['OWNER', 'PM'];
const STAFF = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR'];

function sendError(reply, err, log) {
  if (err instanceof CmsBridgeError) {
    let status = err.status || 502;
    if (status === 401 || (status >= 500 && status !== 503)) status = 502;
    if (status === 501) status = 409;
    return reply.status(status).send({ code: err.code, message: err.message });
  }
  log?.error?.({ code: err?.code || 'INTERNAL' }, 'Leads/reports route failed');
  return reply.status(500).send({ message: 'Request failed' });
}

async function projectFor(request, reply, roles) {
  if (!roles.includes(request.user?.role)) {
    reply.status(403).send({ message: 'Access denied' });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: String(request.params.projectId) },
    select: { id: true, clientId: true, leadPmId: true, cmsType: true, cmsCapabilities: true, cmsLeadRetentionMonths: true },
  });
  if (!project || !(await ensureProjectAccess(project, request.user))) {
    reply.status(project ? 403 : 404).send({ message: project ? 'Access denied' : 'Project not found' });
    return null;
  }
  return project;
}

function formatLead(l) {
  const erased = parseErasedReason(l.erasedReason);
  return {
    leadId: l.leadId,
    receivedAt: l.receivedAt,
    createdAt: l.siteCreatedAt,
    form: { id: l.formId, name: l.formName },
    sourcePath: l.sourcePath,
    // An erased lead's utm column holds only the site-erase retry bookkeeping (never shown).
    utm: l.erasedAt ? null : l.utm || null,
    fields: l.fields || null,
    consentMarketing: !!l.consentMarketing,
    consent: l.consent || null,
    spam: l.spamVerdict,
    erasedAt: l.erasedAt,
    erasedReason: erased.reason,
    // 'pending': erased in Agency OS, the erase on the site is retried automatically; 'failed': retries ran out.
    siteErase: erased.siteErase,
    photos: (l.photos || []).map((p) => ({ id: p.id, contentType: p.contentType, bytes: p.bytes, copied: !!p.copiedAt, error: p.error || null })),
    // v1.7.0 §38.5 / plan §6.3: "Came from … → landed on … → … → quote form" + model / mismatch / session link.
    attribution: l.erasedAt ? null : staffAttribution(l.attribution || null),
  };
}

export async function pmCmsLeadsReportsRoutes(app) {
  const auth = { onRequest: [app.verifyJwt] };

  app.get('/projects/:projectId/cms-leads', auth, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, LEAD_ROLES);
      if (!project) return;
      const take = Math.min(100, Math.max(1, Number(request.query?.limit) || 50));
      const rows = await prisma.cmsLead.findMany({
        where: { projectId: project.id, ...(request.query?.includeErased === 'true' ? {} : { erasedAt: null }) },
        orderBy: { receivedAt: 'desc' },
        take,
        include: { photos: true, attribution: true },
      });
      const [sitePending, siteFailed] = await Promise.all([
        prisma.cmsLead.count({ where: { projectId: project.id, erasedReason: { startsWith: SITE_ERASE_PENDING } } }),
        prisma.cmsLead.count({ where: { projectId: project.id, erasedReason: { startsWith: SITE_ERASE_FAILED } } }),
      ]);
      reply.header('cache-control', 'no-store');
      return reply.send({ items: rows.map(formatLead), retentionMonths: project.cmsLeadRetentionMonths ?? 24, siteErase: { pending: sitePending, failed: siteFailed } });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.get('/projects/:projectId/cms-leads/:leadId/photos/:photoId', auth, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, LEAD_ROLES);
      if (!project) return;
      const photo = await prisma.cmsLeadPhoto.findFirst({
        where: { id: String(request.params.photoId), lead: { projectId: project.id, leadId: String(request.params.leadId), erasedAt: null } },
      });
      const file = photo?.copiedAt ? photoPath(photo.storageName) : null;
      if (!file) return reply.status(404).send({ message: 'Photo not available' });
      await stat(file);
      reply.header('cache-control', 'private, no-store');
      reply.type(photo.contentType || 'application/octet-stream');
      return reply.send(createReadStream(file));
    } catch (err) {
      if (err?.code === 'ENOENT') return reply.status(404).send({ message: 'Photo not available' });
      return sendError(reply, err, request.log);
    }
  });

  // Erasure (subject request, spam, …): OWNER only; the site erases first, then our copy.
  app.post('/projects/:projectId/cms-leads/:leadId/erase', auth, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, ['OWNER']);
      if (!project) return;
      const out = await eraseLead({ projectId: project.id, leadId: String(request.params.leadId).slice(0, 64), reason: request.body?.reason, user: request.user, log: request.log });
      return reply.send(out);
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.patch('/projects/:projectId/cms-leads/settings', auth, async (request, reply) => {
    const project = await projectFor(request, reply, ['OWNER']);
    if (!project) return;
    const months = Number(request.body?.retentionMonths);
    if (!Number.isInteger(months) || months < 1 || months > 120) return reply.status(400).send({ message: 'Retention must be 1–120 months.' });
    await prisma.project.update({ where: { id: project.id }, data: { cmsLeadRetentionMonths: months } });
    return reply.send({ retentionMonths: months });
  });

  app.get('/projects/:projectId/site-reports', auth, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, STAFF);
      if (!project) return;
      return reply.send({ reports: await listSiteReports(project.id), available: project.cmsCapabilities?.reports === true });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });

  app.post('/projects/:projectId/site-reports/refresh', auth, async (request, reply) => {
    try {
      const project = await projectFor(request, reply, LEAD_ROLES);
      if (!project) return;
      const status = await pullSiteReports(project.id, { interactive: true, log: request.log });
      return reply.send({ status, reports: await listSiteReports(project.id) });
    } catch (err) {
      return sendError(reply, err, request.log);
    }
  });
}
