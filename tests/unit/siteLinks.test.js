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

import { safeSiteLink, safeReviewLinks } from '../../src/lib/siteLinks.js';
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

  it('safeReviewLinks vets WordPress rows and leaves EmDash rows alone', () => {
    const row = { pmPreviewUrl: 'https://evil.example/pm', clientPreviewUrl: 'https://example.com/c' };
    expect(safeReviewLinks(row, { wpUrl: SITE, cmsType: 'WORDPRESS' })).toEqual({ pmPreviewUrl: null, clientPreviewUrl: 'https://example.com/c' });
    expect(safeReviewLinks(row, { wpUrl: SITE, cmsType: 'EMDASH' })).toEqual(row);
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
