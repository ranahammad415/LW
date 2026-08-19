import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';
import { generateClientReport } from '../../lib/monthlyReport/generateForCycle.js';
import {
  generateAndStoreFormalPdf,
  getFormalReportHtmlPreview,
  readMonthlyReportPdf,
  deleteMonthlyReportPdf,
} from '../../lib/monthlyReport/renderFormalPdf.js';
import {
  REPORT_ASSET_FOLDERS,
  REPORT_ASSET_MAX_BYTES,
  getClientReportAssets,
} from '../../lib/monthlyReport/reportAssets.js';
import {
  resolveUploadBaseUrl,
  validateUpload,
  sanitizeUploadFilename,
} from '../../lib/uploadUrl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_ROOT = join(__dirname, '..', '..', '..', 'uploads');

function multipartField(fields, name) {
  const raw = fields?.[name];
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw.value === 'string') return raw.value;
  if (Array.isArray(raw) && raw.length) return multipartField({ [name]: raw[0] }, name);
  return null;
}

const generateBodySchema = z.object({
  clientId: z.string().uuid(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
  /** When true, replace an existing non-delivered draft. Default preserves drafts. */
  force: z.boolean().optional().default(false),
});

/** Reply before proxies drop long AI calls; generation keeps running in-process. */
const GENERATE_SOFT_TIMEOUT_MS = Number(process.env.REPORT_GENERATE_SOFT_TIMEOUT_MS || 25000);

const formalAiContentSchema = z
  .object({
    coverSummary: z.string().optional(),
    preparedBy: z.string().optional(),
    executive: z
      .object({
        strategicApproach: z.string().optional(),
        performanceGains: z.string().optional(),
        localVisibility: z.string().optional(),
        technicalHealth: z.string().optional(),
        nextSteps: z.string().optional(),
      })
      .optional(),
    sections: z
      .array(
        z.object({
          number: z.number().optional(),
          title: z.string().optional(),
          intro: z.string().optional(),
          blocks: z
            .array(
              z.object({
                heading: z.string().optional(),
                bullets: z.array(z.string()).optional(),
              }),
            )
            .optional(),
          valueDelivered: z.string().optional(),
        }),
      )
      .optional(),
    conclusion: z.string().optional(),
    // legacy
    executiveSummary: z.string().optional(),
    seoPerformance: z.string().optional(),
    highlights: z.array(z.string()).optional(),
  })
  .passthrough();

function serializeReport(r, extras = {}) {
  return {
    id: r.id,
    clientId: r.clientId,
    month: r.month,
    year: r.year,
    status: r.status,
    aiContent: r.aiContent,
    createdAt: r.createdAt?.toISOString?.() ?? r.createdAt,
    pdfFileName: r.pdfFileName ?? null,
    pdfFileSize: r.pdfFileSize ?? null,
    pdfGeneratedAt: r.pdfGeneratedAt?.toISOString?.() ?? r.pdfGeneratedAt ?? null,
    hasPdf: Boolean(r.pdfStoredPath),
    ...extras,
  };
}

async function assertPmClientAccess(user, client) {
  if (user.role === 'OWNER') return true;
  if (user.role !== 'PM') return false;
  return client.leadPmId === user.id || client.secondaryPmId === user.id;
}

export async function pmReportRoutes(app) {
  app.get(
    '/reports',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        querystring: {
          type: 'object',
          properties: { clientId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const { clientId } = request.query || {};

      const where = {};
      if (user.role === 'PM') {
        const clients = await prisma.clientAccount.findMany({
          where: {
            OR: [{ leadPmId: user.id }, { secondaryPmId: user.id }],
          },
          select: { id: true },
        });
        where.clientId = { in: clients.map((c) => c.id) };
      }
      if (clientId) where.clientId = clientId;

      const reports = await prisma.monthlyReport.findMany({
        where,
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: { client: { select: { agencyName: true } } },
      });

      return reply.send(
        reports.map((r) =>
          serializeReport(r, { client: r.client }),
        ),
      );
    },
  );

  app.get(
    '/reports/assets',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        querystring: {
          type: 'object',
          properties: { clientId: { type: 'string', format: 'uuid' } },
          required: ['clientId'],
        },
      },
    },
    async (request, reply) => {
      const { clientId } = request.query;
      const user = request.user;
      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { id: true, agencyName: true, leadPmId: true, secondaryPmId: true, websiteUrl: true },
      });
      if (!client) return reply.status(404).send({ message: 'Client not found' });
      if (!(await assertPmClientAccess(user, client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }
      const assets = await getClientReportAssets(clientId);
      return reply.send({
        clientId,
        agencyName: client.agencyName,
        websiteUrl: client.websiteUrl,
        folders: REPORT_ASSET_FOLDERS,
        ...assets,
      });
    },
  );

  app.post(
    '/reports/assets',
    {
      onRequest: [app.verifyJwt, app.requirePM],
    },
    async (request, reply) => {
      const user = request.user;
      const data = await request.file();
      if (!data) return reply.status(400).send({ message: 'No file uploaded' });

      const buffer = await data.toBuffer();
      const fileName = data.filename || 'asset';
      if (buffer.length > REPORT_ASSET_MAX_BYTES) {
        return reply.status(413).send({
          message: `File too large. Report assets (logo / website snap) must be ${Math.round(REPORT_ASSET_MAX_BYTES / 1024 / 1024)}MB or less.`,
        });
      }
      const validation = validateUpload({
        mimetype: data.mimetype,
        filename: fileName,
        size: buffer.length,
      });
      if (!validation.ok) return reply.status(400).send({ message: validation.message });
      const mt = String(data.mimetype || '').toLowerCase();
      if (!mt.startsWith('image/')) {
        return reply.status(400).send({
          message: 'Upload an image file (PNG, JPG, WEBP, or GIF). Screenshots work best as PNG or JPG under 10MB.',
        });
      }

      const clientId = multipartField(data.fields, 'clientId');
      const folder = multipartField(data.fields, 'folder');
      if (!clientId) return reply.status(400).send({ message: 'clientId is required' });
      if (![REPORT_ASSET_FOLDERS.LOGO, REPORT_ASSET_FOLDERS.FOLD].includes(folder)) {
        return reply.status(400).send({
          message: `folder must be ${REPORT_ASSET_FOLDERS.LOGO} or ${REPORT_ASSET_FOLDERS.FOLD}`,
        });
      }

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { id: true, leadPmId: true, secondaryPmId: true },
      });
      if (!client) return reply.status(404).send({ message: 'Client not found' });
      if (!(await assertPmClientAccess(user, client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      const now = new Date();
      const year = String(now.getFullYear());
      const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const dir = join(UPLOADS_ROOT, year, monthDay);
      mkdirSync(dir, { recursive: true });
      const safeName = sanitizeUploadFilename(fileName);
      const storedName = `${randomUUID()}-${safeName}`;
      writeFileSync(join(dir, storedName), buffer);
      const baseUrl = resolveUploadBaseUrl(request);
      const relPath = `/uploads/${year}/${monthDay}/${storedName}`;
      const fileUrl = baseUrl ? `${baseUrl}${relPath}` : relPath;

      const asset = await prisma.clientAsset.create({
        data: {
          clientId,
          projectId: null,
          folder,
          filename: fileName,
          fileUrl,
          uploadNote: multipartField(data.fields, 'uploadNote') || `Monthly report ${folder}`,
        },
      });

      return reply.status(201).send({
        id: asset.id,
        fileUrl: asset.fileUrl,
        filename: asset.filename,
        folder: asset.folder,
      });
    },
  );

  app.get(
    '/reports/:id',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;

      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: {
          client: {
            select: {
              agencyName: true,
              websiteUrl: true,
              leadPmId: true,
              secondaryPmId: true,
            },
          },
        },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });

      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      const assets = await getClientReportAssets(report.clientId);

      return reply.send(
        serializeReport(report, {
          client: {
            agencyName: report.client.agencyName,
            websiteUrl: report.client.websiteUrl,
          },
          reportAssets: assets,
        }),
      );
    },
  );

  // Save draft / update content without delivering (works for DRAFT and DELIVERED).
  app.patch(
    '/reports/:id',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body || {};
      const user = request.user;

      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: {
          client: {
            select: {
              agencyName: true,
              websiteUrl: true,
              leadPmId: true,
              secondaryPmId: true,
            },
          },
        },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      if (!body.aiContent || typeof body.aiContent !== 'object') {
        return reply.status(400).send({ message: 'aiContent is required' });
      }
      const parsed = formalAiContentSchema.safeParse(body.aiContent);
      if (!parsed.success) {
        return reply.status(400).send({ message: 'Invalid aiContent' });
      }

      const nextAi = { ...(report.aiContent || {}), ...parsed.data };
      const updated = await prisma.monthlyReport.update({
        where: { id },
        data: { aiContent: nextAi },
      });

      const assets = await getClientReportAssets(report.clientId);
      return reply.send(
        serializeReport(updated, {
          client: {
            agencyName: report.client.agencyName,
            websiteUrl: report.client.websiteUrl,
          },
          reportAssets: assets,
        }),
      );
    },
  );

  app.delete(
    '/reports/:id',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;

      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: {
          client: { select: { leadPmId: true, secondaryPmId: true, agencyName: true } },
        },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });

      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      if (report.pdfStoredPath) {
        try {
          deleteMonthlyReportPdf(report.pdfStoredPath);
        } catch (err) {
          request.log.warn({ err, reportId: id }, 'Failed to delete report PDF file');
        }
      }

      await prisma.monthlyReport.delete({ where: { id } });
      return reply.status(204).send();
    },
  );

  app.post(
    '/reports/generate',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        body: {
          type: 'object',
          properties: {
            clientId: { type: 'string', format: 'uuid' },
            month: { type: 'integer' },
            year: { type: 'integer' },
            force: { type: 'boolean' },
          },
          required: ['clientId', 'month', 'year'],
        },
      },
    },
    async (request, reply) => {
      const parsed = generateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const { clientId, month, year, force } = parsed.data;
      const user = request.user;

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { id: true, agencyName: true, leadPmId: true, secondaryPmId: true },
      });
      if (!client) {
        return reply.status(404).send({ message: 'Client not found' });
      }

      if (!(await assertPmClientAccess(user, client))) {
        return reply.status(403).send({ message: 'You are not assigned to this client' });
      }

      const cycle = await prisma.workCycle
        .findUnique({ where: { month_year: { month, year } } })
        .catch(() => null);

      // AI drafting can exceed nginx/Cloudflare idle limits. Race a soft timeout so we
      // can return 202 while generation continues; the client polls the reports list.
      const reportPromise = generateClientReport({
        clientId,
        month,
        year,
        workCycleId: cycle?.id ?? null,
        force,
        log: request.log,
      });

      const outcome = await Promise.race([
        reportPromise.then(
          (result) => ({ kind: 'done', result }),
          (err) => ({ kind: 'error', err }),
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: 'pending' }), GENERATE_SOFT_TIMEOUT_MS),
        ),
      ]);

      if (outcome.kind === 'pending') {
        reportPromise
          .then((result) => {
            request.log.info(
              { reportId: result?.report?.id, action: result?.action, clientId, month, year },
              'Report generate finished after soft timeout',
            );
          })
          .catch((err) => {
            request.log.error({ err, clientId, month, year }, 'Report generate failed after soft timeout');
          });
        return reply.status(202).send({
          status: 'generating',
          clientId,
          month,
          year,
          message: 'Draft is still generating. Poll GET /pm/reports until it appears.',
        });
      }

      if (outcome.kind === 'error') {
        request.log.error({ err: outcome.err, clientId, month, year }, 'Report generate failed');
        return reply.status(500).send({ message: 'Failed to generate report draft' });
      }

      if (!outcome.result?.report) {
        return reply.status(404).send({ message: 'Client not found' });
      }

      const { report, action } = outcome.result;

      if (action === 'delivered_unchanged') {
        return reply.status(409).send({
          code: 'ALREADY_DELIVERED',
          message: 'This report was already delivered and cannot be regenerated.',
          reportId: report.id,
        });
      }

      if (action === 'preserved') {
        return reply.status(409).send({
          code: 'DRAFT_EXISTS',
          message:
            'A draft already exists for this client and month. Pass force: true to regenerate and replace it.',
          reportId: report.id,
        });
      }

      return reply.status(201).send(
        serializeReport(report, { client: { agencyName: client.agencyName } }),
      );
    },
  );

  app.patch(
    '/reports/:id/approve',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body || {};
      const user = request.user;

      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true, agencyName: true } } },
      });
      if (!report) {
        return reply.status(404).send({ message: 'Report not found' });
      }

      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'You are not assigned to this client' });
      }

      let nextAi = report.aiContent;
      if (body.aiContent && typeof body.aiContent === 'object') {
        const parsed = formalAiContentSchema.safeParse(body.aiContent);
        if (!parsed.success) {
          return reply.status(400).send({ message: 'Invalid aiContent' });
        }
        nextAi = { ...(report.aiContent || {}), ...parsed.data };
      }

      await prisma.monthlyReport.update({
        where: { id },
        data: { aiContent: nextAi, status: 'DELIVERED' },
      });

      let pdfError = null;
      try {
        await generateAndStoreFormalPdf(id, { log: request.log });
      } catch (err) {
        pdfError = err?.message || 'PDF generation failed';
        request.log?.error?.({ err }, 'Formal PDF generation failed on approve');
      }

      try {
        const fullReport = await prisma.monthlyReport.findUnique({
          where: { id },
          include: { client: { include: { clientUsers: { select: { userId: true } } } } },
        });
        if (fullReport?.client?.clientUsers?.length > 0) {
          notify({
            slug: 'report_published',
            recipientIds: fullReport.client.clientUsers.map((cu) => cu.userId),
            variables: {
              reportTitle: `${fullReport.month}/${fullReport.year} Report`,
              clientName: fullReport.client.agencyName || '',
            },
            actionUrl: `/portal/client/reports`,
            metadata: { reportId: id },
          }).catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }

      const updated = await prisma.monthlyReport.findUnique({ where: { id } });
      return reply.send({
        id: updated.id,
        status: updated.status,
        hasPdf: Boolean(updated.pdfStoredPath),
        pdfFileName: updated.pdfFileName,
        pdfError,
      });
    },
  );

  app.post(
    '/reports/:id/regenerate-pdf',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;
      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }

      if (request.body?.aiContent && typeof request.body.aiContent === 'object') {
        const parsed = formalAiContentSchema.safeParse(request.body.aiContent);
        if (!parsed.success) {
          return reply.status(400).send({ message: 'Invalid aiContent' });
        }
        await prisma.monthlyReport.update({
          where: { id },
          data: { aiContent: { ...(report.aiContent || {}), ...parsed.data } },
        });
      }

      try {
        const updated = await generateAndStoreFormalPdf(id, { log: request.log });
        return reply.send(serializeReport(updated));
      } catch (err) {
        return reply.status(err.statusCode || 500).send({
          message: err.message || 'PDF generation failed',
        });
      }
    },
  );

  // PM-only: remove stored PDF without deleting the report content.
  app.delete(
    '/reports/:id/pdf',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;
      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: {
          client: {
            select: {
              agencyName: true,
              websiteUrl: true,
              leadPmId: true,
              secondaryPmId: true,
            },
          },
        },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }
      if (!report.pdfStoredPath) {
        return reply.status(404).send({ message: 'No PDF to remove' });
      }

      try {
        deleteMonthlyReportPdf(report.pdfStoredPath);
      } catch (err) {
        request.log.warn({ err, reportId: id }, 'Failed to delete report PDF file');
      }

      const updated = await prisma.monthlyReport.update({
        where: { id },
        data: {
          pdfStoredPath: null,
          pdfFileName: null,
          pdfFileSize: null,
          pdfGeneratedAt: null,
        },
      });

      const assets = await getClientReportAssets(report.clientId);
      return reply.send(
        serializeReport(updated, {
          client: {
            agencyName: report.client.agencyName,
            websiteUrl: report.client.websiteUrl,
          },
          reportAssets: assets,
        }),
      );
    },
  );

  app.get(
    '/reports/:id/pdf',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;
      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }
      if (!report.pdfStoredPath) {
        return reply.status(404).send({ message: 'PDF not generated yet' });
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
    '/reports/:id/html-preview',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;
      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });
      if (!(await assertPmClientAccess(user, report.client))) {
        return reply.status(403).send({ message: 'Forbidden' });
      }
      const html = await getFormalReportHtmlPreview(id);
      if (!html) return reply.status(404).send({ message: 'Report not found' });
      return reply.type('text/html').send(html);
    },
  );
}
