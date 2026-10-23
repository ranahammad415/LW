/**
 * Remote MCP server for Claude connectors (docs/ledger/features/mcp-server.md). Registered by src/index.js only when
 * MCP_ENABLED=true. The OS backend is both the MCP resource server (POST /api/mcp) and its own OAuth 2.1
 * authorization server (discovery, dynamic client registration, authorize via the SPA consent page, token, revoke).
 *
 *   installMcpRouteCollector(app)  before any route plugin: records the live route table (onRoute) for the catalog
 *   registerMcp(app, { cfg, collector })  after the route plugins: OAuth + /api/mcp + discovery, in one encapsulated
 *                                         plugin (its form-urlencoded parser stays scoped to these routes)
 *   purgeMcpRecords()  leader-only hourly retention (src/index.js '23 * * * *' block)
 */
import { prisma } from '../lib/prisma.js';
import { createRouteCollector, RouteCatalog } from './catalog.js';
import { metadataRoutes, publicJsonHeaders } from './oauth/metadata.js';
import { registerRoute } from './oauth/clients.js';
import { authorizeRoutes } from './oauth/authorize.js';
import { tokenRoutes } from './oauth/token.js';
import { mcpEndpointRoutes } from './transport.js';

export { loadMcpConfig } from './config.js';

export function installMcpRouteCollector(app) {
  const collector = createRouteCollector();
  app.addHook('onRoute', (opts) => collector.onRoute(opts));
  return collector;
}

export function registerMcp(app, { cfg, collector, db = prisma }) {
  let catalog = null;
  const getCatalog = () => {
    if (!catalog || catalog.entries.length !== collector.routes.length) catalog = new RouteCatalog(collector.routes);
    return catalog;
  };
  app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)));
      } catch (err) {
        done(err);
      }
    });
    // Browser preflights for the public OAuth JSON endpoints (no credentials).
    const preflight = async (_request, reply) => publicJsonHeaders(reply).code(204).send();
    for (const p of ['/api/mcp/oauth/register', '/api/mcp/oauth/token', '/api/mcp/oauth/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${cfg.resourcePath}`]) {
      scope.options(p, preflight);
    }
    await scope.register(metadataRoutes, { cfg });
    await scope.register(registerRoute, { cfg, db });
    await scope.register(authorizeRoutes, { cfg, db });
    await scope.register(tokenRoutes, { cfg, db });
    await scope.register(mcpEndpointRoutes, { cfg, db, rootApp: app, getCatalog });
  });
  return { getCatalog };
}

/**
 * Hourly retention (leader only): expired auth requests, used/expired/revoked tokens older than 7 days, expired
 * confirmations, audit rows older than MCP_AUDIT_RETENTION_DAYS, never-used clients older than 180 days.
 * Plain conditional deletes, safe to run twice.
 */
export async function purgeMcpRecords(cfg, { db = prisma, now = new Date() } = {}) {
  const DAY = 86_400_000;
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [authRequests, tokens, confirmations, audit, clients] = await Promise.all([
    db.mcpAuthRequest.deleteMany({ where: { expiresAt: { lt: weekAgo } } }),
    db.mcpToken.deleteMany({ where: { OR: [{ expiresAt: { lt: weekAgo } }, { revokedAt: { lt: weekAgo } }, { usedAt: { lt: weekAgo } }] } }),
    db.mcpConfirmation.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY) } } }),
    db.mcpAuditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - cfg.auditRetentionDays * DAY) } } }),
    db.mcpClient.deleteMany({ where: { lastUsedAt: null, createdAt: { lt: new Date(now.getTime() - 180 * DAY) }, grants: { none: {} } } }),
  ]);
  return { authRequests: authRequests.count, tokens: tokens.count, confirmations: confirmations.count, audit: audit.count, clients: clients.count };
}
