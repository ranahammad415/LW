import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { notify } from '../../lib/notificationService.js';
import { generateClientReport } from '../../lib/monthlyReport/generateForCycle.js';

const generateBodySchema = z.object({
  clientId: z.string().uuid(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
});

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

      // Unified rich report generation (tasks + content + keyword wins +
      // AI-search visibility + search KPIs), keyed to the month's work cycle.
      const cycle = await prisma.workCycle
        .findUnique({ where: { month_year: { month, year } } })
        .catch(() => null);

      const report = await generateClientReport({
        clientId,
        month,
        year,
        workCycleId: cycle?.id ?? null,
        log: request.log,
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
