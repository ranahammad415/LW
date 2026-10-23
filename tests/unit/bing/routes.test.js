/**
 * Bing routes: guards (CLIENT / TEAM_MEMBER 403 on /pm/*, PM without access 403, non-OWNER 403 on admin), agents and
 * API tokens 403 HUMAN_ONLY on connect / disconnect / auto-bind / bind / sync / Bing Places / config activate before any
 * outside call, API tokens denied on /api/admin/integrations/bing/*, the connect route validates with GetUserSites and
 * never returns or stores the key in clear, bind accepts only listed verified sites (422 BING_SITE_UNKNOWN), sync
 * cooldown 429 + retry-after, the client tile is scoped to the caller's client, the client `ops` view is 404.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const outside = vi.hoisted(() => ({ calls: [], sitesResult: null }));

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
          if (method === 'create') return { id: 'row-1', createdAt: new Date(), ...(args?.data || {}) };
          if (method === 'update') return { ...(db.project || {}), ...(args?.data || {}) };
          if (method === 'updateMany') return { count: 1 };
          return null;
        };
      },
    });
  const prisma = new Proxy({}, { get: (_, n) => (n === '$transaction' ? async (fn) => fn(prisma) : model(String(n))) });
  return { prisma };
});
vi.mock('../../../src/lib/bing/client.js', async (orig) => ({
  ...(await orig()),
  getUserSites: async ({ credential }) => {
    outside.calls.push(['GetUserSites', credential?.apiKey === KEY_CONST ? 'key' : 'other']);
    if (outside.sitesResult instanceof Error) throw outside.sitesResult;
    return outside.sitesResult || [{ siteUrl: 'https://www.example.com/', verified: true }, { siteUrl: 'https://example.org/', verified: false }];
  },
}));
vi.mock('../../../src/lib/bing/bingSync.js', async (orig) => ({
  ...(await orig()),
  runBingSync: async () => {
    outside.calls.push(['sync']);
    return { total: 0 };
  },
}));
vi.mock('../../../src/lib/gscSync.js', () => ({ runGscSync: async () => ({ ok: true }) }));
vi.mock('../../../src/lib/analytics/runNativeSync.js', () => ({ runNativeAnalyticsSync: async () => ({}) }));
vi.mock('../../../src/lib/health/healthScoreService.js', async (orig) => ({ ...(await orig()), recomputeAll: async () => ({ projects: 0 }) }));
const KEY_CONST = vi.hoisted(() => '0123456789abcdef0123456789abcdef');

import { adminIntegrationsRoutes } from '../../../src/routes/admin/integrations.js';
import { pmBingRoutes } from '../../../src/routes/pm/bing.js';
import { clientBingRoutes } from '../../../src/routes/client/bing.js';
import { clientAnalyticsRoutes } from '../../../src/routes/client/analytics.js';
import { adminHealthRoutes } from '../../../src/routes/admin/health.js';
import { checkApiTokenRoute } from '../../../src/lib/apiTokens.js';
import { decryptSecret } from '../../../src/lib/analytics/tokenCrypto.js';
import { invalidateBingSitesCache } from '../../../src/lib/bing/bingBinding.js';
import { encryptSecret } from '../../../src/lib/analytics/tokenCrypto.js';

let app;
let who;
beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-secret-0123456789';
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
  await app.register(adminIntegrationsRoutes, { prefix: '/api/admin' });
  await app.register(adminHealthRoutes, { prefix: '/api/admin' });
  await app.register(pmBingRoutes, { prefix: '/api/pm' });
  await app.register(clientBingRoutes, { prefix: '/api/client' });
  await app.register(clientAnalyticsRoutes, { prefix: '/api/client' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const PROJECT = {
  id: 'p1', name: 'Harbor', clientId: 'c1', leadPmId: 'pm1', gscSiteUrl: null, wpUrl: 'https://www.example.com', dataforseoDomain: null,
  gmbLocationName: null, localLocationCode: null, localLanguageCode: 'en', bingSiteUrl: 'https://www.example.com/', bingLastSyncedAt: null,
  bingSyncError: null, bingPlacesUrl: null, bingPlacesClaimed: false, bingPlacesCheckedAt: null, client: { websiteUrl: null, agencyName: 'Harbor' },
};
const encKey = () => encryptSecret(KEY_CONST, { purpose: 'bing' });

beforeEach(() => {
  db.calls = [];
  db.project = PROJECT;
  db.overrides = {
    'project.findUnique': async () => PROJECT,
    'project.findFirst': async () => PROJECT,
    'agencyBingConnection.findFirst': async (args) => (args?.select?.apiKeyEnc ? { id: 'conn1', authType: 'api_key', apiKeyEnc: encKey() } : { id: 'conn1', authType: 'api_key', status: 'ACTIVE' }),
  };
  outside.calls = [];
  outside.sitesResult = null;
  invalidateBingSitesCache();
  who = { user: { id: 'o', role: 'OWNER' } };
});

const WRITES = [
  ['POST', '/api/admin/integrations/bing/connect', { apiKey: KEY_CONST, accountLabel: 'me' }],
  ['POST', '/api/admin/integrations/bing/disconnect', {}],
  ['POST', '/api/admin/integrations/bing/auto-bind', {}],
  ['PUT', '/api/admin/integrations/clients/c1/projects/p1', { bingSiteUrl: 'https://www.example.com/' }],
  ['POST', '/api/pm/projects/p1/bing/sync', {}],
  ['PUT', '/api/pm/projects/p1/bing-places', { claimed: true }],
  ['POST', '/api/admin/health/config/3/activate', {}],
];

describe('guards', () => {
  it('CLIENT / TEAM_MEMBER / CONTRACTOR refused on the staff tab; PM without access refused; lead PM allowed', async () => {
    for (const role of ['CLIENT', 'TEAM_MEMBER', 'CONTRACTOR']) {
      who = { user: { id: 'x', role } };
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/bing' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/bing/sync' })).statusCode).toBe(403);
    }
    who = { user: { id: 'pm2', role: 'PM' } };
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: 'pmX', secondaryPmId: null });
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/bing' })).statusCode).toBe(403);
    who = { user: { id: 'pm1', role: 'PM' } };
    const ok = await app.inject({ method: 'GET', url: '/api/pm/projects/p1/bing' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ linked: true, binding: { siteUrl: 'https://www.example.com/' } });
  });

  it('admin Bing routes are OWNER only', async () => {
    who = { user: { id: 'pm1', role: 'PM' } };
    for (const [method, url] of [['GET', '/api/admin/integrations/bing/status'], ['GET', '/api/admin/integrations/bing/fleet'], ['GET', '/api/admin/integrations/properties/bing'], ['POST', '/api/admin/integrations/bing/connect']]) {
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(403);
    }
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
    expect(db.calls.some((c) => c.key === 'agencyBingConnection.create' || c.key === 'agencyBingConnection.update')).toBe(false);
  });

  it('API tokens cannot reach /api/admin/integrations/bing/* at all', () => {
    for (const url of ['/api/admin/integrations/bing/status', '/api/admin/integrations/bing/connect', '/api/admin/integrations/bing/fleet']) {
      expect(checkApiTokenRoute({ scopes: [] }, 'GET', url)).toMatchObject({ ok: false, status: 403 });
    }
  });
});

describe('connect / disconnect / status', () => {
  it('rejects a malformed key without calling Bing; a key Bing rejects → 422', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/admin/integrations/bing/connect', payload: { apiKey: 'short' } });
    expect(bad.statusCode).toBe(400);
    expect(outside.calls).toEqual([]);
    const { BingApiError } = await import('../../../src/lib/bing/client.js');
    outside.sitesResult = new BingApiError('InvalidApiKey', { httpStatus: 400 });
    const rej = await app.inject({ method: 'POST', url: '/api/admin/integrations/bing/connect', payload: { apiKey: KEY_CONST } });
    expect(rej.statusCode).toBe(422);
    expect(rej.json().code).toBe('BING_KEY_REJECTED');
    expect(rej.body).not.toContain(KEY_CONST);
    expect(db.calls.some((c) => c.key === 'agencyBingConnection.update')).toBe(false);
  });

  it('validates with GetUserSites, stores the key encrypted, never echoes it', async () => {
    db.overrides['agencyBingConnection.findFirst'] = async () => null;
    const res = await app.inject({ method: 'POST', url: '/api/admin/integrations/bing/connect', payload: { apiKey: KEY_CONST, accountLabel: 'seo@agency.com' } });
    expect(res.statusCode).toBe(200);
    expect(outside.calls).toEqual([['GetUserSites', 'key']]);
    expect(res.body).not.toContain(KEY_CONST);
    expect(res.json().sites).toHaveLength(2);
    const create = db.calls.find((c) => c.key === 'agencyBingConnection.create').args;
    expect(create.data.apiKeyEnc).not.toContain(KEY_CONST);
    expect(decryptSecret(create.data.apiKeyEnc, { purpose: 'bing' })).toBe(KEY_CONST);
    expect(create.select.apiKeyEnc).toBeUndefined();
  });

  it('status never includes the key; disconnect wipes the credential', async () => {
    const st = await app.inject({ method: 'GET', url: '/api/admin/integrations/bing/status' });
    expect(st.statusCode).toBe(200);
    const sel = db.calls.find((c) => c.key === 'agencyBingConnection.findFirst').args.select;
    expect(sel.apiKeyEnc).toBeUndefined();
    const dis = await app.inject({ method: 'POST', url: '/api/admin/integrations/bing/disconnect' });
    expect(dis.statusCode).toBe(200);
    const upd = db.calls.find((c) => c.key === 'agencyBingConnection.updateMany').args;
    expect(upd.data).toMatchObject({ status: 'DISCONNECTED', apiKeyEnc: null });
  });
});

describe('binding', () => {
  it('only listed VERIFIED sites (exact string); empty unbinds', async () => {
    db.project = { ...PROJECT, bingSiteUrl: null };
    db.overrides['project.findFirst'] = async () => ({ ...PROJECT, bingSiteUrl: null });
    const bad = await app.inject({ method: 'PUT', url: '/api/admin/integrations/clients/c1/projects/p1', payload: { bingSiteUrl: 'https://example.org/' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('BING_SITE_UNKNOWN');
    const ok = await app.inject({ method: 'PUT', url: '/api/admin/integrations/clients/c1/projects/p1', payload: { bingSiteUrl: 'https://www.example.com/' } });
    expect(ok.statusCode).toBe(200);
    expect(db.calls.filter((c) => c.key === 'project.update').at(-1).args.data).toMatchObject({ bingSiteUrl: 'https://www.example.com/', bingSyncError: null });
    db.overrides['project.findFirst'] = async () => PROJECT;
    await app.inject({ method: 'PUT', url: '/api/admin/integrations/clients/c1/projects/p1', payload: { bingSiteUrl: '' } });
    expect(db.calls.filter((c) => c.key === 'project.update').at(-1).args.data).toMatchObject({ bingSiteUrl: null });
  });

  it('auto-bind returns the plan buckets', async () => {
    db.overrides['project.findMany'] = async () => [{ id: 'p9', name: 'New', clientId: 'c9', bingSiteUrl: null, gscSiteUrl: null, wpUrl: 'https://example.com', dataforseoDomain: null, client: { websiteUrl: null, agencyName: 'X' } }];
    const res = await app.inject({ method: 'POST', url: '/api/admin/integrations/bing/auto-bind' });
    expect(res.statusCode).toBe(200);
    expect(res.json().bound).toEqual([{ projectId: 'p9', name: 'New', siteUrl: 'https://www.example.com/' }]);
  });
});

describe('sync now', () => {
  it('not bound → 409; cooldown → 429 + retry-after; else 202 with a run', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, bingSiteUrl: null });
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/bing/sync' })).json().code).toBe('NOT_BOUND');
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, bingLastSyncedAt: new Date(Date.now() - 5 * 60_000) });
    const cool = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/bing/sync' });
    expect(cool.statusCode).toBe(429);
    expect(Number(cool.headers['retry-after'])).toBeGreaterThan(500);
    db.overrides['project.findUnique'] = async () => PROJECT;
    const ok = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/bing/sync' });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().run).toMatchObject({ kind: 'bing_sync', projectId: 'p1' });
  });
});

describe('Bing Places checklist', () => {
  it('saves url / claimed / checked and shows the citation-mirror NAP row', async () => {
    db.overrides['seoCitationMirror.findMany'] = async () => [{ name: 'Bing Places', url: 'https://www.bingplaces.com/x', kind: 'maps', listed: true, napStatus: 'wrong', lastChecked: null }];
    const bad = await app.inject({ method: 'PUT', url: '/api/pm/projects/p1/bing-places', payload: { url: 'javascript:alert(1)' } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'PUT', url: '/api/pm/projects/p1/bing-places', payload: { url: 'https://www.bing.com/maps?cp=1', claimed: true, checked: true } });
    expect(res.statusCode).toBe(200);
    const data = db.calls.filter((c) => c.key === 'project.update').at(-1).args.data;
    expect(data).toMatchObject({ bingPlacesUrl: 'https://www.bing.com/maps?cp=1', bingPlacesClaimed: true, bingPlacesCheckedAt: expect.any(Date) });
    expect(res.json().citation).toEqual({ name: 'Bing Places', listed: true, napStatus: 'wrong', lastChecked: null });
  });
});

describe('client portal', () => {
  it('tile is scoped to the caller client; ops view 404', async () => {
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c2'] };
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/bing-summary' })).statusCode).toBe(404);
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c1'] };
    const ok = await app.inject({ method: 'GET', url: '/api/client/projects/p1/bing-summary' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toMatch(/example\.com|p1|bingSyncError/);
    expect((await app.inject({ method: 'GET', url: '/api/client/analytics/bing/ops' })).statusCode).toBe(404);
  });
});

describe('health config activate', () => {
  it('activates a stored valid version: others deactivated, this one active; 404 unknown, 409 invalid, PM 403', async () => {
    const { DEFAULT_CONFIG_V3 } = await import('../../../src/lib/health/defaultConfig.js');
    const stored = { version: 3, isActive: false, note: 'v3 proposal', createdAt: new Date(), config: JSON.parse(JSON.stringify(DEFAULT_CONFIG_V3)) };
    db.overrides['healthScoreConfig.findUnique'] = async () => stored;
    db.overrides['healthScoreConfig.update'] = async (args) => ({ ...stored, ...args.data });
    const res = await app.inject({ method: 'POST', url: '/api/admin/health/config/3/activate' });
    expect(res.statusCode).toBe(200);
    expect(res.json().active.version).toBe(3);
    const keys = db.calls.map((c) => c.key);
    expect(keys.indexOf('healthScoreConfig.updateMany')).toBeLessThan(keys.indexOf('healthScoreConfig.update'));
    expect(db.calls.find((c) => c.key === 'healthScoreConfig.updateMany').args).toEqual({ where: { isActive: true }, data: { isActive: false } });
    expect(db.calls.find((c) => c.key === 'healthScoreConfig.update').args).toEqual({ where: { version: 3 }, data: { isActive: true } });

    db.overrides['healthScoreConfig.findUnique'] = async () => null;
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/config/9/activate' })).statusCode).toBe(404);
    db.overrides['healthScoreConfig.findUnique'] = async () => ({ ...stored, config: { nope: true } });
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/config/3/activate' })).statusCode).toBe(409);
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/config/3/activate' })).statusCode).toBe(403);
  });
});
