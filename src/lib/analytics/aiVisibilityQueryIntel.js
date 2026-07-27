/**
 * Local-market query intelligence for AI Visibility seeding.
 * Uses Anthropic (ANTHROPIC_API_KEY) to rewrite GSC queries into local service probes.
 */

import { prisma } from '../prisma.js';
import { generateChat, isAiConfigured, sanitizeUserInputForPrompt } from '../ai.js';

const GSC_CANDIDATE_LIMIT = 40;
const PROBE_LIMIT = 15;
const GSC_SEED_DAYS = 28;
export const AI_VIS_AUTO_NOTES_PREFIX = 'AI Visibility auto';

export function brandTokensForProject(project) {
  const tokens = new Set();
  const agency = String(project.client?.agencyName || '')
    .toLowerCase()
    .replace(/,?\s*(inc|llc|ltd|co)\.?$/i, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (agency) {
    tokens.add(agency);
    // First two words as brand phrase when available (e.g. "roman electric")
    const words = agency.split(/\s+/).filter((w) => w.length > 1);
    if (words.length >= 2) tokens.add(`${words[0]} ${words[1]}`);
    if (words[0]?.length >= 4) tokens.add(words[0]);
  }
  for (const s of [project.client?.websiteUrl, project.dataforseoDomain, project.gscSiteUrl].filter(Boolean)) {
    const cleaned = String(s)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/^sc-domain:/, '');
    const hostLabel = cleaned.split(/[./]/)[0];
    if (hostLabel && hostLabel.length >= 3) tokens.add(hostLabel);
  }
  return [...tokens];
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isBrandQuery(query, brandTokens) {
  const q = String(query || '').toLowerCase();
  return brandTokens.some((t) => {
    const token = String(t || '')
      .toLowerCase()
      .trim()
      .replace(/[.,]/g, ' ')
      .replace(/\s+/g, ' ');
    if (!token || token.length < 3) return false;
    // Multi-word brand phrases (e.g. "roman electric")
    if (token.includes(' ')) return q.includes(token);
    // Word-boundary so "electric" does not match "electrical"
    return new RegExp(`\\b${escapeRe(token)}\\b`, 'i').test(q);
  });
}

/** Parse first city-like token from intake keyMarkets (e.g. "US, Milwaukee; WI"). */
export function parseMarketFromKeyMarkets(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw
    .split(/[;|/]/)
    .flatMap((p) => p.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    // Skip country codes / short tokens
    if (p.length < 3 || /^[A-Z]{2}$/.test(p)) continue;
    if (/^(uk|us|usa|united states|england)$/i.test(p)) continue;
    return p;
  }
  return parts.find((p) => p.length >= 3) || null;
}

export async function resolveTargetMarket(project) {
  const direct = String(project.targetMarket || '').trim();
  if (direct) return { market: direct, source: 'project' };

  const intake = await prisma.intakeSubmission.findFirst({
    where: {
      OR: [{ projectId: project.id }, { clientId: project.clientId, projectId: null }],
    },
    orderBy: { submittedAt: 'desc' },
    select: { data: true },
  });
  const keyMarkets = intake?.data?.keyMarkets;
  const fromIntake = parseMarketFromKeyMarkets(keyMarkets);
  if (fromIntake) return { market: fromIntake, source: 'intake' };

  return { market: null, source: null };
}

async function loadGscCandidates(projectId, brandTokens) {
  const end = new Date();
  const start = new Date(end.getTime() - GSC_SEED_DAYS * 86400000);
  const rows = await prisma.gscQueryMetric.findMany({
    where: { projectId, date: { gte: start, lte: end } },
    orderBy: { impressions: 'desc' },
    take: 500,
  });

  const byQuery = new Map();
  for (const r of rows) {
    const acc = byQuery.get(r.query) || { query: r.query, impressions: 0, clicks: 0 };
    acc.impressions += r.impressions || 0;
    acc.clicks += r.clicks || 0;
    byQuery.set(r.query, acc);
  }

  const all = [...byQuery.values()].sort((a, b) => b.impressions - a.impressions);
  const generic = all.filter((q) => !isBrandQuery(q.query, brandTokens));
  const preferred = generic.length > 0 ? generic : all;

  return {
    candidates: preferred.slice(0, GSC_CANDIDATE_LIMIT),
    rangeStart: start,
    rangeEnd: end,
  };
}

function heuristicLocalize(candidates, market, brandTokens, limit = PROBE_LIMIT) {
  const marketLower = String(market || '').toLowerCase();
  const out = [];
  for (const c of candidates) {
    if (isBrandQuery(c.query, brandTokens)) continue;
    const q = c.query.trim();
    if (!q) continue;
    let probe = q;
    if (marketLower && !q.toLowerCase().includes(marketLower)) {
      probe = `${q} in ${market}`;
    }
    out.push({
      sourceQuery: q,
      probeQuery: probe.slice(0, 500),
      reason: market ? 'heuristic_local' : 'heuristic_passthrough',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build localized probe queries from GSC + Anthropic intelligence.
 * @returns {{ probes: Array<{sourceQuery, probeQuery, reason}>, rangeStart, rangeEnd, market, marketSource, warning }}
 */
export async function buildIntelligentProbeQueries(project, brandTokens) {
  const { candidates, rangeStart, rangeEnd } = await loadGscCandidates(project.id, brandTokens);
  if (candidates.length === 0) {
    return {
      probes: [],
      rangeStart,
      rangeEnd,
      market: null,
      marketSource: null,
      warning: 'No GSC queries available — sync Search Console data first',
    };
  }

  const { market, source: marketSource } = await resolveTargetMarket(project);
  const brandNames = [
    project.client?.agencyName,
    ...brandTokens,
  ].filter(Boolean);

  if (!market) {
    const probes = heuristicLocalize(candidates, null, brandTokens);
    return {
      probes,
      rangeStart,
      rangeEnd,
      market: null,
      marketSource: null,
      warning:
        'No target market set — using generic GSC queries. Set Project targetMarket (e.g. Milwaukee) for local rewrites.',
    };
  }

  if (!isAiConfigured()) {
    return {
      probes: heuristicLocalize(candidates, market, brandTokens),
      rangeStart,
      rangeEnd,
      market,
      marketSource,
      warning: 'ANTHROPIC_API_KEY not set — used heuristic "in {market}" rewrites',
    };
  }

  const candidateList = candidates.map((c) => c.query);
  const system = `You select and rewrite Google Search Console queries into local-service AI visibility probes.
Rules:
- Prefer commercial/service intent (contractors, plumbing, electrical, repair, installation, etc.).
- Drop branded queries for the client (names in brandNames).
- Drop irrelevant landmarks, stations, pure navigational queries, and queries that are not local services.
- Rewrite each kept query into a natural local probe that includes the target market (e.g. "commercial plumbing services" → "commercial plumbing services in milwaukee").
- If the query already contains the market, keep it (normalize casing lightly).
- Return at most ${PROBE_LIMIT} items.
- Respond with JSON only: { "probes": [ { "sourceQuery": string, "probeQuery": string, "reason": string } ] }`;

  const user = JSON.stringify({
    targetMarket: market,
    brandNames,
    candidates: candidateList,
  });

  try {
    const { parsed, text } = await generateChat({
      system,
      user: sanitizeUserInputForPrompt(user, 12000),
      json: true,
      maxTokens: 2000,
      temperature: 0.2,
      feature: 'ai_visibility_query_intel',
      clientId: project.clientId || null,
    });

    let probes = parsed?.probes;
    if (!Array.isArray(probes)) {
      try {
        const fallback = JSON.parse(text);
        probes = fallback?.probes;
      } catch {
        probes = null;
      }
    }

    if (!Array.isArray(probes) || probes.length === 0) {
      return {
        probes: heuristicLocalize(candidates, market, brandTokens),
        rangeStart,
        rangeEnd,
        market,
        marketSource,
        warning: 'Claude returned no probes — used heuristic local rewrites',
      };
    }

    const cleaned = [];
    const seen = new Set();
    for (const p of probes) {
      const sourceQuery = String(p.sourceQuery || p.source || '').trim();
      let probeQuery = String(p.probeQuery || p.probe || '').trim();
      if (!probeQuery && sourceQuery) {
        probeQuery = sourceQuery.toLowerCase().includes(market.toLowerCase())
          ? sourceQuery
          : `${sourceQuery} in ${market}`;
      }
      if (!probeQuery) continue;
      if (isBrandQuery(probeQuery, brandTokens) || isBrandQuery(sourceQuery, brandTokens)) continue;
      const key = probeQuery.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({
        sourceQuery: (sourceQuery || probeQuery).slice(0, 500),
        probeQuery: probeQuery.slice(0, 500),
        reason: String(p.reason || 'claude').slice(0, 200),
      });
      if (cleaned.length >= PROBE_LIMIT) break;
    }

    if (cleaned.length === 0) {
      return {
        probes: heuristicLocalize(candidates, market, brandTokens),
        rangeStart,
        rangeEnd,
        market,
        marketSource,
        warning: 'Claude filters removed all queries — used heuristic local rewrites',
      };
    }

    return {
      probes: cleaned,
      rangeStart,
      rangeEnd,
      market,
      marketSource,
      warning: null,
    };
  } catch (err) {
    return {
      probes: heuristicLocalize(candidates, market, brandTokens),
      rangeStart,
      rangeEnd,
      market,
      marketSource,
      warning: `Claude rewrite failed (${err.message}) — used heuristic local rewrites`,
    };
  }
}
