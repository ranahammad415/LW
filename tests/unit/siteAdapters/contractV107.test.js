/**
 * Contract v1.0.7 (§20) + inventory parity recheck: sitemap index discovery (EmDash), orphan logic with home and
 * site-info.navigation, site-info navigation/sitemapUrl sanitising.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectSitemapUrls, parseSitemapXml, looksLikeSitemap, SITEMAP_LIMITS } from '../../../src/lib/siteAdapters/emdashSitemap.js';
import { enrichPage, computeInboundLinks } from '../../../src/lib/contentMapSync.js';
import { sanitizeNavigation } from '../../../src/lib/cmsStore.js';
import { CONTRACT_REVISION } from '../../../src/lib/siteAdapters/signing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract', p), 'utf8'));

const index = (locs) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (locs) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${locs
    .map((l) => `<url><loc>${l}</loc><image:image><image:loc>${l}hero.jpg</image:loc></image:image></url>`)
    .join('')}</urlset>`;

function fakeFetch(site) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = site[url];
    return { ok: body != null, text: async () => body ?? '' };
  };
  fn.calls = calls;
  return fn;
}

describe('EmDash sitemap discovery (recheck HIGH, v1.0.7 §20(3))', () => {
  const B = 'https://oasispoolspas.com';

  it('follows a <sitemapindex> (Oasis shape) and never stores the child sitemap URL as a page', async () => {
    const f = fakeFetch({
      [`${B}/sitemap.xml`]: index([`${B}/sitemap-pages.xml`, `${B}/sitemap-posts.xml`]),
      [`${B}/sitemap-pages.xml`]: urlset([`${B}/`, `${B}/pool-services/`, `${B}/sitemap-extra.xml`]),
      [`${B}/sitemap-posts.xml`]: urlset([]),
    });
    const r = await collectSitemapUrls(B, { fetchFn: f });
    expect(r).toMatchObject({ found: true, root: `${B}/sitemap.xml`, complete: true, sitemapsFetched: 3 });
    expect(r.urls).toEqual([`${B}/`, `${B}/pool-services/`]);
    expect(r.urls.some((u) => looksLikeSitemap(u))).toBe(false);
  });

  it('prefers site-info sitemapUrl when same host; ignores a foreign one', async () => {
    const f = fakeFetch({ [`${B}/custom-map.xml`]: urlset([`${B}/a/`]), [`${B}/sitemap.xml`]: urlset([`${B}/b/`]) });
    expect((await collectSitemapUrls(B, { fetchFn: f, sitemapUrl: `${B}/custom-map.xml` })).urls).toEqual([`${B}/a/`]);
    const g = fakeFetch({ ['https://evil.example/sitemap.xml']: urlset(['https://evil.example/x/']), [`${B}/sitemap.xml`]: urlset([`${B}/b/`]) });
    const r = await collectSitemapUrls(B, { fetchFn: g, sitemapUrl: 'https://evil.example/sitemap.xml' });
    expect(r.urls).toEqual([`${B}/b/`]);
    expect(g.calls.some((u) => u.includes('evil'))).toBe(false);
  });

  it('skips foreign-host children and URLs; bounds child count, depth and URL total (incomplete → no removals)', async () => {
    const children = Array.from({ length: 3 }, (_, i) => `${B}/s${i}.xml`);
    const site = { [`${B}/sitemap.xml`]: index(['https://other.example/s.xml', ...children]) };
    children.forEach((c, i) => (site[c] = urlset([`${B}/p${i}/`, 'https://other.example/x/'])));
    const r = await collectSitemapUrls(B, { fetchFn: fakeFetch(site), limits: { maxChildSitemaps: 2 } });
    expect(r.urls).toEqual([`${B}/p0/`, `${B}/p1/`]);
    expect(r.complete).toBe(false);

    const deep = fakeFetch({
      [`${B}/sitemap.xml`]: index([`${B}/i1.xml`]),
      [`${B}/i1.xml`]: index([`${B}/i2.xml`]),
      [`${B}/i2.xml`]: index([`${B}/i3.xml`]),
      [`${B}/i3.xml`]: urlset([`${B}/deep/`]),
    });
    const d = await collectSitemapUrls(B, { fetchFn: deep });
    expect(d.urls).toEqual([]);
    expect(d.complete).toBe(false);
    expect(deep.calls).not.toContain(`${B}/i3.xml`);

    const many = fakeFetch({ [`${B}/sitemap.xml`]: urlset(Array.from({ length: 10 }, (_, i) => `${B}/u${i}/`)) });
    const m = await collectSitemapUrls(B, { fetchFn: many, limits: { maxUrls: 4 } });
    expect(m.urls).toHaveLength(4);
    expect(m.complete).toBe(false);
    expect(SITEMAP_LIMITS).toMatchObject({ maxDepth: 2, maxChildSitemaps: 50, maxUrls: 5000 });
  });

  it('parseSitemapXml ignores image:loc and handles namespaced tags and entities', () => {
    expect(parseSitemapXml(urlset(['https://s.example/a/?x=1&amp;y=2'])).locs).toEqual(['https://s.example/a/?x=1&y=2']);
    expect(parseSitemapXml('<sm:sitemapindex><sm:sitemap><sm:loc>https://s.example/a.xml</sm:loc></sm:sitemap></sm:sitemapindex>')).toEqual({
      kind: 'index',
      locs: ['https://s.example/a.xml'],
    });
    expect(parseSitemapXml('<html>nope</html>').kind).toBeNull();
  });

  it('reports not found when no candidate answers with a sitemap', async () => {
    expect(await collectSitemapUrls(B, { fetchFn: fakeFetch({}) })).toMatchObject({ found: false, urls: [] });
  });
});

describe('orphans: home and site-info.navigation count as linked (v1.0.7 §20(1))', () => {
  const base = { title: 'T', seoTitle: null, seoDescription: null, modifiedAt: null, featuredImageUrl: null };
  const item = (p, links, cms = true) => {
    const page = { ...base, url: `https://s.example${p}`, ...(cms ? { cmsEntryId: p, cmsWordCount: 400, cmsOutline: { headings: [], internalLinks: links } } : { content: links.map((l) => `<a href="${l}">x</a>`).join('') }) };
    return { page, path: p, isLive: true, enrichment: enrichPage(page) };
  };

  it('EmDash: "/" and navigation paths are never orphans; other unlinked pages are', () => {
    const items = computeInboundLinks([item('/', []), item('/about/', []), item('/lonely/', []), item('/a/', ['/a/'])], {
      templateLinkedPaths: ['/about/'],
    });
    expect(items.map((i) => [i.path, i.enrichment.isOrphan])).toEqual([
      ['/', false],
      ['/about/', false],
      ['/lonely/', true],
      ['/a/', true], // self-links do not count
    ]);
  });

  it('WordPress pages are unchanged (no exemption without template paths)', () => {
    const items = computeInboundLinks([item('/', [], false), item('/b/', ['/'], false)]);
    expect(items.map((i) => i.enrichment.isOrphan)).toEqual([false, true]);
  });
});

describe('site-info v1.0.7 fields', () => {
  it('navigation: unique site-relative paths, capped at 200 × 300 chars', () => {
    const nav = fx('examples/site-info.response.json').navigation;
    expect(sanitizeNavigation(nav)).toEqual(nav);
    expect(sanitizeNavigation(['/a/', '/a/', 'https://x/', '//evil/', `/${'x'.repeat(300)}`, 5, '/b/'])).toEqual(['/a/', '/b/']);
    expect(sanitizeNavigation(Array.from({ length: 250 }, (_, i) => `/p${i}/`))).toHaveLength(200);
    expect(sanitizeNavigation(undefined)).toBeNull();
  });

  it('contractRevision is at least 1.0.7 and the deleted example carries hasPendingDraft:false without live', () => {
    expect(CONTRACT_REVISION).toBe('1.1.0'); // v1.1.0 (§21) supersedes 1.0.7; the 1.0.7 rules still hold
    const del = fx('examples/events.request--deleted.json').events.find((e) => e.type === 'content.deleted');
    expect(del.entry.hasPendingDraft).toBe(false);
    expect(del.entry).not.toHaveProperty('live');
  });
});
