/**
 * Keyword data provider.
 *
 * Returns search volume, CPC, and difficulty for a list of keywords.
 * Dispatches to DataForSEO when credentials are present, otherwise falls back
 * to the existing Claude-based estimator in omniSearchAi.js.
 *
 * Shape returned by fetchKeywordMetrics(seedKeyword, country, count):
 *   {
 *     seedKeyword,
 *     country,
 *     keywords: [
 *       {
 *         keyword,
 *         estimatedVolume: number,
 *         difficulty: number,     // 0-100
 *         cpc: number,
 *         intent: string,
 *         trend: string,
 *       }, ...
 *     ],
 *     dataSource: 'dataforseo' | 'claude_estimated',
 *   }
 */

import {
  KEYWORD_DATA_PROVIDER,
  CLAUDE_ESTIMATED_SOURCE,
  hasRealKeywordProvider,
} from './omniSearchConfig.js';
import { analyzeKeywords as claudeAnalyze } from './omniSearchAi.js';

export async function fetchKeywordMetrics(seedKeyword, country = 'US', count = 20) {
  if (hasRealKeywordProvider()) {
    try {
      if (KEYWORD_DATA_PROVIDER === 'dataforseo') {
        return await fetchViaDataForSeo(seedKeyword, country, count);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[keywordDataProvider] ${KEYWORD_DATA_PROVIDER} failed, falling back to Claude: ${err.message}`,
      );
    }
  }

  const claudePayload = await claudeAnalyze(seedKeyword, country, count);
  return {
    seedKeyword,
    country,
    keywords: claudePayload?.keywords || [],
    dataSource: CLAUDE_ESTIMATED_SOURCE,
  };
}

// ─── DataForSEO ─────────────────────────────────────────────────────────────
async function fetchViaDataForSeo(seedKeyword, country, count) {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString('base64');

  // 1) Related keywords (provides volume + CPC + competition)
  const endpoint =
    'https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        keywords: [seedKeyword],
        location_code: countryToDfsCode(country),
        language_code: 'en',
        limit: count,
      },
    ]),
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}`);
  const payload = await res.json();

  const items = payload?.tasks?.[0]?.result || [];
  const keywords = items.slice(0, count).map((item) => ({
    keyword: item.keyword,
    estimatedVolume: item.search_volume ?? 0,
    difficulty: Math.round((item.competition_index ?? 0)),
    cpc: item.cpc ?? 0,
    intent: inferIntent(item.keyword),
    trend: inferTrend(item.monthly_searches),
  }));

  return {
    seedKeyword,
    country,
    keywords,
    dataSource: 'dataforseo',
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────
function countryToDfsCode(country) {
  const map = { US: 2840, GB: 2826, CA: 2124, AU: 2036, DE: 2276, FR: 2250, IN: 2356 };
  return map[country?.toUpperCase()] || 2840;
}

function inferIntent(keyword) {
  const k = (keyword || '').toLowerCase();
  if (/buy|price|cost|cheap|order|coupon|deal/.test(k)) return 'transactional';
  if (/best|vs|review|top|compare/.test(k)) return 'commercial';
  if (/how|what|why|when|tutorial|guide/.test(k)) return 'informational';
  if (/login|sign in|contact|address/.test(k)) return 'navigational';
  return 'informational';
}

function inferTrend(monthlySearches) {
  if (!Array.isArray(monthlySearches) || monthlySearches.length < 3) return 'stable';
  const recent = monthlySearches.slice(-3).map((m) => m.search_volume ?? 0);
  const earlier = monthlySearches.slice(0, 3).map((m) => m.search_volume ?? 0);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length || 1;
  const delta = (recentAvg - earlierAvg) / earlierAvg;
  if (delta > 0.2) return 'rising';
  if (delta < -0.2) return 'declining';
  return 'stable';
}
