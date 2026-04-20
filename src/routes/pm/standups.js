import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

const submitStandupBodySchema = z.object({
  yesterday: z.string().min(1, 'Yesterday is required'),
  today: z.string().min(1, 'Today is required'),
  blockers: z.string().optional(),
});

function todayDate() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function pmStandupRoutes(app) {
  app.get(
    '/standups/today',
    {
      onRequest: [app.verifyJwt, app.requirePM],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                userId: { type: 'string' },
                date: { type: 'string' },
                yesterday: { type: 'string' },
                today: { type: 'string' },
                blockers: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    avatarUrl: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const start = todayDate();
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);

      const standups = await prisma.dailyStandup.findMany({
        where: {
          date: { gte: start, lt: end },
        },
        include: {
          user: {
            select: { name: true, avatarUrl: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      return reply.send(
        standups.map((s) => ({
          id: s.id,
          userId: s.userId,
          date: s.date.toISOString(),
          yesterday: s.yesterday,
          today: s.today,
          blockers: s.blockers,
          createdAt: s.createdAt.toISOString(),
          user: s.user,
        }))
      );
    }
  );

  app.get(
    '/standups/me/today',
    {
      onRequest: [app.verifyJwt],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              submitted: { type: 'boolean' },
              standup: {
                type: 'object',
                nullable: true,
                properties: {
                  id: { type: 'string' },
                  yesterday: { type: 'string' },
                  today: { type: 'string' },
                  blockers: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role === 'CLIENT') {
        return reply.status(403).send({ message: 'Access denied' });
      }
      const start = todayDate();
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);

      const standup = await prisma.dailyStandup.findUnique({
        where: {
          userId_date: { userId: request.user.id, date: start },
        },
      });

      if (!standup) {
        return reply.send({ submitted: false, standup: null });
      }

      return reply.send({
        submitted: true,
        standup: {
          id: standup.id,
          yesterday: standup.yesterday,
          today: standup.today,
          blockers: standup.blockers,
        },
      });
    }
  );

  // History of current user's standups (paginated, newest first)
  app.get(
    '/standups/me/history',
    {
      onRequest: [app.verifyJwt],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    date: { type: 'string' },
                    yesterday: { type: 'string' },
                    today: { type: 'string' },
                    blockers: { type: 'string', nullable: true },
                    createdAt: { type: 'string' },
                  },
                },
              },
              nextCursor: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role === 'CLIENT') {
        return reply.status(403).send({ message: 'Access denied' });
      }
      const limit = Math.min(Number(request.query.limit) || 20, 50);
      const cursor = request.query.cursor || undefined;

      const standups = await prisma.dailyStandup.findMany({
        where: { userId: request.user.id },
        orderBy: { date: 'desc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = standups.length > limit;
      const items = hasMore ? standups.slice(0, limit) : standups;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      return reply.send({
        items: items.map((s) => ({
          id: s.id,
          date: s.date.toISOString(),
          yesterday: s.yesterday,
          today: s.today,
          blockers: s.blockers,
          createdAt: s.createdAt.toISOString(),
        })),
        nextCursor,
      });
    }
  );

  app.post(
    '/standups',
    {
      onRequest: [app.verifyJwt],
      schema: {
        body: {
          type: 'object',
          properties: {
            yesterday: { type: 'string' },
            today: { type: 'string' },
            blockers: { type: 'string' },
          },
          required: ['yesterday', 'today'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              date: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.user.role === 'CLIENT') {
        return reply.status(403).send({ message: 'Access denied' });
      }
      const parsed = submitStandupBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Validation failed',
          errors: parsed.error.flatten().fieldErrors,
        });
      }
      const { yesterday, today, blockers } = parsed.data;
      const date = todayDate();

      const standup = await prisma.dailyStandup.upsert({
        where: {
          userId_date: { userId: request.user.id, date },
        },
        create: {
          userId: request.user.id,
          date,
          yesterday,
          today,
          blockers: blockers?.trim() || null,
        },
        update: {
          yesterday,
          today,
          blockers: blockers?.trim() || null,
        },
      });

      return reply.status(201).send({
        id: standup.id,
        date: standup.date.toISOString(),
      });
    }
  );
}
