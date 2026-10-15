/**
 * EmDash adapter: signed OS → site calls against a mocked fetch that answers with the
 * contract example payloads (tests/fixtures/cms-contract/examples), plus the Review /
 * entry normalisers for both adapters (WordPress webhook vs EmDash Review → same shape).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  siteRequest,
  emdashRoutes,
  connectionFor,
  credentialToRings,
  normalizeReviewEvent,
  reviewToMirrorData,
  entryToPageData,
  publishNotAllowed,
  osActor,
  CmsBridgeError,
  emdashAdapter,
} from '../../../src/lib/siteAdapters/emdash.js';
import { normalizePipelineWebhook, wordpressAdapter } from '../../../src/lib/siteAdapters/wordpress.js';
import { getAdapter, cmsLabel } from '../../../src/lib/siteAdapters/index.js';
import { verifyRequest } from '../../../src/lib/siteAdapters/signing.js';
import { encryptCmsSecret, cmsAad } from '../../../src/lib/cmsKeyCrypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) =>
  JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));
const vectors = JSON.parse(
  readFileSync(path.join(here, '../../fixtures/cms-contract/vectors/signature-vectors.json'), 'utf8')
);
const K = vectors.keys;

const conn = {
  siteUrl: 'https://oasispoolspas.com',
  siteId: K.siteId,
  inbound: { current: { id: 1, secret: K.inbound1 }, prev: null },
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Mock site: verifies the signature with the inbound key ring, then answers via `handler`. */
function mockSite(handler, ring = { 1: K.inbound1 }) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const u = new URL(url);
    const seen = new Set();
    const v = await verifyRequest({
      method: init.method,
      path: u.pathname,
      body: init.body,
      headers: init.headers,
      resolveSecret: async (siteId, keyId) => (siteId === K.siteId ? ring[keyId] ?? null : undefined),
      nonceCache: { checkAndStore: async (k) => (seen.has(k) ? false : (seen.add(k), true)) },
    });
    const route = u.pathname.split('/').pop();
    const call = { route, url, init, verified: v, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (!v.ok) return jsonResponse({ ok: false, error: { code: v.code, message: v.message, retryable: false } }, v.status);
    return handler(call, calls.length);
  });
  return { fetchImpl, calls };
}

const noSleep = vi.fn(async () => {});

beforeAll(() => {
  process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
});

describe('siteRequest: signed POST to /_emdash/api/plugins/agency-os-bridge/<route>', () => {
  it('reads site-info with a valid signature, no idempotency key and the exact plugin path', async () => {
    const { fetchImpl, calls } = mockSite(() => jsonResponse(ex('site-info.response')));
    const res = await emdashRoutes.siteInfo(conn, { fetchImpl, sleep: noSleep });
    expect(res.siteId).toBe(K.siteId);
    expect(calls[0].url).toBe('https://oasispoolspas.com/_emdash/api/plugins/agency-os-bridge/site-info');
    expect(calls[0].verified.ok).toBe(true);
    expect(calls[0].init.headers['x-aos-idempotency-key']).toBeUndefined();
    expect(calls[0].init.body).toBe('{}');
  });

  it('keeps a path prefix and percent-encoding in the signed path', async () => {
    const { fetchImpl, calls } = mockSite(() => jsonResponse(ex('health.response')));
    await emdashRoutes.health({ ...conn, siteUrl: 'https://ex.com/staging%20site' }, { fetchImpl, sleep: noSleep });
    expect(new URL(calls[0].url).pathname).toBe('/staging%20site/_emdash/api/plugins/agency-os-bridge/health');
    expect(calls[0].verified.ok).toBe(true);
  });

  it('retries a 503 mutation with the SAME idempotency key and a fresh nonce', async () => {
    const { fetchImpl, calls } = mockSite((call, n) =>
      n === 1
        ? jsonResponse({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'busy', retryable: true } }, 503)
        : jsonResponse(ex('review.response'))
    );
    const res = await emdashRoutes.pipelineReview(
      conn,
      { reviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X', decision: 'approved', comment: 'ok', actor: osActor({ id: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM', role: 'PM' }) },
      { fetchImpl, sleep: noSleep }
    );
    expect(res.review.reviewId).toBe('01JAC7Q2HV5M8N3P4R6S9T0W1X');
    expect(calls).toHaveLength(2);
    const [a, b] = calls.map((c) => c.init.headers);
    expect(a['x-aos-idempotency-key']).toBeTruthy();
    expect(a['x-aos-idempotency-key']).toBe(b['x-aos-idempotency-key']);
    expect(a['x-aos-nonce']).not.toBe(b['x-aos-nonce']);
    expect(calls[0].body.actor).toEqual({ kind: 'human', osUserId: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM', role: 'PM' });
  });

  it('does not retry a final 409 and surfaces the contract error', async () => {
    const { fetchImpl, calls } = mockSite(() => jsonResponse(ex('error.response'), 409));
    await expect(
      emdashRoutes.pipelineSendToClient(conn, { reviewId: 'x1', actor: osActor({ id: 'u', name: 'n' }) }, { fetchImpl, sleep: noSleep })
    ).rejects.toMatchObject({ name: 'CmsBridgeError', status: 409, code: 'INVALID_TRANSITION', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('retries once with the previous inbound key on 401 UNKNOWN_KEY (site has not installed a rotation)', async () => {
    const ringConn = {
      ...conn,
      inbound: { current: { id: 2, secret: K.inbound2 }, prev: { id: 1, secret: K.inbound1, expiresAt: Date.now() + 1e6 } },
    };
    const { fetchImpl, calls } = mockSite(() => jsonResponse(ex('health.response')), { 1: K.inbound1 });
    const res = await emdashRoutes.health(ringConn, { fetchImpl, sleep: noSleep });
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.init.headers['x-aos-key-id'])).toEqual(['2', '1']);
  });

  it('turns network failures into a retryable UPSTREAM_UNAVAILABLE after the retry budget', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const sleep = vi.fn(async () => {});
    await expect(siteRequest(conn, 'health', {}, { fetchImpl, sleep, retryDelays: [1, 2] })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('treats a non-contract 4xx host error as INTERNAL and final (v1.0.1 §9)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'INVALID_PLUGIN_REQUEST', message: 'too big' } }, 413));
    await expect(siteRequest(conn, 'inventory', {}, { fetchImpl, sleep: noSleep })).rejects.toMatchObject({
      status: 413,
      code: 'INTERNAL',
      retryable: false,
      details: { nonContract: true, hostCode: 'INVALID_PLUGIN_REQUEST' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a non-contract 404 means the plugin is missing; a non-contract 502 is retried', async () => {
    const notFound = vi.fn(async () => new Response('Not Found', { status: 404 }));
    await expect(siteRequest(conn, 'health', {}, { fetchImpl: notFound, sleep: noSleep })).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { pluginMissing: true },
      message: expect.stringMatching(/plugin is missing or disabled/),
    });
    const flaky = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(siteRequest(conn, 'health', {}, { fetchImpl: flaky, sleep: noSleep, retryDelays: [1] })).rejects.toMatchObject({
      code: 'INTERNAL',
      retryable: true,
    });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('pages inventory and pipeline-list with the contract request shapes', async () => {
    const { fetchImpl, calls } = mockSite((call) =>
      jsonResponse(call.route === 'inventory' ? ex('inventory.response') : ex('pipeline-list.response'))
    );
    const inv = await emdashRoutes.inventory(conn, { cursor: null }, { fetchImpl, sleep: noSleep });
    const list = await emdashRoutes.pipelineList(conn, { status: 'active' }, { fetchImpl, sleep: noSleep });
    expect(inv.items[0].entryNo).toBe(118);
    expect(list.items[0].reviewNo).toBe(42);
    expect(calls[0].body).toEqual({ status: 'any', limit: 100, cursor: null });
    expect(calls[1].body).toEqual({ status: 'active', limit: 100 });
  });
});

describe('connection and gates', () => {
  const PID = 'p-emdash-1';
  const credential = () => ({
    projectId: PID,
    keyId: 1,
    inboundKeyEnc: encryptCmsSecret(K.inbound1, cmsAad(PID, 'inbound')),
    outboundKeyEnc: encryptCmsSecret(K.outbound1, cmsAad(PID, 'outbound')),
  });
  const project = { cmsType: 'EMDASH', wpUrl: 'https://oasispoolspas.com/', cmsSiteId: K.siteId, cmsContractVersion: 1 };

  it('builds a connection from an encrypted credential', () => {
    const c = connectionFor(project, credential());
    expect(c).toMatchObject({ siteUrl: 'https://oasispoolspas.com', siteId: K.siteId });
    expect(c.inbound.current).toEqual({ id: 1, secret: K.inbound1 });
  });

  it('refuses unpaired projects and unsupported contracts with one actionable message', () => {
    expect(() => connectionFor({ ...project, cmsSiteId: null }, null)).toThrow(/not paired/);
    expect(() => connectionFor({ ...project, cmsContractVersion: 2 }, credential())).toThrow(/contract v2.*supports v1/);
    expect(() => connectionFor({ ...project, cmsType: 'WORDPRESS' }, credential())).toThrow(CmsBridgeError);
  });

  it('drops an expired previous key from the ring', () => {
    const rings = credentialToRings(
      {
        ...credential(),
        keyId: 2,
        prevKeyId: 1,
        inboundKeyPrevEnc: encryptCmsSecret('p-in', cmsAad(PID, 'inbound')),
        outboundKeyPrevEnc: encryptCmsSecret('p-out', cmsAad(PID, 'outbound')),
        prevExpiresAt: new Date(Date.now() - 1000),
      },
      Date.now()
    );
    expect(rings.inbound.prev).toBeNull();
  });

  it('PUBLISH_NOT_ALLOWED matches the contract example', () => {
    const err = publishNotAllowed('https://oasispoolspas.com/_emdash/admin/content/pages/01JAB4M9ZQ7X3K2V8N5T6R1W0C');
    const example = ex('error.response--publish-not-allowed').error;
    expect({ code: err.code, message: err.message, retryable: err.retryable, details: err.details }).toEqual(example);
    expect(err.status).toBe(403);
  });

  it('adapter info: EmDash never publishes from the OS in Phase 1; WordPress does', () => {
    expect(emdashAdapter.info({ cmsCapabilities: { publishFromOs: true, rotateLinks: true } }).capabilities).toMatchObject({
      publishFromOs: false,
      rotateLinks: true,
    });
    expect(wordpressAdapter.info().capabilities.publishFromOs).toBe(true);
    expect(getAdapter({ cmsType: 'EMDASH' }).type).toBe('EMDASH');
    expect(getAdapter({}).type).toBe('WORDPRESS');
    expect(cmsLabel({ cmsType: 'EMDASH' })).toBe('EmDash');
  });
});

describe('Review → WpContentReview normalisation (both adapters)', () => {
  const events = ex('events.request').events;

  it('maps the EmDash Review onto the legacy columns with surrogate integers', () => {
    const ev = events[0];
    const n = normalizeReviewEvent(ev.review, { eventType: ev.type, seq: ev.seq, message: ev.message });
    expect(n).toMatchObject({
      source: 'EMDASH',
      wpPipelineId: 42,
      wpPostId: 118,
      eventType: 'pipeline_pm_approved',
      postTitle: 'Hot Tub Repair for Most Brands',
      postType: 'Page',
      contentType: 'service_page',
      parentWpPostId: 118,
      status: 'pm_approved',
      revisionNumber: 1,
      pmDecision: 'approved',
      pmComment: 'Good to go',
      submittedById: 'c9f0f895-fb98-4b91-a5b3-0e1d2c3b4a59',
      pmMemberId: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90',
      workerNote: 'Refreshed FAQ',
      cms: {
        reviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X',
        entryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C',
        revisionId: '01JAC6ZK3D4F5G6H7J8K9M0N1P',
        seq: 3,
        editUrl: 'https://oasispoolspas.com/_emdash/admin/content/pages/01JAB4M9ZQ7X3K2V8N5T6R1W0C',
      },
    });
    expect(n.wpUpdatedAt).toBeInstanceOf(Date);
    // v1.0.1: token-free link state travels with every Review.
    expect(n.cms.links).toEqual(ev.review.links);
  });

  it('produces the same keys as the WordPress webhook normaliser', () => {
    const wp = normalizePipelineWebhook({
      apiKey: 'k',
      pipelineId: 42,
      eventType: 'pipeline_pm_approved',
      postId: 118,
      postTitle: 'Hot Tub Repair for Most Brands',
      postType: 'Page',
      contentType: 'service_page',
      parentPostId: 118,
      status: 'pm_approved',
      revisionNumber: 1,
      pmDecision: 'approved',
      pmComment: 'Good to go',
      submittedBy: { memberId: 'c9f0f895-fb98-4b91-a5b3-0e1d2c3b4a59', name: 'Sam Worker' },
      pmAssigned: { memberId: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM' },
      workerNote: 'Refreshed FAQ',
      pmReviewedAt: '2026-10-15T11:59:58Z',
      createdAt: '2026-10-15T11:00:00Z',
      updatedAt: '2026-10-15T12:00:00Z',
    });
    const em = normalizeReviewEvent(events[0].review, { eventType: 'pipeline_pm_approved', seq: 3 });
    expect(Object.keys(wp).sort()).toEqual(Object.keys(em).sort());
    for (const k of ['wpPipelineId', 'wpPostId', 'eventType', 'postTitle', 'postType', 'contentType', 'parentWpPostId', 'status', 'revisionNumber', 'pmDecision', 'pmComment', 'submittedById', 'submittedByName', 'pmMemberId', 'pmMemberName', 'workerNote', 'pmReviewedAt']) {
      expect(em[k]).toEqual(wp[k]);
    }
    expect(wp.cms).toBeNull();
    expect(wp.source).toBe('WORDPRESS');
  });

  it('marks override publishes in the timeline message', () => {
    const r = { ...events[0].review, status: 'published' };
    const n = normalizeReviewEvent(r, { eventType: 'pipeline_published', seq: 9, override: true });
    expect(n.logMessage).toMatch(/before client approval/);
  });

  it('mirror data never advances cmsSeq and keeps stored preview URLs when the site sends null', () => {
    const list = ex('pipeline-list.response').items[0];
    const m = reviewToMirrorData({ ...list, pmPreviewUrl: null, clientPreviewUrl: null });
    expect(m.wpPipelineId).toBe(42);
    expect(m.data.cmsSeq).toBeUndefined();
    expect(m.data).not.toHaveProperty('pmPreviewUrl');
    expect(m.data).not.toHaveProperty('clientPreviewUrl');
    expect(m.data.cmsReviewId).toBe('01JAC7Q2HV5M8N3P4R6S9T0W1X');
    const ready = reviewToMirrorData(ex('review.response--ready').review);
    expect(ready.data.status).toBe('client_approved');
    expect(ready.data.isPublished).toBeUndefined();
  });

  it('maps an inventory entry to a WpPage row', () => {
    const entry = ex('inventory.response').items[0];
    const { wpPostId, data } = entryToPageData(entry, 'https://oasispoolspas.com/');
    expect(wpPostId).toBe(118);
    expect(data).toMatchObject({
      // v1.0.6: pending draft → the published state uses `live`; the draft title is kept separately.
      title: entry.live.title,
      cmsDraftTitle: entry.title,
      cmsHasPendingDraft: true,
      slug: 'hot-tub-repair',
      status: 'published',
      postType: 'page',
      url: 'https://oasispoolspas.com/spa-services/hot-tub-repair/',
      seoTitle: 'Hot Tub Repair in Waukesha & Milwaukee | Oasis Pool and Spa',
      contentHash: entry.live.contentHash,
      template: null,
      cmsEntryId: entry.entryId,
      cmsCollection: 'pages',
      cmsDraftRevisionId: entry.draftRevisionId,
      cmsLiveRevisionId: entry.liveRevisionId,
      cmsEditUrl: entry.editUrl,
    });
    expect(data.modifiedAt.toISOString()).toBe('2026-10-15T12:01:00.000Z');
  });
});

describe('idempotent replay signal (errata v1.0.1: body first, header fallback)', () => {
  it('reads the body flag, then the header', async () => {
    const { isIdempotentReplay } = await import('../../../src/lib/siteAdapters/emdash.js');
    const h = (v) => ({ headers: new Headers(v ? { 'x-aos-idempotent-replay': v } : {}) });
    expect(isIdempotentReplay(h(), { ok: true, idempotentReplay: true })).toBe(true);
    expect(isIdempotentReplay(h('true'), { ok: true })).toBe(true);
    expect(isIdempotentReplay(h(), { ok: true })).toBe(false);
    const fetchImpl = vi.fn(async () => jsonResponse(ex('review.response'), 200, { 'x-aos-idempotent-replay': 'true' }));
    const res = await siteRequest(conn, 'pipeline-cancel', { reviewId: 'r', actor: osActor({ id: 'u', name: 'n' }) }, { fetchImpl, sleep: noSleep });
    expect(res.idempotentReplay).toBe(true);
    expect(Object.keys(res)).not.toContain('idempotentReplay');
  });
});
