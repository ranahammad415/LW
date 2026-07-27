/**
 * DataForSEO LLM Mentions / AI Optimization helpers.
 * @see https://dataforseo.com/help-center/how-to-get-llm-citation-data-with-llm-mentions-api
 */

import { postDataForSeo } from './client.js';
import { domainFromUrl } from '../analytics/providers.js';

export function isDataForSeoConfigured() {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function firstTaskResult(json) {
  const task = json?.tasks?.[0];
  if (!task) return { ok: false, error: 'No DataForSEO task returned', raw: json };
  if (task.status_code && task.status_code >= 40000) {
    return { ok: false, error: task.status_message || `DFS status ${task.status_code}`, raw: json };
  }
  return { ok: true, result: task.result || [], raw: json };
}

/**
 * Pull target metrics for a domain across ChatGPT + Google AI Overview.
 * @param {string} domain
 * @param {{ locationCode?: number, languageCode?: string }} [opts]
 */
export async function fetchLlmTargetMetrics(domain, opts = {}) {
  const clean = domainFromUrl(domain);
  if (!clean) throw new Error('Domain is required for LLM Mentions');

  const locationCode = opts.locationCode || 2840; // United States
  const languageCode = opts.languageCode || 'en';

  const payload = [];
  for (const platform of ['chat_gpt', 'google']) {
    payload.push({
      target: [{ domain: clean, search_scope: ['sources'], search_filter: 'include' }],
      platform,
      location_code: locationCode,
      language_code: languageCode,
    });
  }

  try {
    const json = await postDataForSeo('/v3/ai_optimization/llm_mentions/target_metrics/live', payload);
    const { ok, error, raw } = firstTaskResult(json);
    const tasks = json?.tasks || [];
    const byPlatform = {};
    let totalMentions = 0;
    let aiSearchVolume = 0;
    let topDomains = [];
    for (const task of tasks) {
      const platform = task?.data?.platform || 'unknown';
      const metrics = task?.result?.[0] || {};
      const mentions =
        Number(
          metrics.total_count ??
            metrics.mentions ??
            metrics.mention_count ??
            metrics.platform_mentions ??
            0
        ) || 0;
      const volume = Number(metrics.ai_search_volume ?? metrics.search_volume ?? 0) || 0;
      const mentioned =
        metrics.top_domains ||
        metrics.mentioned_domains ||
        metrics.items ||
        [];
      if (Array.isArray(mentioned)) {
        for (const m of mentioned.slice(0, 10)) {
          const d = typeof m === 'string' ? m : m.domain || m.url;
          if (d) topDomains.push(String(d).toLowerCase());
        }
      }
      byPlatform[platform] = { platform, mentions, aiSearchVolume: volume, raw: metrics };
      totalMentions += mentions;
      aiSearchVolume += volume;
    }

    return {
      ok: ok || tasks.some((t) => (t.status_code || 0) < 40000),
      domain: clean,
      totalMentions,
      aiSearchVolume,
      byPlatform,
      topDomains: [...new Set(topDomains)].slice(0, 20),
      error: ok ? null : error,
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      domain: clean,
      totalMentions: 0,
      aiSearchVolume: 0,
      byPlatform: {},
      topDomains: [],
      error: err.message,
      raw: null,
    };
  }
}

/**
 * Search mentions / top sources for a domain (best-effort; API shapes vary).
 */
export async function fetchLlmSearchMentions(domain, opts = {}) {
  const clean = domainFromUrl(domain);
  if (!clean) throw new Error('Domain is required');

  const locationCode = opts.locationCode || 2840;
  const languageCode = opts.languageCode || 'en';
  const platform = opts.platform || 'chat_gpt';

  try {
    const json = await postDataForSeo('/v3/ai_optimization/llm_mentions/search_mentions/live', [
      {
        target: [{ domain: clean, search_scope: ['sources'], search_filter: 'include' }],
        platform,
        location_code: locationCode,
        language_code: languageCode,
        limit: 20,
        order_by: ['ai_search_volume,desc'],
      },
    ]);
    const task = json?.tasks?.[0];
    if (task?.status_code && task.status_code >= 40000) {
      return {
        ok: false,
        platform,
        topDomains: [],
        items: [],
        error: task.status_message || `DFS ${task.status_code}`,
        raw: json,
      };
    }
    const items = task?.result?.[0]?.items || [];
    const list = Array.isArray(items) ? items : [];
    const topDomains = [];
    for (const item of list.slice(0, 20)) {
      const sources = item.sources || item.mentioned_domains || [];
      if (Array.isArray(sources)) {
        for (const s of sources) {
          const d = typeof s === 'string' ? s : s?.domain || s?.url;
          if (d) topDomains.push(String(d));
        }
      }
      if (item.domain) topDomains.push(item.domain);
      if (item.source_domain) topDomains.push(item.source_domain);
    }
    const uniq = [...new Set(topDomains.map((d) => String(d).toLowerCase()))].slice(0, 15);
    return {
      ok: true,
      platform,
      totalCount: Number(task?.result?.[0]?.total_count || 0),
      topDomains: uniq,
      items: list.slice(0, 10),
      raw: json,
    };
  } catch (err) {
    return { ok: false, platform, topDomains: [], items: [], error: err.message, raw: null };
  }
}

/**
 * Combined DFS snapshot for an AI Visibility run.
 */
export async function buildDfsVisibilitySnapshot(domain) {
  if (!isDataForSeoConfigured()) {
    return {
      ok: false,
      skipped: true,
      error: 'DataForSEO credentials are not configured',
      domain: domainFromUrl(domain || ''),
    };
  }
  const clean = domainFromUrl(domain || '');
  if (!clean) {
    return { ok: false, skipped: true, error: 'No DataForSEO domain set on project', domain: '' };
  }

  const metrics = await fetchLlmTargetMetrics(clean);
  const chatMentions = await fetchLlmSearchMentions(clean, { platform: 'chat_gpt' });
  const googleMentions = await fetchLlmSearchMentions(clean, { platform: 'google' });

  return {
    ok: metrics.ok || chatMentions.ok || googleMentions.ok,
    domain: clean,
    totalMentions: metrics.totalMentions,
    aiSearchVolume: metrics.aiSearchVolume,
    byPlatform: metrics.byPlatform,
    topDomains: [
      ...new Set([
        ...(metrics.topDomains || []),
        ...(chatMentions.topDomains || []),
        ...(googleMentions.topDomains || []),
      ]),
    ]
      .filter((d) => d && d !== clean && d !== `www.${clean}`)
      .slice(0, 20),
    searchMentions: {
      chat_gpt: {
        ok: chatMentions.ok,
        totalCount: chatMentions.totalCount || 0,
        topDomains: chatMentions.topDomains,
        error: chatMentions.error || null,
      },
      google: {
        ok: googleMentions.ok,
        totalCount: googleMentions.totalCount || 0,
        topDomains: googleMentions.topDomains,
        error: googleMentions.error || null,
      },
    },
    error: metrics.error || null,
    fetchedAt: new Date().toISOString(),
  };
}
