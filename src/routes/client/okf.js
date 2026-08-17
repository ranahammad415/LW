/**
 * OKF v2 client endpoints: business intake orchestration, asset index,
 * folder-spec generation, file revision history and strategy versioning.
 */
import { prisma } from '../../lib/prisma.js';
import {
  readOkfFile,
  listOkfVersions,
  getOkfVersion,
  writeOkfFile,
  setOkfContext,
  clearOkfContext,
} from '../../lib/knowledgeEngine.js';
import {
  runBusinessIntakeOrchestration,
  getIntakeStatus,
  assessOkfIntakeCompleteness,
} from '../../lib/businessIntakeService.js';
import {
  reindexOkfAssets,
  listOkfIndex,
  logStrategyVersion,
  listStrategyVersions,
  rollbackStrategyTo,
} from '../../lib/okfIndexingService.js';
import {
  generateOkfSpecStructure,
  validateOkfSpecCompliance,
} from '../../lib/okfFolderGeneratorService.js';
import { resolvePrimaryClientId } from '../../lib/clientContext.js';

function requireClientId(request, reply) {
  const clientId = resolvePrimaryClientId(request);
  if (!clientId) {
    reply.status(403).send({ message: 'No client account linked' });
    return null;
  }
  return clientId;
}

async function assertProjectBelongsToClient(projectId, clientId, reply) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, clientId },
    select: { id: true },
  });
  if (!project) {
    reply.status(404).send({ message: 'Project not found' });
    return false;
  }
  return true;
}

export async function clientOkfRoutes(app) {
  // ── Business intake ───────────────────────────────────────────────────────

  app.get(
    '/intake/status',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      try {
        return reply.send(await getIntakeStatus(clientId));
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      }
    }
  );

  app.post(
    '/intake/orchestrate',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string', nullable: true },
            intakeData: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const { projectId = null } = request.body || {};
      let { intakeData } = request.body || {};

      // Fall back to the most recent submitted intake when none is supplied.
      if (!intakeData || Object.keys(intakeData).length === 0) {
        const latest = await prisma.intakeSubmission.findFirst({
          where: { clientId, ...(projectId ? { projectId } : {}) },
          orderBy: { submittedAt: 'desc' },
        });
        if (!latest) {
          return reply.status(400).send({
            message: 'No intake data supplied and no prior intake submission found.',
          });
        }
        intakeData = mapSubmissionToIntake(latest.data);
      }

      setOkfContext({ userId: request.user.id, reason: 'Business intake orchestration' });
      try {
        const result = await runBusinessIntakeOrchestration(clientId, intakeData, request.user.id, projectId);
        await reindexOkfAssets(clientId);
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'Business intake orchestration failed');
        return reply.status(500).send({ message: err.message });
      } finally {
        clearOkfContext();
      }
    }
  );

  app.get(
    '/intake/assessment',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;
      return reply.send(assessOkfIntakeCompleteness(clientId));
    }
  );

  // ── Asset index ───────────────────────────────────────────────────────────

  app.get(
    '/knowledge/index',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            type: { type: 'string' },
            search: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const assets = await listOkfIndex(clientId, request.query || {});
      return reply.send({ assets, count: assets.length });
    }
  );

  app.post(
    '/knowledge/reindex',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const result = await reindexOkfAssets(clientId);
      if (!result.success) return reply.status(500).send({ message: result.message });
      return reply.send(result);
    }
  );

  // ── Folder spec ───────────────────────────────────────────────────────────

  app.post(
    '/knowledge/spec/generate',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const client = await prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { agencyName: true },
      });

      setOkfContext({ userId: request.user.id, reason: 'OKF spec structure generation' });
      try {
        const result = await generateOkfSpecStructure(clientId, { agencyName: client?.agencyName || 'Client' });
        await reindexOkfAssets(clientId);
        return reply.send(result);
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      } finally {
        clearOkfContext();
      }
    }
  );

  app.get(
    '/knowledge/spec/validate',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;
      return reply.send(await validateOkfSpecCompliance(clientId));
    }
  );

  // ── File revision history ─────────────────────────────────────────────────
  // Folder is passed as a query param because OKF folders contain slashes
  // (e.g. "seo/strategy"), which a path param cannot represent.

  app.get(
    '/knowledge/versions',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            filename: { type: 'string' },
          },
          required: ['folder', 'filename'],
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const { folder, filename } = request.query;
      const versions = await listOkfVersions(clientId, folder, filename);
      return reply.send({ versions });
    }
  );

  app.get(
    '/knowledge/versions/:versionId',
    { onRequest: [app.verifyJwt, app.requireClient] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const version = await getOkfVersion(request.params.versionId);
      if (!version || version.clientId !== clientId) {
        return reply.status(404).send({ message: 'Revision not found' });
      }
      return reply.send(version);
    }
  );

  app.post(
    '/knowledge/versions/:versionId/restore',
    { onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter] },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const version = await getOkfVersion(request.params.versionId);
      if (!version || version.clientId !== clientId) {
        return reply.status(404).send({ message: 'Revision not found' });
      }

      // The stored body is the full serialized file; re-split it so the restore
      // goes back through writeOkfFile and gets its own new revision.
      const match = String(version.body).match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
      const body = match ? match[2] : version.body;
      const metadata = {
        ...(version.metadata || {}),
        change_summary: `Restored from version ${version.versionNumber}`,
      };

      setOkfContext({ userId: request.user.id, reason: `Restore v${version.versionNumber}` });
      try {
        const filePath = writeOkfFile(
          clientId,
          version.folder,
          version.filename,
          metadata,
          body
        );
        await reindexOkfAssets(clientId);
        return reply.send({ success: true, path: filePath });
      } catch (err) {
        return reply.status(500).send({ message: err.message });
      } finally {
        clearOkfContext();
      }
    }
  );

  // ── Project strategy blueprint ────────────────────────────────────────────

  app.get(
    '/knowledge/strategy',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        querystring: {
          type: 'object',
          properties: { projectId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      try {
        const doc = readOkfFile(clientId, 'seo/strategy', 'strategy');
        return reply.send(doc);
      } catch {
        return reply.send({
          metadata: { type: 'seo-strategy', title: 'Project SEO Strategy Blueprint' },
          body: '',
        });
      }
    }
  );

  app.post(
    '/knowledge/strategy',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            content: { type: 'string' },
            changeSummary: { type: 'string' },
          },
          required: ['projectId', 'content'],
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const { projectId, content, changeSummary } = request.body;
      if (!(await assertProjectBelongsToClient(projectId, clientId, reply))) return;

      setOkfContext({ userId: request.user.id, reason: changeSummary || 'Strategy update' });
      try {
        const result = await logStrategyVersion(projectId, content, request.user.id, changeSummary);
        if (!result.success) return reply.status(500).send({ message: result.message });
        await reindexOkfAssets(clientId);
        return reply.send(result);
      } finally {
        clearOkfContext();
      }
    }
  );

  app.get(
    '/knowledge/strategy/versions',
    {
      onRequest: [app.verifyJwt, app.requireClient],
      schema: {
        querystring: {
          type: 'object',
          properties: { projectId: { type: 'string' } },
          required: ['projectId'],
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const { projectId } = request.query;
      if (!(await assertProjectBelongsToClient(projectId, clientId, reply))) return;

      return reply.send({ versions: await listStrategyVersions(projectId) });
    }
  );

  app.post(
    '/knowledge/strategy/rollback',
    {
      onRequest: [app.verifyJwt, app.requireClient, app.requireClientWriter],
      schema: {
        body: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            versionNumber: { type: 'integer' },
          },
          required: ['projectId', 'versionNumber'],
        },
      },
    },
    async (request, reply) => {
      const clientId = requireClientId(request, reply);
      if (!clientId) return;

      const { projectId, versionNumber } = request.body;
      if (!(await assertProjectBelongsToClient(projectId, clientId, reply))) return;

      setOkfContext({ userId: request.user.id, reason: `Rollback to v${versionNumber}` });
      try {
        const result = await rollbackStrategyTo(projectId, versionNumber, request.user.id);
        if (!result.success) return reply.status(400).send({ message: result.message });
        await reindexOkfAssets(clientId);
        return reply.send(result);
      } finally {
        clearOkfContext();
      }
    }
  );
}

/**
 * Maps the flat onboarding/gap-interview answer shape onto the structured
 * payload the intake orchestrator expects.
 */
function mapSubmissionToIntake(data = {}) {
  const toList = (value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') {
      return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };

  return {
    businessName: data.businessName || data.companyName || undefined,
    website: data.websiteUrl || data.website || undefined,
    industry: data.industry || undefined,
    services: toList(data.primaryProduct || data.services),
    locations: toList(data.keyMarkets || data.locations),
    serviceAreas: toList(data.keyMarkets || data.serviceAreas),
    targetCustomers: data.targetCustomer || data.targetCustomers || undefined,
    competitors: toList(data.competitors),
    usps: toList(data.uniqueSellingPoints || data.usps),
    approvedClaims: toList(data.approvedClaims),
    restrictedClaims: toList(data.topicsToAvoid || data.restrictedClaims),
    faqs: Array.isArray(data.faqs) ? data.faqs : [],
    testimonials: Array.isArray(data.testimonials) ? data.testimonials : [],
    caseStudies: Array.isArray(data.caseStudies) ? data.caseStudies : [],
    brandVoice: data.brandVoice || undefined,
    proofLinks: toList(data.proofLinks),
  };
}
