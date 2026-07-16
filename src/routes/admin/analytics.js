import { prisma } from '../../lib/prisma.js';
import { resolveCycle } from '../../lib/workCycle.js';
import { buildClientAnalytics } from '../../lib/analytics/freezeSnapshot.js';
import {
  buildOverview,
  buildGscView,
  buildGa4View,
  buildGmbView,
  buildSeoView,
  buildLlmView,
} from '../../lib/analytics/sectionBuilders.js';

/**
 * OWNER-scoped native analytics. Mirrors the client-facing native section
 * endpoints (routes/client/analytics.js) but keyed by an explicit :clientId so
 * an admin can view any client's Data-Bloo-style dashboard from the Analytics
 * tab. Uses the same section builders — no data-shape divergence.
 */
async function assertClientExists(clientId, reply) {
  const client = await prisma.clientAccount.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) {
    reply.status(404).send({ message: 'Client not found' });
    return false;
  }
  return true;
}

function sendSection(reply, result) {
  if (result?.status && result?.message) {
    return reply.status(result.status).send({ message: result.message });
  }
  return reply.send(result);
}

export async function adminAnalyticsRoutes(app) {
  const requireOwner = app.requireOwner;

  app.get(
    '/analytics/:clientId/overview',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildOverview([clientId], request.query));
    }
  );

  app.get(
    '/analytics/:clientId/native',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;

      const { cycle: cycleId, month, year } = request.query ?? {};
      const cycle = await resolveCycle({ cycleId, month, year });
      if (!cycle) return reply.status(404).send({ message: 'Work cycle not found' });

      const cycleMeta = {
        id: cycle.id,
        month: cycle.month,
        year: cycle.year,
        label: cycle.label,
        status: cycle.status,
      };

      if (cycle.status === 'CLOSED') {
        const snapshot = await prisma.workCycleAnalyticsSnapshot.findUnique({
          where: { workCycleId_clientId: { workCycleId: cycle.id, clientId } },
        });
        if (snapshot) {
          return reply.send({ cycle: cycleMeta, data: snapshot.data, source: 'frozen' });
        }
        const data = await buildClientAnalytics(clientId, cycle);
        return reply.send({ cycle: cycleMeta, data, source: 'computed' });
      }

      const data = await buildClientAnalytics(clientId, cycle);
      return reply.send({ cycle: cycleMeta, data, source: 'live' });
    }
  );

  app.get(
    '/analytics/:clientId/gsc/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildGscView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/ga4/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildGa4View([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/gmb/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildGmbView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/seo/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildSeoView([clientId], view, request.query));
    }
  );

  app.get(
    '/analytics/:clientId/llm/:view',
    { onRequest: [app.verifyJwt, requireOwner] },
    async (request, reply) => {
      const { clientId, view } = request.params;
      if (!(await assertClientExists(clientId, reply))) return;
      return sendSection(reply, await buildLlmView([clientId], view, request.query));
    }
  );
}
