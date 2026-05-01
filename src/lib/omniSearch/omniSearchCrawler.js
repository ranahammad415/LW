/**
 * Lightweight page crawler using native fetch and regex-based HTML parsing.
 * No external HTML parser dependency required.
 */

const USER_AGENT = 'Mozilla/5.0 (compatible; OmniSearchBot/1.0; +https://localwave.io)';
const FETCH_TIMEOUT = 10_000; // 10 seconds

// ─── HTML Parsing Helpers ───────────────────────────────────────────────────

function extractTag(html, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(regex);
  return match ? match[1].trim() : '';
}

function extractMetaContent(html, name) {
  // Match name= or property= attributes
  const regex = new RegExp(`<meta\\s+(?:[^>]*?(?:name|property)=["']${name}["'][^>]*?content=["']([^"']*?)["']|[^>]*?content=["']([^"']*?)["'][^>]*?(?:name|property)=["']${name}["'])`, 'i');
  const match = html.match(regex);
  return match ? (match[1] || match[2] || '').trim() : '';
}

function extractAllTags(html, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    results.push(match[1].replace(/<[^>]+>/g, '').trim());
  }
  return results;
}

function extractLinks(html, baseUrl) {
  const regex = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  const internal = [];
  const external = [];
  let match;
  const baseHost = new URL(baseUrl).hostname;

  while ((match = regex.exec(html)) !== null) {
    let href = match[1].trim();
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname === baseHost) {
        internal.push(resolved.href);
      } else {
        external.push(resolved.href);
      }
    } catch {
      // Invalid URL, skip
    }
  }
  return { internal: [...new Set(internal)], external: [...new Set(external)] };
}

function extractImages(html) {
  const regex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const images = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    const alt = match[0].match(/alt=["']([^"']*?)["']/i);
    images.push({ src: match[1], alt: alt ? alt[1] : '' });
  }
  return images;
}

function extractCanonical(html) {
  const match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  return match ? match[1].trim() : '';
}

function extractStructuredData(html) {
  const regex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const results = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    try { results.push(JSON.parse(match[1])); } catch { /* skip invalid JSON-LD */ }
  }
  return results;
}

function extractOgTags(html) {
  const tags = {};
  const regex = /<meta\s+[^>]*property=["'](og:[^"']+)["'][^>]*content=["']([^"']*?)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    tags[match[1]] = match[2];
  }
  return tags;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetches and parses a single URL for SEO data.
 */
export async function crawlPage(url) {
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const statusCode = response.status;
    const html = await response.text();
    const loadTime = Date.now() - startTime;

    const title = extractTag(html, 'title');
    const metaDescription = extractMetaContent(html, 'description');
    const h1 = extractAllTags(html, 'h1')[0] || '';
    const h2s = extractAllTags(html, 'h2');
    const canonical = extractCanonical(html);
    const { internal: internalLinks, external: externalLinks } = extractLinks(html, url);
    const images = extractImages(html);
    const bodyText = stripHtml(html);
    const wordCount = countWords(bodyText);
    const structuredData = extractStructuredData(html);
    const ogTags = extractOgTags(html);

    return {
      url,
      statusCode,
      title,
      metaDescription,
      h1,
      h2s,
      canonical,
      wordCount,
      internalLinks: internalLinks.slice(0, 100),
      externalLinks: externalLinks.slice(0, 50),
      images: images.slice(0, 50),
      loadTime,
      structuredData,
      ogTags,
    };
  } catch (err) {
    return {
      url,
      statusCode: 0,
      error: err.name === 'AbortError' ? 'Timeout after 10s' : err.message,
      title: '',
      metaDescription: '',
      h1: '',
      h2s: [],
      canonical: '',
      wordCount: 0,
      internalLinks: [],
      externalLinks: [],
      images: [],
      loadTime: Date.now() - startTime,
      structuredData: [],
      ogTags: {},
    };
  }
}

/**
 * Crawls multiple pages from a root URL (follow internal links, max depth).
 */
export async function crawlSite(rootUrl, maxPages = 50, maxDepth = 3) {
  const visited = new Set();
  const results = [];
  const queue = [{ url: rootUrl, depth: 0 }];
  const baseHost = new URL(rootUrl).hostname;

  while (queue.length > 0 && results.length < maxPages) {
    const { url, depth } = queue.shift();
    const normalized = url.split('#')[0].split('?')[0].replace(/\/$/, '');

    if (visited.has(normalized)) continue;
    visited.add(normalized);

    const pageData = await crawlPage(url);
    results.push({ ...pageData, depth });

    // Queue internal links if we haven't exceeded depth
    if (depth < maxDepth && pageData.internalLinks) {
      for (const link of pageData.internalLinks) {
        try {
          const linkHost = new URL(link).hostname;
          const linkNormalized = link.split('#')[0].split('?')[0].replace(/\/$/, '');
          if (linkHost === baseHost && !visited.has(linkNormalized) && results.length + queue.length < maxPages) {
            queue.push({ url: link, depth: depth + 1 });
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }
  }

  return results;
}

/**
 * Extracts basic SERP-like data from a URL analysis.
 */
export async function analyzeUrl(url) {
  const pageData = await crawlPage(url);
  const bodyText = pageData.wordCount > 0 ? '' : ''; // Text already counted

  // Simple readability estimate — average words per sentence
  return {
    url: pageData.url,
    title: pageData.title,
    meta: pageData.metaDescription,
    headings: {
      h1: pageData.h1,
      h2s: pageData.h2s,
    },
    content: {
      wordCount: pageData.wordCount,
      hasStructuredData: pageData.structuredData.length > 0,
      imageCount: pageData.images.length,
      internalLinkCount: pageData.internalLinks.length,
      externalLinkCount: pageData.externalLinks.length,
    },
    readability: {
      estimatedGrade: pageData.wordCount > 0 ? 'analyzed' : 'no-content',
    },
    statusCode: pageData.statusCode,
    loadTime: pageData.loadTime,
    canonical: pageData.canonical,
    ogTags: pageData.ogTags,
  };
}
