/**
 * Backlink data provider.
 *
 * Returns backlinks for a target domain. Dispatches to DataForSEO / Majestic /
 * Ahrefs when credentials are configured, otherwise returns Claude-estimated
 * example backlinks (explicitly marked via dataSource = 'claude_estimated').
 *
 * Shape returned by fetchBacklinks(domain, limit):
 *   {
 *     domain,
 *     backlinks: [
 *       {
 *         sourceDomain,
 *         sourceUrl,
 *         targetUrl,
 *         anchorText,
 *         domainAuthority,   // 0-100
 *         spamScore,         // 0-17 (Moz-style)
 *         linkType,          // 'dofollow' | 'nofollow' | 'ugc' | 'sponsored'
 *         firstSeen,         // ISO date
 *         lastSeen,          // ISO date
 *       }, ...
 *     ],
 *     dataSource: 'dataforseo' | 'majestic' | 'ahrefs' | 'claude_estimated',
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AI_MODEL,
  BACKLINK_PROVIDER,
  CLAUDE_ESTIMATED_SOURCE,
  hasRealBacklinkProvider,
} from './omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function fetchBacklinks(domain, limit = 50) {
  if (hasRealBacklinkProvider()) {
    try {
      if (BACKLINK_PROVIDER === 'dataforseo') return await fetchViaDataForSeo(domain, limit);
      if (BACKLINK_PROVIDER === 'majestic') return await fetchViaMajestic(domain, limit);
      if (BACKLINK_PROVIDER === 'ahrefs') return await fetchViaAhrefs(domain, limit);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[backlinkProvider] ${BACKLINK_PROVIDER} failed, falling back to Claude: ${err.message}`,
      );
    }
  }
  return estimateWithClaude(domain, limit);
}

// ─── DataForSEO ─────────────────────────────────────────────────────────────
async function fetchViaDataForSeo(domain, limit) {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString('base64');
  const endpoint = 'https://api.dataforseo.com/v3/backlinks/backlinks/live';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        target: domain,
        limit,
        mode: 'as_is',
        order_by: ['rank,desc'],
      },
    ]),
  });
  if (!res.ok) throw new Error(`DataForSEO ${res.status}`);
  const payload = await res.json();

  const items = payload?.tasks?.[0]?.result?.[0]?.items || [];
  const backlinks = items.map((b) => ({
    sourceDomain: b.domain_from,
    sourceUrl: b.url_from,
    targetUrl: b.url_to,
    anchorText: b.anchor || '',
    domainAuthority: Math.round(b.rank ?? 0),
    spamScore: b.is_broken ? 10 : 0,
    linkType: b.dofollow === false ? 'nofollow' : 'dofollow',
    firstSeen: b.first_seen || null,
    lastSeen: b.last_seen || null,
  }));

  return { domain, backlinks, dataSource: 'dataforseo' };
}

// ─── Majestic (stub) ────────────────────────────────────────────────────────
async function fetchViaMajestic(domain, limit) {
  const endpoint = 'https://api.majestic.com/api/json';
  const url = new URL(endpoint);
  url.searchParams.set('app_api_key', process.env.MAJESTIC_API_KEY);
  url.searchParams.set('cmd', 'GetBackLinkData');
  url.searchParams.set('item', domain);
  url.searchParams.set('Count', String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Majestic ${res.status}`);
  const payload = await res.json();
  const rows = payload?.DataTables?.BackLinks?.Data || [];
  const backlinks = rows.map((r) => ({
    sourceDomain: r.SourceURL ? new URL(r.SourceURL).hostname : '',
    sourceUrl: r.SourceURL,
    targetUrl: r.TargetURL,
    anchorText: r.AnchorText || '',
    domainAuthority: Number(r.SourceTrustFlow ?? 0),
    spamScore: 0,
    linkType: r.FlagNoFollow === '1' ? 'nofollow' : 'dofollow',
    firstSeen: r.FirstIndexedDate || null,
    lastSeen: r.LastSeenDate || null,
  }));
  return { domain, backlinks, dataSource: 'majestic' };
}

// ─── Ahrefs (stub) ──────────────────────────────────────────────────────────
async function fetchViaAhrefs(domain, limit) {
  const endpoint = 'https://api.ahrefs.com/v3/site-explorer/all-backlinks';
  const url = new URL(endpoint);
  url.searchParams.set('target', domain);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('mode', 'domain');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${process.env.AHREFS_API_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Ahrefs ${res.status}`);
  const payload = await res.json();
  const rows = payload?.backlinks || [];
  const backlinks = rows.map((r) => ({
    sourceDomain: r.domain_from,
    sourceUrl: r.url_from,
    targetUrl: r.url_to,
    anchorText: r.anchor || '',
    domainAuthority: Number(r.domain_rating_source ?? 0),
    spamScore: 0,
    linkType: r.nofollow ? 'nofollow' : 'dofollow',
    firstSeen: r.first_seen || null,
    lastSeen: r.last_seen || null,
  }));
  return { domain, backlinks, dataSource: 'ahrefs' };
}

// ─── Claude fallback ────────────────────────────────────────────────────────
async function estimateWithClaude(domain, limit) {
  const prompt = `You do NOT have live backlink data. Generate up to ${limit} REPRESENTATIVE (example) backlinks for domain "${domain}" with realistic anchors and DA values. Clearly label them as estimated. Return ONLY JSON of shape: {"backlinks":[{"sourceDomain":"","sourceUrl":"","targetUrl":"","anchorText":"","domainAuthority":0,"spamScore":0,"linkType":"dofollow","firstSeen":null,"lastSeen":null}]}.`;

  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  let backlinks = [];
  try {
    const text = response.content?.[0]?.text || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed.backlinks)) backlinks = parsed.backlinks;
  } catch {
    /* noop */
  }

  return { domain, backlinks, dataSource: CLAUDE_ESTIMATED_SOURCE };
}
