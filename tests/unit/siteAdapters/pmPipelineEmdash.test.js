/**
 * PM pipeline routes dispatch by Project.cmsType (plan O3): EmDash projects go through the
 * signed adapter, Publish answers 403 PUBLISH_NOT_ALLOWED with the admin edit URL; WordPress
 * projects keep calling wp-json/lwa/v1 exactly as before.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const db = vi.hoisted(() => ({ calls: [], overrides: {}, user: null }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'upsert' || method === 'update' || method === 'create') return { id: 'row-1' };
          return null;
        };
      },
    });
  const prisma = new Proxy(
    { $transaction: async (ops) => Promise.all(ops), $executeRawUnsafe: async () => 0, $executeRaw: async () => 0, $queryRaw: async () => [] },
    { get: (t, n) => (n in t ? t[n] : model(String(n))) }
  );
  return { prisma };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
// OS → site calls go through netGuard.guardedFetch by default; route it to the test's fetch mock.
vi.mock('../../../src/lib/siteAdapters/netGuard.js', async (orig) => ({
  ...(await orig()),
  guardedFetch: (...args) => globalThis.fetch(...args),
}));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: vi.fn(async () => {}), reconcileProjectMapsSafe: vi.fn() }));

import { pmPipelineRoutes } from '../../../src/routes/pm/pipeline.js';
import { encryptCmsSecret, cmsAad } from '../../../src/lib/cmsKeyCrypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) =>
  JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));

const PID = '7d0c6c55-1111-4222-8333-944444444444';
const EDIT = 'https://oasispoolspas.com/_emdash/admin/content/pages/01JAB4M9ZQ7X3K2V8N5T6R1W0C';
let app;
const fetchMock = vi.fn();

beforeAll(async () => {
  process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
  vi.stubGlobal('fetch', fetchMock);
  app = Fastify();
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.decorate('verifyJwt', async (request) => {
    request.user = db.user;
  });
  app.decorate('requireOwner', async () => {});
  await app.register(pmPipelineRoutes, { prefix: '/api/pm' });
  await app.ready();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});
beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  db.user = { id: '3b0d9a1e-6c2f-4d8a-9e57-0f1a2b3c4d5e', role: 'OWNER', name: 'Agency Owner' };
  fetchMock.mockReset();
});

function emdashProject() {
  db.overrides['project.findUnique'] = async (args) =>
    args.select?.cmsSiteId
      ? { id: PID, name: 'Oasis', cmsType: 'EMDASH', wpUrl: 'https://oasispoolspas.com', cmsSiteId: 'site_9f3c2a7b41d0', cmsContractVersion: 1, cmsPairedAt: new Date() }
      : { wpUrl: 'https://oasispoolspas.com', wpApiKey: null, leadPmId: 'pm-1', cmsType: 'EMDASH', name: 'Oasis', clientId: 'c1' };
  db.overrides['cmsCredential.findUnique'] = async () => ({
    projectId: PID,
    keyId: 1,
    inboundKeyEnc: encryptCmsSecret('aosk1_fp_X5pa6uAaNxcPnJsvZkCaJQv4tX5T0j3UoZzndQLE', cmsAad(PID, 'inbound')),
    outboundKeyEnc: encryptCmsSecret('aosk1_O9FJkHcJu47W4g1qqob6gmxImoTv7uIB8dn3aHnBS3g', cmsAad(PID, 'outbound')),
  });
  db.overrides['wpContentReview.findUnique'] = async () => ({
    id: 'r1',
    cmsReviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X',
    cmsEditUrl: EDIT,
    status: 'client_approved',
    isPublished: false,
    cmsSeq: 2,
  });
}

describe('EmDash projects', () => {
  it('Publish → 403 PUBLISH_NOT_ALLOWED with the admin edit URL, and no call to the site', async () => {
    emdashProject();
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish` });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: 'PUBLISH_NOT_ALLOWED', message: 'Approved. Publish in the site admin.', editUrl: EDIT });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PM review → signed pipeline-review (OWNER = override:true) and the mirror is refreshed', async () => {
    emdashProject();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('review.response')), { status: 200 }));
    const r = await app.inject({
      method: 'POST',
      url: `/api/pm/pipeline/${PID}/42/review`,
      payload: { decision: 'approved', comment: 'Good to go' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oasispoolspas.com/_emdash/api/plugins/agency-os-bridge/pipeline-review');
    expect(init.headers['x-aos-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(init.headers['x-aos-idempotency-key']).toBeTruthy();
    expect(JSON.parse(init.body)).toMatchObject({ reviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X', decision: 'approved', override: true, actor: { kind: 'human', role: 'OWNER' } });
    // Mirror from the response: cmsMirrorSeq only, never cmsSeq (the event still notifies once).
    const mirror = db.calls.find((c) => c.key === 'wpContentReview.updateMany');
    expect(mirror.args.data.cmsSeq).toBeUndefined();
    expect(mirror.args.data.cmsMirrorSeq).toBe(ex('review.response').review.seq);
  });

  it('a PM who does not lead the project is refused before any site call', async () => {
    emdashProject();
    db.user = { id: 'pm-2', role: 'PM', name: 'Other PM' };
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/review`, payload: { decision: 'approved' } });
    expect(r.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a site 409 is passed through with its code', async () => {
    emdashProject();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('error.response')), { status: 409 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/change-type`, payload: { contentType: 'location_page' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // final 4xx: no retry
  });
});

describe('EmDash approve-for-client (v1.0.1 §8.2)', () => {
  it('a PM "request changes" after the client asked for changes gets an actionable 409', async () => {
    emdashProject();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('error.response')), { status: 409 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/review`, payload: { decision: 'changes_requested' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'INVALID_TRANSITION', message: expect.stringMatching(/use Approve/) });
  });
});

describe('WordPress projects are unchanged', () => {
  it('Publish still proxies to wp-json/lwa/v1/pipeline/:id/publish with the API key header', async () => {
    db.overrides['project.findUnique'] = async () => ({ wpUrl: 'https://wp.example/', wpApiKey: 'k-123', leadPmId: 'pm-1', name: 'WP', clientId: 'c1', cmsType: 'WORDPRESS' });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/7/publish` });
    expect(r.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://wp.example/wp-json/lwa/v1/pipeline/7/publish');
    expect(init.headers['X-LWA-API-Key']).toBe('k-123');
    expect(init.headers['User-Agent']).toBe('Localwaves-AgencyOS/1.0 (+https://localwaves; pipeline sync)');
  });

  it('PM review still sends as_admin + reviewer for OWNER', async () => {
    db.overrides['project.findUnique'] = async () => ({ wpUrl: 'https://wp.example', wpApiKey: 'k-123', leadPmId: 'pm-1', cmsType: 'WORDPRESS' });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/7/review`, payload: { decision: 'approved', comment: 'x' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://wp.example/wp-json/lwa/v1/pipeline/7/pm-review');
    expect(JSON.parse(init.body)).toEqual({ decision: 'approved', comment: 'x', as_admin: true, reviewer: 'Agency Owner' });
  });
});

describe('review C3: EmDash delete never leaks raw errors', () => {
  it('a DB failure inside the EmDash delete becomes a JSON 500', async () => {
    emdashProject();
    db.overrides['wpContentReview.findUnique'] = async () => {
      throw new Error('db exploded: secret detail');
    };
    const r = await app.inject({ method: 'DELETE', url: `/api/pm/pipeline/${PID}/42` });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ message: 'EmDash request failed' });
  });
});

describe('e2e issue 3: EmDash access equals the WP rule (no stricter, no looser)', () => {
  it.each(['WORDPRESS', 'EMDASH'])('%s: a PM who is not the project lead gets 403 on review and publish before any site call', async (cmsType) => {
    db.overrides['project.findUnique'] = async () => ({ wpUrl: 'https://s.example', wpApiKey: cmsType === 'WORDPRESS' ? 'k' : null, leadPmId: 'pm-lead', cmsType, name: 'P', clientId: 'c1' });
    db.user = { id: 'pm-other', role: 'PM', name: 'Other' };
    for (const url of [`/api/pm/pipeline/${PID}/42/review`, `/api/pm/pipeline/${PID}/42/publish`]) {
      const r = await app.inject({ method: 'POST', url, payload: { decision: 'approved' } });
      expect(r.statusCode).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('contract v1.0.5: Review in a pipeline-* response', () => {
  it('a response Review for another siteId is not mirrored', async () => {
    emdashProject();
    const base = db.overrides['project.findUnique'];
    db.overrides['project.findUnique'] = async (args) => (args.select?.cmsSiteId && !args.select?.name ? { cmsSiteId: 'site_9f3c2a7b41d0' } : base(args));
    const resp = ex('review.response');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...resp, review: { ...resp.review, siteId: 'site_other0001' } }), { status: 200 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/review`, payload: { decision: 'approved' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().pipeline).toBeNull();
    expect(db.calls.find((c) => c.key === 'wpContentReview.updateMany' || c.key === 'wpContentReview.upsert')).toBeUndefined();
  });
});

describe('contract v1.0.5: 409 SITE_MISMATCH', () => {
  it('maps to an actionable 409 and closes the OS row (history kept, no retry)', async () => {
    emdashProject();
    const body = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../fixtures/cms-contract/examples/error.response--site-mismatch.json'), 'utf8'));
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status: 409 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/review`, payload: { decision: 'approved' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'SITE_MISMATCH', message: expect.stringMatching(/previous site pairing/) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const upd = db.calls.find((c) => c.key === 'wpContentReview.update');
    expect(upd.args.data).toMatchObject({ status: 'cancelled', isPublished: true, lastEventType: 'pipeline_site_mismatch' });
    expect(db.calls.find((c) => c.key === 'wpContentReview.delete')).toBeUndefined();
    expect(db.calls.find((c) => c.key === 'wpContentReviewEvent.create').args.data.eventType).toBe('pipeline_site_mismatch');
  });
});

describe('v1.3.0 publish / schedule from the OS (§24)', () => {
  function withCaps(caps, status = 'client_approved') {
    emdashProject();
    const base = db.overrides['project.findUnique'];
    db.overrides['project.findUnique'] = async (args) => (args.select?.cmsCapabilities && !args.select?.cmsSiteId ? { cmsCapabilities: caps } : base(args));
    db.overrides['wpContentReview.findUnique'] = async () => ({
      id: 'r1', cmsReviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X', cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsEditUrl: EDIT, status, isPublished: false, cmsSeq: 2,
    });
  }
  const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body);
  const routeOf = () => fetchMock.mock.calls[0][0].split('/').pop();

  it('publishFromOs on: a client-approved review is published by a human OWNER/PM through pipeline-publish', async () => {
    withCaps({ publishFromOs: true });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('pipeline-publish.response')), { status: 200 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish` });
    expect(r.statusCode).toBe(200);
    expect(routeOf()).toBe('pipeline-publish');
    expect(sent()).toEqual({ reviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X', actor: { kind: 'human', osUserId: db.user.id, name: 'Agency Owner', role: 'OWNER' } });
    expect(fetchMock.mock.calls[0][1].headers['x-aos-idempotency-key']).toBeTruthy();
  });

  it('not client-approved: refused locally unless an OWNER overrides with a reason (≥ 20 chars); PMs cannot override', async () => {
    withCaps({ publishFromOs: true }, 'pending_client_review');
    const r1 = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish` });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().code).toBe('INVALID_TRANSITION');
    const r2 = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish`, payload: { override: true, overrideReason: 'too short' } });
    expect(r2.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('pipeline-publish.response')), { status: 200 }));
    const reason = 'Client approved by phone on 16 Oct, email to follow';
    const r3 = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish`, payload: { override: true, overrideReason: reason } });
    expect(r3.statusCode).toBe(200);
    expect(sent()).toMatchObject({ override: true, overrideReason: reason });
    fetchMock.mockReset();
    db.user = { id: 'pm-1', role: 'PM', name: 'Jane PM' };
    const r4 = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish`, payload: { override: true, overrideReason: reason } });
    expect(r4.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 PUBLISH_BLOCKED lists the failing gates; 403 PUBLISH_NOT_ALLOWED keeps the edit link', async () => {
    withCaps({ publishFromOs: true });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('error.response--publish-blocked')), { status: 409 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish` });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('PUBLISH_BLOCKED');
    expect(r.json().message).toMatch(/blocked by 2 rules/);
    expect(r.json().details.gates.map((g) => g.ruleId)).toEqual(['claims.placeholder', 'contract.title']);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not retried
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('error.response--publish-not-allowed')), { status: 403 }));
    const r2 = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/publish` });
    expect(r2.statusCode).toBe(403);
    expect(r2.json()).toMatchObject({ code: 'PUBLISH_NOT_ALLOWED' });
    expect(r2.json().editUrl || r2.json().details?.editUrl).toBeTruthy();
  });

  it('schedule (future, ≤ 365 days) and unschedule; scheduling needs scheduleFromOs', async () => {
    withCaps({ publishFromOs: true, scheduleFromOs: false });
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/schedule`, payload: { at } })).statusCode).toBe(403);
    withCaps({ publishFromOs: true, scheduleFromOs: true });
    expect((await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/schedule`, payload: { at: '2001-01-01T00:00:00Z' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/schedule`, payload: { at: new Date(Date.now() + 400 * 86_400_000).toISOString() } })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('review.response--scheduled')), { status: 200 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/schedule`, payload: { at } });
    expect(r.statusCode).toBe(200);
    expect(routeOf()).toBe('pipeline-schedule');
    expect(sent().at).toBe(at.replace(/\.\d{3}Z$/, 'Z'));
    fetchMock.mockReset();
    withCaps({ scheduleFromOs: true }, 'scheduled');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('review.response--ready')), { status: 200 }));
    const u = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/unschedule` });
    expect(u.statusCode).toBe(200);
    expect(routeOf()).toBe('pipeline-unschedule');
  });

  it('staff preview link: returned once, not stored; needs previewLinks', async () => {
    withCaps({ previewLinks: false });
    expect((await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/preview-link` })).statusCode).toBe(409);
    withCaps({ previewLinks: true });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ex('preview-link.response')), { status: 200 }));
    const r = await app.inject({ method: 'POST', url: `/api/pm/pipeline/${PID}/42/preview-link` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().url).toBe(ex('preview-link.response').url);
    expect(sent()).toMatchObject({ entryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', ttlSeconds: 3600 });
    const writes = db.calls.filter((c) => /\.(create|update|updateMany|upsert)$/.test(c.key));
    expect(JSON.stringify(writes)).not.toContain(ex('preview-link.response').url);
  });
});
