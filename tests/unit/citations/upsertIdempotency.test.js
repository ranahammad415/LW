/**
 * O-C180-1: POST /api/pm/projects/:id/citations/upsert answers a repeated body.idempotencyKey from the stored first
 * response (OS-05 middleware), instead of rebuilding the site body (new last_checked, new baseRev → 409). A different
 * body with the same key → 409 IDEMPOTENCY_KEY_REUSED. The site write runs once.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ keys: [], rev: 2 }));
const lib = vi.hoisted(() => ({ upsertCalls: [] }));

vi.mock('../../../src/lib/prisma.js', () => {
  const rows = () => db.keys;
  const find = (w) => rows().find((r) => r.userId === w.userId && r.route === w.route && r.key === w.key);
  const idempotencyKey = {
    create: async ({ data }) => {
      if (find(data)) {
        const e = new Error('Unique constraint');
        e.code = 'P2002';
        throw e;
      }
      const row = { id: `idem-${rows().length + 1}`, createdAt: new Date(), statusCode: null, responseBody: null, ...data };
      rows().push(row);
      return { id: row.id };
    },
    findUnique: async ({ where }) => find(where.userId_route_key) || null,
    updateMany: async ({ where, data }) => {
      const row = rows().find((r) => r.id === where.id && (!where.state || r.state === where.state));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    deleteMany: async ({ where }) => {
      const i = rows().findIndex((r) => r.id === where.id);
      if (i >= 0) rows().splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    },
  };
  const project = { findUnique: async ({ where }) => ({ id: where.id, cmsType: 'EMDASH', cmsCapabilities: { seoCitations: true } }) };
  return { prisma: { idempotencyKey, project } };
});
vi.mock('../../../src/lib/ensureProjectAccess.js', () => ({ ensureProjectAccess: async () => true }));
vi.mock('../../../src/lib/localRank.js', () => ({ LOCAL_PROJECT_SELECT: { id: true } }));
vi.mock('../../../src/lib/analytics/syncRuns.js', () => ({ startBackgroundRun: vi.fn(), runView: vi.fn() }));
vi.mock('../../../src/lib/analytics/aiVisibilityScheduled.js', () => ({ staffAiPromptsView: vi.fn() }));
vi.mock('../../../src/lib/citations/monitor.js', () => ({
  checkProjectCitations: vi.fn(),
  isCitationsMonitorEnabled: () => false,
  isPageCheckEnabled: () => false,
  manualCheckBlocker: vi.fn(),
  PAGE_CHECKS_PER_PROJECT: 5,
}));
vi.mock('../../../src/lib/citations/citations.js', async () => {
  const { CmsBridgeError } = await import('../../../src/lib/siteAdapters/emdash.js');
  return {
    hasSeoCitations: (p) => p?.cmsType === 'EMDASH' && p?.cmsCapabilities?.seoCitations === true,
    pullCitations: vi.fn(),
    setCanonicalNap: vi.fn(),
    staffCitationsView: async () => ({ rev: db.rev, items: [] }),
    // Mirrors the real behaviour: a second call for the same edit sees body.baseRev ≠ mirror rev → CONFLICT_REV.
    staffUpsertCitation: async (projectId, user, body, opts) => {
      lib.upsertCalls.push({ projectId, body, opts });
      if (Number.isInteger(body.baseRev) && body.baseRev !== db.rev) {
        throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: 'changed', details: { currentRev: db.rev } });
      }
      db.rev += 1;
      return { rev: db.rev, applied: [{ id: body.item.id, fields: ['listed', 'last_checked'] }], rejected: [], warnings: [], replayed: false, retried: false };
    },
  };
});

const { pmSeoMonitoringRoutes, citationUpsertKey } = await import('../../../src/routes/pm/seoMonitoring.js');

const PM = { id: 'u-pm', role: 'PM', isAgent: false };
let app;
beforeAll(async () => {
  app = Fastify();
  app.decorate('verifyJwt', async (request) => {
    request.user = { ...PM };
  });
  app.register(pmSeoMonitoringRoutes, { prefix: '/api/pm' });
  await app.ready();
});
afterAll(async () => app?.close());
beforeEach(() => {
  db.keys = [];
  db.rev = 2;
  lib.upsertCalls = [];
});

const URL_ = '/api/pm/projects/p1/citations/upsert';
const body = (over = {}) => ({ baseRev: 2, idempotencyKey: 'key-0001-abcd', item: { id: 'angi.com', listed: true, nap_status: 'correct' }, ...over });

describe('citations/upsert idempotency (O-C180-1)', () => {
  it('a lost-response retry with the same key gets the same success answer; the site write runs once', async () => {
    const a = await app.inject({ method: 'POST', url: URL_, payload: body() });
    expect(a.statusCode).toBe(200);
    expect(a.json().result.rev).toBe(3);
    const b = await app.inject({ method: 'POST', url: URL_, payload: body() });
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(lib.upsertCalls).toHaveLength(1);
    expect(lib.upsertCalls[0].opts.idempotencyKey).toBe('key-0001-abcd');
  });

  it('the same key with a different body → 409 IDEMPOTENCY_KEY_REUSED (no site call)', async () => {
    await app.inject({ method: 'POST', url: URL_, payload: body() });
    const b = await app.inject({ method: 'POST', url: URL_, payload: body({ baseRev: 3, item: { id: 'angi.com', listed: false } }) });
    expect(b.statusCode).toBe(409);
    expect(b.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(lib.upsertCalls).toHaveLength(1);
  });

  it('a new key is a new write (and then meets the rev pre-check as before)', async () => {
    await app.inject({ method: 'POST', url: URL_, payload: body() });
    const b = await app.inject({ method: 'POST', url: URL_, payload: body({ idempotencyKey: 'key-0002-abcd' }) });
    expect(b.statusCode).toBe(409);
    expect(b.json().code).toBe('CONFLICT_REV');
    expect(lib.upsertCalls).toHaveLength(2);
  });

  it('without a usable key the route runs normally (nothing stored)', async () => {
    const a = await app.inject({ method: 'POST', url: URL_, payload: body({ idempotencyKey: undefined }) });
    expect(a.statusCode).toBe(200);
    expect(db.keys).toHaveLength(0);
    expect(citationUpsertKey({ body: { idempotencyKey: 'short' } })).toBeUndefined();
    expect(citationUpsertKey({ body: { idempotencyKey: 12345678 } })).toBeUndefined();
    expect(citationUpsertKey({ body: { idempotencyKey: 'key-0001-abcd' } })).toBe('key-0001-abcd');
  });
});
