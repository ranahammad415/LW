/**
 * v1.2 draft push + media import (contract §22, §23): body building against the contract examples, access rules,
 * push outcomes (created, conflict, lock, local validation), idempotency-key reuse, media checks and dedupe,
 * the AI writer helpers, image sniffing, the team roster and osRequest confirmation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ upsert: null, media: null, info: null, bodies: [], opts: [] }));

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
  defaultBylines,
  actorFor,
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
    db.overrides['cmsDraft.findUnique'] = async () => ({ ...DRAFT, cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C', cmsRev: 'v1' });
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
    const ok = async () => new Response(pngBytes(), { status: 200 });
    expect((await fetchImageFromUrl('https://x.example/img/a%20b.png', { maxBytes: 1000, fetchImpl: ok })).filename).toBe('a b.png');
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
