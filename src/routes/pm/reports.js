import { generateChat, isAiConfigured } from '../../lib/ai.js';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';

const generateBodySchema = z.object({
  clientId: z.string().uuid(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
});

const AI_CONTENT_STRUCTURE = {
  executiveSummary: '',
  seoPerformance: '',
};

const SYSTEM_PROMPT = `
You are a Senior SEO Account Manager at a premium digital growth agency. 
Your job is to write the monthly performance report for our client. 
Your tone must be consultative, professional, and confidence-inspiring. Focus on the value delivered, not just a dry list of technical tasks.

Avoid generic AI filler words like "delve into," "testament," or "robust." Use crisp, business-focused language.

You will be provided with:
1. The Client's Name
2. The Reporting Month & Year
3. A raw list of tasks our team completed this month.

You must output a strictly valid JSON object with exactly two keys:
{
  "executiveSummary": "A 2-3 paragraph high-level overview of the month's progress. Frame the completed work as strategic wins moving the client closer to their growth goals.",
  "seoPerformance": "A 2-3 paragraph breakdown of the specific SEO, Technical, or Content work completed this month. Translate the technical tasks into business value (e.g., instead of 'fixed 404s', say 'improved site health and crawlability to protect search rankings')."
}
`;

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
                client: { type: 'object' },
              },
            },
          },
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
        reports.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          month: r.month,
          year: r.year,
          status: r.status,
          aiContent: r.aiContent,
          createdAt: r.createdAt.toISOString(),
          client: r.client,
        }))
      );
    }
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
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              clientId: { type: 'string' },
              month: { type: 'integer' },
              year: { type: 'integer' },
              status: { type: 'string' },
              aiContent: { type: 'object', nullable: true },
              client: { type: 'object' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user;

      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: { client: { select: { agencyName: true, leadPmId: true, secondaryPmId: true } } },
      });
      if (!report) return reply.status(404).send({ message: 'Report not found' });

      if (user.role === 'PM') {
        const isAssigned =
          report.client.leadPmId === user.id || report.client.secondaryPmId === user.id;
        if (!isAssigned) return reply.status(403).send({ message: 'Forbidden' });
      }

      return reply.send({
        id: report.id,
        clientId: report.clientId,
        month: report.month,
        year: report.year,
        status: report.status,
        aiContent: report.aiContent,
        client: { agencyName: report.client.agencyName },
      });
    }
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
          },
          required: ['clientId', 'month', 'year'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              clientId: { type: 'string' },
              month: { type: 'integer' },
              year: { type: 'integer' },
              status: { type: 'string' },
              aiContent: { type: 'object' },
            },
          },
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
      const { clientId, month, year } = parsed.data;
      const user = request.user;

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { id: true, agencyName: true, leadPmId: true, secondaryPmId: true },
      });
      if (!client) {
        return reply.status(404).send({ message: 'Client not found' });
      }

      if (user.role === 'PM') {
        const isAssigned = client.leadPmId === user.id || client.secondaryPmId === user.id;
        if (!isAssigned) {
          return reply.status(403).send({ message: 'You are not assigned to this client' });
        }
      }

      const startDate = new Date(Date.UTC(year, month - 1, 1));
      const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      const completedTasks = await prisma.task.findMany({
        where: {
          project: { clientId },
          status: 'COMPLETED',
          updatedAt: { gte: startDate, lte: endDate },
        },
        include: { project: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
      });

      const userMessage = `
Client Name: ${client.agencyName}
Reporting Period: ${month}/${year}

Completed Tasks this month:
${completedTasks.length === 0 ? 'No completed tasks recorded for this month.' : completedTasks.map((t) => `- [${t.taskType}] ${t.title}`).join('\n')}
`;

      let aiContent = { ...AI_CONTENT_STRUCTURE };
      if (isAiConfigured()) {
        try {
          const { text, parsed } = await generateChat({
            system: SYSTEM_PROMPT,
            user: userMessage,
            json: true,
            temperature: 0.7,
            maxTokens: 1024,
          });
          const raw = text;
          if (raw) {
            const parsedContent = parsed || (() => { try { return JSON.parse(raw); } catch { return null; } })();
            if (parsedContent) {
              aiContent = {
                executiveSummary:
                  parsedContent.executiveSummary ?? 'No summary generated.',
                seoPerformance:
                  parsedContent.seoPerformance ?? 'No SEO summary generated.',
              };
            }
          }
        } catch (err) {
          request.log.warn({ err }, 'AI report generation failed, using fallback');
          aiContent = {
            executiveSummary: `This month we completed ${completedTasks.length} task(s) for ${client.agencyName}. Key deliverables are reflected in your project activity.`,
            seoPerformance: `SEO activity for ${month}/${year} included the completed tasks above. Add specific performance notes as needed.`,
          };
        }
      } else {
        aiContent = {
          executiveSummary: `Monthly summary for ${client.agencyName} (${month}/${year}). ${completedTasks.length} task(s) completed. Configure ANTHROPIC_API_KEY for AI-generated content.`,
          seoPerformance: `SEO performance summary for ${month}/${year}. Configure ANTHROPIC_API_KEY for AI-generated content.`,
        };
      }

      const existing = await prisma.monthlyReport.findUnique({
        where: {
          clientId_month_year: { clientId, month, year },
        },
      });
      if (existing) {
        const updated = await prisma.monthlyReport.update({
          where: { id: existing.id },
          data: { aiContent, status: 'DRAFT' },
        });
        return reply.status(201).send(updated);
      }

      const report = await prisma.monthlyReport.create({
        data: {
          clientId,
          month,
          year,
          status: 'DRAFT',
          aiContent,
        },
      });
      return reply.status(201).send(report);
    }
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
        body: {
          type: 'object',
          properties: {
            aiContent: {
              type: 'object',
              properties: {
                executiveSummary: { type: 'string' },
                seoPerformance: { type: 'string' },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body || {};
      const user = request.user;

      const report = await prisma.monthlyReport.findUnique({
        where: { id },
        include: { client: { select: { leadPmId: true, secondaryPmId: true } } },
      });
      if (!report) {
        return reply.status(404).send({ message: 'Report not found' });
      }

      if (user.role === 'PM') {
        const isAssigned =
          report.client.leadPmId === user.id || report.client.secondaryPmId === user.id;
        if (!isAssigned) {
          return reply.status(403).send({ message: 'You are not assigned to this client' });
        }
      }

      const updateData = { status: 'DELIVERED' };
      if (body.aiContent && typeof body.aiContent === 'object') {
        updateData.aiContent = body.aiContent;
      }

      const updated = await prisma.monthlyReport.update({
        where: { id },
        data: updateData,
      });

      // Notify client contacts about the published report
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
      } catch (_) { /* don't fail report publish if notification fails */ }

      return reply.send({ id: updated.id, status: updated.status });
    }
  );
}
