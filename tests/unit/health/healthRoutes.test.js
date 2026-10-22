/**
 * Health score v2 routes: guards (roles, ensureProjectAccess, client lead/secondary PM, owner only), client scoping,
 * humans-only writes, config validation, token denials and the client-audience redaction layer. Prisma is stubbed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany') return { count: 0 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'row', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  const prisma = new Proxy({}, { get: (_, n) => (n === '$transaction' ? async (fn) => fn(prisma) : model(String(n))) });
  return { prisma };
});

import { pmHealthRoutes } from '../../../src/routes/pm/health.js';
import { clientHealthRoutes } from '../../../src/routes/client/health.js';
import { adminHealthRoutes } from '../../../src/routes/admin/health.js';
import { requireOwner } from '../../../src/lib/requireOwner.js';
import { requirePM } from '../../../src/lib/requirePM.js';
import { redactResponseSecrets, responseDropKeys } from '../../../src/lib/redactSecrets.js';
import { checkApiTokenRoute } from '../../../src/lib/apiTokens.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';
import { invalidateConfigCache } from '../../../src/lib/health/healthConfig.js';

let app;
let who;
beforeAll(async () => {
  app = Fastify();
  app.decorate('verifyJwt', async (request) => {
    request.user = who.user;
    if (who.token) request.authMethod = 'apiToken';
  });
  app.decorate('requireOwner', requireOwner);
  app.decorate('requirePM', requirePM);
  app.decorate('requireClient', async (request) => {
    request.clientAccountIds = who.clientIds || [];
    request.clientUserRoles = (who.clientIds || []).map((clientId) => ({ clientId, isPrimaryContact: false }));
  });
  app.addHook('preSerialization', async (request, _reply, payload) => redactResponseSecrets(payload, 0, responseDropKeys(request)));
  await app.register(pmHealthRoutes, { prefix: '/api/pm' });
  await app.register(clientHealthRoutes, { prefix: '/api/client' });
  await app.register(adminHealthRoutes, { prefix: '/api/admin' });
  await app.ready();
});
afterAll(() => app.close());

const PROJECT = { id: 'p1', clientId: 'c1', leadPmId: 'pm1' };
const ROW = {
  projectId: 'p1', date: '2026-10-22', score: 65, coverage: 90, profile: 'LOCAL', configVersion: 1, trend28: 4, computedAt: new Date('2026-10-22T07:00:00Z'),
  pillars: { visibility: { score: 61, weight: 20, scored: 4, total: 4 }, site: { score: 25, weight: 15, scored: 1, total: 3 } },
  factors: [
    { key: 'V1', pillar: 'visibility', score: 81, weight: 1, raw: { cur: 560, prev: 504, yoy: 448 }, parts: { trend: 80.9, level: null }, reason: 'ok' },
    { key: 'S1', pillar: 'site', score: 25, weight: 1, raw: { cur: 'fail', prev: null, yoy: null }, parts: { trend: null, level: 25 }, reason: 'ok', checkId: 'tls.cert_valid' },
  ],
};

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  invalidateConfigCache();
  who = { user: { id: 'u1', role: 'CLIENT' }, clientIds: ['c1'] };
});

describe('client health routes', () => {
  it('another client\'s project is 404', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, clientId: 'other' });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/health' })).statusCode).toBe(404);
  });

  it('project view is an allow-list: no factors, raw values, check ids or security numbers', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    db.overrides['healthScoreDaily.findFirst'] = async () => ROW;
    db.overrides['healthScoreDaily.findMany'] = async () => [{ date: '2026-10-21', score: 63 }];
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toMatch(/"(factors|healthFactors|raw|parts|weight|checkId|configVersion|profile|reason)"/);
    expect(res.body).not.toMatch(/tls\.cert_valid|560|504/);
    const body = res.json();
    expect(body).toMatchObject({ available: true, score: 65, label: 'On track', coverage: 90, arrow: 'up' });
    expect(body.pillars.find((p) => p.key === 'site')).toEqual({ key: 'site', label: 'Website & security', state: 'fail', backups: 'unknown' });
  });

  it('client rollup uses the caller\'s client only', async () => {
    db.overrides['clientHealthDaily.findFirst'] = async (a) => {
      expect(a.where.clientId).toBe('c1');
      return null;
    };
    const res = await app.inject({ method: 'GET', url: '/api/client/health' });
    expect(res.json()).toEqual({ available: false });
  });
});

describe('staff health routes', () => {
  it('CLIENT and TEAM_MEMBER are refused on /api/pm', async () => {
    for (const role of ['CLIENT', 'TEAM_MEMBER', 'CONTRACTOR']) {
      who = { user: { id: 'x', role } };
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/health' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/pm/clients/c1/health' })).statusCode).toBe(403);
    }
  });

  it('a PM without project access is refused; with access gets healthFactors', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: 'pmX', secondaryPmId: null });
    who = { user: { id: 'pm2', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/health' })).statusCode).toBe(403);
    who = { user: { id: 'pm1', role: 'PM' } };
    db.overrides['healthScoreDaily.findFirst'] = async () => ROW;
    const res = await app.inject({ method: 'GET', url: '/api/pm/projects/p1/health?compare=7' });
    expect(res.statusCode).toBe(200);
    expect(res.json().row.healthFactors).toHaveLength(2);
    expect(res.json().compare).toBe(7);
  });

  it('client staff view: PM must be lead or secondary PM of the client; OWNER always', async () => {
    db.overrides['clientAccount.findUnique'] = async () => ({ id: 'c1', leadPmId: 'pmA', secondaryPmId: 'pmB' });
    who = { user: { id: 'pmC', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/clients/c1/health' })).statusCode).toBe(403);
    who = { user: { id: 'pmB', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/clients/c1/health' })).statusCode).toBe(200);
    who = { user: { id: 'o', role: 'OWNER' } };
    const res = await app.inject({ method: 'GET', url: '/api/pm/clients/c1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deliveryHealth');
  });

  it('note: ≤ 500 chars, stored with author; agents and tokens refused', async () => {
    db.overrides['clientAccount.findUnique'] = async () => ({ id: 'c1', leadPmId: 'pm1', secondaryPmId: null });
    who = { user: { id: 'pm1', role: 'PM', name: 'Pat' } };
    expect((await app.inject({ method: 'PUT', url: '/api/pm/clients/c1/health-note', payload: { note: 'x'.repeat(501) } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/pm/clients/c1/health-note', payload: { note: ' Waiting on GA4 access ' } });
    expect(ok.json()).toMatchObject({ note: 'Waiting on GA4 access', by: 'Pat' });
    expect(db.calls.find((c) => c.key === 'clientAccount.update').args.data).toMatchObject({ healthNote: 'Waiting on GA4 access', healthNoteById: 'pm1' });
    for (const w of [{ user: { id: 'pm1', role: 'PM', isAgent: true } }, { user: { id: 'pm1', role: 'PM' }, token: true }]) {
      who = w;
      const res = await app.inject({ method: 'PUT', url: '/api/pm/clients/c1/health-note', payload: { note: 'x' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('HUMAN_ONLY');
      const rc = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/health/recompute' });
      expect(rc.json().code).toBe('HUMAN_ONLY');
    }
  });
});

describe('admin health routes', () => {
  const clone = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));

  it('owner only', async () => {
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/admin/health/config' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/backfill', payload: { days: 5 } })).statusCode).toBe(403);
  });

  it('config PUT: a profile that does not sum to 100 → 400; valid → new version', async () => {
    who = { user: { id: 'o', role: 'OWNER' } };
    const bad = clone();
    bad.profiles.LOCAL.reputation = 30;
    const res = await app.inject({ method: 'PUT', url: '/api/admin/health/config', payload: { config: bad } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe('profiles.LOCAL');
    db.overrides['healthScoreConfig.findFirst'] = async () => ({ version: 3 });
    const good = clone();
    good.minCoverage = 50;
    const ok = await app.inject({ method: 'PUT', url: '/api/admin/health/config', payload: { config: good, note: 'stricter' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().active).toMatchObject({ version: 4, note: 'stricter' });
    expect(db.calls.find((c) => c.key === 'healthScoreConfig.updateMany').args).toEqual({ where: { isActive: true }, data: { isActive: false } });
    expect(db.calls.find((c) => c.key === 'healthScoreConfig.create').args.data).toMatchObject({ version: 4, isActive: true, createdById: 'o' });
  });

  it('config PUT and recompute are humans only', async () => {
    who = { user: { id: 'o', role: 'OWNER', isAgent: true } };
    expect((await app.inject({ method: 'PUT', url: '/api/admin/health/config', payload: { config: clone() } })).json().code).toBe('HUMAN_ONLY');
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/recompute', payload: {} })).json().code).toBe('HUMAN_ONLY');
  });

  it('backfill caps days at 90', async () => {
    who = { user: { id: 'o', role: 'OWNER' } };
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/backfill', payload: { days: 91 } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/admin/health/backfill', payload: { days: 30 } });
    expect(ok.json()).toEqual({ projects: 0, rows: 0, errors: [], nextOffset: null });
  });
});

describe('API tokens and redaction', () => {
  it('tokens never reach health routes', () => {
    for (const [m, u] of [
      ['GET', '/api/pm/projects/:projectId/health'],
      ['POST', '/api/pm/projects/:projectId/health/recompute'],
      ['GET', '/api/pm/clients/:clientId/health'],
      ['PUT', '/api/pm/clients/:clientId/health-note'],
      ['PUT', '/api/admin/health/config'],
      ['POST', '/api/admin/health/backfill'],
    ]) expect(checkApiTokenRoute({}, m, u).ok).toBe(false);
  });

  it('client audiences lose healthFactors, securityScore and checkId; staff keep them', () => {
    const payload = { row: { healthFactors: [1], securityScore: 93, nested: { checkId: 'a.b' } } };
    expect(redactResponseSecrets(payload, 0, responseDropKeys({ url: '/api/client/health', user: { role: 'OWNER' } }))).toEqual({ row: { nested: {} } });
    expect(redactResponseSecrets(payload, 0, responseDropKeys({ url: '/api/pm/projects/p1/health', user: { role: 'CLIENT' } }))).toEqual({ row: { nested: {} } });
    expect(redactResponseSecrets(payload, 0, responseDropKeys({ url: '/api/pm/projects/p1/health', user: { role: 'PM' } }))).toEqual(payload);
  });
});
