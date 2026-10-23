/**
 * Per-user API tokens (SEO Engine OS-02/04). `Authorization: Bearer lwk_<base64url>`.
 *
 * - Only sha256(token) is stored (`ApiToken.tokenHash`); the plaintext is returned once at issue time.
 * - A token resolves to its user with that user's normal role and project rights: it never grants more.
 *   Optional `scopes` (route groups below) and `projectIds` (allowlist) only narrow it.
 * - Revocation, expiry, user deactivation and a `User.tokenVersion` bump all take effect on the next request.
 * - Tokens can never reach auth/session/token-management endpoints (DENIED_ROUTES).
 * - Only PM / TEAM_MEMBER / CONTRACTOR users can hold tokens (no OWNER or CLIENT tokens).
 * The plaintext token is never logged; log lines carry the token id only.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from './prisma.js';

export const API_TOKEN_PREFIX = 'lwk_';
const TOKEN_RE = /^lwk_[A-Za-z0-9_-]{43,128}$/;
export const API_TOKEN_ROLES = ['PM', 'TEAM_MEMBER', 'CONTRACTOR'];
export const API_TOKEN_MAX_DAYS = 365;
const LAST_USED_THROTTLE_MS = 60_000;

/** The user fields every authenticated request carries (same as the JWT path, plus the server-only agent flag). */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  role: true,
  name: true,
  avatarUrl: true,
  phone: true,
  timezone: true,
  isActive: true,
  tokenVersion: true,
  isAgent: true,
};

/**
 * Route groups a token can be narrowed to. Keys are "METHOD /full/route/pattern" (Fastify routeOptions.url).
 * A token with no scopes keeps the user's normal permissions, except EXPLICIT_SCOPES routes, which always need
 * the scope to be listed on the token.
 */
export const API_TOKEN_SCOPES = {
  'projects:read': ['GET /api/projects/:id'],
  'tasks:read': ['GET /api/tasks', 'GET /api/tasks/:id/comments', 'GET /api/tasks/:id/activity-logs'],
  'tasks:create': ['POST /api/tasks'],
  'tasks:status': ['PATCH /api/tasks/:id/status'],
  'comments:write': ['POST /api/tasks/:id/comments'],
  'knowledge:read': [
    'GET /api/staff/clients/:clientId/knowledge/index',
    'GET /api/staff/clients/:clientId/knowledge/versions',
  ],
  'engine-review:outbox': ['GET /api/engine-review/outbox', 'POST /api/engine-review/outbox/:eventId/ack'],
  'bindings:read': ['GET /api/projects/:id/google-bindings'],
  'google:token': ['POST /api/engine/google/token'],
  // SEO Engine OS-21: EmDash site drafts (never publish). Read = list / get / push context / pre-check.
  'drafts:read': [
    'GET /api/pm/projects/:projectId/cms-drafts',
    'GET /api/pm/cms-drafts/:id',
    'GET /api/pm/projects/:projectId/cms-push-context',
    'POST /api/pm/cms-drafts/:id/check',
  ],
  // Write = create / PATCH / push / open a site page / image upload. Implies drafts:read.
  'drafts:write': [
    'POST /api/pm/projects/:projectId/cms-drafts',
    'PATCH /api/pm/cms-drafts/:id',
    'POST /api/pm/cms-drafts/:id/push',
    'POST /api/pm/projects/:projectId/cms-drafts/from-entry',
    'POST /api/pm/projects/:projectId/cms-media',
  ],
};
/** Scopes that must be listed on the token: an empty scope list never grants them (OS-16, OS-21). */
export const EXPLICIT_SCOPES = new Set(['bindings:read', 'google:token', 'drafts:read', 'drafts:write']);
/** A listed scope that also satisfies another scope's routes. */
export const SCOPE_IMPLIES = { 'drafts:write': ['drafts:read'] };
export const API_TOKEN_SCOPE_NAMES = Object.keys(API_TOKEN_SCOPES);

const ROUTE_TO_SCOPE = new Map();
for (const [scope, routes] of Object.entries(API_TOKEN_SCOPES)) {
  for (const r of routes) ROUTE_TO_SCOPE.set(r, scope);
}

/** Never reachable with an API token, whatever its scopes. */
// Security platform: agents and tokens never act on security (reads included, to keep evidence away from automations).
// Health score v2: tokens never read or write health scores, notes or config (deny for now).
// Remote MCP server: tokens never reach the OAuth consent API or the MCP admin routes.
const DENIED_PREFIXES = ['/api/auth/', '/api/admin/api-tokens', '/api/pm/security/', '/api/admin/security-settings', '/api/admin/health/', '/api/mcp', '/api/admin/mcp'];
/** Never reachable with an API token (method + route): deleting OS drafts and the paid AI writer stay human-only. */
const DENIED_METHOD_ROUTES = new Set(['DELETE /api/pm/cms-drafts/:id', 'POST /api/pm/cms-drafts/:id/ai-write']);
const DENIED_ROUTES = new Set([
  '/api/admin/change-password',
  '/api/admin/impersonate',
  '/api/admin/profile',
  '/api/admin/team/members/:id',
  '/api/admin/team/members',
  '/api/pm/projects/:projectId/health',
  '/api/pm/projects/:projectId/health/recompute',
  '/api/pm/clients/:clientId/health',
  '/api/pm/clients/:clientId/health-note',
]);

/**
 * Routes a project-allowlisted token can use, with how to find the project. Any other route is refused for a
 * token that has `projectIds` (fail closed). 'filter' = the handler filters by tokenProjectIds() itself.
 */
const PROJECT_RESOLVERS = {
  'GET /api/projects/:id': (req) => ({ projectId: req.params?.id }),
  'GET /api/projects/:id/google-bindings': (req) => ({ projectId: req.params?.id }),
  'POST /api/engine/google/token': (req) => ({ projectId: req.body?.projectId }),
  'GET /api/tasks': () => 'filter',
  'POST /api/tasks': (req) => ({ projectId: req.body?.projectId }),
  'GET /api/engine-review/outbox': () => 'filter',
  'POST /api/engine-review/outbox/:eventId/ack': () => 'filter',
  'GET /api/staff/clients/:clientId/knowledge/index': (req) => ({ clientId: req.params?.clientId }),
  'GET /api/staff/clients/:clientId/knowledge/versions': (req) => ({ clientId: req.params?.clientId }),
  // OS-21 draft routes: the project in the path, or the draft's project.
  'GET /api/pm/projects/:projectId/cms-drafts': (req) => ({ projectId: req.params?.projectId }),
  'POST /api/pm/projects/:projectId/cms-drafts': (req) => ({ projectId: req.params?.projectId }),
  'POST /api/pm/projects/:projectId/cms-drafts/from-entry': (req) => ({ projectId: req.params?.projectId }),
  'GET /api/pm/projects/:projectId/cms-push-context': (req) => ({ projectId: req.params?.projectId }),
  'POST /api/pm/projects/:projectId/cms-media': (req) => ({ projectId: req.params?.projectId }),
  'GET /api/pm/cms-drafts/:id': (req) => projectIdForDraft(req.params?.id),
  'PATCH /api/pm/cms-drafts/:id': (req) => projectIdForDraft(req.params?.id),
  'POST /api/pm/cms-drafts/:id/push': (req) => projectIdForDraft(req.params?.id),
  'POST /api/pm/cms-drafts/:id/check': (req) => projectIdForDraft(req.params?.id),
};

async function projectIdForDraft(draftId) {
  if (!draftId || typeof draftId !== 'string') return null;
  const d = await prisma.cmsDraft.findUnique({ where: { id: draftId }, select: { projectId: true } });
  return { projectId: d?.projectId || null };
}

export function generateApiToken() {
  return API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashApiToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function looksLikeApiToken(token) {
  return typeof token === 'string' && token.startsWith(API_TOKEN_PREFIX);
}

function routeKey(request) {
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const url = request.routeOptions?.url || request.routerPath || '';
  return { method, url, key: `${method} ${url}` };
}

function asList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : [];
}

/** Scope/denylist decision for one route. Pure; exported for tests. */
export function checkApiTokenRoute(token, method, url) {
  const m = method === 'HEAD' ? 'GET' : method;
  if (!url) return { ok: false, status: 403, message: 'API tokens cannot be used for this endpoint' };
  const key = `${m} ${url}`;
  if (DENIED_PREFIXES.some((p) => url.startsWith(p)) || DENIED_ROUTES.has(url) || DENIED_METHOD_ROUTES.has(key)) {
    return { ok: false, status: 403, message: 'API tokens cannot be used for this endpoint' };
  }
  const routeScope = ROUTE_TO_SCOPE.get(key) || null;
  const scopes = asList(token.scopes);
  const has = (scope) => scopes.includes(scope) || scopes.some((x) => (SCOPE_IMPLIES[x] || []).includes(scope));
  if (routeScope && EXPLICIT_SCOPES.has(routeScope) && !has(routeScope)) {
    return { ok: false, status: 403, message: `This API token needs the ${routeScope} scope` };
  }
  if (scopes.length > 0 && (!routeScope || !has(routeScope))) {
    return { ok: false, status: 403, message: 'This API token is not allowed to use this endpoint' };
  }
  if (asList(token.projectIds).length > 0 && !PROJECT_RESOLVERS[key]) {
    return { ok: false, status: 403, message: 'This project-restricted API token cannot use this endpoint' };
  }
  return { ok: true };
}

const lastUsedWrites = new Map();
function touchLastUsed(row, log) {
  const now = Date.now();
  const prev = lastUsedWrites.get(row.id) || (row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0);
  if (now - prev < LAST_USED_THROTTLE_MS) return;
  lastUsedWrites.set(row.id, now);
  if (lastUsedWrites.size > 5000) lastUsedWrites.clear();
  const cutoff = new Date(now - LAST_USED_THROTTLE_MS);
  // Conditional write: N PM2 instances still write at most about once a minute per token.
  prisma.apiToken
    .updateMany({
      where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
      data: { lastUsedAt: new Date(now) },
    })
    .catch((err) => log?.warn?.({ err: err?.message, apiTokenId: row.id }, 'apiToken lastUsedAt update failed'));
}

const INVALID = 'Invalid or revoked API token';

/** verifyJwt's API-token branch. Sends 401/403 itself; on success sets request.user/authMethod/apiToken. */
export async function authenticateApiToken(request, reply, raw) {
  if (!TOKEN_RE.test(raw)) return reply.status(401).send({ message: INVALID });
  const tokenHash = hashApiToken(raw);
  let row;
  try {
    row = await prisma.apiToken.findUnique({
      where: { tokenHash },
      include: { user: { select: AUTH_USER_SELECT } },
    });
  } catch (err) {
    request.log?.error?.({ err: err?.message }, 'apiToken lookup failed');
    return reply.status(401).send({ message: INVALID });
  }
  // The DB lookup is by hash; the second comparison is constant time on equal-length hex strings.
  if (!row || !row.tokenHash || row.tokenHash.length !== tokenHash.length
    || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(tokenHash))) {
    return reply.status(401).send({ message: INVALID });
  }
  const user = row.user;
  if (row.revokedAt) return reply.status(401).send({ message: INVALID });
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) {
    return reply.status(401).send({ message: 'API token expired' });
  }
  if (!user || !user.isActive) return reply.status(401).send({ message: 'User not found or inactive' });
  if (user.tokenVersion !== row.userTokenVersion) return reply.status(401).send({ message: INVALID });
  if (!API_TOKEN_ROLES.includes(user.role)) return reply.status(401).send({ message: INVALID });

  const { method, url } = routeKey(request);
  const decision = checkApiTokenRoute(row, method, url);
  if (!decision.ok) return reply.status(decision.status).send({ message: decision.message });

  request.user = user;
  request.authMethod = 'apiToken';
  request.apiToken = {
    id: row.id,
    name: row.name,
    userId: row.userId,
    scopes: asList(row.scopes),
    projectIds: asList(row.projectIds),
    expiresAt: row.expiresAt,
  };
  touchLastUsed(row, request.log);
}

/** Project allowlist of the calling token, or null when unrestricted / not a token request. */
export function tokenProjectIds(request) {
  if (request?.authMethod !== 'apiToken') return null;
  const ids = request.apiToken?.projectIds || [];
  return ids.length ? ids : null;
}

/** True for API-token requests by TEAM_MEMBER / CONTRACTOR users (OS-09 worker rules). */
export function isWorkerApiToken(request) {
  return request?.authMethod === 'apiToken'
    && (request.user?.role === 'TEAM_MEMBER' || request.user?.role === 'CONTRACTOR');
}

/** True when the caller is an agent account or a non-interactive API token: never an approver/reviewer. */
export function isAgentOrToken(request) {
  return request?.authMethod === 'apiToken' || request?.user?.isAgent === true;
}

async function projectIdForTask(taskId) {
  if (!taskId || typeof taskId !== 'string') return null;
  const t = await prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
  return t?.projectId || null;
}

/**
 * Global preHandler (runs after onRequest guards and body parsing). Enforces a token's projectIds allowlist.
 * Task routes resolve the task's project; client-addressed knowledge routes need an allowlisted project of
 * that client. Anything unresolvable is refused.
 */
export async function enforceApiTokenProjectScope(request, reply) {
  const allowed = tokenProjectIds(request);
  if (!allowed) return;
  const { key, url } = routeKey(request);
  let resolver = PROJECT_RESOLVERS[key];
  if (!resolver && url.startsWith('/api/tasks/:')) {
    resolver = async (req) => ({ projectId: await projectIdForTask(req.params?.id || req.params?.taskId) });
  }
  if (!resolver) return reply.status(403).send({ message: 'This project-restricted API token cannot use this endpoint' });
  const target = await resolver(request);
  if (target === 'filter') return;
  if (target?.projectId) {
    if (!allowed.includes(target.projectId)) {
      return reply.status(403).send({ message: 'This API token is not allowed for this project' });
    }
    return;
  }
  if (target?.clientId) {
    const n = await prisma.project.count({ where: { id: { in: allowed }, clientId: target.clientId } });
    if (n > 0) return;
  }
  return reply.status(403).send({ message: 'This API token is not allowed for this project' });
}

/** Registers the API-token hooks on the root app (index.js and tests/setup/test-app.js). */
export function registerApiTokenHooks(app) {
  app.addHook('preHandler', enforceApiTokenProjectScope);
}

/** Admin view of a token row (never the hash). */
export function serializeApiToken(row) {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: asList(row.scopes),
    projectIds: asList(row.projectIds),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
    user: row.user ? { id: row.user.id, name: row.user.name, email: row.user.email, role: row.user.role, isAgent: row.user.isAgent === true, isActive: row.user.isActive } : undefined,
  };
}
