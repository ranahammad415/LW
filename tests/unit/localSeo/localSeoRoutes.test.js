/**
 * Local SEO routes: role + project guards, agents / API tokens denied on every write before any outside call, flags,
 * DB cooldowns, OWNER-only grid, Find-business auto-match, identity confirm keeps the native binding, 202 background
 * runs (also the admin Integrations sync), and the client allow-list (no vendor, cost, ids).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const outside = vi.hoisted(() => ({ calls: [] }));

vi.mock('../../../src/lib/prisma.js', async () => {
  const { assertPrismaArgs } = await import('../../helpers/prismaShape.js');
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          assertPrismaArgs(name, method, args);
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'count') return 0;
          if (method === 'create') return { id: 'run-1', createdAt: new Date(), ...(args?.data || {}) };
          if (method === 'update') return { ...(db.project || {}), ...(args?.data || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/omniSearch/businessDataProvider.js', async (orig) => ({
  ...(await orig()),
  fetchGmbInfo: async (args) => {
    outside.calls.push(['info', args.identifier]);
    return { title: "Joe's Pizza", cid: '111111111', placeId: 'ChIJjoe12345', lat: 43.04, lng: -87.9, rating: 4.6, reviewsCount: 212, url: 'https://joespizza.com', costUsd: 0.0054 };
  },
  searchBusinessCandidates: async (args) => {
    outside.calls.push(['search', args.query]);
    return {
      costUsd: 0.002,
      candidates: [
        { title: 'Joes Pizza (other)', cid: '222', placeId: 'ChIJother1234', url: 'https://xjoespizza.com', rating: 4.1, reviewsCount: 3 },
        { title: "Joe's Pizza", cid: '111111111', placeId: 'ChIJjoe12345', url: 'https://www.joespizza.com/', address: '1 Main St', phone: '+1', rating: 4.6, reviewsCount: 212 },
      ],
    };
  },
}));
vi.mock('../../../src/lib/localRank.js', async (orig) => ({
  ...(await orig()),
  runLocalRankForProject: async () => { outside.calls.push(['ranks']); return { checked: 1 }; },
  runGridForKeyword: async () => { outside.calls.push(['grid']); return { calls: 25 }; },
}));
vi.mock('../../../src/lib/gscSync.js', () => ({ runGscSync: async () => { outside.calls.push(['gsc']); return { ok: true }; } }));
vi.mock('../../../src/lib/analytics/runNativeSync.js', () => ({ runNativeAnalyticsSync: async () => { outside.calls.push(['native']); return { ga4: {}, gmb: {}, dataforseo: {} }; } }));

import { pmLocalSeoRoutes } from '../../../src/routes/pm/localSeo.js';
import { clientLocalSeoRoutes } from '../../../src/routes/client/localSeo.js';
import { adminIntegrationsRoutes } from '../../../src/routes/admin/integrations.js';
import { redactResponseSecrets, CLIENT_DROP_KEYS } from '../../../src/lib/redactSecrets.js';

let app;
let who;
beforeAll(async () => {
  process.env.DATAFORSEO_LOGIN = 'l';
  process.env.DATAFORSEO_PASSWORD = 'p';
  app = Fastify();
  app.decorate('verifyJwt', async (request) => {
    request.user = who.user;
    if (who.token) request.authMethod = 'apiToken';
  });
  app.decorate('requireClient', async (request) => {
    request.clientAccountIds = who.clientIds || [];
  });
  app.decorate('requireOwner', async (request, reply) => {
    if (request.user?.role !== 'OWNER') return reply.status(403).send({ message: 'Owner only' });
  });
  await app.register(pmLocalSeoRoutes, { prefix: '/api/pm' });
  await app.register(clientLocalSeoRoutes, { prefix: '/api/client' });
  await app.register(adminIntegrationsRoutes, { prefix: '/api/admin' });
  await app.ready();
});
afterAll(async () => {
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  delete process.env.LOCAL_RANK_ENABLED;
  await app.close();
});

const PROJECT = {
  id: 'p1', name: 'Joe', clientId: 'c1', leadPmId: 'pm1', wpUrl: 'https://www.joespizza.com', dataforseoDomain: null, gmbLocationId: 'accounts/1/locations/2',
  gmbCid: '111111111', gmbPlaceId: null, gmbLocationName: "Joe's Pizza", gmbLat: 43.04, gmbLng: -87.9, localLanguageCode: 'en', localGridSize: 5,
  localGridSpacingKm: 1.5, gmbProfileSyncedAt: null, client: { websiteUrl: null },
};

beforeEach(() => {
  db.calls = [];
  db.overrides = { 'project.findUnique': async () => PROJECT };
  db.project = PROJECT;
  outside.calls = [];
  who = { user: { id: 'o', role: 'OWNER' } };
  delete process.env.LOCAL_RANK_ENABLED;
  delete process.env.LOCAL_GRID_ENABLED;
});

const WRITES = [
  ['POST', '/api/pm/projects/p1/local-seo/find-business', { name: 'Joe' }],
  ['POST', '/api/pm/projects/p1/local-seo/identity', { cid: '111111111' }],
  ['POST', '/api/pm/projects/p1/local-seo/profile/refresh', {}],
  ['PUT', '/api/pm/projects/p1/local-seo/location', { languageCode: 'en' }],
  ['PATCH', '/api/pm/projects/p1/keywords/k1/track-local', { trackLocal: true }],
  ['POST', '/api/pm/projects/p1/local-seo/refresh', {}],
  ['PUT', '/api/pm/projects/p1/local-seo/grid', { enabled: true }],
  ['POST', '/api/pm/projects/p1/local-seo/grid/refresh', { keywordId: 'k1' }],
  ['POST', '/api/admin/integrations/sync', {}],
];

describe('guards', () => {
  it('TEAM_MEMBER / CONTRACTOR / CLIENT refused; PM without access refused; lead PM allowed', async () => {
    for (const role of ['TEAM_MEMBER', 'CONTRACTOR', 'CLIENT']) {
      who = { user: { id: 'x', role } };
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/local-seo' })).statusCode).toBe(403);
    }
    who = { user: { id: 'pm2', role: 'PM' } };
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: 'pmX', secondaryPmId: null });
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/local-seo' })).statusCode).toBe(403);
    who = { user: { id: 'pm1', role: 'PM' } };
    const ok = await app.inject({ method: 'GET', url: '/api/pm/projects/p1/local-seo' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().identity).toMatchObject({ cid: '111111111', nativeLocationId: 'accounts/1/locations/2' });
  });

  it('agents and API tokens never write (403 HUMAN_ONLY, no outside call)', async () => {
    for (const w of [{ user: { id: 'o', role: 'OWNER', isAgent: true } }, { user: { id: 'o', role: 'OWNER' }, token: true }]) {
      who = w;
      for (const [method, url, payload] of WRITES) {
        const res = await app.inject({ method, url, payload });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().code).toBe('HUMAN_ONLY');
      }
    }
    expect(outside.calls).toEqual([]);
    expect(db.calls.some((c) => /\.(update|create|upsert|updateMany)$/.test(c.key))).toBe(false);
  });

  it('grid settings and grid runs are OWNER-only', async () => {
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'PUT', url: '/api/pm/projects/p1/local-seo/grid', payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/grid/refresh', payload: { keywordId: 'k1' } })).statusCode).toBe(403);
    who = { user: { id: 'o', role: 'OWNER' } };
    const off = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/grid/refresh', payload: { keywordId: 'k1' } });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('DISABLED');
    const put = await app.inject({ method: 'PUT', url: '/api/pm/projects/p1/local-seo/grid', payload: { enabled: true, size: 9, spacingKm: 50 } });
    expect(put.statusCode).toBe(200);
    expect(db.calls.find((c) => c.key === 'project.update').args.data).toEqual({ localGridEnabled: true, localGridSize: 7, localGridSpacingKm: 10 });
  });
});

describe('identity', () => {
  it('Find business marks the candidate on the project site and saves nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/find-business', payload: { name: "Joe's Pizza", city: 'Milwaukee' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(outside.calls).toEqual([['search', "Joe's Pizza Milwaukee"]]);
    expect(body.candidates.map((c) => c.siteMatch)).toEqual([false, true]);
    expect(body.autoMatch).toBe('111111111');
    expect(db.calls.some((c) => c.key === 'project.update')).toBe(false);
  });

  it('a CID / place_id input uses my_business_info directly', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/find-business', payload: { input: 'https://maps.google.com/?cid=111111111' } });
    expect(res.statusCode).toBe(200);
    expect(outside.calls).toEqual([['info', 'cid:111111111']]);
  });

  it('confirm saves the verified identity and never clears the native location', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/identity', payload: { cid: '111111111' } });
    expect(res.statusCode).toBe(200);
    const data = db.calls.find((c) => c.key === 'project.update').args.data;
    expect(data).toMatchObject({ gmbCid: '111111111', gmbPlaceId: 'ChIJjoe12345', gmbLat: 43.04, gmbRating: 4.6, gmbReviewsCount: 212, gmbIdentitySource: 'dataforseo', gmbLocationName: "Joe's Pizza" });
    expect(data.gmbIdentityVerifiedAt).toBeTruthy();
    expect(data).not.toHaveProperty('gmbLocationId');
    expect(data).not.toHaveProperty('gmbAccountId');
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/identity', payload: { cid: 'abc' } })).statusCode).toBe(400);
  });
});

describe('refresh and runs', () => {
  it('Maps refresh: 409 while LOCAL_RANK_ENABLED is off; 202 + run when on; DB cooldown 429', async () => {
    const off = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/refresh' });
    expect(off.statusCode).toBe(409);
    expect(outside.calls).toEqual([]);

    process.env.LOCAL_RANK_ENABLED = 'true';
    db.overrides['keywordTrack.count'] = async () => 2;
    const ok = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/refresh' });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().run).toMatchObject({ id: 'run-1', kind: 'local_rank', status: 'queued', projectId: 'p1' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    expect(outside.calls).toEqual([['ranks']]);
    expect(db.calls.filter((c) => c.key === 'analyticsSyncRun.update').map((c) => c.args.data.status)).toEqual(['running', 'done']);

    db.overrides['localRankDaily.findFirst'] = async () => ({ fetchedAt: new Date() });
    const cool = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/refresh' });
    expect(cool.statusCode).toBe(429);
  });

  it('an active run is returned instead of starting a second one', async () => {
    process.env.LOCAL_RANK_ENABLED = 'true';
    db.overrides['keywordTrack.count'] = async () => 2;
    db.overrides['analyticsSyncRun.findFirst'] = async () => ({ id: 'run-0', kind: 'local_rank', projectId: 'p1', status: 'running', createdAt: new Date() });
    const res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/local-seo/refresh' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ existing: true, run: { id: 'run-0' } });
    expect(db.calls.some((c) => c.key === 'analyticsSyncRun.create')).toBe(false);
  });

  it('runs: a PM sees only runs of projects they can access', async () => {
    db.overrides['analyticsSyncRun.findUnique'] = async () => ({ id: 'r', kind: 'local_rank', projectId: 'p1', status: 'done', createdAt: new Date() });
    who = { user: { id: 'pm2', role: 'PM' } };
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: 'pmX', secondaryPmId: null });
    expect((await app.inject({ method: 'GET', url: '/api/pm/local-seo/runs/r' })).statusCode).toBe(404);
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/local-seo/runs/r' })).statusCode).toBe(200);
  });

  it('admin Integrations sync answers 202 at once and runs in the background', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/integrations/sync' });
    expect(res.statusCode).toBe(202);
    expect(res.json().run).toMatchObject({ kind: 'integrations_sync', status: 'queued' });
    await new Promise((r) => setTimeout(r, 20));
    expect(outside.calls).toEqual([['gsc'], ['native']]);
    db.overrides['analyticsSyncRun.findUnique'] = async () => ({ id: 'run-1', kind: 'integrations_sync', status: 'done', summary: { gsc: {} }, createdAt: new Date() });
    const poll = await app.inject({ method: 'GET', url: '/api/admin/integrations/sync/runs/run-1' });
    expect(poll.json()).toMatchObject({ status: 'done', summary: { gsc: {} } });
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'POST', url: '/api/admin/integrations/sync' })).statusCode).toBe(403);
  });

  it('track-local validates the body and the keyword belongs to the project', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/pm/projects/p1/keywords/k1/track-local', payload: { trackLocal: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/pm/projects/p1/keywords/k1/track-local', payload: { trackLocal: true } })).statusCode).toBe(404);
    expect(db.calls.find((c) => c.key === 'keywordTrack.findFirst').args.where).toEqual({ id: 'k1', projectId: 'p1' });
  });
});

describe('client Google Maps ranking tile', () => {
  it('scoped to the caller; allow-list without vendor, cost or ids', async () => {
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c2'] };
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/maps-ranking' })).statusCode).toBe(404);

    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c1'] };
    db.overrides['keywordTrack.findMany'] = async () => [{ id: 'k1', keyword: 'pizza milwaukee' }];
    db.overrides['localRankDaily.findMany'] = async () => [
      { keywordId: 'k1', date: new Date(), rank: 2, inPack: true, depth: 20, competitors: [{ title: 'Rival', cid: '900', rating: 4.9, votes: 9 }] },
    ];
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/maps-ranking' });
    expect(res.statusCode).toBe(200);
    const text = res.body.toLowerCase();
    for (const bad of ['"cid"', 'costusd', 'matchedby', 'dataforseo', 'errorcode', '"900"', 'place_id', 'placeid']) expect(text).not.toContain(bad);
    expect(res.json().keywords[0]).toMatchObject({ keyword: 'pizza milwaukee', position: 2, inTop3: true, nearbyCompetitors: ['Rival'] });
  });

  it('client drop list covers the new internal keys', () => {
    for (const k of ['costUsd', 'gmbCid', 'gmbPlaceId', 'gmbFeatureId', 'gmbReviewsTaskId', 'gmbSyncError', 'matchedBy']) expect(CLIENT_DROP_KEYS.has(k)).toBe(true);
    expect(redactResponseSecrets({ p: { gmbCid: '1', name: 'x' } }, 0, CLIENT_DROP_KEYS)).toEqual({ p: { name: 'x' } });
  });
});
