/**
 * Website crawl that seeds a knowledge base, mounted for both clients and staff.
 *
 * Crawling is deliberately allowed for PMs as well as Owners (the read guard),
 * and for clients on their own account, because it only produces PENDING
 * drafts — approval still runs through the Knowledge Review queue.
 */
import { prisma } from '../../lib/prisma.js';
import { requireStaffKnowledgeRead } from '../../lib/knowledgeScope.js';
import { resolvePrimaryClientId } from '../../lib/clientContext.js';
import {
  createKnowledgeCrawlRun,
  executeKnowledgeCrawlRun,
} from '../../lib/knowledgeCrawler.js';

const ACTIVE_STATUSES = ['PENDING', 'CRAWLING', 'EXTRACTING'];

function buildCrawlRoutes({ staff }) {
  return async function knowledgeCrawlRoutes(app) {
    const base = staff ? '/clients/:clientId' : '';
    const guards = staff
      ? [app.verifyJwt, requireStaffKnowledgeRead]
      : [app.verifyJwt, app.requireClient];

    function requireClientId(request, reply) {
      const clientId = staff
        ? request.knowledgeClientId || null
        : resolvePrimaryClientId(request);
      if (!clientId) {
        reply.status(403).send({ message: 'No client account linked' });
        return null;
      }
      return clientId;
    }

    app.post(
      `${base}/knowledge/crawl`,
      {
        onRequest: guards,
        schema: {
          body: {
            type: 'object',
            properties: {
              rootUrl: { type: 'string' },
              projectId: { type: 'string', nullable: true },
            },
          },
        },
      },
      async (request, reply) => {
        const clientId = requireClientId(request, reply);
        if (!clientId) return;

        const { projectId = null } = request.body || {};

        const existing = await prisma.knowledgeCrawlRun.findFirst({
          where: { clientId, status: { in: ACTIVE_STATUSES } },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) {
          return reply.status(409).send({
            message: 'A crawl is already running for this client',
            run: existing,
          });
        }

        const client = await prisma.clientAccount.findUnique({
          where: { id: clientId },
          select: { websiteUrl: true },
        });
        const rootUrl = String(request.body?.rootUrl || client?.websiteUrl || '').trim();
        if (!rootUrl) {
          return reply
            .status(400)
            .send({ message: 'No website URL on file. Supply one to crawl.' });
        }

        let run;
        try {
          run = await createKnowledgeCrawlRun({
            clientId,
            projectId,
            rootUrl: /^https?:\/\//i.test(rootUrl) ? rootUrl : `https://${rootUrl}`,
            triggeredById: request.user.id,
          });
        } catch (err) {
          return reply.status(400).send({ message: err.message });
        }

        // Fire and forget: the crawl outlives this request and is polled via the
        // run id. Failures are recorded on the run row, not thrown here.
        setImmediate(() => {
          executeKnowledgeCrawlRun(run.id).catch((err) =>
            app.log.error({ err, runId: run.id }, 'Knowledge crawl failed')
          );
        });

        return reply.status(202).send({ run });
      }
    );

    app.get(`${base}/knowledge/crawl`, { onRequest: guards }, async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const runs = await prisma.knowledgeCrawlRun.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return reply.send({ runs });
    });

    app.get(`${base}/knowledge/crawl/:runId`, { onRequest: guards }, async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const run = await prisma.knowledgeCrawlRun.findUnique({
        where: { id: request.params.runId },
      });
      if (!run || run.clientId !== clientId) {
        return reply.status(404).send({ message: 'Crawl run not found' });
      }
      return reply.send({ run });
    });
  };
}

export const clientKnowledgeCrawlRoutes = buildCrawlRoutes({ staff: false });
export const staffKnowledgeCrawlRoutes = buildCrawlRoutes({ staff: true });
