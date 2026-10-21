/**
 * Security platform routes: client view scoping and allow-list over HTTP (no non-client field ever leaves
 * /api/client/*), staff guards (roles, ensureProjectAccess, agents/tokens refused before any site call),
 * item notes, agency security settings. Prisma and the site are stubbed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ calls: [] }));

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
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/security/securitySync.js', async (orig) => ({
  ...(await orig()),
  pullSecurity: async () => {
    site.calls.push('pull');
    return { status: 'ok' };
  },
}));

import { pmSecurityRoutes } from '../../../src/routes/pm/security.js';
import { clientSecurityRoutes } from '../../../src/routes/client/security.js';
import { adminSecuritySettingsRoutes } from '../../../src/routes/admin/securitySettings.js';
import { requireOwner } from '../../../src/lib/requireOwner.js';

let app;
let who;
beforeAll(async () => {
  app = Fastify();
  app.decorate('verifyJwt', async (request) => {
    request.user = who.user;
    if (who.token) request.authMethod = 'apiToken';
  });
  app.decorate('requireOwner', requireOwner);
  app.decorate('requireClient', async (request) => {
    request.clientAccountIds = who.clientIds || [];
  });
  await app.register(pmSecurityRoutes, { prefix: '/api/pm' });
  await app.register(clientSecurityRoutes, { prefix: '/api/client' });
  await app.register(adminSecuritySettingsRoutes, { prefix: '/api/admin' });
  await app.ready();
});
afterAll(() => app.close());

const EMDASH = { id: 'p1', clientId: 'c1', leadPmId: 'pm1', cmsType: 'EMDASH', cmsCapabilities: { security: true, backups: true } };
const CHECK_ROWS = [
  { checkId: 'backup.primary_fresh', clientSummary: 'A backup is late.', state: 'warn', severity: 'critical', since: new Date('2026-11-03T08:00:00Z'), pmNote: 'On it', pmNoteEta: null },
];

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  site.calls = [];
  who = { user: { id: 'u1', role: 'CLIENT' }, clientIds: ['c1'] };
});

const FORBIDDEN = /"(id|checkId|score|evidence|remediation|summary|severity|versions?|siteUrl|host|destinationId|type|acknowledged|note|pmNote|catalogueVersion|refs|projectId)"/;

describe('client security route', () => {
  it('scoped to the caller: another client\'s project is 404', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...EMDASH, clientId: 'other' });
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/security' });
    expect(res.statusCode).toBe(404);
  });

  it('WordPress (no capability) → {available:false}, nothing else', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...EMDASH, cmsType: 'WORDPRESS', cmsCapabilities: {} });
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/security' });
    expect(res.json()).toEqual({ available: false });
  });

  it('never sends a non-client field (score, ids, evidence, versions, hosts, settings)', async () => {
    db.overrides['project.findUnique'] = async () => EMDASH;
    db.overrides['securitySiteStatus.findUnique'] = async () => ({ overallState: 'warn', score: 93, backups: { agency: { db: { lastOkAt: '2026-11-03T08:30:40Z' }, files: { lastOkAt: '2026-11-02T05:31:02Z', lastError: 'NETWORK' } }, client: [{ destinationId: 'dst_1', type: 'sftp', label: 'Office NAS', db: { lastOkAt: null } }] }, scansLastFullAt: new Date(), statusAt: new Date() });
    db.overrides['securityCheckState.findMany'] = async (a) => {
      // the query itself only selects client-safe columns
      // checkId only to leave disabled checks out (O-R2-4); it never reaches the response (FORBIDDEN below)
      expect(Object.keys(a.select).sort()).toEqual(['checkId', 'clientSummary', 'pmNote', 'pmNoteEta', 'severity', 'since', 'state']);
      return CHECK_ROWS;
    };
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/security' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toMatch(FORBIDDEN);
    expect(res.body).not.toMatch(/93|sftp|dst_1|NETWORK/);
    expect(res.json()).toMatchObject({ available: true, state: 'warn', items: [{ text: 'A backup is late.', agencyNote: 'On it' }] });
  });
});

describe('staff security routes', () => {
  it('TEAM_MEMBER / CLIENT are refused; a PM without access is refused', async () => {
    who = { user: { id: 'tm', role: 'TEAM_MEMBER' } };
    expect((await app.inject({ method: 'GET', url: '/api/pm/security/fleet' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/pm/security/projects/p1' })).statusCode).toBe(403);
    who = { user: { id: 'pm2', role: 'PM' } };
    db.overrides['project.findUnique'] = async () => EMDASH;
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: 'pmX', secondaryPmId: null });
    expect((await app.inject({ method: 'GET', url: '/api/pm/security/projects/p1' })).statusCode).toBe(403);
  });

  it('agents and API tokens never refresh, note, set, run or acknowledge (403 HUMAN_ONLY, no site call)', async () => {
    db.overrides['project.findUnique'] = async () => EMDASH;
    for (const w of [{ user: { id: 'o', role: 'OWNER', isAgent: true } }, { user: { id: 'o', role: 'OWNER' }, token: true }]) {
      who = w;
      for (const [method, url] of [
        ['POST', '/api/pm/security/projects/p1/refresh'],
        ['PUT', '/api/pm/security/projects/p1/notes/edge.hsts'],
        ['POST', '/api/pm/security/projects/p1/config'],
        ['POST', '/api/pm/security/projects/p1/run'],
        ['POST', '/api/pm/security/projects/p1/ack'],
        ['PATCH', '/api/admin/security-settings'],
      ]) {
        const res = await app.inject({ method, url, payload: {} });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('HUMAN_ONLY');
      }
    }
    expect(site.calls).toEqual([]);
  });

  it('OWNER refresh pulls; the lead PM writes an item note (≤ 1000, ETA date)', async () => {
    who = { user: { id: 'o', role: 'OWNER', name: 'Olivia' } };
    db.overrides['project.findUnique'] = async () => EMDASH;
    expect((await app.inject({ method: 'POST', url: '/api/pm/security/projects/p1/refresh' })).statusCode).toBe(200);
    expect(site.calls).toEqual(['pull']);
    who = { user: { id: 'pm1', role: 'PM', name: 'Pat' } };
    db.overrides['securityCheckState.findUnique'] = async () => ({ id: 'c1' });
    const res = await app.inject({ method: 'PUT', url: '/api/pm/security/projects/p1/notes/edge.hsts', payload: { note: 'Fixing the header', eta: '2026-11-05' } });
    expect(res.statusCode).toBe(200);
    expect(db.calls.find((c) => c.key === 'securityCheckState.update').args.data).toMatchObject({ pmNote: 'Fixing the header', pmNoteById: 'pm1' });
    expect((await app.inject({ method: 'PUT', url: '/api/pm/security/projects/p1/notes/edge.hsts', payload: { note: 'x'.repeat(1001) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/pm/security/projects/p1/notes/BAD', payload: { note: 'x' } })).statusCode).toBe(400);
  });

  it('config routes answer 409 NOT_IMPLEMENTED without capabilities.securityConfig (no site call)', async () => {
    who = { user: { id: 'o', role: 'OWNER' } };
    db.overrides['project.findUnique'] = async () => EMDASH;
    const res = await app.inject({ method: 'POST', url: '/api/pm/security/projects/p1/config', payload: { baseRev: 1, changes: [] } });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/pm/security/projects/p1/config' })).json()).toEqual({ available: false });
  });
});

describe('agency security settings', () => {
  it('OWNER only; on-call users must be active human OWNER/PM; retention 90–3650', async () => {
    who = { user: { id: 'pm', role: 'PM' } };
    expect((await app.inject({ method: 'GET', url: '/api/admin/security-settings' })).statusCode).toBe(403);
    who = { user: { id: 'o', role: 'OWNER' } };
    db.overrides['agencySetting.findFirst'] = async () => ({ id: 's1', securityOnCallUserIds: null, securityRetentionDays: 400 });
    db.overrides['user.findMany'] = async (a) => (a.where.id ? [{ id: 'u1' }] : [{ id: 'u1', name: 'U', role: 'PM' }]);
    let res = await app.inject({ method: 'PATCH', url: '/api/admin/security-settings', payload: { onCallUserIds: ['u1', 'agent1'] } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'PATCH', url: '/api/admin/security-settings', payload: { retentionDays: 30 } });
    expect(res.statusCode).toBe(400);
    db.overrides['agencySetting.update'] = async (a) => ({ id: 's1', ...a.data });
    res = await app.inject({ method: 'PATCH', url: '/api/admin/security-settings', payload: { onCallUserIds: ['u1'], retentionDays: 400 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ onCallUserIds: ['u1'], retentionDays: 400, slackConfigured: false });
    expect(res.body).not.toMatch(/hooks\.slack/);
  });
});
