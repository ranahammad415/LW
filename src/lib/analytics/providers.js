/**
 * Shared analytics adapter layer.
 *
 * Thin, core-facing wrappers around the existing OmniSearch data providers so
 * that native (non-OmniSearch) analytics can use DataForSEO / SERP / keyword /
 * backlink data keyed to a core Project/Client — without importing OmniSearch
 * routes or auth. OmniSearch itself can stay hidden behind its flag; only these
 * data adapters are reused.
 */
import { lookupSerpPosition } from '../omniSearch/serpProvider.js';
import { fetchKeywordMetrics } from '../omniSearch/keywordDataProvider.js';
import { fetchBacklinks } from '../omniSearch/backlinkProvider.js';
import {
  hasRealSerpProvider,
  hasRealKeywordProvider,
  hasRealBacklinkProvider,
} from '../omniSearch/omniSearchConfig.js';

export {
  lookupSerpPosition,
  fetchKeywordMetrics,
  fetchBacklinks,
  hasRealSerpProvider,
  hasRealKeywordProvider,
  hasRealBacklinkProvider,
};

/** Extract a bare domain from a project/client URL. */
export function domainFromUrl(url) {
  if (!url) return '';
  return String(url)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

/**
 * Look up current SERP positions for a set of keywords against a domain.
 * Degrades gracefully (Claude-estimated) when no real provider is configured.
 *
 * @param {{ domain: string, keywords: string[], country?: string }} args
 * @returns {Promise<Array<{ keyword, position, url, dataSource }>>}
 */
export async function getKeywordRankings({ domain, keywords, country = 'US' }) {
  const cleanDomain = domainFromUrl(domain);
  if (!cleanDomain || !Array.isArray(keywords) || keywords.length === 0) return [];

  const results = [];
  for (const keyword of keywords) {
    try {
      const r = await lookupSerpPosition({ keyword, domain: cleanDomain, country });
      results.push({ keyword, position: r.position, url: r.url, dataSource: r.dataSource });
    } catch (err) {
      results.push({ keyword, position: null, url: null, dataSource: 'error', error: err.message });
    }
  }
  return results;
}
