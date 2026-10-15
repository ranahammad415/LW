/**
 * Content outline (contract v1.0.6 §19 addendum), ported exactly from
 * oasis-astro packages/os-bridge-contract/src/outline.mjs (f2c7b6f). The vector in
 * tests/fixtures/cms-contract/vectors/signature-vectors.json → `outline[0]` must keep passing.
 */
import { sha256Hex } from './signing.js';

export const OUTLINE_LIMITS = Object.freeze({ headings: 20, headingText: 200, internalLinks: 100, linkPath: 300 });
/** OS: at most this many entry-get calls per sync run to fetch outlines omitted from inventory. */
export const OUTLINE_FETCH_CAP_PER_SYNC = 25;

/**
 * Canonical JSON: keys in this exact order, no whitespace, ECMAScript JSON.stringify escaping (non-ASCII stays
 * literal, hashed as UTF-8):
 *   {"headings":[{"level":2,"text":"…"}],"internalLinks":["/a/"],"externalLinkCount":0,"imageCount":0}
 */
export function canonicalOutline(o) {
  return JSON.stringify({
    headings: (o.headings ?? []).map((h) => ({ level: h.level, text: h.text })),
    internalLinks: [...(o.internalLinks ?? [])],
    externalLinkCount: o.externalLinkCount ?? 0,
    imageCount: o.imageCount ?? 0,
  });
}

export function outlineHash(outline) {
  return sha256Hex(canonicalOutline(outline));
}

/**
 * Apply the contract limits: headings in document order, first 20, text trimmed to 200 code points; internal links
 * deduplicated in first-seen order, first 100, each ≤ 300 chars (longer ones are dropped).
 */
export function limitOutline({ headings = [], internalLinks = [], externalLinkCount = 0, imageCount = 0 }) {
  const seen = new Set();
  const links = [];
  for (const p of internalLinks) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > OUTLINE_LIMITS.linkPath || seen.has(p)) continue;
    seen.add(p);
    links.push(p);
    if (links.length === OUTLINE_LIMITS.internalLinks) break;
  }
  return {
    headings: headings
      .filter((h) => Number.isInteger(h.level) && h.level >= 1 && h.level <= 6 && typeof h.text === 'string' && h.text.trim())
      .slice(0, OUTLINE_LIMITS.headings)
      .map((h) => ({ level: h.level, text: [...h.text.trim()].slice(0, OUTLINE_LIMITS.headingText).join('') })),
    internalLinks: links,
    externalLinkCount,
    imageCount,
  };
}
