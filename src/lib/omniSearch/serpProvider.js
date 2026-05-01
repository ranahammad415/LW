/**
 * SERP data provider.
 *
 * Returns ranking positions for a keyword across search engines.
 * Dispatches to a configured real provider (SerpAPI or DataForSEO) when
 * credentials are present, otherwise falls back to Claude-estimated positions.
 *
 * Shape returned by lookupSerpPosition:
 *   {
 *     keyword,
 *     engine,
 *     country,
 *     position: number|null,   // 1-100 or null if not ranking in top 100
 *     url: string|null,        // ranking URL if known
 *     dataSource: 'serpapi' | 'dataforseo' | 'claude_estimated',
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Main entry point.
 */
export async function lookupSerpPosition({ keyword, domain, engine = 'google', country = 'US' }) {
  if (hasRealSerpProvider()) {
    try {
      if (SERP_PROVIDER === 'serpapi') {
        return await lookupViaSerpApi({ keyword, domain, engine, country });
      }
      if (SERP_PROVIDER === 'dataforseo') {
        return await lookupViaDataForSeo({ keyword, domain, engine, country });
      }
    } catch (err) {
      // Any provider failure falls through to Claude estimate with a note.
      // eslint-disable-next-line no-console
      console.warn(`[serpProvider] ${SERP_PROVIDER} failed, falling back to Claude: ${err.message}`);
    }
  }
  return estimateWithClaude({ keyword, domain, engine, country });
}

// ─── SerpAPI ────────────────────────────────────────────────────────────────
async function lookupViaSerpApi({ keyword, domain, engine, country }) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', keyword);
  url.searchParams.set('engine', engine);
  url.searchParams.set('gl', country.toLowerCase());
  url.searchParams.set('num', '100');
  url.searchParams.set('api_key', process.env.SERPAPI_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  const data = await res.json();

  const results = data.organic_results || [];
  const normalizedDomain = normalizeDomain(domain);
  let position = null;
  let matchedUrl = null;
  for (const r of results) {
    if (normalizeDomain(r.link || '').includes(normalizedDomain)) {
      position = r.position;
      matchedUrl = r.link;
      break;
    }
  }

  return {
    keyword,
    engine,
    country,
    position,
    url: matchedUrl,
    dataSource: 'serpapi',
    raw: data,
  };
}

// ─── DataForSEO ─────────────────────────────────────────────────────────────
async function lookupViaDataForSeo({ keyword, domain, engine, country }) {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString('base64');
  const endpoint = 'https://api.dataforseo.com/v3/serp/google/organic/live/regular';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        keyword,
        location_code: countryToDfsCode(country),
        language_code: 'en',
        depth: 100,
      },
    ]),
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}`);
  const payload = await res.json();

  const items = payload?.tasks?.[0]?.result?.[0]?.items || [];
  const normalizedDomain = normalizeDomain(domain);
  let position = null;
  let matchedUrl = null;
  for (const item of items) {
    if (item.type !== 'organic') continue;
    if (normalizeDomain(item.url || '').includes(normalizedDomain)) {
      position = item.rank_absolute;
      matchedUrl = item.url;
      break;
    }
  }

  return {
    keyword,
    engine,
    country,
    position,
    url: matchedUrl,
    dataSource: 'dataforseo',
    raw: payload,
  };
}

// ─── Claude fallback ────────────────────────────────────────────────────────
async function estimateWithClaude({ keyword, domain, engine, country }) {
  const prompt = `Estimate an approximate Google-style SERP position for domain "${domain}" on the query "${keyword}" in ${country}. You do NOT have live data. Return ONLY JSON: {"position": <1-100 or null>, "confidence": "low"}.`;
  const response = await anthropic.messages.create({
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
function normalizeDomain(input) {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function countryToDfsCode(country) {
  const map = { US: 2840, GB: 2826, CA: 2124, AU: 2036, DE: 2276, FR: 2250, IN: 2356 };
  return map[country?.toUpperCase()] || 2840;
}
