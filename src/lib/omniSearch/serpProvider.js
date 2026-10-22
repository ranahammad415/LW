/**
 * SERP data provider.
 *
 * Returns ranking positions for a keyword across search engines.
 * Dispatches to a configured real provider (SerpAPI or DataForSEO) when credentials are present.
 *
 * Estimates: when `allowEstimate` is true (the default, used only by OmniSearch, which stores and shows the
 * `dataSource` label next to every row) a provider failure or a missing provider falls back to a Claude-ESTIMATED
 * position with dataSource 'claude_estimated'. Core rank tracking (lib/analytics/dfsSync.js) calls with
 * allowEstimate: false: it gets real data or an error, never an estimate (docs/ledger/features/local-seo.md).
 *
 * Domain matching is strict (lib/analytics/domainMatch.js): same registrable domain only, so `abc.com` never matches
 * `xabc.com`; `www.` and subdomains of the same site match.
 *
 * Shape returned by lookupSerpPosition:
 *   {
 *     keyword,
 *     engine,
 *     country,
 *     position: number|null,   // 1-100 or null if not ranking in top 100
 *     url: string|null,        // ranking URL if known
 *     dataSource: 'serpapi' | 'dataforseo' | 'claude_estimated',
 *     costUsd?: number|null,   // DataForSEO task cost when returned
 *     raw?: object,            // provider-specific raw payload (real providers only)
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AI_MODEL,
  SERP_PROVIDER,
  CLAUDE_ESTIMATED_SOURCE,
  hasRealSerpProvider,
} from './omniSearchConfig.js';
import { dfsPostTask } from '../dataforseo/client.js';
import { sameSite } from '../analytics/domainMatch.js';

/** dataSource values that are real measurements (the only ones tracking tables may store). */
export const REAL_SERP_SOURCES = Object.freeze(['serpapi', 'dataforseo']);

const SERPAPI_TIMEOUT_MS = 60_000;

let anthropic = null;
function anthropicClient() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

/**
 * Main entry point.
 * @param {{ keyword: string, domain: string, engine?: string, country?: string, locationCode?: number|null,
 *   locationName?: string|null, languageCode?: string|null, allowEstimate?: boolean }} args
 */
export async function lookupSerpPosition({
  keyword,
  domain,
  engine = 'google',
  country = 'US',
  locationCode = null,
  locationName = null,
  languageCode = null,
  allowEstimate = true,
}) {
  const args = { keyword, domain, engine, country, locationCode, locationName, languageCode };
  if (hasRealSerpProvider()) {
    try {
      if (SERP_PROVIDER === 'serpapi') return await lookupViaSerpApi(args);
      if (SERP_PROVIDER === 'dataforseo') return await lookupViaDataForSeo(args);
    } catch (err) {
      if (!allowEstimate) throw err;
      // OmniSearch only: fall through to a labelled Claude estimate.
      // eslint-disable-next-line no-console
      console.warn(`[serpProvider] ${SERP_PROVIDER} failed, falling back to Claude estimate: ${err.message}`);
    }
  } else if (!allowEstimate) {
    throw new Error('No real SERP provider is configured');
  }
  return estimateWithClaude(args);
}

// ─── SerpAPI ────────────────────────────────────────────────────────────────
async function lookupViaSerpApi({ keyword, domain, engine, country, locationName, languageCode }) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', keyword);
  url.searchParams.set('engine', engine);
  url.searchParams.set('gl', country.toLowerCase());
  if (locationName) url.searchParams.set('location', locationName);
  if (languageCode) url.searchParams.set('hl', languageCode);
  url.searchParams.set('num', '100');
  url.searchParams.set('api_key', process.env.SERPAPI_API_KEY);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(SERPAPI_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  const data = await res.json();
  if (data?.error && !/hasn't returned any results/i.test(String(data.error))) throw new Error(`SerpAPI: ${String(data.error).slice(0, 120)}`);

  const results = data.organic_results || [];
  let position = null;
  let matchedUrl = null;
  for (const r of results) {
    if (sameSite(r.link || '', domain)) {
      position = r.position;
      matchedUrl = r.link;
      break;
    }
  }

  return { keyword, engine, country, position, url: matchedUrl, dataSource: 'serpapi', costUsd: null, raw: data };
}

// ─── DataForSEO ─────────────────────────────────────────────────────────────
export const DFS_ORGANIC_PATH = '/v3/serp/google/organic/live/regular';

async function lookupViaDataForSeo({ keyword, domain, engine, country, locationCode, languageCode }) {
  const parsed = await dfsPostTask(DFS_ORGANIC_PATH, {
    keyword,
    location_code: Number(locationCode) || countryToDfsCode(country),
    language_code: languageCode || 'en',
    depth: 100,
  });
  const items = parsed.state === 'ok' ? parsed.result?.items || [] : [];
  if (parsed.state === 'pending') throw new Error('DataForSEO live task still pending');
  const { position, url } = matchOrganicItems(items, domain);
  return {
    keyword,
    engine,
    country,
    position,
    url,
    dataSource: 'dataforseo',
    costUsd: parsed.costUsd,
    raw: { tasks: [parsed.task] },
  };
}

/** First organic item on the same site (strict registrable-domain match). Pure. */
export function matchOrganicItems(items, domain) {
  for (const item of items || []) {
    if (item?.type !== 'organic') continue;
    if (sameSite(item.url || item.domain || '', domain)) {
      // rank_absolute (position among all SERP elements), as before this change.
      return { position: item.rank_absolute ?? item.rank_group ?? null, url: item.url || null };
    }
  }
  return { position: null, url: null };
}

// ─── Claude fallback (OmniSearch only) ──────────────────────────────────────
async function estimateWithClaude({ keyword, domain, engine, country }) {
  const prompt = `Estimate an approximate Google-style SERP position for domain "${domain}" on the query "${keyword}" in ${country}. You do NOT have live data. Return ONLY JSON: {"position": <1-100 or null>, "confidence": "low"}.`;
  const response = await anthropicClient().messages.create({
    model: AI_MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  let position = null;
  try {
    const text = response.content?.[0]?.text || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (typeof parsed.position === 'number') position = parsed.position;
  } catch {
    /* noop */
  }

  return {
    keyword,
    engine,
    country,
    position,
    url: null,
    dataSource: CLAUDE_ESTIMATED_SOURCE,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────
export function countryToDfsCode(country) {
  const map = { US: 2840, GB: 2826, CA: 2124, AU: 2036, DE: 2276, FR: 2250, IN: 2356 };
  return map[country?.toUpperCase()] || 2840;
}
