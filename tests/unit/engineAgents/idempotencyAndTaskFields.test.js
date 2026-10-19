/**
 * SEO Engine agents, stage 2: Idempotency-Key (OS-05), comment author (OS-06), task read fields (OS-07),
 * assigned-task listing (OS-08) and POST /api/tasks assigneeIds.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, keys: [] }));
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
          if (method === 'updateMany' || method === 'deleteMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'r1', createdAt: new Date(), ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn(), sanitizeUserInputForPrompt: (s) => s }));
vi.mock('../../../src/lib/workCycle.js', () => ({
  ensureCurrentCycle: vi.fn(async () => ({ id: 'cycle-1' })),
  resolveCycle: vi.fn(async () => ({ id: 'cycle-1' })),
}));
vi.mock('../../../src/lib/mentionParser.js', () => ({ extractMentionedUserIds: vi.fn(async () => []) }));

const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');
const { requirePM } = await import('../../../src/lib/requirePM.js');
const { redactResponseSecrets, responseDropKeys } = await import('../../../src/lib/redactSecrets.js');
const { registerApiTokenHooks, generateApiToken, hashApiToken } = await import('../../../src/lib/apiTokens.js');
const { taskRoutes } = await import('../../../src/routes/tasks.js');
const { canonicalJson, purgeExpiredIdempotencyKeys } = await import('../../../src/lib/idempotency.js');
const { completedAtPatch, withTaskReadFields } = await import('../../../src/lib/taskReadFields.js');

const SECRET = process.env.JWT_ACCESS_SECRET;
const ENGINE = { id: 'u-engine', email: 'e@x.test', role: 'PM', name: 'Engine', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: true };
const WORKER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'w@x.test', role: 'TEAM_MEMBER', name: 'Ava Writer', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: true };
const OTHER_PM = { ...ENGINE, id: 'u-pm2', isAgent: false };
const USERS = { [ENGINE.id]: ENGINE, [WORKER.id]: WORKER, [OTHER_PM.id]: OTHER_PM };
const tokens = new Map();
function issue(user) {
  const raw = generateApiToken();
  tokens.set(hashApiToken(raw), { id: `tok-${tokens.size}`, userId: user.id, name: 't', tokenHash: hashApiToken(raw), scopes: null, projectIds: null, userTokenVersion: 0, expiresAt: new Date(Date.now() + 1e8), lastUsedAt: new Date(), revokedAt: null });
  return raw;
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

const PROJECT = { id: '11111111-2222-4333-8444-555555555555', name: 'Oasis', leadPmId: ENGINE.id, wpUrl: null, wpApiKey: null, client: { leadPmId: null, secondaryPmId: null } };
const TASK = { id: 't1', projectId: '11111111-2222-4333-8444-555555555555', title: 'Write page', status: 'IN_PROGRESS', assignees: [{ id: WORKER.id }], workCycle: { id: 'cycle-1', status: 'OPEN' }, project: PROJECT };

/** In-memory IdempotencyKey table with a unique (userId, route, key) constraint. */
function idempotencyStore() {
  const rows = db.keys;
  const find = (w) => rows.find((r) => r.userId === w.userId && r.route === w.route && r.key === w.key);
  db.overrides['idempotencyKey.create'] = async ({ data }) => {
    if (find(data)) { const e = new Error('Unique constraint'); e.code = 'P2002'; throw e; }
    const row = { id: `idem-${rows.length + 1}`, createdAt: new Date(), statusCode: null, responseBody: null, ...data };
    rows.push(row);
    return { id: row.id };
  };
  db.overrides['idempotencyKey.findUnique'] = async ({ where }) => find(where.userId_route_key) || null;
  db.overrides['idempotencyKey.updateMany'] = async ({ where, data }) => {
    const row = rows.find((r) => r.id === where.id && (!where.state || r.state === where.state));
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  };
  db.overrides['idempotencyKey.deleteMany'] = async ({ where }) => {
    const i = rows.findIndex((r) => r.id === where.id);
    if (i >= 0) rows.splice(i, 1);
    return { count: i >= 0 ? 1 : 0 };
  };
}

let app;
let taskSeq = 0;
beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  app.addHook('preSerialization', async (request, _r, payload) => redactResponseSecrets(payload, 0, responseDropKeys(request)));
  registerApiTokenHooks(app);
  app.decorate('verifyJwt', verifyJwt);
  app.decorate('requirePM', requirePM);
  app.register(taskRoutes, { prefix: '/api/tasks' });
  await app.ready();
});
afterAll(async () => app?.close());

beforeEach(() => {
  db.calls = [];
  db.keys = [];
  taskSeq = 0;
  db.overrides = {
    'apiToken.findUnique': async ({ where }) => {
      const row = tokens.get(where.tokenHash);
      return row ? { ...row, user: { ...USERS[row.userId] } } : null;
    },
    'user.findUnique': async ({ where }) => (USERS[where.id] ? { ...USERS[where.id] } : null),
    'user.findMany': async ({ where }) => (where.id?.in || []).filter((id) => USERS[id] && USERS[id].role !== 'CLIENT').map((id) => ({ id })),
    'project.findUnique': async () => ({ ...PROJECT }),
    'task.findUnique': async () => ({ ...TASK }),
    'task.create': async ({ data }) => {
      taskSeq += 1;
      return { id: `new-${taskSeq}`, ...data, assignees: (data.assignees?.connect || []).map((a) => ({ id: a.id, name: 'n' })), assigneesConnect: undefined, createdAt: new Date('2026-10-19T00:00:00Z'), updatedAt: new Date('2026-10-19T00:00:00Z'), completedAt: null };
    },
    'task.update': async ({ data }) => ({ ...TASK, ...data, updatedAt: new Date('2026-10-19T01:00:00Z') }),
    'taskComment.create': async ({ data }) => ({ id: 'c-1', ...data, parentId: null, createdAt: new Date('2026-10-19T02:00:00Z'), editedAt: null, user: { id: data.userId, name: USERS[data.userId]?.name, avatarUrl: null }, parent: null }),
  };
  idempotencyStore();
});

const createBody = { projectId: '11111111-2222-4333-8444-555555555555', title: 'New service page', taskType: 'SEO', assigneeIds: [WORKER.id] };

describe('Idempotency-Key (OS-05)', () => {
  it('same key + same body replays the stored status and body; only one task is created', async () => {
    const t = issue(ENGINE);
    const headers = { ...bearer(t), 'idempotency-key': 'engine-job-1' };
    const first = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: createBody });
    const second = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { ...createBody } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(db.calls.filter((c) => c.key === 'task.create')).toHaveLength(1);
  });

  it('the body fingerprint is canonical (key order does not matter)', async () => {
    const headers = { ...bearer(issue(ENGINE)), 'idempotency-key': 'k-order' };
    await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: createBody });
    const reordered = { assigneeIds: createBody.assigneeIds, taskType: 'SEO', title: createBody.title, projectId: '11111111-2222-4333-8444-555555555555' };
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: reordered });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
  });

  it('same key + different body returns 409', async () => {
    const headers = { ...bearer(issue(ENGINE)), 'idempotency-key': 'engine-job-2' };
    await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: createBody });
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { ...createBody, title: 'Other' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(db.calls.filter((c) => c.key === 'task.create')).toHaveLength(1);
  });

  it('concurrent first use: the loser of the unique insert gets 409 in progress', async () => {
    const headers = { ...bearer(issue(ENGINE)), 'idempotency-key': 'engine-job-3' };
    db.keys.push({ id: 'idem-x', userId: ENGINE.id, route: 'POST /api/tasks', key: 'engine-job-3', requestHash: 'whatever', state: 'pending', createdAt: new Date(), expiresAt: new Date(Date.now() + 1e8) });
    // Same fingerprint as the in-flight request:
    const { idempotencyFingerprint } = await import('../../../src/lib/idempotency.js');
    db.keys[0].requestHash = idempotencyFingerprint({ params: {}, body: createBody });
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: createBody });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(res.headers['retry-after']).toBe('5');
  });

  it('keys are scoped per user and per route', async () => {
    const pmToken = issue(OTHER_PM);
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, leadPmId: null, client: { leadPmId: ENGINE.id, secondaryPmId: OTHER_PM.id } });
    const a = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...bearer(issue(ENGINE)), 'idempotency-key': 'shared' }, payload: createBody });
    const b = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...bearer(pmToken), 'idempotency-key': 'shared' }, payload: createBody });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(db.calls.filter((c) => c.key === 'task.create')).toHaveLength(2);
  });

  it('PATCH status and POST comments replay too; a 5xx releases the key', async () => {
    const w = issue(WORKER);
    const h = { ...bearer(w), 'idempotency-key': 'status-1' };
    const s1 = await app.inject({ method: 'PATCH', url: '/api/tasks/t1/status', headers: h, payload: { status: 'NEEDS_REVIEW' } });
    const s2 = await app.inject({ method: 'PATCH', url: '/api/tasks/t1/status', headers: h, payload: { status: 'NEEDS_REVIEW' } });
    expect(s1.statusCode).toBe(200);
    expect(s2.body).toBe(s1.body);
    expect(db.calls.filter((c) => c.key === 'task.update')).toHaveLength(1);

    const ch = { ...bearer(w), 'idempotency-key': 'comment-1' };
    const c1 = await app.inject({ method: 'POST', url: '/api/tasks/t1/comments', headers: ch, payload: { content: 'Draft ready.' } });
    const c2 = await app.inject({ method: 'POST', url: '/api/tasks/t1/comments', headers: ch, payload: { content: 'Draft ready.' } });
    expect(c2.body).toBe(c1.body);
    expect(db.calls.filter((c) => c.key === 'taskComment.create')).toHaveLength(1);

    db.overrides['taskComment.create'] = async () => { throw new Error('db down'); };
    const ef = { ...bearer(w), 'idempotency-key': 'comment-err' };
    const e1 = await app.inject({ method: 'POST', url: '/api/tasks/t1/comments', headers: ef, payload: { content: 'x' } });
    expect(e1.statusCode).toBe(500);
    expect(db.keys.find((k) => k.key === 'comment-err')).toBeUndefined();
  });

  it('rejects malformed keys and purges expired rows', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...bearer(issue(ENGINE)), 'idempotency-key': 'has space' }, payload: createBody });
    expect(res.statusCode).toBe(400);
    db.overrides['idempotencyKey.deleteMany'] = async () => ({ count: 3 });
    expect(await purgeExpiredIdempotencyKeys(new Date('2026-10-19T00:00:00Z'))).toBe(3);
    const call = db.calls.filter((c) => c.key === 'idempotencyKey.deleteMany').pop();
    expect(call.args.where.expiresAt.lt).toEqual(new Date('2026-10-19T00:00:00Z'));
  });
});

describe('comments by token user (OS-06)', () => {
  it('the comment is authored by the token user and returns the exact id, taskId and content', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tasks/t1/comments', headers: bearer(issue(WORKER)), payload: { content: 'Result: page drafted.' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ id: 'c-1', taskId: 't1', content: 'Result: page drafted.', userId: WORKER.id });
    expect(body.user.name).toBe(WORKER.name);
    expect(res.body.toLowerCase()).not.toContain('via api');
    expect(res.body).not.toContain('isAgent');
    expect(db.calls.find((c) => c.key === 'taskComment.create').args.data.userId).toBe(WORKER.id);
  });
});

describe('task read fields (OS-07) and assignee listing (OS-08)', () => {
  it('POST /api/tasks accepts assigneeIds:[osUserId] and returns OS-07 fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer(issue(ENGINE)), payload: createBody });
    expect(res.statusCode).toBe(201);
    const create = db.calls.find((c) => c.key === 'task.create').args.data;
    expect(create.assignees).toEqual({ connect: [{ id: WORKER.id }] });
    const body = res.json();
    expect(body.assigneeId).toBe(WORKER.id);
    expect(body).toHaveProperty('updatedAt');
    expect(body.completedAt).toBeNull();
    expect(body.workCycleId).toBe('cycle-1');
  });

  it('GET /api/tasks?assignee=me&status=A,B returns only the caller\'s assigned tasks with the read fields', async () => {
    db.overrides['task.findMany'] = async () => [{ ...TASK, workCycleId: 'cycle-1', updatedAt: new Date(), completedAt: null, assignees: [{ id: WORKER.id }, { id: 'u-x' }] }];
    const res = await app.inject({ method: 'GET', url: '/api/tasks?assignee=me&status=TO_DO,REVISION_NEEDED&cycle=all', headers: bearer(issue(WORKER)) });
    expect(res.statusCode).toBe(200);
    const args = db.calls.find((c) => c.key === 'task.findMany').args;
    expect(JSON.stringify(args.where.AND)).toContain(`"assignees":{"some":{"id":"${WORKER.id}"}}`);
    expect(args.where.status).toEqual({ in: ['TO_DO', 'REVISION_NEEDED'] });
    expect(args.where.parentTaskId).toBeUndefined();
    expect(args.include.subTasks).toBeUndefined();
    const [row] = res.json();
    expect(row.assigneeId).toBe(WORKER.id);
    expect(row.assignees).toHaveLength(2);
    expect(row).toHaveProperty('completedAt', null);
    expect(row.workCycleId).toBe('cycle-1');
  });

  it('rejects unknown status filters and other assignee values', async () => {
    const t = issue(WORKER);
    expect((await app.inject({ method: 'GET', url: '/api/tasks?assignee=me&status=DONE', headers: bearer(t) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/tasks?assignee=u-x', headers: bearer(t) })).statusCode).toBe(400);
  });

  it('completedAt is stamped entering COMPLETED and cleared when leaving it', () => {
    expect(completedAtPatch('COMPLETED', 'IN_PROGRESS').completedAt).toBeInstanceOf(Date);
    expect(completedAtPatch('COMPLETED', 'COMPLETED')).toEqual({});
    expect(completedAtPatch('IN_PROGRESS', 'COMPLETED')).toEqual({ completedAt: null });
    expect(withTaskReadFields({ id: 'a', assignees: [], subTasks: [{ id: 'b', assignees: [{ id: 'u' }] }] }).subTasks[0].assigneeId).toBe('u');
  });

  it('PATCH status by a human PM to COMPLETED stamps completedAt in the same update', async () => {
    const human = { ...ENGINE, isAgent: false };
    db.overrides['user.findUnique'] = async () => human;
    const res = await app.inject({ method: 'PATCH', url: '/api/tasks/t1/status', headers: bearer(jwt.sign({ sub: ENGINE.id, role: 'PM' }, SECRET)), payload: { status: 'COMPLETED' } });
    expect(res.statusCode).toBe(200);
    const data = db.calls.find((c) => c.key === 'task.update').args.data;
    expect(data.status).toBe('COMPLETED');
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(res.json()).toHaveProperty('completedAt');
  });
});

describe('notification rule (OS-10)', () => {
  it('Engine-created tasks can only be assigned to staff, so clients are never notified', async () => {
    const { notify } = await import('../../../src/lib/notificationService.js');
    notify.mockClear();
    const CLIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    USERS[CLIENT_ID] = { id: CLIENT_ID, role: 'CLIENT', name: 'Client', isActive: true, tokenVersion: 0 };
    const bad = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer(issue(ENGINE)), payload: { ...createBody, assigneeIds: [CLIENT_ID] } });
    expect(bad.statusCode).toBe(400);
    expect(notify).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'POST', url: '/api/tasks', headers: bearer(issue(ENGINE)), payload: createBody });
    expect(ok.statusCode).toBe(201);
    const call = notify.mock.calls.find(([n]) => n.slug === 'task_created')[0];
    expect(call.recipientIds).toEqual([WORKER.id]);
  });

  it('an agent comment notifies the same people as a human comment (assignees + project lead PM, minus the author)', async () => {
    const { notify } = await import('../../../src/lib/notificationService.js');
    notify.mockClear();
    await app.inject({ method: 'POST', url: '/api/tasks/t1/comments', headers: bearer(issue(WORKER)), payload: { content: 'Agent update' } });
    const agentCall = notify.mock.calls.find(([n]) => n.slug === 'task_comment_added')[0];
    notify.mockClear();
    db.overrides['user.findUnique'] = async ({ where }) => (where.id === WORKER.id ? { ...WORKER, isAgent: false } : USERS[where.id] || null);
    await app.inject({ method: 'POST', url: '/api/tasks/t1/comments', headers: bearer(jwt.sign({ sub: WORKER.id, role: 'TEAM_MEMBER' }, SECRET)), payload: { content: 'Human update' } });
    const humanCall = notify.mock.calls.find(([n]) => n.slug === 'task_comment_added')[0];
    expect(agentCall.recipientIds).toEqual(humanCall.recipientIds);
    expect(agentCall.recipientIds).toEqual([ENGINE.id]);
    expect(JSON.stringify(agentCall)).not.toContain('isAgent');
  });
});
