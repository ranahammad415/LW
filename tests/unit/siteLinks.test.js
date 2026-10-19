/** Security hotfix: WordPress site links (preview / edit) are kept only when https and on the project's site host. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../src/lib/prisma.js', () => {
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
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'r1', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../src/lib/realtimeBus.js', () => ({ publish: vi.fn() }));
vi.mock('../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: vi.fn(async () => {}), reconcileProjectMapsSafe: vi.fn() }));
vi.mock('../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn() }));

import { safeSiteLink, safeReviewLinks, safeEmdashLink, sanitizeEmdashLinks } from '../../src/lib/siteLinks.js';
import { normalizeReviewEvent, reviewToMirrorData, entryToPageData } from '../../src/lib/siteAdapters/emdash.js';
import { applyReviewEvent } from '../../src/lib/reviewEvents.js';
import { normalizePipelineWebhook } from '../../src/lib/siteAdapters/wordpress.js';

const SITE = 'https://example.com';

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('safeSiteLink', () => {
  it('keeps https links on the site host (www. ignored); drops other schemes, hosts and credentials', () => {
    expect(safeSiteLink('https://example.com/?lwa_preview=abc', SITE)).toBe('https://example.com/?lwa_preview=abc');
    expect(safeSiteLink('https://www.example.com/p/', SITE)).toBe('https://www.example.com/p/');
    expect(safeSiteLink('https://EXAMPLE.com/wp-admin/post.php?post=1&action=edit', 'https://www.example.com')).toBeTruthy();
    for (const bad of [
      'http://example.com/?x=1',
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://evil.example/?x',
      'https://example.com.evil.net/',
      'https://user:pw@example.com/',
      '//example.com/x',
      '',
      null,
    ]) expect(safeSiteLink(bad, SITE)).toBeNull();
    expect(safeSiteLink('https://example.com/x', null)).toBeNull(); // no stored site URL: cannot verify
  });

  it('safeReviewLinks vets WordPress and EmDash rows', () => {
    const row = { pmPreviewUrl: 'https://evil.example/pm', clientPreviewUrl: 'https://example.com/c' };
    expect(safeReviewLinks(row, { wpUrl: SITE, cmsType: 'WORDPRESS' })).toEqual({ pmPreviewUrl: null, clientPreviewUrl: 'https://example.com/c' });
    expect(safeReviewLinks(row, { wpUrl: SITE, cmsType: 'EMDASH' })).toEqual({ pmPreviewUrl: null, clientPreviewUrl: 'https://example.com/c' });
  });
});

describe('EmDash links (same rule on the stored site host)', () => {
  const DEV = { NODE_ENV: 'development', EMDASH_BRIDGE_ALLOW_INSECURE_DEV: 'true' };
  it('exact host + port, https; http only under the insecure dev opt-in', () => {
    expect(safeEmdashLink('https://example.com/_emdash/admin/content/pages/1', SITE, {})).toBe('https://example.com/_emdash/admin/content/pages/1');
    expect(safeEmdashLink('https://www.example.com/x', SITE, {})).toBeNull(); // EmDash: exact host
    expect(safeEmdashLink('https://example.com:8443/x', SITE, {})).toBeNull();
    expect(safeEmdashLink('http://example.com/x', SITE, {})).toBeNull();
    expect(safeEmdashLink('javascript:alert(1)', SITE, DEV)).toBeNull();
    expect(safeEmdashLink('https://u:p@example.com/x', SITE, {})).toBeNull();
    expect(safeEmdashLink('http://localhost:4321/_emdash/admin', 'http://localhost:4321', {})).toBeNull();
    expect(safeEmdashLink('http://localhost:4321/_emdash/admin', 'http://localhost:4321', DEV)).toBe('http://localhost:4321/_emdash/admin');
    expect(safeEmdashLink('http://localhost:4321/x', 'http://localhost:4321', { ...DEV, NODE_ENV: 'production' })).toBeNull();
  });
  it('sanitizeEmdashLinks nulls off-host link keys anywhere in a site answer', () => {
    const body = { editUrl: 'https://evil.example/e', review: { pmPreviewUrl: 'https://example.com/p?t=1', clientPreviewUrl: 'data:x' }, details: [{ existingEditUrl: 'https://example.com/a' }], url: 'https://evil.example/' };
    sanitizeEmdashLinks(body, SITE, {});
    expect(body).toEqual({ editUrl: null, review: { pmPreviewUrl: 'https://example.com/p?t=1', clientPreviewUrl: null }, details: [{ existingEditUrl: 'https://example.com/a' }], url: 'https://evil.example/' });
  });
  it('mirror and inventory normalisers keep only on-host links', () => {
    const review = { reviewNo: 3, entryNo: 2, status: 'pending_pm_review', pmPreviewUrl: 'https://evil.example/p', clientPreviewUrl: 'https://example.com/c', editUrl: 'https://evil.example/e' };
    const m = reviewToMirrorData(review, SITE);
    expect(m.data.pmPreviewUrl).toBeUndefined();
    expect(m.data.clientPreviewUrl).toBe('https://example.com/c');
    expect(m.data.cmsEditUrl).toBeNull();
    expect(reviewToMirrorData(review).data.clientPreviewUrl).toBeUndefined(); // no site URL: fail closed
    expect(entryToPageData({ entryNo: 1, editUrl: 'https://evil.example/e' }, SITE).data.cmsEditUrl).toBeNull();
    expect(entryToPageData({ entryNo: 1, editUrl: 'https://example.com/_emdash/admin/x' }, SITE).data.cmsEditUrl).toBe('https://example.com/_emdash/admin/x');
  });
  it('applyReviewEvent drops off-host EmDash links before storing', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => null;
    const n = normalizeReviewEvent({ reviewNo: 4, entryNo: 2, status: 'pending_pm_review', reviewId: '01JREV', pmPreviewUrl: 'https://evil.example/p', clientPreviewUrl: 'https://example.com/c', editUrl: 'javascript:alert(1)' }, { eventType: 'pipeline_submitted', seq: 1 });
    await applyReviewEvent({ project: { id: 'p1', leadPmId: 'pm1', name: 'S', wpUrl: SITE, cmsType: 'EMDASH' }, event: n });
    const write = db.calls.find((c) => c.key === 'wpContentReview.upsert' || c.key === 'wpContentReview.create');
    const data = write.args.create || write.args.data;
    expect(data.pmPreviewUrl ?? null).toBeNull();
    expect(data.clientPreviewUrl).toBe('https://example.com/c');
    expect(data.cmsEditUrl ?? null).toBeNull();
  });
});

describe('stored from the WordPress webhook', () => {
  it('an off-host or non-https preview link is not stored', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => null;
    const n = normalizePipelineWebhook({ pipelineId: 9, eventType: 'pipeline_submitted', postId: 3, status: 'pending_pm_review', postTitle: 'P', pmPreviewUrl: 'javascript:alert(1)', clientPreviewUrl: 'https://example.com/?c=1' });
    await applyReviewEvent({ project: { id: 'p1', leadPmId: 'pm1', name: 'S', wpUrl: SITE }, event: n });
    const write = db.calls.find((c) => c.key === 'wpContentReview.upsert' || c.key === 'wpContentReview.create');
    const data = write.args.create || write.args.data;
    expect(data.pmPreviewUrl ?? null).toBeNull();
    expect(data.clientPreviewUrl).toBe('https://example.com/?c=1');
  });
});
