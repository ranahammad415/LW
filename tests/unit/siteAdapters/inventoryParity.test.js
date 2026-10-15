/**
 * Inventory parity (oasis-astro inventory-parity-report.md) + contract v1.0.6: live vs draft, wordCount,
 * outline (ported canonical JSON/hash, vector), content-map enrichment for EmDash pages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalOutline, outlineHash, limitOutline, OUTLINE_FETCH_CAP_PER_SYNC } from '../../../src/lib/siteAdapters/outline.js';
import { entryToPageData } from '../../../src/lib/siteAdapters/emdash.js';
import { enrichPage, computeInboundLinks } from '../../../src/lib/contentMapSync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract', p), 'utf8'));
const vectors = fx('vectors/signature-vectors.json');

describe('outline hash (v1.0.6 vector)', () => {
  it.each(vectors.outline.map((v) => [v.name, v]))('%s', (_n, v) => {
    expect(canonicalOutline(v.outline)).toBe(v.canonical);
    expect(outlineHash(v.outline)).toBe(v.outlineHash);
  });
  it('limitOutline applies the contract caps (dedupe, drop long links, trim headings)', () => {
    const o = limitOutline({
      headings: [{ level: 7, text: 'x' }, { level: 2, text: '  ' }, ...Array.from({ length: 25 }, (_, i) => ({ level: 2, text: ` H${i} ` }))],
      internalLinks: ['/a/', '/a/', 'https://ext', `/${'x'.repeat(301)}`, '/b/'],
      externalLinkCount: 3,
      imageCount: 1,
    });
    expect(o.headings).toHaveLength(20);
    expect(o.headings[0]).toEqual({ level: 2, text: 'H0' });
    expect(o.internalLinks).toEqual(['/a/', '/b/']);
    expect(OUTLINE_FETCH_CAP_PER_SYNC).toBe(25);
  });
});

describe('entry → WpPage: live vs draft (v1.0.6)', () => {
  const entry = fx('examples/inventory.response.json').items[0];

  it('`live` present: published state from live values, draft title kept for the badge, SEO as sent', () => {
    const { data, outlinePending } = entryToPageData(entry, 'https://oasispoolspas.com');
    expect(data).toMatchObject({
      status: 'published',
      title: entry.live.title,
      contentHash: entry.live.contentHash,
      cmsWordCount: entry.live.wordCount,
      cmsHasPendingDraft: true,
      cmsDraftTitle: entry.title,
      seoTitle: entry.seo.title,
      cmsOutlineHash: entry.live.outlineHash,
    });
    expect(data.cmsOutline.headings.length).toBeGreaterThan(0);
    expect(outlinePending).toBe(false);
  });

  it('older plugin (no `live`): values kept as sent, pending flag still set', () => {
    const { live, ...old } = entry;
    const { data } = entryToPageData(old, 'https://oasispoolspas.com');
    expect(data).toMatchObject({ title: entry.title, cmsHasPendingDraft: true, cmsDraftTitle: entry.title, cmsWordCount: entry.wordCount });
  });

  it('no pending draft: top-level values, no draft title', () => {
    const { live, ...rest } = entry;
    const { data } = entryToPageData({ ...rest, hasPendingDraft: false }, 'https://oasispoolspas.com');
    expect(data).toMatchObject({ title: entry.title, cmsHasPendingDraft: false, cmsDraftTitle: null, cmsWordCount: entry.wordCount });
  });

  it('outlineOmitted: marks the entry for a capped entry-get fetch of the live variant', () => {
    const omitted = fx('examples/inventory.response--outline-omitted.json').items[0];
    const r = entryToPageData(omitted, 'https://oasispoolspas.com');
    expect(r.outlinePending).toBe(true);
    expect(r.outlineVariant).toBe('live');
    expect(r.outlineHash).toBe((omitted.live || omitted).outlineHash);
    expect(r.data).not.toHaveProperty('cmsOutline');
  });
});

describe('content map enrichment for EmDash pages', () => {
  const base = { url: 'https://s.example/a/', seoTitle: 'T', seoDescription: 'D', content: '', modifiedAt: new Date() };
  it('uses wordCount + outline; WP pages keep the HTML path', () => {
    const e = enrichPage({ ...base, cmsEntryId: '01A', cmsWordCount: 812, cmsOutline: { headings: [{ level: 1, text: 'H' }], internalLinks: ['/b/', '/a/'], externalLinkCount: 2, imageCount: 3 } });
    expect(e).toMatchObject({ wordCount: 812, h1: 'H', internalLinksOut: 1, externalLinks: 2, imageCount: 3, linksKnown: true, isThin: false });
    const wp = enrichPage({ ...base, content: '<h1>Hi</h1><p>one two</p><a href="/b/">b</a>' });
    expect(wp).toMatchObject({ wordCount: expect.any(Number), h1: 'Hi', internalLinksOut: 1 });
    expect(wp).not.toHaveProperty('linksKnown');
  });

  it('orphan status is unknown (null) while any EmDash page lacks an outline, computed once all have one', () => {
    const page = (p, outline) => ({ path: p, isLive: true, enrichment: enrichPage({ ...base, url: `https://s.example${p}`, cmsEntryId: p, cmsWordCount: 400, cmsOutline: outline }) });
    const unknown = computeInboundLinks([page('/a/', { headings: [], internalLinks: ['/b/'] }), page('/b/', null)]);
    expect(unknown.map((i) => i.enrichment.isOrphan)).toEqual([null, null]);
    const known = computeInboundLinks([page('/a/', { headings: [], internalLinks: ['/b/'] }), page('/b/', { headings: [], internalLinks: [] })]);
    expect(known.map((i) => i.enrichment.isOrphan)).toEqual([true, false]);
  });
});
