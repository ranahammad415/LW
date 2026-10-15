/** Review S1 + C2: PATCH /api/projects/:id cmsType / wpUrl rules for EmDash projects. */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, user: null }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'count') return 0;
          if (method === 'update') return { id: 'p1', ...args.data };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/ensureProjectAccess.js', () => ({ ensureProjectAccess: async () => true }));
vi.mock('../../../src/lib/wpSync.js', () => ({ syncProjectPages: vi.fn(async () => ({})) }));
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('../../../src/lib/siteAdapters/netGuard.js', async (orig) => ({
  ...(await orig()),
  validateSiteUrl: async (u) => (String(u).startsWith('https://') ? { ok: true, url: String(u).replace(/\/$/, '') } : { ok: false, message: 'The site URL must use https://' }),
}));

import { projectRoutes } from '../../../src/routes/projects.js';

const PID = '7d0c6c55-1111-4222-8333-944444444444';
let app;
const patch = (payload) => app.inject({ method: 'PATCH', url: `/api/projects/${PID}`, payload });

beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.decorate('verifyJwt', async (request) => {
    request.user = db.user;
  });
  app.decorate('requirePM', async () => {});
  app.decorate('requireOwner', async () => {});
  await app.register(projectRoutes, { prefix: '/api/projects' });
  await app.ready();
});
afterAll(async () => app.close());
beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  db.user = { id: 'owner-1', role: 'OWNER' };
});

const proj = (o = {}) => async () => ({ id: PID, name: 'P', projectType: 'SEO_CAMPAIGN', status: 'ACTIVE', cmsType: 'WORDPRESS', wpUrl: null, wpApiKey: null, client: {}, ...o });

describe('PATCH /api/projects/:id (CMS rules)', () => {
  it('S1: an EmDash project refuses a wpUrl change (domain change needs re-pairing)', async () => {
    db.overrides['project.findUnique'] = proj({ cmsType: 'EMDASH', wpUrl: 'https://site.example' });
    const r = await patch({ wpUrl: 'http://169.254.169.254' });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toBe('Domain change needs re-pairing; create a new pairing code');
    expect(db.calls.find((c) => c.key === 'project.update')).toBeUndefined();
  });

  it('S1: switching to EMDASH validates the site URL', async () => {
    db.overrides['project.findUnique'] = proj({ wpUrl: 'http://plain.example' });
    const r = await patch({ cmsType: 'EMDASH' });
    expect(r.statusCode).toBe(400);
    db.overrides['project.findUnique'] = proj({ wpUrl: 'https://good.example/' });
    const ok = await patch({ cmsType: 'EMDASH' });
    expect(ok.statusCode).toBe(200);
    expect(db.calls.find((c) => c.key === 'project.update').args.data).toMatchObject({ cmsType: 'EMDASH', wpUrl: 'https://good.example' });
  });

  it('C2: a project with WP data or an API key cannot switch CMS (409), in either direction', async () => {
    db.overrides['project.findUnique'] = proj({ wpApiKey: 'k' });
    expect((await patch({ cmsType: 'EMDASH' })).statusCode).toBe(409);
    db.overrides['project.findUnique'] = proj();
    db.overrides['wpContentReview.count'] = async () => 3;
    const r = await patch({ cmsType: 'EMDASH' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('CMS_SWITCH_BLOCKED');
    db.overrides['project.findUnique'] = proj({ cmsType: 'EMDASH' });
    db.overrides['wpContentReview.count'] = async () => 0;
    db.overrides['wpPage.count'] = async () => 1;
    expect((await patch({ cmsType: 'WORDPRESS' })).statusCode).toBe(409);
  });
});
