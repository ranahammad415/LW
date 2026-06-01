import { prisma } from '../lib/prisma.js';

const VALID_ROLES = ['OWNER', 'PM', 'TEAM_MEMBER', 'CONTRACTOR', 'CLIENT'];

export async function modalityRoutes(app) {
  // ── List all modality configs (OWNER only) ──
  app.get(
    '/modalities',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const configs = await prisma.modalityConfig.findMany({
        orderBy: [{ featureKey: 'asc' }, { role: 'asc' }],
      });

      // Group by featureKey for easier frontend consumption
      const grouped = {};
      for (const cfg of configs) {
        if (!grouped[cfg.featureKey]) {
          grouped[cfg.featureKey] = {};
        }
        grouped[cfg.featureKey][cfg.role] = cfg.enabled;
      }

      return reply.send({ configs, grouped });
    }
  );

  // ── Bulk update modality configs (OWNER only) ──
  app.put(
    '/modalities',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const items = request.body;
      if (!Array.isArray(items)) {
        return reply.status(400).send({ message: 'Expected an array of { featureKey, role, enabled }' });
      }

      const results = [];
      for (const item of items) {
        const featureKey = String(item.featureKey || '').trim().slice(0, 100);
        const role = String(item.role || '').trim().toUpperCase();
        const enabled = Boolean(item.enabled);

        if (!featureKey || !VALID_ROLES.includes(role)) {
          continue;
        }

        const upserted = await prisma.modalityConfig.upsert({
          where: { featureKey_role: { featureKey, role } },
          create: { featureKey, role, enabled },
          update: { enabled },
        });
        results.push(upserted);
      }

      return reply.send({ updated: results.length, configs: results });
    }
  );

  // ── Get current user's effective modalities ──
  app.get(
    '/modalities/me',
    {
      onRequest: [app.verifyJwt],
    },
    async (request, reply) => {
      const userRole = request.user.role;
      const configs = await prisma.modalityConfig.findMany({
        where: { role: userRole },
        select: { featureKey: true, enabled: true },
      });

      const map = {};
      for (const cfg of configs) {
        map[cfg.featureKey] = cfg.enabled;
      }

      return reply.send({ role: userRole, modalities: map });
    }
  );
}
