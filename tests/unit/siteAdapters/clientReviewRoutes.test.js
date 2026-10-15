/**
 * v1.1.0 client review routes: client portal scoping (caller's client only, VIEWER blocked), EmDash/capability
 * gates, local status/round checks, site errors (CONFLICT_REV mirrors the current Review, NOT_IMPLEMENTED → fallback,
 * SUGGESTION_LIMIT message), OWNER acting for the client. Site calls and the store are stubbed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ clientReview: null, bodies: [] }));
const store = vi.hoisted(() => ({ mirrored: [], stored: [] }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'updateMany') return { count: 1 };
          if (method === 'update') return { id: 'x' };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/cmsStore.js', () => ({
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } }),
  mirrorEmdashReview: async (_p, review) => {
    store.mirrored.push(review);
    return { id: 'row-1' };
  },
  closeForeignReview: async () => true,
  storeEmdashSuggestions: async (_p, list) => {
    store.stored.push(list);
    return Array.isArray(list) ? list.length : 0;
  },
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    emdashRoutes: {
      ...orig.emdashRoutes,
      pipelineClientReview: async (_conn, body) => {
        site.bodies.push(body);
        return site.clientReview(body);
      },
      entryGetFields: async () => ({ ok: true, entry: { title: 'T', entryId: '01SECRET', editUrl: 'https://s.example/_emdash/admin/x', blocks: [{ key: 'k1', type: 'faq', fields: { q: 'Why?' } }] } }),
    },
  };
});

import { clientContentReviewsEmdashRoutes } from '../../../src/routes/client/contentReviewsEmdash.js';
import { requireClientWriter } from '../../../src/lib/requireClient.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));

let app;
let who;
beforeAll(async () => {
  app = Fastify();
  app.decorate('verifyJwt', async (request) => {
    request.user = who.user;
  });
  app.decorate('requireClient', async (request) => {
    request.clientAccountIds = who.clientIds;
    request.clientUserRoles = who.clientIds.map((clientId) => ({ clientId, role: who.clientRole }));
  });
  app.decorate('requireClientWriter', requireClientWriter);
  await app.register(clientContentReviewsEmdashRoutes, { prefix: '/api/client' });
  await app.ready();
});
afterAll(() => app.close());

const PROJECT = { id: 'p1', clientId: 'c1', cmsType: 'EMDASH', cmsCapabilities: { clientReviewFromOs: true }, cmsRepairNeededAt: null };
const ROW = { id: 'r1', wpPipelineId: 42, cmsReviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X', cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', status: 'pending_client_review', isPublished: false, revisionNumber: 1 };

beforeEach(() => {
  db.calls = [];
  site.bodies = [];
  store.mirrored = [];
  store.stored = [];
  who = { user: { id: '2c624232-cdd2-4f4a-9e8b-1d2c3b4a5f60', name: 'Client Owner', role: 'CLIENT' }, clientIds: ['c1'], clientRole: 'MANAGER' };
  db.overrides = {
    'project.findUnique': async () => PROJECT,
    'wpContentReview.findFirst': async () => ROW,
    'wpContentReview.findUnique': async () => ({ status: 'changes_requested_by_client', clientDecision: 'changes_publish', revisionNumber: 1 }),
  };
  const resp = ex('pipeline-client-review.response');
  site.clientReview = async () => resp;
});

const decide = (payload, url = '/api/client/projects/p1/pipeline/r1/decision') => app.inject({ method: 'POST', url, payload });

describe('client portal decision', () => {
  it('sends a CLIENT decision with suggestions, mirrors the Review and stores the suggestions', async () => {
    const res = await decide({
      decision: 'changes_publish',
      comment: 'Two small fixes',
      expectedRound: 1,
      suggestions: [{ field: 'seo.description', quote: 'across Waukesha', proposedText: 'in Waukesha' }],
    });
    expect(res.statusCode).toBe(200);
    expect(site.bodies[0]).toMatchObject({
      reviewId: ROW.cmsReviewId,
      expectedRound: 1,
      decision: 'changes_publish',
      actor: { kind: 'human', role: 'CLIENT', name: 'Client Owner' },
      suggestions: [{ target: { field: 'seo.description' }, quote: 'across Waukesha', proposedText: 'in Waukesha', note: null }],
    });
    expect(site.bodies[0]).not.toHaveProperty('onBehalfOf');
    expect(site.bodies[0]).not.toHaveProperty('expectedRev');
    expect(store.mirrored).toHaveLength(1);
    expect(store.stored[0]).toHaveLength(ex('pipeline-client-review.response').suggestions.length);
  });

  it('is scoped to the caller\'s client and blocked for VIEWER users', async () => {
    who.clientIds = ['other'];
    expect((await decide({ decision: 'approved' })).statusCode).toBe(404);
    who.clientIds = ['c1'];
    who.clientRole = 'VIEWER';
    expect((await decide({ decision: 'approved' })).statusCode).toBe(403);
    expect(site.bodies).toHaveLength(0);
  });

  it('OWNER (X-Client-Id) acts for the client with onBehalfOf', async () => {
    who.user = { id: '3b0d9a1e-6c2f-4d8a-9e57-0f1a2b3c4d5e', name: 'Agency Owner', role: 'OWNER' };
    expect((await decide({ decision: 'approved' })).statusCode).toBe(200);
    expect(site.bodies[0]).toMatchObject({ actor: { role: 'OWNER' }, onBehalfOf: { role: 'CLIENT', clientAccountId: 'c1' } });
  });

  it('refuses WordPress projects, missing capability and stale rounds without calling the site', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, cmsType: 'WORDPRESS' });
    expect((await decide({ decision: 'approved' })).statusCode).toBe(400);
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, cmsCapabilities: {} });
    const noCap = await decide({ decision: 'approved' });
    expect(noCap.statusCode).toBe(409);
    expect(noCap.json()).toMatchObject({ code: 'CLIENT_REVIEW_UNAVAILABLE', fallback: 'review-link' });
    db.overrides['project.findUnique'] = async () => PROJECT;
    const stale = await decide({ decision: 'approved', expectedRound: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('CONFLICT_REV');
    db.overrides['wpContentReview.findFirst'] = async () => ({ ...ROW, status: 'client_approved' });
    expect((await decide({ decision: 'approved' })).json().code).toBe('INVALID_TRANSITION');
    expect(site.bodies).toHaveLength(0);
  });

  it('site CONFLICT_REV mirrors the current Review; NOT_IMPLEMENTED falls back; SUGGESTION_LIMIT is actionable', async () => {
    const conflict = ex('error.response--client-review-conflict').error;
    site.clientReview = async () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: conflict.message, details: conflict.details });
    };
    const r1 = await decide({ decision: 'approved' });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().message).toMatch(/updated since you opened it/);
    expect(store.mirrored[0]).toEqual(conflict.details.review);

    site.clientReview = async () => {
      throw new CmsBridgeError({ status: 501, code: 'NOT_IMPLEMENTED', message: 'nope' });
    };
    const r2 = await decide({ decision: 'approved' });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ code: 'NOT_IMPLEMENTED', fallback: 'review-link' });
    // e2e P2 O5: the fallback is remembered until the next heartbeat rewrites the capabilities.
    const capUpd = db.calls.find((c) => c.key === 'project.update');
    expect(capUpd.args.data.cmsCapabilities).toMatchObject({ clientReviewFromOs: false });

    site.clientReview = async () => {
      throw new CmsBridgeError({ status: 422, code: 'SUGGESTION_LIMIT', message: 'too many' });
    };
    const r3 = await decide({ decision: 'changes_requested', suggestions: [{ field: 'title', quote: 'a', proposedText: 'b' }] });
    expect(r3.statusCode).toBe(422);
    expect(r3.json().message).toMatch(/maximum number of suggestions \(200\)/);
  });

  it('validation errors never reach the site', async () => {
    const r = await decide({ decision: 'changes_requested' });
    expect(r.statusCode).toBe(400);
    expect(site.bodies).toHaveLength(0);
  });
});

describe('client portal content view', () => {
  it('returns text only (no entry id, edit URL or block keys) for a client-visible review', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/pipeline/r1/content' });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(res.json().content.blocks[0]).toEqual({ type: 'faq', fields: { q: 'Why?' } });
    for (const secret of ['01SECRET', '_emdash/admin', '"k1"']) expect(text).not.toContain(secret);
    db.overrides['wpContentReview.findFirst'] = async () => ({ ...ROW, status: 'pending_pm_review' });
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/pipeline/r1/content' })).statusCode).toBe(404);
  });
});
