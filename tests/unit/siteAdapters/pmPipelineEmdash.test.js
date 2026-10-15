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
