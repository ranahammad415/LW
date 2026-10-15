/**
 * EmDash sitemap discovery for SitemapNode auto-sync. Follows a <sitemapindex> to its child sitemaps with hard bounds,
 * same host only, every fetch through the SSRF-guarded `guardedFetch`. Sitemap URLs themselves are never returned
 * as pages. WordPress keeps its own (older) single-file path in `lib/wpSync.js`.
 */
import { guardedFetch } from './netGuard.js';

export const SITEMAP_LIMITS = Object.freeze({
  /** Index levels followed below the root (root index → child index → urlset). */
  maxDepth: 2,
  maxChildSitemaps: 50,
  maxUrls: 5000,
  fetchTimeoutMs: 15_000,
  totalDeadlineMs: 60_000,
  maxUrlLength: 500,
});

/** Tried after a site-advertised `sitemapUrl` (contract v1.0.7 site-info). Oasis serves /sitemap.xml as an index. */
export const EMDASH_SITEMAP_PATHS = ['/sitemap.xml', '/sitemap-index.xml', '/sitemap-0.xml'];

const UA = 'Localwaves-AgencyOS/1.0 (+https://localwaves; sitemap sync)';

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** A URL that is itself a sitemap file (never stored as a page). */
export function looksLikeSitemap(url) {
  try {
    return /sitemap[^/]*\.xml(\.gz)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Parse one sitemap document. Returns the kind and the <loc> of each <sitemap> (index) or <url> (urlset) entry.
 * Only the entry's own <loc> counts: image:/video:/news: locs inside a <url> are ignored.
 */
export function parseSitemapXml(text) {
  const xml = String(text || '');
  const kind = /<(?:[\w-]+:)?sitemapindex[\s>]/i.test(xml) ? 'index' : /<(?:[\w-]+:)?urlset[\s>]/i.test(xml) ? 'urlset' : null;
  if (!kind) return { kind: null, locs: [] };
  const tag = kind === 'index' ? 'sitemap' : 'url';
  const blockRe = new RegExp(`<(?:[\\w-]+:)?${tag}[\\s>][\\s\\S]*?<\\/(?:[\\w-]+:)?${tag}>`, 'gi');
  const locRe = /<(?:(?!image:|video:|news:|xhtml:)[\w-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?loc>/i;
  const locs = [];
  for (const m of xml.matchAll(blockRe)) {
    const loc = m[0].match(locRe);
    if (loc) locs.push(decodeXml(loc[1]));
  }
  return { kind, locs };
}

/**
 * Collect page URLs from the site's sitemap.
 * @param {string} baseUrl the paired site URL
 * @param {{ sitemapUrl?: string|null, fetchFn?: Function, limits?: object }} opts
 * @returns {Promise<{ found: boolean, root: string|null, urls: string[], sitemapsFetched: number, complete: boolean }>}
 *   `complete` is false when a bound, the deadline or a child fetch failure cut the walk short (callers must not
 *   infer removals from an incomplete list).
 */
export async function collectSitemapUrls(baseUrl, { sitemapUrl = null, fetchFn = guardedFetch, limits = {} } = {}) {
  const L = { ...SITEMAP_LIMITS, ...limits };
  const base = new URL(String(baseUrl).trim());
  const deadline = Date.now() + L.totalDeadlineMs;

  const sameHost = (raw) => {
    try {
      const u = new URL(raw, base);
      if (u.host !== base.host || u.protocol !== base.protocol) return null;
      u.hash = '';
      return u.toString();
    } catch {
      return null;
    }
  };

  const fetchDoc = async (url) => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(L.fetchTimeoutMs), headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const parsed = parseSitemapXml(await res.text());
    return parsed.kind ? parsed : null;
  };

  // Root: the site-advertised sitemapUrl (validated same-host) first, then the usual Astro paths.
  const candidates = [];
  const advertised = sitemapUrl ? sameHost(sitemapUrl) : null;
  if (advertised) candidates.push(advertised);
  for (const p of EMDASH_SITEMAP_PATHS) {
    const u = sameHost(p);
    if (u && !candidates.includes(u)) candidates.push(u);
  }

  let root = null;
  let rootDoc = null;
  for (const c of candidates) {
    if (Date.now() > deadline) break;
    try {
      const doc = await fetchDoc(c);
      if (doc) {
        root = c;
        rootDoc = doc;
        break;
      }
    } catch {
      // try the next path
    }
  }
  if (!rootDoc) return { found: false, root: null, urls: [], sitemapsFetched: 0, complete: false };

  const urls = new Set();
  const visited = new Set([root]);
  let sitemapsFetched = 1;
  let complete = true;

  const walk = async (doc, depth) => {
    if (doc.kind === 'urlset') {
      for (const loc of doc.locs) {
        const u = sameHost(loc);
        if (!u || u.length > L.maxUrlLength || looksLikeSitemap(u)) continue;
        if (urls.size >= L.maxUrls) {
          complete = false;
          return;
        }
        urls.add(u);
      }
      return;
    }
    // Index: follow child sitemaps (never stored as pages).
    if (depth >= L.maxDepth) {
      if (doc.locs.length) complete = false;
      return;
    }
    for (const loc of doc.locs) {
      const child = sameHost(loc);
      if (!child || visited.has(child)) continue;
      if (sitemapsFetched - 1 >= L.maxChildSitemaps || urls.size >= L.maxUrls || Date.now() > deadline) {
        complete = false;
        return;
      }
      visited.add(child);
      sitemapsFetched += 1;
      let childDoc = null;
      try {
        childDoc = await fetchDoc(child);
      } catch {
        childDoc = null;
      }
      if (!childDoc) {
        complete = false;
        continue;
      }
      await walk(childDoc, depth + 1);
    }
  };

  await walk(rootDoc, 0);
  return { found: true, root, urls: [...urls], sitemapsFetched, complete };
}
