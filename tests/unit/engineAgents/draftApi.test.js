/**
 * SEO Engine OS-19 / OS-20 / OS-21: the /api/pm draft routes for an Engine caller.
 * - OS-21: lwk_ tokens reach the draft routes only with the explicit drafts:read / drafts:write scopes; role and
 *   assignment rules are unchanged (an assigned worker token pushes its own task's draft, 403 on another task);
 *   no publish path for tokens or agent accounts; the site actor is "agent".
 * - OS-19: Idempotency-Key on create / PATCH / push (OS-05 semantics) and a deterministic site key.
 * - OS-20: the push result forwards rev / draftRevisionId / draftHash / hashBasis and the stored content read back.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, keys: [], pushes: [] }));
const site = vi.hoisted(() => ({ upsert: null, layout: null, info: null, bodies: [], opts: [], reads: 0 }));

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
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn(), sanitizeUserInputForPrompt: (s) => s }));
vi.mock('../../../src/lib/cmsStore.js', () => ({
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://oasispoolspas.com' } }),
  mirrorEmdashReview: vi.fn(async () => ({ id: 'rev-row' })),
  listPms: async () => [{ memberId: 'u-lead', name: 'Lead PM' }],
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    emdashRoutes: {
      ...orig.emdashRoutes,
      siteInfo: async () => site.info,
      draftUpsert: async (_c, body, opts) => {
        site.bodies.push(body);
        site.opts.push(opts);
        return site.upsert(body, opts);
      },
      entryGetLayout: async (_c, entryId, variant) => {
        site.reads += 1;
        return site.layout(entryId, variant);
      },
    },
  };
});

const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');
const { registerApiTokenHooks, generateApiToken, hashApiToken, checkApiTokenRoute } = await import('../../../src/lib/apiTokens.js');
const { pmCmsDraftRoutes } = await import('../../../src/routes/pm/cmsDrafts.js');
const { clearSiteInfoCache, siteKeyFromCallerKey, actorFor } = await import('../../../src/lib/cmsDrafts.js');
const { CmsBridgeError } = await import('../../../src/lib/siteAdapters/emdash.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));

const AGENT = { id: 'u-agent', email: 'a@x.test', role: 'TEAM_MEMBER', name: 'Ava Agent', avatarUrl: null, phone: null, timezone: 'UTC', isActive: true, tokenVersion: 0, isAgent: true };
const USERS = { [AGENT.id]: AGENT };
const PROJECT = { id: 'p1', name: 'Oasis', clientId: 'c1', leadPmId: 'u-lead', cmsType: 'EMDASH', cmsCapabilities: { draftPushFromOs: true, layoutRead: true, draftHash: true, atomicDraftUpdate: true }, cmsHealth: { contractRevision: '1.5.8' }, cmsRepairNeededAt: null, cmsSiteId: 'site_9f3c2a7b41d0', client: { leadPmId: null, secondaryPmId: null } };
const MY_TASK = 't-mine';
const OTHER_TASK = 't-other';
const DRAFT = {
  id: 'd1', projectId: 'p1', contentMapNodeId: null, taskId: MY_TASK, collection: 'pages', title: 'Hot Tub Repair for Most Brands', slug: 'hot-tub-repair', parent: 'spa-services',
  contentKind: 'layout', layout: [], markdown: null, excerpt: null, seoTitle: null, seoDescription: null, bylines: null, taxonomies: null,
  aiGenerated: false, cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: 'v1', lastPushStatus: 'ok', cmsEditedAt: new Date(), updatedAt: new Date(),
};
const OTHER_DRAFT = { ...DRAFT, id: 'd2', taskId: OTHER_TASK };

const tokens = new Map();
function issue(user, extra = {}) {
  const raw = generateApiToken();
  tokens.set(hashApiToken(raw), {
    id: `tok-${tokens.size + 1}`, userId: user.id, name: 'engine', tokenHash: hashApiToken(raw), tokenPrefix: raw.slice(0, 12),
    scopes: null, projectIds: null, userTokenVersion: 0, expiresAt: new Date(Date.now() + 86_400_000), lastUsedAt: null, revokedAt: null, createdAt: new Date(), ...extra,
  });
  return raw;
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

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
beforeAll(async () => {
  process.env.CMS_KEY_ENCRYPTION_KEY = process.env.CMS_KEY_ENCRYPTION_KEY || 'test-cms-key-0123456789-abcdefghijklmnop';
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  registerApiTokenHooks(app);
  app.decorate('verifyJwt', verifyJwt);
  app.register(pmCmsDraftRoutes, { prefix: '/api/pm' });
  await app.ready();
});
afterAll(async () => app?.close());

beforeEach(() => {
  db.calls = [];
  db.keys = [];
  db.pushes = [];
  site.bodies = [];
  site.opts = [];
  site.reads = 0;
  site.info = ex('site-info.response');
  site.upsert = async () => ex('draft-upsert.response--draft-hash');
  site.layout = async () => ex('entry-get.response--draft-hash');
  clearSiteInfoCache();
  db.overrides = {
    'apiToken.findUnique': async ({ where }) => {
      const row = tokens.get(where.tokenHash);
      return row ? { ...row, user: USERS[row.userId] ? { ...USERS[row.userId] } : null } : null;
    },
    'user.findUnique': async ({ where }) => (USERS[where.id] ? { ...USERS[where.id] } : null),
    'project.findUnique': async () => ({ ...PROJECT }),
    'cmsDraft.findUnique': async ({ where }) => ({ d1: { ...DRAFT }, d2: { ...OTHER_DRAFT } }[where.id] || null),
    // canWriteDraft: the agent is assigned to MY_TASK only.
    'task.count': async ({ where }) => (where.id === MY_TASK && where.assignees?.some?.id === AGENT.id ? 1 : 0),
    'task.findFirst': async ({ where }) => (where.id === MY_TASK || where.id === OTHER_TASK ? { id: where.id } : null),
    'cmsDraftPush.findUnique': async ({ where }) => db.pushes.find((p) => p.idempotencyKey === where.idempotencyKey) || null,
    'cmsDraftPush.create': async ({ data }) => {
      const row = { id: `push-${db.pushes.length + 1}`, createdAt: new Date(), ...data };
      db.pushes.push(row);
      return row;
    },
  };
  idempotencyStore();
});

describe('OS-21 scopes: drafts:read / drafts:write must be listed', () => {
  it('an empty scope list never reaches the draft routes; drafts:write implies drafts:read; delete and AI writer stay human-only', () => {
    const none = { scopes: [], projectIds: [] };
    expect(checkApiTokenRoute(none, 'POST', '/api/pm/cms-drafts/:id/push')).toMatchObject({ ok: false, message: 'This API token needs the drafts:write scope' });
    expect(checkApiTokenRoute(none, 'GET', '/api/pm/cms-drafts/:id')).toMatchObject({ ok: false, message: 'This API token needs the drafts:read scope' });
    const read = { scopes: ['drafts:read'] };
    expect(checkApiTokenRoute(read, 'GET', '/api/pm/cms-drafts/:id').ok).toBe(true);
    expect(checkApiTokenRoute(read, 'PATCH', '/api/pm/cms-drafts/:id').ok).toBe(false);
    const write = { scopes: ['drafts:write'] };
    for (const [m, u] of [
      ['POST', '/api/pm/projects/:projectId/cms-drafts'],
      ['PATCH', '/api/pm/cms-drafts/:id'],
      ['POST', '/api/pm/cms-drafts/:id/push'],
      ['POST', '/api/pm/cms-drafts/:id/check'],
      ['POST', '/api/pm/projects/:projectId/cms-drafts/from-entry'],
      ['POST', '/api/pm/projects/:projectId/cms-media'],
      ['GET', '/api/pm/projects/:projectId/cms-drafts'],
      ['GET', '/api/pm/cms-drafts/:id'],
      ['GET', '/api/pm/projects/:projectId/cms-push-context'],
    ]) expect(checkApiTokenRoute(write, m, u).ok).toBe(true);
    expect(checkApiTokenRoute(write, 'DELETE', '/api/pm/cms-drafts/:id').ok).toBe(false);
    expect(checkApiTokenRoute({ scopes: [] }, 'DELETE', '/api/pm/cms-drafts/:id').ok).toBe(false);
    expect(checkApiTokenRoute(write, 'POST', '/api/pm/cms-drafts/:id/ai-write').ok).toBe(false);
    // no publish path: publish / schedule are not draft routes (a drafts-scoped token cannot reach them)
    expect(checkApiTokenRoute(write, 'POST', '/api/pm/pipeline/:projectId/:wpPipelineId/publish').ok).toBe(false);
    expect(checkApiTokenRoute(write, 'POST', '/api/pm/pipeline/:projectId/:wpPipelineId/schedule').ok).toBe(false);
  });

  it('over HTTP: no scope → 403; with drafts:write the assigned agent pushes its own task draft and gets 403 on another task', async () => {
    const noScope = issue(AGENT);
    expect((await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: bearer(noScope), payload: {} })).statusCode).toBe(403);
    const t = issue(AGENT, { scopes: ['drafts:write'] });
    const mine = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: bearer(t), payload: {} });
    expect(mine.statusCode).toBe(200);
    const other = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d2/push', headers: bearer(t), payload: {} });
    expect(other.statusCode).toBe(403);
    expect(site.bodies).toHaveLength(1);
  });

  it('a project-restricted token is refused for a draft of another project', async () => {
    const t = issue(AGENT, { scopes: ['drafts:write'], projectIds: ['p-other'] });
    const r = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: bearer(t), payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/not allowed for this project/);
    expect(site.bodies).toHaveLength(0);
  });

  it('the site actor is "agent" for tokens and agent accounts; humans keep the existing rule', () => {
    expect(actorFor({ id: 'u1', name: 'Pat', role: 'PM' }, {}, { agent: true })).toMatchObject({ kind: 'agent', osUserId: 'u1', name: 'Pat' });
    expect(actorFor(AGENT, {})).toMatchObject({ kind: 'agent', osUserId: AGENT.id });
    expect(actorFor({ id: 'u1', name: 'Pat', role: 'PM' }, {})).toMatchObject({ kind: 'human' });
    expect(actorFor({ id: 'u1', name: 'Pat', role: 'PM' }, { aiGenerated: true })).toMatchObject({ kind: 'agent', name: 'Nova writer (for Pat)' });
  });
});

describe('OS-20: push result forwards the stored state and content', () => {
  it('rev / draftRevisionId / draftHash / hashBasis verbatim, plus the editable content read right after the save', async () => {
    const t = issue(AGENT, { scopes: ['drafts:write'] });
    const r = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: bearer(t), payload: {} });
    const want = ex('draft-upsert.response--draft-hash');
    const read = ex('entry-get.response--draft-hash').editable;
    const { result } = r.json();
    expect(result).toMatchObject({ ok: true, entryId: want.entryId, revision: want.revision, rev: want.revision, draftRevisionId: want.draftRevisionId, entryNo: want.entryNo, draftHash: want.draftHash, hashBasis: want.hashBasis });
    expect(result.storedContent.format).toBe(read.format);
    expect(result.storedContent.layout ?? result.storedContent.portableText ?? result.storedContent.body).toEqual(read.layout ?? read.portableText ?? read.body);
    expect(result.storedContent.draftHash).toBe(read.draftHash);
    expect(site.bodies[0].actor).toMatchObject({ kind: 'agent', osUserId: AGENT.id });
  });

  it('a failed read-back never fails the push: storedContent null + CONTENT_READ_FAILED warning', async () => {
    site.layout = async () => {
      throw new CmsBridgeError({ status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'down', retryable: true });
    };
    const t = issue(AGENT, { scopes: ['drafts:write'] });
    const r = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: bearer(t), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.storedContent).toBeNull();
    expect(r.json().result.warnings.some((w) => w.code === 'CONTENT_READ_FAILED')).toBe(true);
  });
});

describe('OS-19: Idempotency-Key on draft create / PATCH / push', () => {
  it('same key + same body replays the push (one site call); a different body is 409', async () => {
    const t = issue(AGENT, { scopes: ['drafts:write'] });
    const h = { ...bearer(t), 'idempotency-key': 'engine-run-1-push' };
    const a = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: h, payload: {} });
    const b = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: h, payload: {} });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toBe(a.body);
    expect(site.bodies).toHaveLength(1);
    // the site key is derived from the caller's key
    expect(site.opts[0].idempotencyKey).toBe(siteKeyFromCallerKey({ userId: AGENT.id, draftId: 'd1', callerKey: 'engine-run-1-push' }, 0));
    const c = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: h, payload: { includeContent: true, changeUrl: true } });
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('an unknown outcome releases the key; the retry runs again with the SAME site key and push row', async () => {
    let n = 0;
    site.upsert = async () => {
      n += 1;
      if (n === 1) throw new CmsBridgeError({ status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'timeout', retryable: true });
      return { ...ex('draft-upsert.response--draft-hash'), idempotentReplay: true };
    };
    const t = issue(AGENT, { scopes: ['drafts:write'] });
    const h = { ...bearer(t), 'idempotency-key': 'engine-run-2-push' };
    const first = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: h, payload: {} });
    expect(first.statusCode).toBe(409);
    expect(first.json().result.retryable).toBe(true);
    const second = await app.inject({ method: 'POST', url: '/api/pm/cms-drafts/d1/push', headers: h, payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(site.opts[1].idempotencyKey).toBe(site.opts[0].idempotencyKey);
    expect(db.pushes).toHaveLength(1);
  });

  it('create and PATCH replay with the same key and body (one draft)', async () => {
    const t = issue(AGENT, { scopes: ['drafts:write'] });
    let creates = 0;
    db.overrides['cmsDraft.create'] = async ({ data }) => {
      creates += 1;
      return { id: `new-${creates}`, ...data, updatedAt: new Date('2026-10-19T00:00:00Z') };
    };
    const h = { ...bearer(t), 'idempotency-key': 'engine-run-3-create' };
    const body = { taskId: MY_TASK, collection: 'pages', title: 'Pool Opening' };
    const a = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/cms-drafts', headers: h, payload: body });
    const b = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/cms-drafts', headers: h, payload: body });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(creates).toBe(1);
    let updates = 0;
    db.overrides['cmsDraft.update'] = async ({ data }) => {
      updates += 1;
      return { ...DRAFT, ...data, updatedAt: new Date('2026-10-19T00:00:00Z') };
    };
    const p = { ...bearer(t), 'idempotency-key': 'engine-run-3-patch' };
    await app.inject({ method: 'PATCH', url: '/api/pm/cms-drafts/d1', headers: p, payload: { title: 'New title' } });
    const again = await app.inject({ method: 'PATCH', url: '/api/pm/cms-drafts/d1', headers: p, payload: { title: 'New title' } });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(updates).toBe(1);
  });

  it('siteKeyFromCallerKey is deterministic, UUID-shaped and separates users, drafts, keys and attempts', () => {
    const k = siteKeyFromCallerKey({ userId: 'u', draftId: 'd', callerKey: 'k' }, 0);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(siteKeyFromCallerKey({ userId: 'u', draftId: 'd', callerKey: 'k' }, 0)).toBe(k);
    expect(siteKeyFromCallerKey({ userId: 'u2', draftId: 'd', callerKey: 'k' }, 0)).not.toBe(k);
    expect(siteKeyFromCallerKey({ userId: 'u', draftId: 'd2', callerKey: 'k' }, 0)).not.toBe(k);
    expect(siteKeyFromCallerKey({ userId: 'u', draftId: 'd', callerKey: 'k2' }, 0)).not.toBe(k);
    expect(siteKeyFromCallerKey({ userId: 'u', draftId: 'd', callerKey: 'k' }, 1)).not.toBe(k);
  });
});
