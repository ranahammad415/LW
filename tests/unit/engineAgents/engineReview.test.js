/**
 * SEO Engine review issuer (OS-11/12/13/14): exact-result freeze → challenge → confirm → Ed25519 envelope,
 * agents never reviewers (config load + per request), pull outbox, retention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync, verify as edVerify } from 'crypto';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, tables: {} }));
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
          if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
          return null;
        };
      },
    });
  const root = new Proxy({}, {
    get: (_, n) => (n === '$transaction' ? async (fn) => (typeof fn === 'function' ? fn(root) : Promise.all(fn)) : model(String(n))),
  });
  return { prisma: root };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}) }));

const { prisma } = await import('../../../src/lib/prisma.js');
const { verifyJwt } = await import('../../../src/lib/verifyJwt.js');
const { requirePM } = await import('../../../src/lib/requirePM.js');
const { registerApiTokenHooks, generateApiToken, hashApiToken } = await import('../../../src/lib/apiTokens.js');
const { installEngineReview } = await import('../../../src/lib/engineReview/install.js');
const { canonical, validateReviewerMap } = await import('../../../src/lib/engineReview/issuer.js');
const { purgeEngineReviewRecords, ENGINE_REVIEW_RETENTION } = await import('../../../src/lib/engineReview/retention.js');

const SECRET = process.env.JWT_ACCESS_SECRET;
const ORIGIN = 'https://os.example.test';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const PM = { id: 'u-pm', email: 'pm@x', role: 'PM', name: 'Pam', isActive: true, tokenVersion: 0, isAgent: false };
const ENGINE = { id: 'u-engine', email: 'e@x', role: 'PM', name: 'Engine', isActive: true, tokenVersion: 0, isAgent: true };
const AGENT_PM = { id: 'u-agent-pm', email: 'a@x', role: 'PM', name: 'Agent PM', isActive: true, tokenVersion: 0, isAgent: true };
const WORKER = { id: 'u-worker', email: 'w@x', role: 'TEAM_MEMBER', name: 'Ava', isActive: true, tokenVersion: 0, isAgent: true };
const USERS = { [PM.id]: PM, [ENGINE.id]: ENGINE, [AGENT_PM.id]: AGENT_PM, [WORKER.id]: WORKER };

const env = (over = {}) => ({
  ENGINE_REVIEW_ISSUER_ENABLED: '1',
  ENGINE_REVIEW_ISSUER: 'localwaves-os',
  ENGINE_REVIEW_TENANT_ID: 'tenant-1',
  ENGINE_REVIEW_KEY_ID: 'os-key-1',
  ENGINE_REVIEW_SIGNING_PRIVATE_KEY_PEM: PEM.replace(/\n/g, '\\n'),
  FRONTEND_URL: `${ORIGIN},http://localhost:5173`,
  ENGINE_REVIEW_REPORTER_USER_IDS_JSON: JSON.stringify([ENGINE.id]),
  ENGINE_REVIEW_REVIEWERS_JSON: JSON.stringify([{ osUserId: PM.id, engineActorId: 'actor-pm', role: 'PM' }]),
  ...over,
});

const REPORT = {
  engineProjectId: 'ep-1', engineTaskId: 'et-1', resultId: 'res-1', resultHash: 'a'.repeat(64), reviewVersion: 0,
  workerId: 'actor-worker', authorId: 'actor-worker', publicationAuthorized: false,
};
const COMMENT = { id: 'c-1', taskId: 't-1', userId: ENGINE.id, content: `SEO Engine worker result\n${JSON.stringify(REPORT)}\n\n[seo-engine-result:res-1]` };
const TASK = { id: 't-1', projectId: 'p-1', status: 'NEEDS_REVIEW', assignees: [{ id: WORKER.id }], project: { id: 'p-1', leadPmId: PM.id, client: { leadPmId: null, secondaryPmId: null } } };

function memoryTables() {
  const t = { frozen: [], heads: [], challenges: [], outbox: [] };
  db.tables = t;
  const pick = (rows, where) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) || null;
  Object.assign(db.overrides, {
    'engineReviewFrozenResult.findUnique': async ({ where }) => pick(t.frozen, where),
    'engineReviewFrozenResult.create': async ({ data }) => { t.frozen.push({ ...data, createdAt: new Date() }); return data; },
    'engineReviewTaskHead.findUnique': async ({ where }) => pick(t.heads, where),
    'engineReviewTaskHead.create': async ({ data }) => { t.heads.push({ ...data }); return data; },
    'engineReviewTaskHead.updateMany': async ({ where, data }) => { const r = pick(t.heads, where); if (!r) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
    'engineReviewChallenge.findUnique': async ({ where }) => pick(t.challenges, where),
    'engineReviewChallenge.create': async ({ data }) => { t.challenges.push({ consumed: false, ...data }); return data; },
    'engineReviewChallenge.updateMany': async ({ where, data }) => { const r = pick(t.challenges, where); if (!r) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
    'engineReviewOutbox.findUnique': async ({ where }) => pick(t.outbox, where),
    'engineReviewOutbox.create': async ({ data }) => { t.outbox.push({ ackedAt: null, createdAt: new Date(), ...data }); return data; },
    'engineReviewOutbox.findMany': async () => t.outbox.filter((r) => !r.ackedAt),
    'engineReviewOutbox.updateMany': async ({ where, data }) => { const r = pick(t.outbox, { eventId: where.eventId }); if (!r || r.ackedAt) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
  });
}

async function buildApp(e = env()) {
  const app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  registerApiTokenHooks(app);
  app.decorate('verifyJwt', verifyJwt);
  app.decorate('requirePM', requirePM);
  const state = await installEngineReview(app, { prisma, env: e });
  await app.ready();
  return { app, state };
}

const auth = (user, extra = {}) => ({ authorization: `Bearer ${jwt.sign({ sub: user.id, role: user.role }, SECRET)}`, origin: ORIGIN, ...extra });

beforeEach(() => {
  db.calls = [];
  db.overrides = {
    'user.findUnique': async ({ where }) => (USERS[where.id] ? { ...USERS[where.id] } : null),
    'user.findMany': async ({ where }) => where.id.in.map((id) => USERS[id]).filter(Boolean),
    'task.findUnique': async () => ({ ...TASK }),
    'taskComment.findUnique': async ({ where }) => (where.id === COMMENT.id ? { ...COMMENT } : null),
  };
  memoryTables();
});

describe('reviewer map (OS-12): agents are never reviewers', () => {
  it('config load refuses an agent account in the reviewer map (issuer stays disabled)', async () => {
    await expect(validateReviewerMap(prisma, [{ osUserId: AGENT_PM.id, engineActorId: 'x', role: 'PM' }], [ENGINE.id])).rejects.toMatchObject({ code: 'REVIEW_ISSUER_CONFIG' });
    const { app, state } = await buildApp(env({ ENGINE_REVIEW_REVIEWERS_JSON: JSON.stringify([{ osUserId: AGENT_PM.id, engineActorId: 'x', role: 'PM' }]) }));
    expect(state.issuer).toBeNull();
    const status = await app.inject({ method: 'GET', url: '/api/engine-review/status', headers: auth(PM) });
    expect(status.json()).toEqual({ enabled: false });
    const res = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: auth(PM), payload: { commentId: 'c-1' } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('config load refuses reporters as reviewers, role mismatches and bad keys', async () => {
    await expect(validateReviewerMap(prisma, [{ osUserId: ENGINE.id, engineActorId: 'x', role: 'PM' }], [ENGINE.id])).rejects.toMatchObject({ code: 'REVIEW_ISSUER_CONFIG' });
    await expect(validateReviewerMap(prisma, [{ osUserId: PM.id, engineActorId: 'x', role: 'OWNER' }], [ENGINE.id])).rejects.toMatchObject({ code: 'REVIEW_ISSUER_CONFIG' });
    const { state } = await buildApp(env({ ENGINE_REVIEW_SIGNING_PRIVATE_KEY_PEM: 'not a key' }));
    expect(state.issuer).toBeNull();
  });

  it('per request: an agent account or an API token is refused even when mapped', async () => {
    // The mapped reviewer is later flagged as an agent: refused on the next request.
    const { app } = await buildApp();
    USERS[PM.id] = { ...PM, isAgent: true };
    const asAgent = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: auth(PM), payload: { commentId: 'c-1' } });
    expect(asAgent.statusCode).toBe(403);
    USERS[PM.id] = PM;
    const raw = generateApiToken();
    db.overrides['apiToken.findUnique'] = async () => ({ id: 'tk', userId: PM.id, tokenHash: hashApiToken(raw), userTokenVersion: 0, expiresAt: new Date(Date.now() + 1e7), revokedAt: null, lastUsedAt: new Date(), user: { ...PM } });
    const asToken = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: { authorization: `Bearer ${raw}`, origin: ORIGIN }, payload: { commentId: 'c-1' } });
    expect(asToken.statusCode).toBe(403);
    await app.close();
  });
});

describe('exact-result review flow (OS-11)', () => {
  it('freezes, challenges, confirms and signs an envelope the Engine can verify', async () => {
    const { app } = await buildApp();
    const frozen = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: auth(PM), payload: { commentId: 'c-1' } });
    expect(frozen.statusCode).toBe(200);
    const snap = frozen.json();
    expect(snap.report.resultHash).toBe(REPORT.resultHash);

    const view = await app.inject({ method: 'GET', url: `/api/tasks/t-1/engine-review/results/${snap.id}`, headers: auth(PM) });
    expect(view.json().publicationAuthorized).toBe(false);

    const ch = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/challenges', headers: auth(PM), payload: { snapshotId: snap.id, operation: 'task_review', decision: 'revision_needed', reason: 'Fix the H1' } });
    expect(ch.statusCode).toBe(200);
    const challenge = ch.json();

    const noOrigin = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/confirm', headers: auth(PM, { origin: 'https://evil.test' }), payload: { challengeId: challenge.id, confirmation: challenge.challengeHash } });
    expect(noOrigin.statusCode).toBe(403);

    const conf = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/confirm', headers: auth(PM), payload: { challengeId: challenge.id, confirmation: challenge.challengeHash } });
    expect(conf.statusCode).toBe(200);
    const envelope = conf.json();
    expect(envelope.keyId).toBe('os-key-1');
    expect(envelope.event).toMatchObject({ decision: 'revision_needed', resultId: 'res-1', osTaskId: 't-1', reviewer: { osUserId: PM.id, engineActorId: 'actor-pm', role: 'PM' } });
    expect(edVerify(null, Buffer.from(canonical(envelope.event)), publicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(true);

    // Retry of the committed challenge returns the same envelope.
    const again = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/confirm', headers: auth(PM), payload: { challengeId: challenge.id, confirmation: challenge.challengeHash } });
    expect(again.json()).toEqual(envelope);
    expect(db.tables.outbox).toHaveLength(1);
    expect(db.tables.outbox[0].osProjectId).toBe('p-1');
    await app.close();
  });

  it('an assignee cannot review its own result and unmapped PMs are refused', async () => {
    const { app } = await buildApp();
    db.overrides['task.findUnique'] = async () => ({ ...TASK, assignees: [{ id: PM.id }] });
    const self = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: auth(PM), payload: { commentId: 'c-1' } });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('REVIEW_SELF_APPROVAL');
    const other = { ...PM, id: 'u-pm-2', isAgent: false };
    USERS[other.id] = other;
    db.overrides['task.findUnique'] = async () => ({ ...TASK, project: { ...TASK.project, leadPmId: other.id } });
    const unmapped = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: auth(other), payload: { commentId: 'c-1' } });
    expect(unmapped.json().code).toBe('REVIEW_IDENTITY_UNTRUSTED');
    await app.close();
  });

  it('only a pinned reporter comment can be frozen', async () => {
    const { app } = await buildApp();
    db.overrides['taskComment.findUnique'] = async () => ({ ...COMMENT, userId: WORKER.id });
    const res = await app.inject({ method: 'POST', url: '/api/tasks/t-1/engine-review/results', headers: auth(PM), payload: { commentId: 'c-1' } });
    expect(res.json().code).toBe('REPORT_NOT_TRUSTED');
    await app.close();
  });
});

describe('pull outbox (OS-13) and retention (OS-14)', () => {
  it('the Engine reporter can collect and ack envelopes; other PMs cannot', async () => {
    const { app } = await buildApp();
    db.tables.outbox.push({ eventId: 'ev-1', challengeId: 'ch-1', taskId: 't-1', osProjectId: 'p-1', resultId: 'res-1', version: 0, data: JSON.stringify({ keyId: 'k', event: { eventId: 'ev-1' }, signature: 's' }), expiresAt: new Date(Date.now() + 60000), ackedAt: null, createdAt: new Date() });
    const list = await app.inject({ method: 'GET', url: '/api/engine-review/outbox', headers: auth(ENGINE) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].envelope.event.eventId).toBe('ev-1');
    expect(list.headers['cache-control']).toBe('no-store');
    const pm = await app.inject({ method: 'GET', url: '/api/engine-review/outbox', headers: auth(PM) });
    expect(pm.statusCode).toBe(403);
    const ack = await app.inject({ method: 'POST', url: '/api/engine-review/outbox/ev-1/ack', headers: auth(ENGINE) });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().ackedAt).toBeTruthy();
    const after = await app.inject({ method: 'GET', url: '/api/engine-review/outbox', headers: auth(ENGINE) });
    expect(after.json().items).toHaveLength(0);
    await app.close();
  });

  it('purges challenges after 1 day, outbox after 30 days, frozen results after 365 days', async () => {
    db.overrides['engineReviewChallenge.deleteMany'] = async () => ({ count: 2 });
    db.overrides['engineReviewOutbox.deleteMany'] = async () => ({ count: 1 });
    db.overrides['engineReviewFrozenResult.deleteMany'] = async () => ({ count: 0 });
    const now = new Date('2026-10-19T00:00:00Z');
    expect(await purgeEngineReviewRecords(now)).toEqual({ challenges: 2, outbox: 1, frozenResults: 0 });
    const cut = (k) => db.calls.find((c) => c.key === k).args.where.createdAt.lt.getTime();
    expect(now.getTime() - cut('engineReviewChallenge.deleteMany')).toBe(ENGINE_REVIEW_RETENTION.challengeDays * 86400000);
    expect(now.getTime() - cut('engineReviewOutbox.deleteMany')).toBe(30 * 86400000);
    expect(now.getTime() - cut('engineReviewFrozenResult.deleteMany')).toBe(365 * 86400000);
  });
});
