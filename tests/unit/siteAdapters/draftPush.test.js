/**
 * v1.2 draft push + media import (contract §22, §23): body building against the contract examples, access rules,
 * push outcomes (created, conflict, lock, local validation), idempotency-key reuse, media checks and dedupe,
 * the AI writer helpers, image sniffing, the team roster and osRequest confirmation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ upsert: null, media: null, info: null, layout: null, bodies: [], opts: [] }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'row-1', ...(args?.data || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/cmsStore.js', () => ({
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } }),
  mirrorEmdashReview: vi.fn(async () => ({ id: 'rev-row' })),
  listPms: async () => [{ memberId: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM' }],
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    emdashRoutes: {
      ...orig.emdashRoutes,
      siteInfo: async () => site.info,
      draftUpsert: async (_c, body, opts) => {
        site.bodies.push(body);
        site.opts.push(opts);
        return site.upsert(body, opts);
      },
      entryGetLayout: async (_c, entryId, variant) => {
        site.bodies.push({ entryId, variant });
        return site.layout(entryId, variant);
      },
      mediaImport: async (_c, body, opts) => {
        site.bodies.push(body);
        site.opts.push(opts);
        return site.media(body, opts);
      },
    },
  };
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildDraftUpsertBody,
  pushContextFrom,
  canWriteDraft,
  pushDraft,
  importImage,
  fetchImageFromUrl,
  checkDraftBody,
  parseAiDraft,
  aiDraftPrompt,
  clearSiteInfoCache,
  createDraftFromEntry,
  defaultBylines,
  actorFor,
  hasHtmlTag,
  draftEditMarkers,
  PUSH_CLAIM_STALE_MS,
  draftAccess,
  parentFromPath,
  changedBy,
  siteWarning,
  storedDraftState,
  pushErrorMessage,
} from '../../../src/lib/cmsDrafts.js';
import { CmsBridgeError } from '../../../src/lib/siteAdapters/emdash.js';
import { probeImage } from '../../../src/lib/imageProbe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const calls = (key) => db.calls.filter((c) => c.key === key);

const JANE = { id: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM', role: 'PM' };
const OWNER = { id: '3b0d9a1e-6c2f-4d8a-9e57-0f1a2b3c4d5e', name: 'Agency Owner', role: 'OWNER' };
const PROJECT = { id: 'p1', name: 'Oasis', clientId: 'c1', leadPmId: JANE.id, cmsType: 'EMDASH', cmsCapabilities: { draftPushFromOs: true, mediaImport: true }, cmsRepairNeededAt: null, cmsSiteId: 'site_9f3c2a7b41d0' };

function pngBytes(w = 800, h = 600, size = 64) {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

beforeEach(() => {
  db.calls = [];
  site.bodies = [];
  site.opts = [];
  site.info = ex('site-info.response');
  clearSiteInfoCache();
  db.overrides = { 'project.findUnique': async () => PROJECT };
});

describe('draft-upsert body (§22.2, §23)', () => {
  const ctxFor = (user) => pushContextFrom(ex('site-info.response'), user, PROJECT);

  it('create, exact slug, parent, layout, SEO: matches the create-exact example', () => {
    const want = ex('draft-upsert.request--create-exact');
    const draft = {
      collection: 'pages', title: want.title, slug: want.target.slug, parent: want.target.parent, contentKind: 'layout', layout: want.layout,
      seoTitle: want.seo?.title, seoDescription: want.seo?.description, excerpt: want.excerpt ?? null,
    };
    const ctx = ctxFor(JANE);
    const body = buildDraftUpsertBody(draft, { user: JANE, ctx, collectionInfo: ctx.collections.find((c) => c.name === 'pages'), slugPolicy: 'exact' });
    expect(body.target).toEqual(want.target);
    expect(body.slugPolicy).toBe('exact');
    expect(body.layout).toEqual(want.layout);
    expect(body).not.toHaveProperty('baseRev');
    expect(body).not.toHaveProperty('bylines'); // pages have no bylines
    expect(body.actor).toMatchObject({ kind: 'human', osUserId: JANE.id, role: 'PM' });
    expect(checkDraftBody(ex('site-info.response'), body, 'pages').ok).toBe(true);
  });

  it('AI-written post: agent actor with the triggering osUserId, team byline only (matches the agent example)', () => {
    const want = ex('draft-upsert.request--agent');
    const ctx = ctxFor(JANE);
    const draft = { collection: 'posts', title: want.title, slug: want.target.slug, contentKind: 'markdown', markdown: want.body.markdown, taxonomies: want.taxonomies, bylines: ['jane-pm'], aiGenerated: true };
    const body = buildDraftUpsertBody(draft, { user: JANE, ctx, collectionInfo: ctx.collections.find((c) => c.name === 'posts'), slugPolicy: 'exact', reviewAfter: want.reviewAfter });
    expect(body.actor).toMatchObject({ kind: 'agent', osUserId: JANE.id, name: 'Nova writer (for Jane PM)' });
    expect(body.bylines).toEqual(['oasis-team']);
    expect(body.body).toEqual(want.body);
    expect(body.reviewAfter).toEqual(want.reviewAfter);
    expect(checkDraftBody(ex('site-info.response'), body, 'posts').ok).toBe(true);
  });

  it('human post defaults to the user\'s own mapped byline; update carries baseRev and never slug/parent unless asked', () => {
    const ctx = ctxFor(JANE);
    expect(defaultBylines(ctx, actorFor(JANE, {}))).toEqual(['jane-pm']);
    expect(defaultBylines(pushContextFrom(ex('site-info.response'), OWNER, PROJECT), actorFor(OWNER, {}))).toEqual(['oasis-team']);
    const upd = buildDraftUpsertBody(
      { collection: 'pages', title: 'T', slug: 'new-slug', parent: 'spa-services', contentKind: 'layout', layout: [], cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: 'v3' },
      { user: JANE, ctx, collectionInfo: ctx.collections[0], slugPolicy: 'exact' }
    );
    expect(upd).toMatchObject({ target: { entryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C' }, baseRev: 'v3' });
    expect(upd).not.toHaveProperty('slug');
    expect(upd).not.toHaveProperty('slugPolicy');
    const moved = buildDraftUpsertBody({ collection: 'pages', title: 'T', slug: 'new-slug', contentKind: 'layout', layout: [], cmsEntryId: 'E', cmsRev: 'v3' }, { user: JANE, ctx, collectionInfo: ctx.collections[0], changeUrl: true, baseRev: 'v4' });
    expect(moved).toMatchObject({ slug: 'new-slug', baseRev: 'v4' });
  });

  it('never HTML in markdown; size and block limits', () => {
    const si = ex('site-info.response');
    const ctx = ctxFor(JANE);
    const body = buildDraftUpsertBody({ collection: 'posts', title: 'T', slug: 'a-b', contentKind: 'markdown', markdown: 'Hi <script>x</script>' }, { user: JANE, ctx, collectionInfo: ctx.collections[1], slugPolicy: 'exact' });
    expect(checkDraftBody(si, body, 'posts').errors.map((e) => e.path)).toContain('$.body.markdown');
  });
});

describe('who may write (OWNER, lead PM, assigned team member/contractor; never clients)', () => {
  it('roles', async () => {
    expect(await canWriteDraft({ id: 'c', role: 'CLIENT' }, PROJECT, {})).toBe(false);
    expect(await canWriteDraft(OWNER, PROJECT, {})).toBe(true);
    expect(await canWriteDraft(JANE, PROJECT, {})).toBe(true);
    expect(await canWriteDraft({ id: 'other-pm', role: 'PM' }, PROJECT, {})).toBe(false);
    db.overrides['contentMapNode.findFirst'] = async () => ({ assigneeId: 'tm1', taskId: null });
    expect(await canWriteDraft({ id: 'tm1', role: 'TEAM_MEMBER' }, PROJECT, { contentMapNodeId: 'n1' })).toBe(true);
    expect(await canWriteDraft({ id: 'tm2', role: 'TEAM_MEMBER' }, PROJECT, { contentMapNodeId: 'n1' })).toBe(false);
    db.overrides['task.count'] = async () => 1;
    expect(await canWriteDraft({ id: 'ct1', role: 'CONTRACTOR' }, PROJECT, { taskId: 't1' })).toBe(true);
  });
});

describe('pushDraft', () => {
  const DRAFT = {
    id: 'd1', projectId: 'p1', contentMapNodeId: 'n1', taskId: null, collection: 'pages', title: 'Hot Tub Heater Repair', slug: 'hot-tub-heater-repair', parent: 'spa-services',
    contentKind: 'layout', layout: ex('draft-upsert.request--create-exact').layout, markdown: null, excerpt: null, seoTitle: null, seoDescription: null, bylines: null, taxonomies: null,
    aiGenerated: false, cmsEntryId: null, cmsRev: null,
  };

  it('creates the entry, stores rev/entry/edit URL, records the push with its idempotency key, mirrors the Review', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => DRAFT;
    site.upsert = async () => ({ ...ex('draft-upsert.response--created-exact'), review: ex('review.response').review });
    const out = await pushDraft({ draftId: 'd1', user: JANE, opts: { reviewAfter: { note: 'please review' } } });
    expect(out.result).toMatchObject({ ok: true, created: true, review: true });
    expect(site.bodies[0]).toMatchObject({ slugPolicy: 'exact', reviewAfter: { pm: { memberId: JANE.id, name: 'Jane PM' }, note: 'please review' } });
    expect(site.opts[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const upd = calls('cmsDraft.update').at(-1).args.data;
    expect(upd).toMatchObject({ cmsEntryId: '01JAF1ENTRY000000000000001', cmsEntryNo: 132, cmsRev: 'v1', lastPushStatus: 'ok' });
    expect(calls('cmsDraftPush.create')[0].args.data).toMatchObject({ route: 'draft-upsert', actorKind: 'human', idempotencyKey: site.opts[0].idempotencyKey });
    expect(calls('contentMapNode.updateMany')[0].args).toMatchObject({ where: { id: 'n1', lifecycle: 'PLANNED' }, data: { lifecycle: 'IN_PIPELINE' } });
  });

  it('CONFLICT_REV is recorded with the current entry (no auto-merge, no retry); ENTRY_LOCKED shows who/until', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...DRAFT, cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: 'v1', lastPushStatus: 'ok', cmsEditedAt: new Date() });
    const conflict = ex('error.response--conflict-rev').error;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: conflict.message, details: conflict.details });
    };
    const out = await pushDraft({ draftId: 'd1', user: JANE });
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toMatchObject({ code: 'CONFLICT_REV', details: { rev: conflict.details.rev, entry: { title: conflict.details.entry.title } } });
    expect(calls('cmsDraft.update').at(-1).args.data.lastPushStatus).toBe('conflict');
    expect(site.bodies).toHaveLength(1);

    const locked = ex('error.response--entry-locked').error;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 409, code: 'ENTRY_LOCKED', message: locked.message, details: locked.details, retryable: false });
    };
    const out2 = await pushDraft({ draftId: 'd1', user: JANE });
    expect(out2.result.error.message).toMatch(/being edited by Site editor until/);
    expect(calls('cmsDraft.update').at(-1).args.data.lastPushStatus).toBe('locked');
  });

  it('local pre-check failures never reach the site; updates need a known rev', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...DRAFT, parent: 'spa-repair' });
    await expect(pushDraft({ draftId: 'd1', user: JANE })).rejects.toMatchObject({ code: 'VALIDATION', details: { errors: [{ code: 'PARENT_NOT_FOUND' }] } });
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...DRAFT, cmsEntryId: 'E', cmsRev: null });
    await expect(pushDraft({ draftId: 'd1', user: JANE })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(site.bodies).toHaveLength(0);
    db.overrides['cmsDraft.findUnique'] = async () => DRAFT;
    await expect(pushDraft({ draftId: 'd1', user: { id: 'x', role: 'CLIENT' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an unknown outcome (timeout) on the same body reuses the idempotency key, so the site replays instead of creating twice', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => DRAFT;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'timeout', retryable: true });
    };
    const first = await pushDraft({ draftId: 'd1', user: JANE });
    expect(first.result.retryable).toBe(true);
    const key = site.opts[0].idempotencyKey;
    const bodySha = calls('cmsDraftPush.create')[0].args.data.summary.bodySha;
    db.overrides['cmsDraftPush.findFirst'] = async () => ({ id: 'push-1', status: 'unknown', idempotencyKey: key, summary: { bodySha }, createdAt: new Date() });
    site.upsert = async () => ({ ...ex('draft-upsert.response--created-exact'), idempotentReplay: true });
    await pushDraft({ draftId: 'd1', user: JANE });
    expect(site.opts[1].idempotencyKey).toBe(key);
    expect(calls('cmsDraftPush.create')).toHaveLength(1);
  });
});

describe('media (direct upload only; ≤ 1 MiB; no re-encoding; sha256 dedupe)', () => {
  it('sniffs the real type and size', () => {
    expect(probeImage(pngBytes(800, 600))).toEqual({ contentType: 'image/png', width: 800, height: 600 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
    expect(probeImage(jpeg)).toMatchObject({ contentType: 'image/jpeg', width: 800, height: 600 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(1199, 24, 3);
    webp.writeUIntLE(799, 27, 3);
    expect(probeImage(webp)).toEqual({ contentType: 'image/webp', width: 1200, height: 800 });
    expect(probeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('uploads once, stores the ref, and reuses it by sha256 without calling the site again', async () => {
    site.media = async (body) => ({ ok: true, items: [{ index: 0, status: 'imported', mediaId: '01JAF0MEDIA000000000000009', ref: { id: '01JAF0MEDIA000000000000009', src: '/_emdash/api/media/file/x.png', alt: body.items[0].alt }, sha256: body.items[0].sha256, contentType: 'image/png', bytes: 64, width: 800, height: 600 }] });
    const out = await importImage({ projectId: 'p1', user: JANE, buffer: pngBytes(), filename: 'heater.png', alt: 'Heater element' });
    expect(out).toMatchObject({ status: 'imported', ref: { id: '01JAF0MEDIA000000000000009', alt: 'Heater element' } });
    expect(site.bodies[0].items[0]).toMatchObject({ alt: 'Heater element', upload: { contentType: 'image/png', filename: 'heater.png' } });
    expect(site.bodies[0].items[0]).not.toHaveProperty('url');
    expect(calls('cmsMediaRef.upsert')).toHaveLength(1);
    db.overrides['cmsMediaRef.findUnique'] = async () => ({ ref: { id: 'M', src: '/x.png', alt: 'old' } });
    const again = await importImage({ projectId: 'p1', user: JANE, buffer: pngBytes(), filename: 'heater.png', alt: 'New alt' });
    expect(again).toMatchObject({ status: 'reused', ref: { id: 'M', alt: 'New alt' } });
    expect(site.bodies).toHaveLength(1);
  });

  it('refuses unsupported types, oversize files and dimensions, and failed site items', async () => {
    const gif = Buffer.alloc(16);
    gif.write('GIF89a', 0, 'ascii');
    await expect(importImage({ projectId: 'p1', user: JANE, buffer: gif, filename: 'a.gif', alt: 'x' })).rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' });
    await expect(importImage({ projectId: 'p1', user: JANE, buffer: pngBytes(800, 600, 1_100_000), filename: 'big.png', alt: 'x' })).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    await expect(importImage({ projectId: 'p1', user: JANE, buffer: pngBytes(5000, 600), filename: 'wide.png', alt: 'x' })).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    await expect(importImage({ projectId: 'p1', user: { id: 'c', role: 'CLIENT' }, buffer: pngBytes(), alt: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    site.media = async () => ({ ok: true, items: [{ index: 0, status: 'failed', error: { code: 'MEDIA_INVALID', message: 'corrupt', retryable: false } }] });
    await expect(importImage({ projectId: 'p1', user: JANE, buffer: pngBytes(), alt: 'x' })).rejects.toMatchObject({ code: 'MEDIA_INVALID' });
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, cmsCapabilities: {} });
    site.info = { ...ex('site-info.response'), capabilities: { ...ex('site-info.response').capabilities, mediaImport: false } };
    clearSiteInfoCache();
    await expect(importImage({ projectId: 'p1', user: JANE, buffer: pngBytes(), alt: 'x' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('URLs are fetched by the OS through the guard: https only, no redirects, size cap', async () => {
    await expect(fetchImageFromUrl('http://x.example/a.png', { maxBytes: 10 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(fetchImageFromUrl('https://u:p@x.example/a.png', { maxBytes: 10 })).rejects.toMatchObject({ code: 'VALIDATION' });
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    await expect(fetchImageFromUrl('https://x.example/a.png', { maxBytes: 10, fetchImpl: redirect })).rejects.toThrow(/redirects/);
    const big = async () => new Response(Buffer.alloc(20), { status: 200 });
    await expect(fetchImageFromUrl('https://x.example/a.png', { maxBytes: 10, fetchImpl: big })).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    // review MEDIUM-5: the transport cap follows the site's maxBytes; a transport refusal is MEDIA_TOO_LARGE too
    const caps = [];
    const capped = async (_u, init) => {
      caps.push(init.maxBytes);
      throw Object.assign(new Error('Response too large'), { code: 'RESPONSE_TOO_LARGE' });
    };
    await expect(fetchImageFromUrl('https://x.example/a.png', { maxBytes: 2_000_000, fetchImpl: capped })).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(caps).toEqual([2_000_001]);
    const ok = async () => new Response(pngBytes(), { status: 200 });
    expect((await fetchImageFromUrl('https://x.example/img/a%20b.png', { maxBytes: 1000, fetchImpl: ok })).filename).toBe('a b.png');
  });

  it('private IP-literal URLs are refused before any fetch (Node skips the guarded lookup for them)', async () => {
    const prevEnv = process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV;
    delete process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV;
    try {
      let fetched = 0;
      const never = async () => {
        fetched += 1;
        return new Response(pngBytes(), { status: 200 });
      };
      for (const url of ['https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://169.254.169.254/a.png', 'https://10.0.0.5/a.png', 'https://0x7f000001/a.png', 'https://2130706433/a.png']) {
        await expect(fetchImageFromUrl(url, { maxBytes: 1000, fetchImpl: never })).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      expect(fetched).toBe(0);
      expect((await fetchImageFromUrl('https://93.184.216.34/a.png', { maxBytes: 1000, fetchImpl: never })).filename).toBe('a.png');
    } finally {
      if (prevEnv !== undefined) process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = prevEnv;
    }
  });
});

describe('AI writer helpers (AiUsageLog caps; markdown or approved blocks, never HTML)', () => {
  it('markdown answers are stripped of tags; layout answers are checked with checkLayout', () => {
    expect(parseAiDraft({ contentKind: 'markdown' }, '## Hi\n<b>bold</b> text', {}).markdown).toBe('## Hi\nbold text');
    const schemas = ex('site-info.response').framework.blockSchemas;
    const ok = parseAiDraft({ contentKind: 'layout' }, JSON.stringify({ layout: [{ _type: 'page_hero', heading: 'H' }] }), schemas);
    expect(ok.errors).toEqual([]);
    expect(ok.layout[0]._version).toBe(schemas.page_hero.version);
    const badBlock = parseAiDraft({ contentKind: 'layout' }, '{"layout":[{"_type":"html_block","html":"<p>"}]}', schemas);
    expect(badBlock.errors[0].code).toBe('UNKNOWN_BLOCK');
    expect(parseAiDraft({ contentKind: 'layout' }, 'not json', schemas).layout).toBeNull();
    const p = aiDraftPrompt({ title: 'T', contentKind: 'layout' }, { blockSchemas: schemas, instructions: 'friendly', node: { keywords: [{ keyword: 'hot tub repair' }] } });
    expect(p.json).toBe(true);
    expect(p.user).toContain('hot tub repair');
    expect(p.system).toMatch(/never HTML/);
  });
});

describe('v1.5.1 edit an existing site page (entry-get includeLayout, layoutRead)', () => {
  const caps = { ...PROJECT, cmsCapabilities: { ...PROJECT.cmsCapabilities, layoutRead: true } };
  beforeEach(() => {
    db.overrides['project.findUnique'] = async () => caps;
    db.overrides['wpPage.findFirst'] = async () => ({ id: 'wp1', cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C' });
    db.overrides['contentMapNode.findFirst'] = async () => ({ id: 'n1', taskId: null });
  });

  it('round trip: the draft built from the read pushes back exactly what the contract helper produces', async () => {
    const res = ex('entry-get.response--layout');
    site.layout = () => res;
    const d = await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE });
    const created = calls('cmsDraft.create')[0].args.data;
    expect(created).toMatchObject({ cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: res.editable.rev, contentKind: 'layout', contentMapNodeId: 'n1' });
    const { draftFromEntryGet } = await import('../../../src/lib/siteAdapters/push.js');
    const want = draftFromEntryGet(res, { actor: { kind: 'human', osUserId: JANE.id, name: 'Jane PM', role: 'PM' } }).draft;
    const ctx = pushContextFrom(ex('site-info.response'), JANE, caps);
    const body = buildDraftUpsertBody({ ...d, layout: created.layout, excerpt: created.excerpt, seoTitle: null, seoDescription: null }, { user: JANE, ctx, collectionInfo: ctx.collections[0], slugPolicy: 'exact' });
    expect(body.target).toEqual(want.target);
    expect(body.layout).toEqual(want.layout);
    expect(body.baseRev).toBe(want.baseRev);
    expect(body.title).toBe(want.title);
    // stored media references ({ id, ... } without src) pass the ported pre-check
    expect(checkDraftBody(ex('site-info.response'), body, 'pages').errors.filter((e) => e.path.includes('image'))).toEqual([]);
  });

  it('posts come back as Portable Text and push back as portableText', async () => {
    const res = ex('entry-get.response--layout-post');
    site.layout = () => res;
    await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE });
    const created = calls('cmsDraft.create')[0].args.data;
    expect(created.contentKind).toBe('portableText');
    const ctx = pushContextFrom(ex('site-info.response'), JANE, caps);
    const body = buildDraftUpsertBody({ ...created, cmsEntryId: 'E', cmsRev: res.editable.rev }, { user: JANE, ctx, collectionInfo: ctx.collections[1], slugPolicy: 'exact' });
    expect(body.portableText).toEqual(res.editable.portableText);
    expect(body).not.toHaveProperty('layout');
  });

  it('too large → edit in the site admin; no capability → refused; live + pending draft → warning; invalid content → paths', async () => {
    site.layout = () => ex('entry-get.response--layout-omitted');
    await expect(createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    db.overrides['project.findUnique'] = async () => PROJECT;
    await expect(createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    db.overrides['project.findUnique'] = async () => caps;
    const res = ex('entry-get.response--layout');
    site.layout = () => ({ ...res, editable: { ...res.editable, variant: 'live', valid: false, errors: [{ path: '$.layout[0].lead', message: 'unknown field' }] } });
    await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE, variant: 'live' });
    const created = calls('cmsDraft.create').at(-1).args.data;
    expect(created.lastPushWarnings[0].code).toBe('REPLACES_PENDING_DRAFT');
    expect(created.lastPushError).toMatchObject({ code: 'SCHEMA_INVALID', details: { errors: [{ path: '$.layout[0].lead' }] } });
    expect(site.bodies.at(-1)).toEqual({ entryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', variant: 'live' });
    await expect(createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: { id: 'c', role: 'CLIENT' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('review fixes: bylines on updates, push claim, markdown HTML, unpushed edits', () => {
  const caps = { ...PROJECT, cmsCapabilities: { ...PROJECT.cmsCapabilities, layoutRead: true } };
  const POST = { id: 'd2', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'posts', title: 'T', slug: 'a-b', parent: null, contentKind: 'markdown', markdown: 'Hi', layout: null, bylines: ['jane-pm'], taxonomies: null, aiGenerated: false };

  it('MEDIUM-4: an update sends bylines only when a person changed them; a create always does', () => {
    const ctx = pushContextFrom(ex('site-info.response'), JANE, PROJECT);
    const posts = ctx.collections.find((c) => c.name === 'posts');
    const upd = { ...POST, cmsEntryId: 'E', cmsRev: 'v2', bylines: ['someone-else'] };
    expect(buildDraftUpsertBody(upd, { user: JANE, ctx, collectionInfo: posts })).not.toHaveProperty('bylines');
    expect(buildDraftUpsertBody({ ...upd, aiGenerated: true }, { user: JANE, ctx, collectionInfo: posts })).not.toHaveProperty('bylines');
    expect(buildDraftUpsertBody({ ...upd, bylines: ['jane-pm'], bylinesEdited: true }, { user: JANE, ctx, collectionInfo: posts }).bylines).toEqual(['jane-pm']);
    expect(buildDraftUpsertBody({ ...POST, bylines: null }, { user: JANE, ctx, collectionInfo: posts, slugPolicy: 'exact' }).bylines).toEqual(['jane-pm']);
  });

  it('MEDIUM-4: edit markers count only real changes', () => {
    const now = new Date('2026-10-17T00:00:00Z');
    expect(draftEditMarkers({ bylines: ['a'], title: 'T' }, { bylines: ['a'], title: 'T' }, now)).toEqual({});
    expect(draftEditMarkers({ bylines: ['a'], title: 'T' }, { bylines: ['b'] }, now)).toEqual({ bylinesEdited: true, cmsEditedAt: now });
    expect(draftEditMarkers({ bylines: null, title: 'T' }, { title: 'U' }, now)).toEqual({ cmsEditedAt: now });
  });

  it('MEDIUM-4: a successful push clears the edit markers', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...POST, cmsEntryId: 'E', cmsRev: 'v2', bylinesEdited: true, cmsEditedAt: new Date() });
    site.upsert = async () => ({ ok: true, entryId: 'E', entryNo: 9, rev: 'v3', created: false });
    await pushDraft({ draftId: 'd2', user: JANE });
    expect(calls('cmsDraft.update').at(-1).args.data).toMatchObject({ lastPushStatus: 'ok', bylinesEdited: false, cmsEditedAt: null });
  });

  it('LOW-9: a push claims the draft (CAS) before the site call; a second concurrent push is refused; failures release it', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...POST, lastPushStatus: 'never' });
    db.overrides['cmsDraft.updateMany'] = async () => ({ count: 0 });
    await expect(pushDraft({ draftId: 'd2', user: JANE })).rejects.toMatchObject({ code: 'PUSH_IN_PROGRESS', status: 409 });
    expect(site.bodies).toHaveLength(0);
    const claim = calls('cmsDraft.updateMany')[0].args;
    expect(claim.data).toEqual({ lastPushStatus: 'pushing' });
    expect(claim.where).toEqual({ id: 'd2', lastPushStatus: 'never' }); // CAS on the status we read (e2e O18b)
    db.calls = [];
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...POST, lastPushStatus: 'pushing' });
    await expect(pushDraft({ draftId: 'd2', user: JANE })).rejects.toMatchObject({ code: 'PUSH_IN_PROGRESS' });
    const takeover = calls('cmsDraft.updateMany')[0].args.where;
    expect(takeover.lastPushStatus).toBe('pushing');
    expect(Date.now() - takeover.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(PUSH_CLAIM_STALE_MS - 1000);
    // claimed, then a local validation failure: the claim is released to the previous status
    db.calls = [];
    db.overrides['cmsDraft.updateMany'] = async () => ({ count: 1 });
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...POST, markdown: 'x <div class="a">y</div>', lastPushStatus: 'failed' });
    await expect(pushDraft({ draftId: 'd2', user: JANE })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(calls('cmsDraft.updateMany').map((c) => c.args)).toEqual([
      expect.objectContaining({ data: { lastPushStatus: 'pushing' } }),
      { where: { id: 'd2', lastPushStatus: 'pushing' }, data: { lastPushStatus: 'failed' } },
    ]);
    // the draft is re-read under the claim: an entry created by the push that just finished is updated, not re-created
    db.calls = [];
    let n = 0;
    db.overrides['cmsDraft.findUnique'] = async () => (n++ === 0 ? { ...POST, lastPushStatus: 'ok', cmsEditedAt: new Date() } : { ...POST, cmsEntryId: 'E', cmsRev: 'v1', lastPushStatus: 'pushing', cmsEditedAt: new Date() });
    site.upsert = async () => ({ ok: true, entryId: 'E', rev: 'v2' });
    await pushDraft({ draftId: 'd2', user: JANE });
    expect(site.bodies.at(-1).target).toEqual({ entryId: 'E' });
  });

  it('LOW-10: markdown HTML check counts real tags only', () => {
    for (const ok of ['a <b and c> d', 'see <https://example.com/a?b=1>', 'a < b > c', '<user@example.com>', '1 <i 2']) expect(hasHtmlTag(ok)).toBe(false);
    for (const tag of ['<b>x</b>', '<div class="a">', '<br>', '<br/>', 'x</p>', '<!-- c -->', '<img src=x>', '<script>x</script>']) expect(hasHtmlTag(tag)).toBe(true);
    const si = ex('site-info.response');
    const ctx = pushContextFrom(si, JANE, PROJECT);
    const body = buildDraftUpsertBody({ ...POST, markdown: 'Use <https://example.com> when a <b and c> d' }, { user: JANE, ctx, collectionInfo: ctx.collections[1], slugPolicy: 'exact' });
    expect(checkDraftBody(si, body, 'posts').errors.map((e) => e.path)).not.toContain('$.body.markdown');
  });

  it('LOW-10: reloading a page from the site never drops unpushed OS edits silently', async () => {
    db.overrides['project.findUnique'] = async () => caps;
    db.overrides['wpPage.findFirst'] = async () => ({ id: 'wp1', cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C' });
    db.overrides['contentMapNode.findFirst'] = async () => ({ id: 'n1', taskId: null });
    db.overrides['cmsDraft.findFirst'] = async () => ({ id: 'd9', cmsEditedAt: new Date(), updatedById: OWNER.id });
    db.overrides['user.findUnique'] = async () => ({ name: 'Agency Owner' });
    site.layout = () => ex('entry-get.response--layout');
    await expect(createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE })).rejects.toMatchObject({ code: 'UNPUSHED_EDITS', status: 409, message: expect.stringMatching(/^Agency Owner has unpushed edits/) });
    expect(site.bodies).toHaveLength(0);
    db.overrides['cmsDraft.findUnique'] = async () => ({ id: 'd9', title: 'kept' });
    expect(await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE, keep: true })).toEqual({ id: 'd9', title: 'kept' });
    expect(site.bodies).toHaveLength(0);
    await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE, overwrite: true });
    expect(calls('cmsDraft.update').at(-1).args).toMatchObject({ where: { id: 'd9' }, data: { bylinesEdited: false, cmsEditedAt: null } });
    // no unpushed edits: reload without asking
    db.overrides['cmsDraft.findFirst'] = async () => ({ id: 'd9', cmsEditedAt: null, updatedById: OWNER.id });
    await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE });
    expect(site.bodies.filter((b) => b.variant)).toHaveLength(2);
  });
});

describe('e2e O1: one draft-access helper (whoever may push may read; ensureProjectAccess unchanged)', () => {
  const TM = { id: 'tm1', name: 'Team', role: 'TEAM_MEMBER' };
  const DRAFT_ROW = { id: 'd1', projectId: 'p1', contentMapNodeId: 'n1', taskId: null };

  it('a node-only assignee (no task) reads and writes that node’s drafts, its push context and media; nothing else', async () => {
    db.overrides['task.count'] = async () => 0; // no task in the project → ensureProjectAccess false
    db.overrides['contentMapNode.findFirst'] = async (args) => (args.where.id === 'n1' ? { assigneeId: 'tm1', taskId: null } : { assigneeId: 'someone', taskId: null });
    db.overrides['contentMapNode.count'] = async (args) => (args.where.assigneeId === 'tm1' ? 1 : 0);
    expect(await draftAccess(TM, PROJECT, 'draft', DRAFT_ROW)).toEqual({ read: true, write: true });
    expect(await draftAccess(TM, PROJECT, 'draft', { ...DRAFT_ROW, contentMapNodeId: 'n2' })).toEqual({ read: false, write: false });
    expect(await draftAccess(TM, PROJECT, 'list', { contentMapNodeId: 'n1' })).toEqual({ read: true, write: true });
    expect((await draftAccess(TM, PROJECT, 'list', {})).read).toBe(false); // never the project's whole draft list
    expect(await draftAccess(TM, PROJECT, 'tools')).toEqual({ read: true, write: true });
    expect(await draftAccess({ id: 'tm2', role: 'TEAM_MEMBER' }, PROJECT, 'tools')).toEqual({ read: false, write: false });
    expect(await draftAccess({ id: 'c', role: 'CLIENT' }, PROJECT, 'tools')).toEqual({ read: false, write: false });
  });

  it('a PM who is not the lead PM may read (client PM) but never write or push; an unrelated PM gets nothing', async () => {
    const SECOND = { id: 'pm-2', name: 'Second PM', role: 'PM' };
    db.overrides['clientAccount.findUnique'] = async () => ({ leadPmId: JANE.id, secondaryPmId: 'pm-2' });
    expect(await draftAccess(SECOND, PROJECT, 'draft', DRAFT_ROW)).toEqual({ read: true, write: false });
    expect(await draftAccess({ id: 'pm-x', role: 'PM' }, PROJECT, 'draft', DRAFT_ROW)).toEqual({ read: false, write: false });
    expect(await draftAccess(JANE, PROJECT, 'draft', DRAFT_ROW)).toEqual({ read: true, write: true });
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...DRAFT_ROW, collection: 'pages', title: 'T', contentKind: 'layout', layout: [] });
    await expect(pushDraft({ draftId: 'd1', user: SECOND })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(site.bodies).toHaveLength(0);
    expect(calls('cmsDraft.updateMany')).toHaveLength(0); // refused before the push claim
  });
});

describe('e2e O3: a review request never costs the user their changes', () => {
  const UPD = { id: 'd3', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'T', slug: 's', parent: null, contentKind: 'layout', layout: [], cmsEntryId: 'E1', cmsRev: 'v1', lastPushStatus: 'ok' };

  it('an open review in the mirror: pushed without reviewAfter, with a warning', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    db.overrides['wpContentReview.findFirst'] = async () => ({ wpPipelineId: 7, status: 'pending_pm_review' });
    site.upsert = async () => ({ ok: true, entryId: 'E1', rev: 'v2' });
    const out = await pushDraft({ draftId: 'd3', user: JANE, opts: { reviewAfter: { note: 'x' } } });
    expect(site.bodies[0]).not.toHaveProperty('reviewAfter');
    expect(out.result.ok).toBe(true);
    expect(out.result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_ALREADY_OPEN' })]));
  });

  it('the site refuses the transition: the same changes are pushed once more without reviewAfter', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    db.overrides['wpContentReview.findFirst'] = async () => null;
    site.upsert = async (body) => {
      if (body.reviewAfter) throw new CmsBridgeError({ status: 409, code: 'INVALID_TRANSITION', message: 'already has an open review (pending_pm_review)' });
      return { ok: true, entryId: 'E1', rev: 'v2' };
    };
    const out = await pushDraft({ draftId: 'd3', user: JANE, opts: { reviewAfter: {} } });
    expect(site.bodies).toHaveLength(2);
    expect(site.bodies[0].reviewAfter).toBeTruthy();
    expect(site.bodies[1]).not.toHaveProperty('reviewAfter');
    expect(site.opts[0].idempotencyKey).not.toBe(site.opts[1].idempotencyKey);
    expect(out.result).toMatchObject({ ok: true });
    expect(out.result.warnings.map((w) => w.code)).toContain('REVIEW_ALREADY_OPEN');
    expect(calls('cmsDraft.update').at(-1).args.data.lastPushStatus).toBe('ok');
    // other refusals are not retried
    site.bodies = [];
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: 'changed' });
    };
    expect((await pushDraft({ draftId: 'd3', user: JANE, opts: { reviewAfter: {} } })).result.ok).toBe(false);
    expect(site.bodies).toHaveLength(1);
  });
});

describe('e2e O20: a push links its node to the entry page when the page row exists', () => {
  it('sets the node wpPageId (only when the node has none)', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ id: 'd5', projectId: 'p1', contentMapNodeId: 'n1', taskId: null, collection: 'pages', title: 'T', slug: 's', parent: null, contentKind: 'layout', layout: [], cmsEntryId: null, cmsRev: null, lastPushStatus: 'never' });
    db.overrides['wpPage.findFirst'] = async (args) => (args.where.cmsEntryId === 'E9' ? { id: 'wp-9' } : null);
    site.upsert = async () => ({ ok: true, entryId: 'E9', rev: 'v1', created: true, path: '/s/' });
    await pushDraft({ draftId: 'd5', user: JANE });
    const link = calls('contentMapNode.updateMany').find((c) => c.args.data.wpPageId);
    expect(link.args).toEqual({ where: { id: 'n1', wpPageId: null }, data: { wpPageId: 'wp-9' } });
  });
});

describe('e2e O18: an unchanged update is not sent to the site', () => {
  const ENTRY = { id: 'd7', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'T', slug: 's', parent: null, contentKind: 'layout', layout: [], cmsEntryId: 'E7', cmsRev: 'v3', cmsEditedAt: null };

  it('a page read from the site and not edited: no site call, status unchanged, UNCHANGED warning', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...ENTRY, lastPushStatus: 'never' });
    site.upsert = async () => ({ ok: true, entryId: 'E7', rev: 'v4' });
    const out = await pushDraft({ draftId: 'd7', user: JANE });
    expect(site.bodies).toHaveLength(0);
    expect(out.result).toMatchObject({ ok: true, unchanged: true });
    expect(out.result.warnings.map((w) => w.code)).toContain('UNCHANGED');
    expect(calls('cmsDraft.update').at(-1).args.data).toEqual({ lastPushStatus: 'never' });
  });

  it('same content as the last successful push: skipped; edited, review requested or "replace pending draft": sent', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...ENTRY, lastPushStatus: 'ok' });
    site.upsert = async () => ({ ok: true, entryId: 'E7', rev: 'v4' });
    // first push records the content hash
    db.overrides['cmsDraftPush.findFirst'] = async () => null;
    await pushDraft({ draftId: 'd7', user: JANE });
    expect(site.bodies).toHaveLength(1);
    const recorded = calls('cmsDraftPush.update').at(-1).args.data.summary.contentSha;
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    db.overrides['cmsDraftPush.findFirst'] = async (a) => (a.where.status === 'ok' ? { summary: { contentSha: recorded } } : null);
    expect((await pushDraft({ draftId: 'd7', user: JANE })).result.unchanged).toBe(true);
    expect(site.bodies).toHaveLength(1);
    // an edit since the last push
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...ENTRY, lastPushStatus: 'ok', cmsEditedAt: new Date() });
    await pushDraft({ draftId: 'd7', user: JANE });
    expect(site.bodies).toHaveLength(2);
    // a review request always goes
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...ENTRY, lastPushStatus: 'ok' });
    db.overrides['wpContentReview.findFirst'] = async () => null;
    await pushDraft({ draftId: 'd7', user: JANE, opts: { reviewAfter: {} } });
    expect(site.bodies).toHaveLength(3);
    // the live version read over a pending draft is meant to replace it
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...ENTRY, lastPushStatus: 'never', lastPushWarnings: [{ code: 'REPLACES_PENDING_DRAFT' }] });
    db.overrides['cmsDraftPush.findFirst'] = async () => null;
    await pushDraft({ draftId: 'd7', user: JANE });
    expect(site.bodies).toHaveLength(4);
  });
});

describe('e2e O19: a draft read from an invalid page', () => {
  const caps = { ...PROJECT, cmsCapabilities: { ...PROJECT.cmsCapabilities, layoutRead: true } };

  it('is "Not pushed" (never) with the read errors kept, and keeps its parent section from the path', async () => {
    db.overrides['project.findUnique'] = async () => caps;
    db.overrides['wpPage.findFirst'] = async () => ({ id: 'wp1', cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C' });
    db.overrides['contentMapNode.findFirst'] = async () => null;
    db.overrides['cmsDraft.findFirst'] = async () => null;
    const res = ex('entry-get.response--layout');
    site.layout = () => ({ ...res, editable: { ...res.editable, valid: false, errors: [{ path: '$.layout[0].lead', message: 'unknown field' }] } });
    await createDraftFromEntry({ projectId: 'p1', wpPageId: 'wp1', user: JANE });
    const created = calls('cmsDraft.create').at(-1).args.data;
    expect(created.lastPushStatus).toBe('never');
    expect(created.lastPushError).toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(created.parent).toBe('spa-services'); // /spa-services/hot-tub-repair/ and spa-services is a parent option
    expect(parentFromPath('/spa-services/hot-tub-repair/', ['None', 'spa-services'])).toBe('spa-services');
    expect(parentFromPath('/hot-tub-repair/', ['spa-services'])).toBeNull();
    expect(parentFromPath('/blog/x/', ['spa-services'])).toBeNull();
    // an unedited invalid read is never "skipped as unchanged": the push goes and the site reports the problem
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...created, id: 'd8', projectId: 'p1', layout: [] });
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 422, code: 'SCHEMA_INVALID', message: 'invalid' });
    };
    const out = await pushDraft({ draftId: 'd8', user: JANE });
    expect(out.result.unchanged).toBeUndefined();
    expect(site.bodies.filter((b) => b.target)).toHaveLength(1);
  });
});

describe('v1.5.4 §30.1: service role / scope refusals', () => {
  const UPD = { id: 'd9', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'T', slug: 's', parent: null, contentKind: 'layout', layout: [], cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: 'v1', lastPushStatus: 'ok', cmsEditedAt: new Date() };

  it('SERVICE_ROLE_INSUFFICIENT: actionable message, details kept, one call (not retried, no best-effort fallback)', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    const e = ex('error.response--service-role-insufficient').error;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 403, code: e.code, message: e.message, details: e.details, retryable: false });
    };
    const out = await pushDraft({ draftId: 'd9', user: JANE });
    expect(site.bodies).toHaveLength(1);
    expect(out.result.retryable).toBe(false);
    expect(out.result.error).toMatchObject({ code: 'SERVICE_ROLE_INSUFFICIENT', details: { requiredRole: 'editor', role: 'author', operation: 'update', collection: 'pages' } });
    expect(out.result.error.message).toBe("The site's service user is an Author; EmDash needs an Editor to edit pages made by someone else. Ask the site admin to raise its role (admin → Users). Nothing was written.");
    // the OS marks nothing about the token: no project / capability write
    expect(calls('project.update')).toHaveLength(0);
    expect(calls('project.updateMany')).toHaveLength(0);
  });

  it('SERVICE_TOKEN_UNAVAILABLE: reason "scope" names the missing permission; otherwise the best-effort path stays', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 503, code: 'SERVICE_TOKEN_UNAVAILABLE', message: 'scope', details: { reason: 'scope' }, retryable: false });
    };
    const out = await pushDraft({ draftId: 'd9', user: JANE });
    expect(out.result.error).toMatchObject({ code: 'SERVICE_TOKEN_UNAVAILABLE', details: { reason: 'scope' } });
    expect(out.result.error.message).toMatch(/missing a permission/); // no scope named: the full list
    // e2e O24: the scope the site names is the one asked for
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 503, code: 'SERVICE_TOKEN_UNAVAILABLE', message: 'scope', details: { reason: 'scope', scope: 'content:write' }, retryable: false });
    };
    const named = await pushDraft({ draftId: 'd9', user: JANE });
    expect(named.result.error.details).toMatchObject({ reason: 'scope', scope: 'content:write' });
    expect(named.result.error.message).toBe("The site's service token is missing the content:write permission. Ask the site admin to add it to the token. Nothing was written.");
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 503, code: 'SERVICE_TOKEN_UNAVAILABLE', message: 'refused', details: {}, retryable: false });
    };
    // An update never offers best effort (v1.5.7): only creates have a slug policy.
    const upd = (await pushDraft({ draftId: "d9", user: JANE })).result.error;
    expect(upd.message).toMatch(/cannot update this page/);
    expect(upd.details.bestEffortAllowed).toBe(false);
  });
});

describe('v1.5.4 §30.4: SLUG_TAKEN names the holder (also in the trash)', () => {
  const NEW = { id: 'd10', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'Hot Tub Heater Repair', slug: 'hot-tub-heater-repair', parent: null, contentKind: 'layout', layout: [], cmsEntryId: null, cmsRev: null, lastPushStatus: 'never' };
  const refuse = (details) => async () => {
    throw new CmsBridgeError({ status: 409, code: 'SLUG_TAKEN', message: 'taken', details, retryable: false });
  };

  it('a live holder we mirror: "open the existing page" link (site admin edit URL)', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => NEW;
    db.overrides['wpPage.findFirst'] = async (a) => (a.where.cmsEntryId === '01JAB4M9ZQ7X3K2V8N5T6R1W0C' ? { id: 'wp1', url: 'https://s.example/x/', cmsEditUrl: 'https://s.example/_emdash/admin/content/pages/01JAB' } : null);
    site.upsert = refuse({ existingEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', existingEntryTrashed: false, suggestedSlug: 'hot-tub-heater-repair-2' });
    const out = await pushDraft({ draftId: 'd10', user: JANE });
    expect(out.result.error.details).toMatchObject({ existingEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', existingEntryTrashed: false, existingWpPageId: 'wp1', existingEditUrl: 'https://s.example/_emdash/admin/content/pages/01JAB', suggestedSlug: 'hot-tub-heater-repair-2' });
    expect(out.result.error.message).toMatch(/Open that page instead/);
  });

  it('a trashed holder (contract example): restore-from-trash note, no open link', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => NEW;
    db.overrides['wpPage.findFirst'] = async () => ({ id: 'wp-trash', url: 'x', cmsEditUrl: 'y' });
    const e = ex('error.response--slug-taken-trashed').error;
    site.upsert = refuse(e.details);
    const out = await pushDraft({ draftId: 'd10', user: JANE });
    expect(out.result.error.details).toMatchObject({ existingEntryId: e.details.existingEntryId, existingEntryTrashed: true });
    expect(out.result.error.details).not.toHaveProperty('existingEditUrl');
    expect(out.result.error.message).toMatch(/in the site's trash\. Restore it/);
  });
});

describe('v1.5.4 §30.3: CONFLICT_REV.updatedBy (last saver, names only)', () => {
  it('keeps name / kind, marks OS pushes, drops site ids', async () => {
    const e = ex('error.response--conflict-rev').error;
    expect(changedBy(e.details.updatedBy)).toEqual({ name: 'Site editor', kind: 'human', viaOs: false });
    expect(changedBy({ kind: 'human', name: 'Jane PM', osUserId: 'u1', source: 'api' })).toEqual({ name: 'Jane PM', kind: 'human', viaOs: true });
    expect(changedBy(null)).toBeNull();
    db.overrides['cmsDraft.findUnique'] = async () => ({ id: 'd11', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'T', slug: 's', parent: null, contentKind: 'layout', layout: [], cmsEntryId: 'E', cmsRev: 'v1', lastPushStatus: 'ok', cmsEditedAt: new Date() });
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: e.message, details: e.details });
    };
    const out = await pushDraft({ draftId: 'd11', user: JANE });
    expect(out.result.error.details.updatedBy).toEqual({ name: 'Site editor', kind: 'human', viaOs: false });
    expect(JSON.stringify(out.result.error.details.updatedBy)).not.toContain('usr_7');
  });
});

describe('e2e O18b: the unchanged check uses the status from before the push claim', () => {
  it('a page read from the site and pushed without edits is not sent, although the re-read shows "pushing"', async () => {
    const READ = { id: 'd12', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'T', slug: 's', parent: null, contentKind: 'layout', layout: [], cmsEntryId: 'E12', cmsRev: 'v3', cmsEditedAt: null, lastPushError: null };
    let reads = 0;
    // like the database: the first read is before the claim, the re-read after it
    db.overrides['cmsDraft.findUnique'] = async () => (reads++ === 0 ? { ...READ, lastPushStatus: 'never' } : { ...READ, lastPushStatus: 'pushing' });
    site.upsert = async () => ({ ok: true, entryId: 'E12', rev: 'v4' });
    const out = await pushDraft({ draftId: 'd12', user: JANE });
    expect(site.bodies).toHaveLength(0);
    expect(out.result).toMatchObject({ ok: true, unchanged: true });
    expect(calls('cmsDraft.update').at(-1).args.data).toEqual({ lastPushStatus: 'never' });
  });
});

describe('e2e O26: push context flags follow the heartbeat, not the cached site-info', () => {
  it('a heartbeat that turned publishFromOs on (or off) wins over a stale cached site-info', () => {
    const cached = { ...ex('site-info.response'), capabilities: { ...ex('site-info.response').capabilities, publishFromOs: false, draftPushFromOs: true } };
    expect(pushContextFrom(cached, JANE, { ...PROJECT, cmsCapabilities: { draftPushFromOs: true, publishFromOs: true } }).capabilities.publishFromOs).toBe(true);
    const cachedOn = { ...cached, capabilities: { ...cached.capabilities, publishFromOs: true } };
    expect(pushContextFrom(cachedOn, JANE, { ...PROJECT, cmsCapabilities: { draftPushFromOs: false, publishFromOs: false } }).capabilities).toMatchObject({ publishFromOs: false, draftPushFromOs: false });
    // no stored flag yet (e.g. right after pairing): the site-info value is used
    expect(pushContextFrom(cachedOn, JANE, { ...PROJECT, cmsCapabilities: {} }).capabilities.publishFromOs).toBe(true);
  });
});

describe('v1.5.7 / v1.5.8: draftHash, hashBasis, CAS, SEO warnings, agent guard', () => {
  const UPD = { id: 'd7', projectId: 'p1', contentMapNodeId: null, taskId: null, collection: 'pages', title: 'Hot Tub Repair for Most Brands', slug: 'hot-tub-repair', parent: 'spa-services', contentKind: 'layout', layout: [], cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: 'v1', lastPushStatus: 'ok', cmsEditedAt: new Date() };

  it('stores rev / draftRevisionId / draftHash / hashBasis on the push row and forwards them in the result', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    const want = ex('draft-upsert.response--draft-hash');
    site.upsert = async () => want;
    const out = await pushDraft({ draftId: 'd7', user: JANE });
    expect(out.result).toMatchObject({
      ok: true,
      entryId: want.entryId,
      entryNo: want.entryNo,
      revision: want.revision,
      rev: want.revision,
      draftRevisionId: want.draftRevisionId,
      draftHash: want.draftHash,
      hashBasis: want.hashBasis,
    });
    const row = calls('cmsDraftPush.update').at(-1).args.data;
    expect(row).toMatchObject({ status: 'ok', rev: want.revision, draftRevisionId: want.draftRevisionId, draftHash: want.draftHash, hashBasis: want.hashBasis });
    expect(calls('cmsDraft.update').at(-1).args.data).toMatchObject({ cmsRev: want.revision, cmsDraftHash: want.draftHash });
    // SEO_LIVE_REFUSED gets the OS wording and keeps its fields
    const w = out.result.warnings.find((x) => x.code === 'SEO_LIVE_REFUSED');
    expect(w.fields).toEqual(['seo.title']);
    expect(w.message).toMatch(/This page is live .* SEO title .* not written\. Everything else was saved/);
  });

  it('storedDraftState: older sites (rev only), DRAFT_HASH_UNAVAILABLE (null hash → null basis), malformed hashes dropped', () => {
    expect(storedDraftState({ rev: 'r1' })).toEqual({ rev: 'r1', draftRevisionId: null, draftHash: null, hashBasis: null });
    expect(storedDraftState({ revision: 'r2', rev: 'r2', draftHash: null, hashBasis: null })).toMatchObject({ rev: 'r2', draftHash: null, hashBasis: null });
    expect(storedDraftState({ rev: 'r3', draftHash: 'v1:xyz', hashBasis: { a: 1 } })).toMatchObject({ draftHash: null, hashBasis: null });
  });

  it('warnings: SEO_FIELD_IGNORED (canonical), DRAFT_HASH_UNAVAILABLE, NON_ATOMIC_UPDATE have clear messages; unknown codes pass through', () => {
    expect(siteWarning({ code: 'SEO_FIELD_IGNORED', field: 'seo.canonical', message: 'x' }).message).toMatch(/canonical URL was not written/);
    expect(siteWarning({ code: 'SEO_FIELD_IGNORED', field: 'seo.image', message: 'x' }).message).toMatch(/SEO image cannot be set from Agency OS/);
    expect(siteWarning({ code: 'DRAFT_HASH_UNAVAILABLE', message: 'x' }).message).toMatch(/fingerprint/);
    expect(siteWarning({ code: 'NON_ATOMIC_UPDATE', message: 'x' }).message).toMatch(/conflict protection/);
    expect(siteWarning({ code: 'SOMETHING_NEW', message: 'as sent', path: '$.x' })).toEqual({ code: 'SOMETHING_NEW', path: '$.x', message: 'as sent' });
  });

  it('CAS conflict (EmDash CONFLICT → 409 CONFLICT_REV) is recorded as a conflict, never retried', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    const conflict = ex('error.response--conflict-rev').error;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: conflict.message, details: conflict.details });
    };
    const out = await pushDraft({ draftId: 'd7', user: JANE });
    expect(out.result.error.code).toBe('CONFLICT_REV');
    expect(site.bodies).toHaveLength(1);
  });

  it('503 SERVICE_TOKEN_UNAVAILABLE reason "cas": actionable message, no best effort, not retried', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => UPD;
    const e = ex('error.response--service-token-cas').error;
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 503, code: e.code, message: e.message, details: e.details, retryable: false });
    };
    const out = await pushDraft({ draftId: 'd7', user: JANE });
    expect(site.bodies).toHaveLength(1);
    expect(out.result.retryable).toBe(false);
    expect(out.result.error).toMatchObject({ code: 'SERVICE_TOKEN_UNAVAILABLE', details: { reason: 'cas', bestEffortAllowed: false } });
    expect(out.result.error.message).toMatch(/fix the service token/);
  });

  it('a create without a working token keeps the best-effort offer', async () => {
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...UPD, id: 'd8', cmsEntryId: null, cmsRev: null, lastPushStatus: 'never', layout: ex('draft-upsert.request--create-exact').layout });
    site.upsert = async () => {
      throw new CmsBridgeError({ status: 503, code: 'SERVICE_TOKEN_UNAVAILABLE', message: 'refused', details: {}, retryable: false });
    };
    const out = await pushDraft({ draftId: 'd8', user: JANE });
    expect(out.result.error.details.bestEffortAllowed).toBe(true);
    expect(out.result.error.message).toMatch(/best-effort URL/);
  });

  it('AGENT_NOT_ALLOWED (403): message, not retried; the host-level REST shape maps to the code', async () => {
    const { errorFromResponse } = await import('../../../src/lib/siteAdapters/emdash.js');
    const err = errorFromResponse(403, { success: false, error: { code: 'AGENT_NOT_ALLOWED', message: 'Agents cannot publish. Ask an editor.' } });
    expect(err).toMatchObject({ code: 'AGENT_NOT_ALLOWED', status: 403, retryable: false });
    expect(pushErrorMessage(err)).toMatch(/does not let agents/);
  });

  it('seo.canonical / seo.noIndex are sent only when the OS draft holds a value', () => {
    const ctx = pushContextFrom(ex('site-info.response'), JANE, PROJECT);
    const ci = ctx.collections.find((c) => c.name === 'pages');
    const none = buildDraftUpsertBody({ ...UPD, seoTitle: 'T' }, { user: JANE, ctx, collectionInfo: ci, slugPolicy: 'exact' });
    expect(none.seo).toEqual({ title: 'T' });
    const both = buildDraftUpsertBody({ ...UPD, seoCanonical: '/spa-services/hot-tub-repair/', seoNoIndex: false }, { user: JANE, ctx, collectionInfo: ci, slugPolicy: 'exact' });
    expect(both.seo).toEqual({ canonical: '/spa-services/hot-tub-repair/', noIndex: false });
  });

  it('push context exposes draftHash / atomicDraftUpdate and the site contract revision', () => {
    const ctx = pushContextFrom(ex('site-info.response'), JANE, { ...PROJECT, cmsCapabilities: { draftHash: true, atomicDraftUpdate: false }, cmsHealth: { contractRevision: '1.5.8' } });
    expect(ctx.capabilities).toMatchObject({ draftHash: true, atomicDraftUpdate: false });
    expect(ctx.contractRevision).toBe('1.5.8');
  });
});
