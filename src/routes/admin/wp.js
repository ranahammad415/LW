import { prisma } from '../../lib/prisma.js';

/** GET /api/admin/wp-presets — list all WP access presets (OWNER only) */
/** POST /api/admin/wp-presets — create WP access preset (OWNER only) */
/** DELETE /api/admin/wp-presets/:id — delete WP access preset (OWNER only) */
export async function adminWpRoutes(app) {
  app.get(
    '/wp-presets',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                capabilities: { type: 'array', items: { type: 'string' } },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const presets = await prisma.wpAccessPreset.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, capabilities: true, createdAt: true },
      });
      return reply.send(presets);
    }
  );

  app.post(
    '/wp-presets',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            capabilities: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['name', 'capabilities'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              capabilities: { type: 'array', items: { type: 'string' } },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, capabilities } = request.body || {};
      const nameStr = typeof name === 'string' ? name.trim() : '';
      const caps = Array.isArray(capabilities)
        ? capabilities.map((c) => String(c).trim()).filter(Boolean)
        : [];
      if (!nameStr) {
        return reply.status(400).send({ message: 'name is required' });
      }
      const preset = await prisma.wpAccessPreset.create({
        data: {
          name: nameStr.slice(0, 255),
          capabilities: caps,
        },
      });
      return reply.status(201).send({
        id: preset.id,
        name: preset.name,
        capabilities: preset.capabilities,
        createdAt: preset.createdAt,
      });
    }
  );

  app.delete(
    '/wp-presets/:id',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: { type: 'object', properties: {} },
          404: { type: 'object', properties: { message: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const preset = await prisma.wpAccessPreset.findUnique({ where: { id } });
      if (!preset) {
        return reply.status(404).send({ message: 'Preset not found' });
      }
      await prisma.wpAccessPreset.delete({ where: { id } });
      return reply.send({});
    }
  );
}
