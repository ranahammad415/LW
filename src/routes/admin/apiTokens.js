/**
 * OWNER-only API token management (SEO Engine OS-02/03/04). Mounted at /api/admin.
 * The plaintext token is returned once by POST and never again; only its sha256 is stored.
 * API tokens themselves can never call these routes (lib/apiTokens.js DENIED_PREFIXES + requireOwner).
 */
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  API_TOKEN_MAX_DAYS,
  API_TOKEN_ROLES,
  API_TOKEN_SCOPES,
  API_TOKEN_SCOPE_NAMES,
  EXPLICIT_SCOPES,
  generateApiToken,
  hashApiToken,
  serializeApiToken,
} from '../../lib/apiTokens.js';

const issueSchema = z.object({
  userId: z.string().min(1).max(191),
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS).optional(),
  scopes: z.array(z.enum(API_TOKEN_SCOPE_NAMES)).max(API_TOKEN_SCOPE_NAMES.length).optional(),
  projectIds: z.array(z.string().min(1).max(191)).max(200).optional(),
}).strict();

const USER_SELECT = { id: true, name: true, email: true, role: true, isAgent: true, isActive: true };

export async function adminApiTokenRoutes(app) {
  const owner = { onRequest: [app.verifyJwt, app.requireOwner] };

  app.get('/api-tokens/meta', owner, async (_request, reply) => reply.send({
    roles: API_TOKEN_ROLES,
    maxDays: API_TOKEN_MAX_DAYS,
    scopes: API_TOKEN_SCOPE_NAMES.map((name) => ({ name, routes: API_TOKEN_SCOPES[name], explicit: EXPLICIT_SCOPES.has(name) })),
  }));

  app.get('/api-tokens', owner, async (request, reply) => {
    const userId = typeof request.query?.userId === 'string' ? request.query.userId : undefined;
    const rows = await prisma.apiToken.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: USER_SELECT } },
    });
    return reply.send(rows.map(serializeApiToken));
  });

  app.post(
    '/api-tokens',
    { ...owner, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = issueSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ message: 'Validation failed', errors: parsed.error.flatten().fieldErrors });
      }
      const { userId, name, expiresInDays = 90 } = parsed.data;
      const scopes = [...new Set(parsed.data.scopes || [])];
      const projectIds = [...new Set(parsed.data.projectIds || [])];

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { ...USER_SELECT, tokenVersion: true } });
      if (!user || !user.isActive) return reply.status(404).send({ message: 'User not found or inactive' });
      if (!API_TOKEN_ROLES.includes(user.role)) {
        return reply.status(400).send({ message: 'API tokens can only be issued to PM, TEAM_MEMBER or CONTRACTOR users' });
      }
      if (projectIds.length) {
        const found = await prisma.project.count({ where: { id: { in: projectIds } } });
        if (found !== projectIds.length) return reply.status(400).send({ message: 'Unknown project id in projectIds' });
      }

      const token = generateApiToken();
      const row = await prisma.apiToken.create({
        data: {
          userId,
          name,
          tokenHash: hashApiToken(token),
          tokenPrefix: token.slice(0, 12),
          scopes: scopes.length ? scopes : undefined,
          projectIds: projectIds.length ? projectIds : undefined,
          userTokenVersion: user.tokenVersion,
          expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
          createdById: request.user.id,
        },
        include: { user: { select: USER_SELECT } },
      });
      request.log.info({ apiTokenId: row.id, userId, scopes, projectCount: projectIds.length }, 'API token issued');
      reply.header('Cache-Control', 'no-store');
      return reply.status(201).send({
        token,
        tokenNotice: 'Copy this token now. It is shown once and cannot be recovered.',
        apiToken: serializeApiToken(row),
      });
    }
  );

  app.post('/api-tokens/:id/revoke', owner, async (request, reply) => {
    const row = await prisma.apiToken.findUnique({ where: { id: request.params.id }, select: { id: true, revokedAt: true } });
    if (!row) return reply.status(404).send({ message: 'API token not found' });
    if (!row.revokedAt) {
      await prisma.apiToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: request.user.id },
      });
      request.log.info({ apiTokenId: row.id }, 'API token revoked');
    }
    const updated = await prisma.apiToken.findUnique({ where: { id: row.id }, include: { user: { select: USER_SELECT } } });
    return reply.send(serializeApiToken(updated));
  });
}
