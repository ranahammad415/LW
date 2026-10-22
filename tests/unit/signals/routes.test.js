/**
 * Signals routes over HTTP: staff guards (roles, ensureProjectAccess; API tokens and agent accounts refused with 403
 * HUMAN_ONLY before any site call), signals-config-set (baseRev + idempotency key, 409 CONFLICT_REV replaces the
 * mirror and asks to redo), visitor erasure input checks, client scoping and the WordPress "available: false".
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { takeShapeViolations } from '../../helpers/prismaShape.js';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../../src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('./fakePrisma.js');
  return { prisma: createFakePrisma() };
});
const site = vi.hoisted(() => ({ handler: null, calls: [] }));
vi.mock('../../../src/lib/cmsStore.js', async (orig) => ({
  ...(await orig()),
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://oasispoolspas.com' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const o = await orig();
  const call = (route) => async (_c, body, opts) => {
    site.calls.push({ route, body, opts });
    return site.handler(route, body, opts);
  };
  return {
    ...o,
    emdashRoutes: {
      ...o.emdashRoutes,
      signalsConfigSet: call('signals-config-set'),
      signalsErase: call('signals-erase'),
      signalsSummary: call('signals-summary'),
      signalsConfigGet: (c, opts) => call('signals-config-get')(c, {}, opts),
    },
  };
});

import { prisma } from '../../../src/lib/prisma.js';
import { pmSignalsRoutes } from '../../../src/routes/pm/signals.js';
import { clientSignalsRoutes } from '../../../src/routes/client/signals.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));
const rows = (name) => prisma._rows(name);

let app;
let who;
beforeAll(async () => {
  app = Fastify();
  app.decorate('verifyJwt', async (request) => {
    request.user = who.user;
    if (who.token) request.authMethod = 'apiToken';
  });
  app.decorate('requireClient', async (request) => {
    request.clientAccountIds = who.clientIds || [];
  });
  await app.register(pmSignalsRoutes, { prefix: '/api/pm' });
  await app.register(clientSignalsRoutes, { prefix: '/api/client' });
  await app.ready();
});
afterAll(() => app.close());

const OWNER = { id: '0f1e2d3c-4b5a-4968-8776-655443322110', name: 'Sam Owner', role: 'OWNER' };
const P = '/api/pm/signals/projects/p1';

beforeEach(() => {
  prisma._reset();
  site.calls = [];
  site.handler = async () => ({ ok: true });
  who = { user: OWNER };
  rows('project').push({ id: 'p1', clientId: 'c1', leadPmId: 'pm1', cmsType: 'EMDASH', cmsCapabilities: { signals: true }, cmsRepairNeededAt: null, wpUrl: 'https://oasispoolspas.com' });
  rows('signalConfigMirror').push({ id: 'm1', projectId: 'p1', rev: 4, config: ex('signals-config-get.response').config, buffer: null, stale: false, fetchedAt: new Date() });
});

describe('staff guards', () => {
  it('TEAM_MEMBER and CLIENT are refused', async () => {
    for (const role of ['TEAM_MEMBER', 'CONTRACTOR', 'CLIENT']) {
      who = { user: { id: 'x', role } };
      expect((await app.inject({ method: 'GET', url: `${P}/sessions` })).statusCode).toBe(403);
    }
  });

  it('API tokens never read or write (403 HUMAN_ONLY); agent accounts may read but never write; no site call', async () => {
    who = { user: OWNER, token: true };
    for (const [method, url] of [['GET', `${P}/sessions`], ['GET', `${P}/config`], ['POST', `${P}/config`], ['POST', `${P}/erase`], ['POST', `${P}/reclassify`]]) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('HUMAN_ONLY');
    }
    who = { user: { ...OWNER, isAgent: true } };
    expect((await app.inject({ method: 'GET', url: `${P}/sessions` })).statusCode).toBe(200);
    for (const url of [`${P}/config`, `${P}/erase`, `${P}/reclassify`, `${P}/quality/refresh`]) {
      const res = await app.inject({ method: 'POST', url, payload: { baseRev: 4, changes: { enabled: true } } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('HUMAN_ONLY');
    }
    expect(site.calls).toHaveLength(0);
  });

  it('reclassify is OWNER only', async () => {
    who = { user: { id: 'pm1', role: 'PM' } };
    rows('clientAccount').push({ id: 'c1', leadPmId: 'pm1', secondaryPmId: null });
    expect((await app.inject({ method: 'POST', url: `${P}/reclassify` })).statusCode).toBe(403);
  });
});

describe('signals-config-set from the OS', () => {
  it('sends baseRev, the dotted changes and the person as actor with the caller\'s idempotency key; mirrors the answer', async () => {
    site.handler = async (route) => (route === 'signals-config-set' ? ex('signals-config-set.response') : {});
    const res = await app.inject({ method: 'POST', url: `${P}/config`, headers: { 'idempotency-key': 'abcdef0123456789' }, payload: { baseRev: 4, changes: { events: { engagement: false }, sampling: { pageview: 0.5 }, bufferDays: 14 } } });
    expect(res.statusCode).toBe(200);
    expect(site.calls[0]).toMatchObject({ route: 'signals-config-set', body: { baseRev: 4, changes: { events: { engagement: false }, sampling: { pageview: 0.5 }, bufferDays: 14 }, actor: { kind: 'human', osUserId: OWNER.id, role: 'OWNER' } }, opts: { idempotencyKey: 'abcdef0123456789' } });
    expect(res.json()).toMatchObject({ applied: ['events.engagement', 'sampling.pageview', 'bufferDays'], config: { rev: 5, bufferDays: 14 }, managedFromOs: true });
    expect(rows('signalConfigMirror')[0].rev).toBe(5);
  });

  it('409 CONFLICT_REV: the mirror is replaced with details.config and the person is asked to redo', async () => {
    const conflict = ex('error.response--signals-config-conflict').error;
    site.handler = async () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: conflict.message, details: conflict.details });
    };
    const res = await app.inject({ method: 'POST', url: `${P}/config`, payload: { baseRev: 4, changes: { enabled: false } } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CONFLICT_REV', details: { currentRev: 5, config: { rev: 5 } } });
    expect(res.json().message).toMatch(/redo your change/);
    expect(rows('signalConfigMirror')[0].rev).toBe(5);
  });

  it('refuses invalid values before any site call', async () => {
    for (const payload of [{ changes: { enabled: true } }, { baseRev: 4, changes: { sampling: { pageview: 0.01 } } }, { baseRev: 4, changes: { bufferDays: 31 } }, { baseRev: 4, changes: {} }]) {
      const res = await app.inject({ method: 'POST', url: `${P}/config`, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(site.calls).toHaveLength(0);
  });
});

describe('erasure and exports', () => {
  it('erase needs a visitor id and a reason', async () => {
    expect((await app.inject({ method: 'POST', url: `${P}/erase`, payload: { visitorId: 'bob@example.com', reason: 'subject_request' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/erase`, payload: { visitorId: 'v_01JB2R1S3T5V7X9Z1B3D5F7H9K', reason: 'because' } })).statusCode).toBe(400);
    site.handler = async () => ({ ok: true, rows: 0, alreadyGone: true });
    const ok = await app.inject({ method: 'POST', url: `${P}/erase`, payload: { visitorId: 'v_01JB2R1S3T5V7X9Z1B3D5F7H9K', reason: 'subject_request' } });
    expect(ok.json()).toMatchObject({ erased: true, site: 'done' });
  });

  it('staff CSV is text/csv, no-store', async () => {
    const res = await app.inject({ method: 'GET', url: `${P}/export.csv?grain=day` });
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

describe('client route', () => {
  it('scoped to the caller: another client\'s project is 404; WordPress gets {available:false}', async () => {
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['other'] };
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/signals' })).statusCode).toBe(404);
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c1'] };
    rows('project')[0].cmsType = 'WORDPRESS';
    rows('project')[0].cmsCapabilities = {};
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/signals' });
    expect(res.json()).toEqual({ available: false });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/signals/export.csv' })).statusCode).toBe(404);
  });

  it('an EmDash project with the capability gets the allow-list view', async () => {
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c1'] };
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/signals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, notes: { aiMode: expect.stringMatching(/AI Mode/) } });
    expect(res.body).not.toMatch(/"city"|visitorId|sessionId|payload/);
  });
});

// Every Prisma call made by the code under test must match the real schema (tests/helpers/prismaShape.js).
afterEach(() => expect(takeShapeViolations()).toEqual([]));
