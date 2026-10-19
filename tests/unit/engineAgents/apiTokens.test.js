/**
 * SEO Engine agents, stage 1 (OS-01/02/04/09): lwk_ API tokens through verifyJwt, worker visibility,
 * worker status limits, scope/project narrowing, agent flag redaction and the human-only approval guard.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'r1', createdAt: new Date(), ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => (n === '$transaction' ? async (fn) => fn(model('tx')) : model(String(n))) }) };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn(), sanitizeUserInputForPrompt: (s) => s }));

const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');
const { requireOwner } = await import('../../../src/lib/requireOwner.js');
const { requirePM } = await import('../../../src/lib/requirePM.js');
const { requireClient, requireClientWriter } = await import('../../../src/lib/requireClient.js');
const { redactResponseSecrets, responseDropKeys } = await import('../../../src/lib/redactSecrets.js');
const { registerApiTokenHooks, generateApiToken, hashApiToken, checkApiTokenRoute } = await import('../../../src/lib/apiTokens.js');
const { rejectAgentReviewer, checkAgentStatusChange } = await import('../../../src/lib/agentPolicy.js');
const { taskRoutes } = await import('../../../src/routes/tasks.js');
const { projectRoutes } = await import('../../../src/routes/projects.js');
const { adminApiTokenRoutes } = await import('../../../src/routes/admin/apiTokens.js');

const SECRET = process.env.JWT_ACCESS_SECRET;
const WORKER = { id: 'u-worker', email: 'w@x.test', role: 'TEAM_MEMBER', name: 'Ava Writer', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: true };
const ENGINE = { id: 'u-engine', email: 'e@x.test', role: 'PM', name: 'Engine', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: true };
const HUMAN = { id: 'u-human', email: 'h@x.test', role: 'TEAM_MEMBER', name: 'Hana', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: false };
const OWNER = { id: 'u-owner', email: 'o@x.test', role: 'OWNER', name: 'Owner', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: false };
const USERS = { [WORKER.id]: WORKER, [ENGINE.id]: ENGINE, [HUMAN.id]: HUMAN, [OWNER.id]: OWNER };

const tokens = new Map(); // hash -> row
function issue(user, extra = {}) {
  const raw = generateApiToken();
  const row = {
    id: `tok-${tokens.size + 1}`, userId: user.id, name: 'test', tokenHash: hashApiToken(raw), tokenPrefix: raw.slice(0, 12),
    scopes: null, projectIds: null, userTokenVersion: 0, expiresAt: new Date(Date.now() + 86_400_000),
    lastUsedAt: null, revokedAt: null, createdAt: new Date(), ...extra,
  };
  tokens.set(row.tokenHash, row);
  return raw;
}
const jwtFor = (user) => jwt.sign({ sub: user.id, role: user.role }, SECRET);
const bearer = (t) => ({ authorization: `Bearer ${t}` });

const TASK_ASSIGNED = { id: 't-mine', projectId: 'p1', title: 'Mine', status: 'TO_DO', assignees: [{ id: WORKER.id }], workCycle: { id: 'c1', status: 'OPEN' }, project: { id: 'p1', name: 'P', leadPmId: ENGINE.id, wpUrl: null, wpApiKey: null, client: { leadPmId: null, secondaryPmId: null } } };
const TASK_OTHER = { ...TASK_ASSIGNED, id: 't-other', title: 'Someone else', assignees: [{ id: 'u-x' }] };

let app;
beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  app.addHook('preSerialization', async (request, _r, payload) => redactResponseSecrets(payload, 0, responseDropKeys(request)));
  registerApiTokenHooks(app);
  app.decorate('verifyJwt', verifyJwt);
  app.decorate('requireOwner', requireOwner);
  app.decorate('requirePM', requirePM);
  app.decorate('requireClient', requireClient);
  app.decorate('requireClientWriter', requireClientWriter);
  app.register(taskRoutes, { prefix: '/api/tasks' });
  app.register(projectRoutes, { prefix: '/api/projects' });
  app.register(adminApiTokenRoutes, { prefix: '/api/admin' });
  // Small fixtures for audience/approval checks.
  const people = async () => ({ comment: { user: { id: WORKER.id, name: WORKER.name, isAgent: true } } });
  app.get('/api/client/fixture', { onRequest: [verifyJwt] }, people);
  app.get('/api/pm/fixture', { onRequest: [verifyJwt] }, people);
  app.get('/api/admin/fixture', { onRequest: [verifyJwt, requireOwner] }, people);
  app.post('/api/pm/fixture/approve', { onRequest: [verifyJwt, requirePM, rejectAgentReviewer] }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => app?.close());

beforeEach(() => {
  db.calls = [];
  db.overrides = {
    'apiToken.findUnique': async ({ where }) => {
      const row = tokens.get(where.tokenHash);
      return row ? { ...row, user: USERS[row.userId] ? { ...USERS[row.userId] } : null } : null;
    },
    'user.findUnique': async ({ where }) => (USERS[where.id] ? { ...USERS[where.id] } : null),
    'task.findUnique': async ({ where }) => ({ [TASK_ASSIGNED.id]: TASK_ASSIGNED, [TASK_OTHER.id]: TASK_OTHER }[where.id] || null),
  };
});

describe('API token authentication (OS-02)', () => {
  it('a valid token resolves to its user with authMethod apiToken and the user role', async () => {
    const t = issue(WORKER);
    db.overrides['task.findMany'] = async () => [];
    const res = await app.inject({ method: 'GET', url: '/api/tasks?cycle=all', headers: bearer(t) });
    expect(res.statusCode).toBe(200);
    const where = db.calls.find((c) => c.key === 'task.findMany').args.where;
    expect(where.assignees).toEqual({ some: { id: WORKER.id } });
  });

  it('a revoked token gets 401', async () => {
    const t = issue(WORKER, { revokedAt: new Date() });
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(t) });
    expect(res.statusCode).toBe(401);
  });

  it('an expired token gets 401', async () => {
    const t = issue(WORKER, { expiresAt: new Date(Date.now() - 1000) });
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(t) });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('API token expired');
  });

  it('an unknown or malformed token gets 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(generateApiToken()) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer('lwk_short') })).statusCode).toBe(401);
  });

  it('a deactivated user or a tokenVersion bump invalidates the token', async () => {
    const inactive = { ...WORKER, id: 'u-gone', isActive: false };
    USERS[inactive.id] = inactive;
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(issue(inactive)) })).statusCode).toBe(401);
    const bumped = { ...WORKER, id: 'u-bumped', tokenVersion: 3 };
    USERS[bumped.id] = bumped;
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(issue(bumped, { userTokenVersion: 2 })) })).statusCode).toBe(401);
  });

  it('an OWNER or CLIENT user can never authenticate with a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/fixture', headers: bearer(issue(OWNER)) });
    expect(res.statusCode).toBe(401);
  });

  it('tokens cannot reach token management or other denied endpoints', async () => {
    const t = issue(ENGINE);
    const res = await app.inject({ method: 'GET', url: '/api/admin/api-tokens', headers: bearer(t) });
    expect(res.statusCode).toBe(403);
    expect(checkApiTokenRoute({}, 'POST', '/api/auth/refresh').ok).toBe(false);
    expect(checkApiTokenRoute({}, 'POST', '/api/admin/change-password').ok).toBe(false);
  });

  it('throttles lastUsedAt writes', async () => {
    const t = issue(WORKER);
    db.overrides['task.findMany'] = async () => [];
    await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(t) });
    await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(t) });
    await new Promise((r) => setTimeout(r, 10));
    expect(db.calls.filter((c) => c.key === 'apiToken.updateMany')).toHaveLength(1);
  });
});

describe('worker visibility (OS-02 / A2)', () => {
  it('a worker token cannot see unassigned sub-tasks in GET /api/tasks', async () => {
    db.overrides['task.findMany'] = async () => [{
      ...TASK_ASSIGNED,
      subTasks: [{ id: 's-mine', assignees: [{ id: WORKER.id }] }, { id: 's-other', assignees: [{ id: 'u-x' }] }],
      dependsOnTasks: [{ id: 't-other', status: 'TO_DO', title: 'Secret title' }],
    }];
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(issue(WORKER)) });
    const body = res.json();
    expect(body.map((t) => t.id)).toEqual(['t-mine']);
    expect(body[0].subTasks.map((s) => s.id)).toEqual(['s-mine']);
    expect(JSON.stringify(body)).not.toContain('Secret title');
  });

  it('a worker token sees only its assigned tasks in GET /api/projects/:id', async () => {
    db.overrides['project.findUnique'] = async () => ({
      id: 'p1', clientId: 'c1', leadPmId: ENGINE.id, wpApiKey: null,
      tasks: [
        { id: 't-mine', assignees: [{ id: WORKER.id }], subTasks: [{ id: 's-other', assignees: [{ id: 'u-x' }], subTasks: [] }] },
        { id: 't-other', assignees: [{ id: 'u-x' }], subTasks: [{ id: 's-mine', assignees: [{ id: WORKER.id }], subTasks: [] }] },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/projects/p1?cycle=all', headers: bearer(issue(WORKER)) });
    expect(res.statusCode).toBe(200);
    const ids = JSON.stringify(res.json().tasks);
    expect(ids).toContain('t-mine');
    expect(ids).toContain('s-mine');
    expect(ids).not.toContain('t-other');
    expect(ids).not.toContain('s-other');
    // A human session for the same role keeps today's full list.
    const human = await app.inject({ method: 'GET', url: '/api/projects/p1?cycle=all', headers: bearer(jwtFor({ ...WORKER, isAgent: false })) });
    expect(JSON.stringify(human.json().tasks)).toContain('t-other');
  });
});

describe('status rules (OS-09)', () => {
  const patch = (id, status, headers) => app.inject({ method: 'PATCH', url: `/api/tasks/${id}/status`, headers, payload: { status } });

  it('a worker token PATCH to COMPLETED gets 403', async () => {
    const res = await patch('t-mine', 'COMPLETED', bearer(issue(WORKER)));
    expect(res.statusCode).toBe(403);
    expect(db.calls.some((c) => c.key === 'task.update')).toBe(false);
  });

  it('a worker token may set IN_PROGRESS / NEEDS_REVIEW on its own task only', async () => {
    db.overrides['task.update'] = async ({ data }) => ({ id: 't-mine', status: data.status });
    const t = issue(WORKER);
    expect((await patch('t-mine', 'NEEDS_REVIEW', bearer(t))).statusCode).toBe(200);
    expect((await patch('t-mine', 'REVISION_NEEDED', bearer(t))).statusCode).toBe(403);
    expect((await patch('t-mine', 'CANCELLED', bearer(t))).statusCode).toBe(403);
    expect((await patch('t-other', 'IN_PROGRESS', bearer(t))).statusCode).toBe(403);
  });

  it('a human JWT session keeps today\'s behaviour (assignee may complete)', async () => {
    db.overrides['task.update'] = async ({ data }) => ({ id: 't-mine', status: data.status });
    const human = { ...HUMAN, id: WORKER.id, isAgent: false };
    USERS['u-human-as-worker'] = human;
    db.overrides['user.findUnique'] = async ({ where }) => (where.id === WORKER.id ? { ...WORKER, isAgent: false } : USERS[where.id] || null);
    expect((await patch('t-mine', 'COMPLETED', bearer(jwtFor(WORKER)))).statusCode).toBe(200);
  });

  it('the Engine PM token may set REVISION_NEEDED but never COMPLETED', async () => {
    db.overrides['task.update'] = async ({ data }) => ({ id: 't-mine', status: data.status });
    const t = issue(ENGINE);
    expect((await patch('t-mine', 'REVISION_NEEDED', bearer(t))).statusCode).toBe(200);
    expect((await patch('t-mine', 'COMPLETED', bearer(t))).statusCode).toBe(403);
  });

  it('a worker token without the tasks:status scope gets 403 (OS-04)', async () => {
    const t = issue(WORKER, { scopes: ['tasks:read', 'comments:write'] });
    expect((await patch('t-mine', 'IN_PROGRESS', bearer(t))).statusCode).toBe(403);
  });

  it('checkAgentStatusChange is a no-op for human sessions', () => {
    expect(checkAgentStatusChange({ authMethod: 'jwt', user: HUMAN }, { status: 'COMPLETED', isAssignee: true })).toBeNull();
  });
});

describe('project allowlist (OS-04)', () => {
  it('refuses a task create for a project outside the allowlist', async () => {
    const t = issue(ENGINE, { projectIds: ['p-allowed'] });
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer(t), payload: { projectId: 'p1', title: 'x', taskType: 'SEO' } });
    expect(res.statusCode).toBe(403);
  });

  it('refuses task routes for a task in another project', async () => {
    const t = issue(WORKER, { projectIds: ['p-allowed'] });
    const res = await app.inject({ method: 'PATCH', url: '/api/tasks/t-mine/status', headers: bearer(t), payload: { status: 'IN_PROGRESS' } });
    expect(res.statusCode).toBe(403);
  });

  it('filters GET /api/tasks to the allowlist', async () => {
    const t = issue(WORKER, { projectIds: ['p-allowed'] });
    db.overrides['task.findMany'] = async () => [];
    await app.inject({ method: 'GET', url: '/api/tasks', headers: bearer(t) });
    expect(db.calls.find((c) => c.key === 'task.findMany').args.where.projectId).toEqual({ in: ['p-allowed'] });
  });
});

describe('agent flag never leaves the OS except OWNER admin views (OS-01)', () => {
  it('isAgent never appears in client or staff responses', async () => {
    const clientUser = { ...HUMAN, id: 'u-client', role: 'CLIENT' };
    USERS[clientUser.id] = clientUser;
    const client = await app.inject({ method: 'GET', url: '/api/client/fixture', headers: bearer(jwtFor(clientUser)) });
    expect(client.body).not.toContain('isAgent');
    expect(client.json().comment.user.name).toBe(WORKER.name);
    const ownerAsClient = await app.inject({ method: 'GET', url: '/api/client/fixture', headers: bearer(jwtFor(OWNER)) });
    expect(ownerAsClient.body).not.toContain('isAgent');
    const pm = await app.inject({ method: 'GET', url: '/api/pm/fixture', headers: bearer(jwtFor(ENGINE)) });
    expect(pm.body).not.toContain('isAgent');
    const admin = await app.inject({ method: 'GET', url: '/api/admin/fixture', headers: bearer(jwtFor(OWNER)) });
    expect(admin.json().comment.user.isAgent).toBe(true);
  });
});

describe('agents never approve (Part D)', () => {
  it('an agent session or any API token is refused on approval routes', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/pm/fixture/approve', headers: bearer(jwtFor(ENGINE)) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/pm/fixture/approve', headers: bearer(issue({ ...ENGINE, isAgent: false })) })).statusCode).toBe(403);
    const humanPm = { ...ENGINE, id: 'u-pm-human', isAgent: false };
    USERS[humanPm.id] = humanPm;
    expect((await app.inject({ method: 'POST', url: '/api/pm/fixture/approve', headers: bearer(jwtFor(humanPm)) })).statusCode).toBe(200);
  });
});

describe('OWNER token issuance (OS-02/03)', () => {
  it('issues a lwk_ token once, stores only its sha256 and never returns the hash', async () => {
    let created;
    db.overrides['apiToken.create'] = async ({ data }) => { created = data; return { id: 'new', createdAt: new Date(), ...data, user: ENGINE }; };
    const res = await app.inject({ method: 'POST', url: '/api/admin/api-tokens', headers: bearer(jwtFor(OWNER)), payload: { userId: ENGINE.id, name: 'Engine dispatcher', scopes: ['tasks:create', 'tasks:status'] } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^lwk_[A-Za-z0-9_-]{43}$/);
    expect(created.tokenHash).toBe(hashApiToken(body.token));
    expect(res.body).not.toContain(created.tokenHash);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses tokens for OWNER accounts, unknown scopes and non-OWNER callers', async () => {
    const owner = await app.inject({ method: 'POST', url: '/api/admin/api-tokens', headers: bearer(jwtFor(OWNER)), payload: { userId: OWNER.id, name: 'x' } });
    expect(owner.statusCode).toBe(400);
    const scope = await app.inject({ method: 'POST', url: '/api/admin/api-tokens', headers: bearer(jwtFor(OWNER)), payload: { userId: ENGINE.id, name: 'x', scopes: ['admin:*'] } });
    expect(scope.statusCode).toBe(400);
    const pm = await app.inject({ method: 'POST', url: '/api/admin/api-tokens', headers: bearer(jwtFor(ENGINE)), payload: { userId: ENGINE.id, name: 'x' } });
    expect(pm.statusCode).toBe(403);
  });
});
