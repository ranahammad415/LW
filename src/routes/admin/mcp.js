/**
 * OWNER admin for the remote MCP server (docs/ledger/features/mcp-server.md). Mounted at /api/admin only when
 * MCP_ENABLED=true. API tokens never reach it (lib/apiTokens.js DENIED_PREFIXES) and MCP itself cannot call it
 * (src/mcp/danger.js blocks /api/admin/mcp). Never returns a token, code or secret hash.
 */
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { invalidatePauseCache } from '../../mcp/oauth/tokens.js';

const USER_SELECT = { id: true, name: true, email: true, role: true };

function grantState(g) {
  if (g.revokedAt) return 'revoked';
  return 'active';
}

function serializeGrant(g) {
  return {
    id: g.id,
    scope: g.scope,
    createdAt: g.createdAt,
    lastUsedAt: g.lastUsedAt,
    revokedAt: g.revokedAt,
    revokedReason: g.revokedReason,
    state: grantState(g),
    user: g.user || null,
    client: g.client ? { id: g.client.id, name: g.client.clientName, disabledAt: g.client.disabledAt } : null,
  };
}

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  tool: z.string().max(64).optional(),
  danger: z.enum(['read', 'write', 'dangerous', 'blocked', 'auth']).optional(),
  ok: z.enum(['true', 'false']).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  grantId: z.string().max(191).optional(),
});

function dateOrNull(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function revokeGrants(where, ownerId) {
  const now = new Date();
  const grants = await prisma.mcpGrant.findMany({ where: { ...where, revokedAt: null }, select: { id: true } });
  if (!grants.length) return 0;
  const ids = grants.map((g) => g.id);
  await prisma.$transaction([
    prisma.mcpGrant.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: now, revokedById: ownerId, revokedReason: 'owner_revoked' } }),
    prisma.mcpToken.updateMany({ where: { grantId: { in: ids }, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  return ids.length;
}

export async function adminMcpRoutes(app, opts = {}) {
  const cfg = opts.cfg || {};
  const owner = { onRequest: [app.verifyJwt, app.requireOwner] };
  const noStore = (reply) => reply.header('Cache-Control', 'no-store');

  app.get('/mcp/status', owner, async (_request, reply) => {
    const since = new Date(Date.now() - 86_400_000);
    const [setting, activeGrants, clients, calls24h, errors24h] = await Promise.all([
      prisma.agencySetting.findFirst({ select: { mcpPausedAt: true, mcpPausedById: true } }),
      prisma.mcpGrant.count({ where: { revokedAt: null } }),
      prisma.mcpClient.count({ where: { disabledAt: null } }),
      prisma.mcpAuditLog.count({ where: { createdAt: { gte: since } } }),
      prisma.mcpAuditLog.count({ where: { createdAt: { gte: since }, ok: false } }),
    ]);
    const by = setting?.mcpPausedById ? await prisma.user.findUnique({ where: { id: setting.mcpPausedById }, select: { id: true, name: true } }) : null;
    return noStore(reply).send({
      enabled: true,
      publicUrl: cfg.resource || null,
      issuer: cfg.issuer || null,
      paused: !!setting?.mcpPausedAt,
      pausedAt: setting?.mcpPausedAt || null,
      pausedBy: by,
      allowedRoles: cfg.allowedRoles || ['OWNER'],
      limits: { perMinute: cfg.ratePerMin, perHour: cfg.ratePerHour, toolTimeoutMs: cfg.toolTimeoutMs, maxResultBytes: cfg.maxResultBytes, auditRetentionDays: cfg.auditRetentionDays },
      counts: { activeGrants, clients, calls24h, errors24h },
    });
  });

  async function setPaused(request, reply, paused) {
    const data = paused ? { mcpPausedAt: new Date(), mcpPausedById: request.user.id } : { mcpPausedAt: null, mcpPausedById: null };
    const existing = await prisma.agencySetting.findFirst({ select: { id: true } });
    if (existing) await prisma.agencySetting.update({ where: { id: existing.id }, data });
    else await prisma.agencySetting.create({ data });
    invalidatePauseCache();
    request.log.info({ by: request.user.id, paused }, 'MCP pause switch changed');
    return noStore(reply).send({ paused, note: 'Other server instances pick this up within 10 seconds.' });
  }
  app.post('/mcp/pause', owner, (request, reply) => setPaused(request, reply, true));
  app.post('/mcp/resume', owner, (request, reply) => setPaused(request, reply, false));

  app.get('/mcp/grants', owner, async (request, reply) => {
    const all = request.query?.state === 'all';
    const rows = await prisma.mcpGrant.findMany({
      where: all ? {} : { revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { user: { select: USER_SELECT }, client: { select: { id: true, clientName: true, disabledAt: true } } },
    });
    return noStore(reply).send(rows.map(serializeGrant));
  });

  app.post('/mcp/grants/:id/revoke', owner, async (request, reply) => {
    const id = String(request.params.id || '').slice(0, 191);
    const exists = await prisma.mcpGrant.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ message: 'Grant not found' });
    const revoked = await revokeGrants({ id }, request.user.id);
    return noStore(reply).send({ revoked });
  });

  app.post('/mcp/grants/revoke-all', owner, async (request, reply) => {
    const revoked = await revokeGrants({}, request.user.id);
    request.log.info({ by: request.user.id, revoked }, 'MCP grants revoked (all)');
    return noStore(reply).send({ revoked });
  });

  app.get('/mcp/clients', owner, async (_request, reply) => {
    const rows = await prisma.mcpClient.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, clientName: true, redirectUris: true, tokenEndpointAuthMethod: true, grantTypes: true, scope: true,
        clientUri: true, softwareId: true, softwareVersion: true, registrationIp: true, createdAt: true, lastUsedAt: true, disabledAt: true,
      },
    });
    return noStore(reply).send(rows);
  });

  app.get('/mcp/audit', owner, async (request, reply) => {
    const parsed = auditQuery.safeParse(request.query || {});
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid query', errors: parsed.error.flatten().fieldErrors });
    const q = parsed.data;
    const from = dateOrNull(q.from);
    const to = dateOrNull(q.to);
    if (from === undefined || to === undefined) return reply.code(400).send({ message: 'from/to must be dates' });
    const where = {
      ...(q.tool ? { tool: q.tool } : {}),
      ...(q.danger ? { danger: q.danger } : {}),
      ...(q.ok ? { ok: q.ok === 'true' } : {}),
      ...(q.grantId ? { grantId: q.grantId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const [items, total] = await Promise.all([
      prisma.mcpAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
      prisma.mcpAuditLog.count({ where }),
    ]);
    return noStore(reply).send({ items, total, limit, offset });
  });

  app.get('/mcp/audit/:id', owner, async (request, reply) => {
    const row = await prisma.mcpAuditLog.findUnique({ where: { id: String(request.params.id || '').slice(0, 191) } });
    if (!row) return reply.code(404).send({ message: 'Audit row not found' });
    return noStore(reply).send(row);
  });
}
