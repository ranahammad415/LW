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
 * Look up current SERP positions for a set of keywords against a domain. Real providers only: a failure comes back
 * as { dataSource: 'error', error } and never as an estimate (estimates are OmniSearch-only, see serpProvider.js).
 * One call per keyword, no retries. An account-level DataForSEO error (auth, balance, rate limit) stops the loop:
 * the remaining keywords come back as errors without being called.
 *
 * @param {{ domain: string, keywords: string[], country?: string, locationCode?: number|null,
 *   locationName?: string|null, languageCode?: string|null }} args
 * @returns {Promise<Array<{ keyword, position, url, dataSource, costUsd?, error? }>>}
 */
export async function getKeywordRankings({ domain, keywords, country = 'US', locationCode = null, locationName = null, languageCode = null, lookup = lookupSerpPosition }) {
  const cleanDomain = domainFromUrl(domain);
  if (!cleanDomain || !Array.isArray(keywords) || keywords.length === 0) return [];

  const results = [];
  let stopped = null;
  for (const keyword of keywords) {
    if (stopped) {
      results.push({ keyword, position: null, url: null, dataSource: 'error', error: stopped });
      continue;
    }
    try {
      const r = await lookup({ keyword, domain: cleanDomain, country, locationCode, locationName, languageCode, allowEstimate: false });
      results.push({ keyword, position: r.position, url: r.url, dataSource: r.dataSource, costUsd: r.costUsd ?? null });
    } catch (err) {
      results.push({ keyword, position: null, url: null, dataSource: 'error', error: String(err?.message || 'lookup failed').slice(0, 200) });
      if (err?.accountLevel) stopped = 'Skipped after an account-level provider error';
    }
  }
  return results;
}
