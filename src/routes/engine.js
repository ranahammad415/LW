/**
 * SEO Engine Google routes (OS-15/16). Registered at the root with full paths (see index.js).
 *   GET  /api/projects/:id/google-bindings   OWNER / project PM (API tokens need the bindings:read scope)
 *   POST /api/engine/google/token            Engine service account API token only (google:token scope + project
 *                                            allowlist); off unless ENGINE_GOOGLE_TOKEN_BROKER_ENABLED=1
 */
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ensureProjectAccess } from '../lib/ensureProjectAccess.js';
import { tokenProjectIds } from '../lib/apiTokens.js';
import {
  BROKER_PRODUCTS,
  BrokerError,
  GOOGLE_BINDING_SELECT,
  agencyGoogleSummary,
  isGoogleBrokerEnabled,
  mintDownscopedAccessToken,
  serializeGoogleBindings,
  takeBrokerSlot,
} from '../lib/googleBroker.js';

const tokenBody = z.object({
  projectId: z.string().min(1).max(191),
  product: z.enum(['gsc', 'ga4', 'gbp']),
}).strict();

export async function engineRoutes(app, { env = process.env, mint = mintDownscopedAccessToken } = {}) {
  app.get('/api/projects/:id/google-bindings', { onRequest: [app.verifyJwt] }, async (request, reply) => {
    const { user } = request;
    if (user.role !== 'OWNER' && user.role !== 'PM') {
      return reply.status(403).send({ message: 'OWNER or the project PM only' });
    }
    const project = await prisma.project.findUnique({ where: { id: request.params.id }, select: GOOGLE_BINDING_SELECT });
    if (!project) return reply.status(404).send({ message: 'Project not found' });
    if (!(await ensureProjectAccess(project, user))) {
      return reply.status(403).send({ message: 'You do not have access to this project' });
    }
    reply.header('Cache-Control', 'no-store');
    return reply.send(serializeGoogleBindings(project, await agencyGoogleSummary()));
  });

  app.post(
    '/api/engine/google/token',
    { onRequest: [app.verifyJwt], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      if (!isGoogleBrokerEnabled(env)) {
        return reply.status(503).send({ message: 'The Google token broker is not enabled on this OS', code: 'BROKER_DISABLED' });
      }
      const { user } = request;
      const allowed = tokenProjectIds(request);
      // Only the Engine service account's API token: PM + agent account, explicit google:token scope (also enforced
      // centrally), and a non-empty project allowlist.
      if (request.authMethod !== 'apiToken' || !request.apiToken?.scopes?.includes('google:token') || !allowed) {
        return reply.status(403).send({ message: 'Only an Engine API token with the google:token scope and a project allowlist can request Google tokens' });
      }
      if (user.role !== 'PM' || user.isAgent !== true) {
        return reply.status(403).send({ message: 'Only the Engine service account can request Google tokens' });
      }
      const parsed = tokenBody.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
      }
      const { projectId, product } = parsed.data;
      if (product === 'gbp') {
        return reply.status(400).send({ message: 'Business Profile tokens are not brokered (its scope can write)', code: 'PRODUCT_NOT_BROKERED' });
      }
      if (!allowed.includes(projectId)) {
        return reply.status(403).send({ message: 'This API token is not allowed for this project' });
      }
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: GOOGLE_BINDING_SELECT });
      if (!project) return reply.status(404).send({ message: 'Project not found' });
      if (!(await ensureProjectAccess(project, user))) {
        return reply.status(403).send({ message: 'You do not have access to this project' });
      }
      const { scope, field } = BROKER_PRODUCTS[product];
      const property = project[field];
      if (!property) {
        return reply.status(409).send({ message: `No ${product.toUpperCase()} property is linked to this project`, code: 'NOT_LINKED' });
      }
      if (!takeBrokerSlot(request.apiToken.id)) {
        reply.header('Retry-After', '600');
        return reply.status(429).send({ message: 'Too many Google token requests for this API token', code: 'RATE_LIMITED' });
      }
      let minted;
      try {
        minted = await mint(scope);
      } catch (err) {
        if (err instanceof BrokerError) return reply.status(err.status).send({ message: err.message, code: err.code });
        request.log.error({ code: err?.code }, 'Google token broker failed');
        return reply.status(502).send({ message: 'Google token request failed', code: 'GOOGLE_UPSTREAM' });
      }
      await prisma.googleTokenIssuance.create({
        data: {
          apiTokenId: request.apiToken.id,
          userId: user.id,
          projectId,
          product,
          property: String(property).slice(0, 500),
          scope,
          expiresAt: minted.expiresAt,
          ip: request.ip ? String(request.ip).slice(0, 45) : null,
        },
      });
      request.log.info({ apiTokenId: request.apiToken.id, projectId, product }, 'Google access token issued to Engine');
      return reply.send({
        accessToken: minted.accessToken,
        tokenType: 'Bearer',
        expiresAt: minted.expiresAt,
        expiresIn: Math.max(0, Math.round((minted.expiresAt.getTime() - Date.now()) / 1000)),
        scope,
        product,
        projectId,
        property,
      });
    }
  );
}
