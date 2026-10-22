/**
 * Site metrics routes: staff guards (roles, ensureProjectAccess, OWNER-only paid refresh), agents / API tokens denied on
 * refresh before any outside call, DB cooldown, and the client allow-lists (no vendor, cost, URL or raw data).
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

import { takeShapeViolations } from '../../helpers/prismaShape.js';
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
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/pageSpeed.js', async (orig) => ({
  ...(await orig()),
  runPageSpeedForProject: async () => {
    outside.calls.push('psi');
    return { url: 'https://example.com/', results: { mobile: 'ok', desktop: 'ok' }, rateLimited: false };
  },
}));
vi.mock('../../../src/lib/backlinkSnapshots.js', async (orig) => ({
  ...(await orig()),
  snapshotProject: async () => {
    outside.calls.push('dfs');
    return { status: 'ok', costUsd: 0.02 };
  },
}));

vi.mock('../../../src/lib/uptime.js', async (orig) => ({
  ...(await orig()),
  probeProject: async () => {
    outside.calls.push('probe');
    return { ok: true, errorClass: null, incident: 'up' };
  },
}));

import { pmSiteMetricsRoutes } from '../../../src/routes/pm/siteMetrics.js';
import { clientSiteMetricsRoutes } from '../../../src/routes/client/siteMetrics.js';
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
  await app.register(pmSiteMetricsRoutes, { prefix: '/api/pm' });
  await app.register(clientSiteMetricsRoutes, { prefix: '/api/client' });
  await app.ready();
});
afterAll(async () => {
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  await app.close();
});

const PROJECT = { id: 'p1', clientId: 'c1', leadPmId: 'pm1', wpUrl: 'https://example.com', dataforseoDomain: null, cmsType: 'EMDASH' };
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const PSI_ROWS = [
  { date: today, strategy: 'desktop', url: 'https://example.com/', performanceScore: 95, lcpMs: 1200, fieldLcpP75: null, fieldInpP75: null, fieldClsP75: null, status: 'ok', errorCode: null, fetchedAt: new Date() },
  { date: today, strategy: 'mobile', url: 'https://example.com/', performanceScore: 41, lcpMs: 6200, fieldLcpP75: 4300, fieldInpP75: 150, fieldClsP75: 0.02, status: 'ok', errorCode: null, fetchedAt: new Date() },
];
const month = new Date().toISOString().slice(0, 7);
const BL_ROWS = [
  { month: '2000-01', referringDomains: 100, status: 'ok' },
  { month, target: 'example.com', rank: 312, referringDomains: 130, backlinksSpamScore: 7, costUsd: '0.02003', status: 'ok' },
];

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  outside.calls = [];
  who = { user: { id: 'o', role: 'OWNER' } };
});

describe('staff guards', () => {
  it('TEAM_MEMBER / CONTRACTOR / CLIENT refused; PM without access refused; lead PM allowed', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    for (const role of ['TEAM_MEMBER', 'CONTRACTOR', 'CLIENT']) {
      who = { user: { id: 'x', role } };
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/page-speed' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/backlinks-summary' })).statusCode).toBe(403);
    }
    who = { user: { id: 'pm2', role: 'PM' } };
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: 'pmX', secondaryPmId: null });
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/page-speed' })).statusCode).toBe(403);
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/page-speed' })).statusCode).toBe(200);
  });

  it('agents and API tokens never refresh (403 HUMAN_ONLY, no outside call)', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    for (const w of [{ user: { id: 'o', role: 'OWNER', isAgent: true } }, { user: { id: 'o', role: 'OWNER' }, token: true }]) {
      who = w;
      for (const url of ['/api/pm/projects/p1/page-speed/refresh', '/api/pm/projects/p1/backlinks-summary/refresh']) {
        const res = await app.inject({ method: 'POST', url });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('HUMAN_ONLY');
      }
    }
    expect(outside.calls).toEqual([]);
  });

  it('backlink refresh is OWNER-only; PM page-speed refresh works; DB cooldown answers 429', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/backlinks-summary/refresh' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/page-speed/refresh' })).statusCode).toBe(200);
    expect(outside.calls).toEqual(['psi']);

    db.overrides['pageSpeedDaily.findFirst'] = async () => ({ fetchedAt: new Date() });
    const cool = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/page-speed/refresh' });
    expect(cool.statusCode).toBe(429);
    expect(cool.json().code).toBe('COOLDOWN');

    who = { user: { id: 'o', role: 'OWNER' } };
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/backlinks-summary/refresh' })).statusCode).toBe(200);
    db.overrides['backlinkSnapshotMonthly.findUnique'] = async () => ({ fetchedAt: new Date() });
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/backlinks-summary/refresh' })).statusCode).toBe(429);
    expect(outside.calls).toEqual(['psi', 'dfs']);
  });

  it('staff views carry metrics, status and cost', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    db.overrides['pageSpeedDaily.findMany'] = async () => PSI_ROWS;
    db.overrides['backlinkSnapshotMonthly.findMany'] = async () => BL_ROWS;
    const ps = (await app.inject({ method: 'GET', url: '/api/pm/projects/p1/page-speed' })).json();
    expect(ps.latest.mobile).toMatchObject({ performanceScore: 41, status: 'ok', rating: 'poor', ratingSource: 'field' });
    expect(ps.latest.desktop).toMatchObject({ rating: 'good', ratingSource: 'lab' });
    expect(ps.overall).toBe('poor');
    expect(ps.history).toHaveLength(2);
    const bl = (await app.inject({ method: 'GET', url: '/api/pm/projects/p1/backlinks-summary' })).json();
    expect(bl.latest).toMatchObject({ referringDomains: 130, rank: 312, costUsd: 0.02003 });
    expect(bl.trend.direction).toBe('up');
  });
});

describe('client routes', () => {
  beforeEach(() => {
    who = { user: { id: 'u1', role: 'CLIENT' }, clientIds: ['c1'] };
  });

  it("another client's project is 404", async () => {
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'other' });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/page-speed' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/authority' })).statusCode).toBe(404);
  });

  it('no data → {available:false}', async () => {
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/page-speed' })).json()).toEqual({ available: false });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/authority' })).json()).toEqual({ available: false });
  });

  it('page speed: plain labels, sentence and score trend only', async () => {
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    db.overrides['pageSpeedDaily.findMany'] = async (a) => {
      expect(a.where.status).toBe('ok');
      expect(a.select).not.toHaveProperty('url');
      return PSI_ROWS;
    };
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/page-speed' });
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ available: true, mobile: { label: 'Slow', score: 41 }, desktop: { label: 'Fast', score: 95 } });
    expect(body.sentence).toMatch(/slow to load on phones/);
    expect(body.trend[0]).toEqual({ date: today.toISOString().slice(0, 10), mobile: 41, desktop: 95 });
    expect(res.body).not.toMatch(/lcp|lighthouse|example\.com|errorCode|fieldLcp|url/i);
  });

  it('authority: referring domains in plain words; no vendor, cost, rank, spam or target', async () => {
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    db.overrides['backlinkSnapshotMonthly.findMany'] = async (a) => {
      expect(Object.keys(a.select).sort()).toEqual(['month', 'referringDomains', 'status']);
      return BL_ROWS.map(({ month: m, referringDomains, status }) => ({ month: m, referringDomains, status }));
    };
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/authority' });
    const body = res.json();
    expect(body).toMatchObject({ available: true, referringDomains: 130, direction: 'up' });
    expect(body.sentence).toBe('130 websites link to you, up from 100 last time we checked. More sites linking to you helps people find you on Google.');
    expect(res.body).not.toMatch(/dataforseo|dfs|cost|rank|spam|target|example\.com/i);
  });

  it('costUsd is in the client drop list of the global redaction', () => {
    expect(CLIENT_DROP_KEYS.has('costUsd')).toBe(true);
    expect(redactResponseSecrets({ a: { costUsd: 1, n: 2 } }, 0, CLIENT_DROP_KEYS)).toEqual({ a: { n: 2 } });
  });
});

describe('uptime routes', () => {
  it('agents and API tokens never run an uptime check (403 HUMAN_ONLY, no probe)', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    for (const w of [{ user: { id: 'o', role: 'OWNER', isAgent: true } }, { user: { id: 'o', role: 'OWNER' }, token: true }]) {
      who = w;
      const res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/uptime/check' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('HUMAN_ONLY');
    }
    expect(outside.calls).toEqual([]);
  });

  it('a person can probe now, with a per-project cooldown', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    who = { user: { id: 'pm1', role: 'PM' } };
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/uptime/check' })).statusCode).toBe(200);
    db.overrides['uptimeCheck.findFirst'] = async () => ({ at: new Date() });
    expect((await app.inject({ method: 'POST', url: '/api/pm/projects/p1/uptime/check' })).statusCode).toBe(429);
    expect(outside.calls).toEqual(['probe']);
  });

  it('staff view guards; fleet is OWNER/PM and scoped to the PM', async () => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    who = { user: { id: 'tm', role: 'TEAM_MEMBER' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/uptime' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/pm/uptime/fleet' })).statusCode).toBe(403);
    who = { user: { id: 'pm1', role: 'PM' } };
    let where;
    db.overrides['project.findMany'] = async (a) => ((where = a.where), [{ id: 'p1', name: 'Acme', client: { agencyName: 'Acme Inc' } }]);
    const res = await app.inject({ method: 'GET', url: '/api/pm/uptime/fleet' });
    expect(res.statusCode).toBe(200);
    expect(where.OR).toEqual([{ leadPmId: 'pm1' }, { client: { leadPmId: 'pm1' } }, { client: { secondaryPmId: 'pm1' } }]);
    expect(res.json().sites[0]).toMatchObject({ projectId: 'p1', clientName: 'Acme Inc', state: 'unknown', availability30: null });
    who = { user: { id: 'o', role: 'OWNER' } };
    await app.inject({ method: 'GET', url: '/api/pm/uptime/fleet' });
    expect(where.OR).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/uptime' })).statusCode).toBe(200);
  });

  it('fleet failure answers a generic 500 (no Prisma text echoed)', async () => {
    who = { user: { id: 'o', role: 'OWNER' } };
    db.overrides['project.findMany'] = async () => {
      throw new Error("Unknown field 'name' for select statement on model 'ClientAccount'");
    };
    const res = await app.inject({ method: 'GET', url: '/api/pm/uptime/fleet' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'FLEET_FAILED', message: 'Could not load the uptime overview.' });
  });

  it('client view: availability, state and plain incidents only', async () => {
    who = { user: { id: 'u1', role: 'CLIENT' }, clientIds: ['c1'] };
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    const now = Date.now();
    db.overrides['uptimeDaily.findMany'] = async () => [{ date: new Date(now), checks: 720, okChecks: 719 }];
    db.overrides['uptimeIncident.findMany'] = async () => [
      { openedAt: new Date(now - 3600_000), closedAt: new Date(now - 3000_000), durationSec: 600, cause: 'http_5xx', lastError: 'server error (HTTP 503)' },
    ];
    // last probe now, first probe 24 h ago, 720 of the 721 expected probes (every 2 min) stored
    db.overrides['uptimeCheck.findFirst'] = async (a) => ({ at: a.orderBy.at === 'asc' ? new Date(now - 86_400_000) : new Date() });
    db.overrides['uptimeCheck.count'] = async () => 720;
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/uptime' });
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toEqual({ available: true, availability30: 99.86, monitoring: 'active', state: 'up', incidents: [{ startedAt: new Date(now - 3600_000).toISOString(), durationText: 'about 10 minutes' }] });
    expect(res.body).not.toMatch(/cause|lastError|http|503|errorClass|"ms"|header/i);

    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'other' });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/uptime' })).statusCode).toBe(404);
  });

  it('client view: sparse probes give no percentage, only "starting" (O-R3-4)', async () => {
    who = { user: { id: 'u1', role: 'CLIENT' }, clientIds: ['c1'] };
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    const now = Date.now();
    // e2e project C: 8 probes (4 ok) in the first minutes, then the prober went quiet for a day
    db.overrides['uptimeDaily.findMany'] = async () => [{ date: new Date(now), checks: 8, okChecks: 4 }];
    db.overrides['uptimeCheck.findFirst'] = async (a) => ({ at: a.orderBy.at === 'asc' ? new Date(now - 86_400_000) : new Date(now - 86_400_000 + 900_000) });
    db.overrides['uptimeCheck.count'] = async () => 8;
    const body = (await app.inject({ method: 'GET', url: '/api/client/projects/p1/uptime' })).json();
    expect(body).toMatchObject({ available: true, availability30: null, monitoring: 'starting', state: 'unknown' });
  });
});

// Every Prisma call made by the code under test must match the real schema (tests/helpers/prismaShape.js).
afterEach(() => expect(takeShapeViolations()).toEqual([]));

describe('O-R3B-6: client uptime with a single probe', () => {
  it('shows "starting", never "100% (30 days)"', async () => {
    who = { user: { id: 'u1', role: 'CLIENT' }, clientIds: ['c1'] };
    db.overrides['project.findUnique'] = async () => ({ id: 'p1', clientId: 'c1' });
    const now = Date.now();
    db.overrides['uptimeDaily.findMany'] = async () => [{ date: new Date(now), checks: 1, okChecks: 1 }];
    db.overrides['uptimeCheck.findFirst'] = async () => ({ at: new Date(now - 60_000) });
    db.overrides['uptimeCheck.count'] = async () => 1;
    const body = (await app.inject({ method: 'GET', url: '/api/client/projects/p1/uptime' })).json();
    expect(body).toMatchObject({ available: true, availability30: null, monitoring: 'starting', state: 'up' });
  });
});
