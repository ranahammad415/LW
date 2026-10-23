/**
 * Aggregate GSC / GA4 / optional SEO·GMB·LLM facts for the AI HTML report.
 * Reuses section builders — no live Google API calls.
 */
import { prisma } from '../../prisma.js';
import {
  buildGscView,
  buildGa4View,
  buildGmbView,
  buildSeoView,
  buildLlmView,
  buildBingView,
} from '../sectionBuilders.js';
import { clientHealthAt } from '../../health/healthViews.js';

const TOP_N = 18;

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function humanRangeLabel(start, end) {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

/** Lower position is better for SEO. */
function isPositiveDelta(metricKey, delta) {
  if (delta == null || Number.isNaN(Number(delta))) return null;
  const d = Number(delta);
  if (metricKey === 'position' || metricKey === 'bounceRate') return d < 0;
  return d > 0;
}

function kpiCard({ source, key, label, value, prevValue, delta, format }) {
  const positive = isPositiveDelta(key, delta);
  let tag = 'neutral';
  if (positive === true) tag = 'win';
  else if (positive === false) tag = 'context';
  return {
    source, // gsc | ga4 | gmb | llm | seo
    key,
    label,
    value,
    prevValue: prevValue ?? null,
    delta: delta ?? null,
    format: format || 'number',
    tag, // win | context | neutral
    positive,
  };
}

function formatDisplayValue(value, format) {
  if (value == null) return '—';
  if (format === 'pct') return `${Number(value).toFixed(1)}%`;
  if (format === 'position') return Number(value).toFixed(2);
  if (format === 'rate') return `${Number(value).toFixed(2)}%`;
  if (typeof value === 'number' && Math.abs(value) >= 1000) {
    return value >= 10000 ? `${(value / 1000).toFixed(1)}K` : value.toLocaleString('en-US');
  }
  return typeof value === 'number' ? String(value) : String(value);
}

/**
 * @param {{ clientIds: string[], start: string, end: string, compare?: boolean, compareYoY?: boolean }} opts
 */
export async function aggregateReportFacts({ clientIds, start, end, compare = true, compareYoY = true }) {
  if (!clientIds?.length) {
    return { error: { status: 400, message: 'No client in scope', emptyReason: 'No client in scope' } };
  }

  const query = {
    start,
    end,
    compare: compare === false ? '0' : '1',
    compareYoY: compareYoY === false ? '0' : '1',
  };

  const [gsc, ga4, gmb, seo, llm, client, bingOverview, bingQueries] = await Promise.all([
    buildGscView(clientIds, 'all', query),
    buildGa4View(clientIds, 'channels', query),
    buildGmbView(clientIds, 'overview', query).catch(() => null),
    buildSeoView(clientIds, 'keywords', query).catch(() => null),
    buildLlmView(clientIds, 'visibility', query).catch(() => null),
    prisma.clientAccount.findUnique({
      where: { id: clientIds[0] },
      select: { id: true, agencyName: true, websiteUrl: true },
    }),
    buildBingView(clientIds, 'overview', query).catch(() => null),
    buildBingView(clientIds, 'queries', query).catch(() => null),
  ]);

  if (gsc?.status) return { error: gsc };
  if (ga4?.status) return { error: ga4 };

  const gscLinked = !!gsc?.linked;
  const ga4Linked = !!ga4?.linked;
  if (!gscLinked && !ga4Linked) {
    return {
      error: {
        status: 400,
        message: 'Connect GSC or GA4 in Admin → Integrations before generating a report',
        emptyReason: gsc?.emptyReason || ga4?.emptyReason || 'No analytics data linked',
      },
    };
  }

  const gscK = gscLinked ? gsc.data?.kpis || {} : {};
  const ga4K = ga4Linked ? ga4.data?.kpis || {} : {};
  const gscQueries = gscLinked ? (gsc.data?.queries || []).slice(0, TOP_N) : [];
  const landingPages = ga4Linked ? (ga4.data?.landingPages || []).slice(0, TOP_N) : [];
  const channels = ga4Linked ? (ga4.data?.channels || []).slice(0, 8) : [];
  const devices = ga4Linked ? (ga4.data?.devices || []).slice(0, 6) : [];

  // Derive prev absolute values from deltas when possible: curr = prev * (1 + d/100)
  function prevFromDelta(curr, delta) {
    if (curr == null || delta == null) return null;
    if (delta === -100) return null;
    const p = curr / (1 + delta / 100);
    return Number.isFinite(p) ? Math.round(p * 100) / 100 : null;
  }

  const kpiCards = [];

  if (gscLinked) {
    kpiCards.push(
      kpiCard({
        source: 'gsc',
        key: 'clicks',
        label: 'Total Clicks',
        value: gscK.clicks ?? 0,
        prevValue: prevFromDelta(gscK.clicks, gscK.clicksDelta),
        delta: gscK.clicksDelta,
      }),
      kpiCard({
        source: 'gsc',
        key: 'impressions',
        label: 'Total Impressions',
        value: gscK.impressions ?? 0,
        prevValue: prevFromDelta(gscK.impressions, gscK.impressionsDelta),
        delta: gscK.impressionsDelta,
      }),
      kpiCard({
        source: 'gsc',
        key: 'ctr',
        label: 'Average CTR',
        value: gscK.ctr ?? 0,
        prevValue: prevFromDelta(gscK.ctr, gscK.ctrDelta),
        delta: gscK.ctrDelta,
        format: 'rate',
      }),
      kpiCard({
        source: 'gsc',
        key: 'position',
        label: 'Average Position',
        value: gscK.position ?? 0,
        prevValue: prevFromDelta(gscK.position, gscK.positionDelta),
        delta: gscK.positionDelta,
        format: 'position',
      })
    );
  }

  if (ga4Linked) {
    // GA4 API bounce is usually 0–1; normalize to percent for the report.
    const bouncePct = normalizeBouncePct(ga4K.bounceRate);
    const bouncePrevRaw = prevFromDelta(ga4K.bounceRate, ga4K.bounceRateDelta);
    const bouncePrevPct = bouncePrevRaw != null ? normalizeBouncePct(bouncePrevRaw) : null;
    kpiCards.push(
      kpiCard({
        source: 'ga4',
        key: 'users',
        label: 'Active Users',
        value: ga4K.users ?? 0,
        prevValue: prevFromDelta(ga4K.users, ga4K.usersDelta),
        delta: ga4K.usersDelta,
      }),
      kpiCard({
        source: 'ga4',
        key: 'sessions',
        label: 'Sessions',
        value: ga4K.sessions ?? 0,
        prevValue: prevFromDelta(ga4K.sessions, ga4K.sessionsDelta),
        delta: ga4K.sessionsDelta,
      }),
      kpiCard({
        source: 'ga4',
        key: 'bounceRate',
        label: 'Bounce Rate',
        value: bouncePct,
        prevValue: bouncePrevPct,
        delta: ga4K.bounceRateDelta,
        format: 'pct',
      }),
      kpiCard({
        source: 'ga4',
        key: 'conversions',
        label: 'Conversions',
        value: ga4K.conversions ?? 0,
        prevValue: prevFromDelta(ga4K.conversions, ga4K.conversionsDelta),
        delta: ga4K.conversionsDelta,
      })
    );
  }

  // Bing Webmaster (features/bing-webmaster.md): one KPI card when a Bing site is bound (never invented when unlinked).
  const bing = bingFactsForAi(bingOverview, bingQueries);
  if (bing) {
    kpiCards.push(
      kpiCard({
        source: 'bing',
        key: 'bingClicks',
        label: 'Bing Clicks',
        value: bing.kpis.clicks,
        prevValue: prevFromDelta(bing.kpis.clicks, bing.kpis.clicksDelta),
        delta: bing.kpis.clicksDelta,
      })
    );
  }

  // Channel surge as optional win card
  const topChannelGain = channels
    .map((c) => ({
      name: c.channel || c.name || c.sessionDefaultChannelGroup || 'Unknown',
      sessions: c.sessions ?? c.value ?? 0,
    }))
    .sort((a, b) => b.sessions - a.sessions)[0];

  const wins = kpiCards.filter((k) => k.tag === 'win');
  const weaks = kpiCards.filter((k) => k.tag === 'context');

  // Health score v2 (docs/ledger/features/health-score.md): the stored client score as of the report end, else the
  // frozen month snapshot's health block. Never a made-up value: null when there is no score.
  const health = await reportHealth(clientIds[0], end);
  const healthScore = health?.score ?? null;
  const healthCoverage = health?.coverage ?? null;
  const healthBand = health?.band ?? null;

  // Page / query rows for table + chart
  const pageRows = landingPages.length
    ? landingPages.map((p) => ({
        page: p.landingPage || p.page || p.path || p.name || '—',
        sessions: p.sessions ?? 0,
        users: p.totalUsers ?? p.users ?? 0,
        bounceRate: p.bounceRate ?? null,
        conversions: p.conversions ?? null,
        kind: 'landing',
      }))
    : gscQueries.map((q) => ({
        page: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
        kind: 'query',
      }));

  const chartPages = (landingPages.length ? landingPages : gscQueries).slice(0, 8).map((row) => {
    if (landingPages.length) {
      return {
        label: shortenLabel(row.landingPage || row.page || row.path || row.name || '—'),
        current: row.sessions ?? 0,
        previous: 0,
      };
    }
    return {
      label: shortenLabel(row.query),
      current: row.clicks ?? 0,
      previous: 0,
    };
  });

  const chartChannels = channels.map((c) => ({
    label: c.channel || c.name || c.sessionDefaultChannelGroup || 'Other',
    value: c.sessions ?? c.value ?? 0,
  }));

  const chartDevices = devices.map((d) => ({
    label: d.deviceCategory || d.device || d.name || 'Other',
    current: d.sessions ?? d.value ?? 0,
    previous: 0,
  }));

  const range = gsc?.range || ga4?.range || { start, end, label: humanRangeLabel(start, end) };
  const prevRange =
    compare !== false && range?.start && range?.end
      ? (() => {
          const s = new Date(`${range.start}T00:00:00.000Z`);
          const e = new Date(`${range.end}T00:00:00.000Z`);
          const len = Math.round((e - s) / 86400000) + 1;
          const prevEnd = new Date(s.getTime() - 86400000);
          const prevStart = new Date(prevEnd.getTime() - (len - 1) * 86400000);
          return {
            start: prevStart.toISOString().slice(0, 10),
            end: prevEnd.toISOString().slice(0, 10),
            label: humanRangeLabel(prevStart.toISOString().slice(0, 10), prevEnd.toISOString().slice(0, 10)),
          };
        })()
      : null;
  const yoyRange =
    compareYoY !== false && range?.start && range?.end
      ? gsc?.range?.yoy ||
        ga4?.range?.yoy ||
        (() => {
          const shift = (iso) => {
            const d = new Date(`${iso}T00:00:00.000Z`);
            const y = d.getUTCFullYear() - 1;
            const m = d.getUTCMonth();
            const day = d.getUTCDate();
            const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
            return new Date(Date.UTC(y, m, Math.min(day, lastDay))).toISOString().slice(0, 10);
          };
          const ys = shift(range.start);
          const ye = shift(range.end);
          return { start: ys, end: ye, label: humanRangeLabel(ys, ye) };
        })()
      : null;

  const brandName = client?.agencyName || 'Performance Report';
  const websiteUrl = client?.websiteUrl || '';
  const sources = [];
  if (gscLinked) sources.push('GSC');
  if (ga4Linked) sources.push('GA4');
  if (seo?.linked) sources.push('DataForSEO');
  if (gmb?.linked) sources.push('GMB');
  if (bing) sources.push('Bing');
  if (llm?.linked !== false && llm?.data) sources.push('AI Visibility');

  const optional = {};
  if (seo?.linked && seo.data?.kpis) {
    optional.seo = {
      kpis: seo.data.kpis,
      topKeywords: (seo.data.keywords || []).slice(0, 12),
    };
  }
  if (gmb?.linked && gmb.data?.kpis) {
    optional.gmb = gmbFactsForAi(gmb.data);
  }
  if (llm?.data?.kpis) {
    optional.llm = { kpis: llm.data.kpis };
  }
  if (bing) optional.bing = bing;

  // Compact AI payload
  const factsForAi = {
    brand: brandName,
    website: websiteUrl,
    range: { current: range, previous: prevRange, yoy: yoyRange },
    sources,
    healthScore,
    healthCoverage,
    healthBand,
    wins: wins.map((w) => ({
      source: w.source,
      label: w.label,
      value: formatDisplayValue(w.value, w.format),
      delta: w.delta,
      prevValue: w.prevValue != null ? formatDisplayValue(w.prevValue, w.format) : null,
    })),
    weaks: weaks.map((w) => ({
      source: w.source,
      label: w.label,
      value: formatDisplayValue(w.value, w.format),
      delta: w.delta,
      prevValue: w.prevValue != null ? formatDisplayValue(w.prevValue, w.format) : null,
    })),
    gsc: gscLinked
      ? {
          kpis: gscK,
          topQueries: gscQueries.slice(0, 12).map((q) => ({
            query: q.query,
            clicks: q.clicks,
            impressions: q.impressions,
            ctr: q.ctr,
            position: q.position,
          })),
          rankings: gsc.data?.rankings
            ? {
                top3: gsc.data.rankings.top3,
                top10: gsc.data.rankings.top10,
                top20: gsc.data.rankings.top20,
              }
            : null,
        }
      : null,
    ga4: ga4Linked
      ? {
          kpis: ga4K,
          topChannels: chartChannels.slice(0, 6),
          topLandingPages: landingPages.slice(0, 10).map((p) => ({
            page: p.landingPage || p.page || p.path || p.name,
            sessions: p.sessions ?? 0,
            users: p.totalUsers ?? p.users ?? 0,
          })),
          topChannel: topChannelGain || null,
        }
      : null,
    optional,
  };

  return {
    facts: {
      brandName,
      websiteUrl,
      sources,
      range,
      prevRange,
      yoyRange,
      healthScore,
      healthCoverage,
      healthBand,
      kpiCards,
      wins,
      weaks,
      pageRows,
      chartPages,
      chartChannels,
      chartDevices,
      pageTableKind: landingPages.length ? 'landing' : 'query',
      factsForAi,
    },
  };
}

/**
 * Business Profile facts for the narrative (features/local-seo.md). Rating and total reviews come from the stored
 * profile; new reviews / reply rate are the period's. Without native Business Profile access the owner metrics are
 * null (missing, NOT zero) and `metricsLimited` + `note` tell the model never to report them as 0. Pure.
 */
export function gmbFactsForAi(data) {
  const k = data?.kpis || {};
  const limited = !!data?.metricsLimited;
  const kpis = {
    rating: k.rating ?? null,
    reviewsTotal: k.reviews ?? null,
    newReviews: k.newReviews ?? null,
    replyRate: k.replyRate ?? null,
    periodRating: k.periodRating ?? null,
    impressions: limited ? null : k.impressions ?? null,
    calls: limited ? null : k.calls ?? null,
    directions: limited ? null : k.directions ?? null,
    websiteClicks: limited ? null : k.websiteClicks ?? null,
  };
  if (!limited) {
    kpis.impressionsDelta = k.impressionsDelta ?? null;
    kpis.callsDelta = k.callsDelta ?? null;
    kpis.directionsDelta = k.directionsDelta ?? null;
    kpis.websiteClicksDelta = k.websiteClicksDelta ?? null;
  }
  return {
    metricsLimited: limited,
    note: limited
      ? 'Calls, directions, website clicks and impressions are not available (Google Business Profile access is not connected yet). They are missing data, not zero: do not mention them as numbers.'
      : null,
    kpis,
  };
}

/**
 * Bing facts for the KPI row and the narrative (features/bing-webmaster.md): null when no Bing site is bound (the
 * narrative must then not mention Bing numbers at all). clicks / impressions / deltas / share of (Google + Bing)
 * search clicks / top 5 queries of the weeks in the period. Pure.
 */
export function bingFactsForAi(overview, queries) {
  if (!overview?.linked || !overview.data?.kpis) return null;
  const k = overview.data.kpis;
  return {
    kpis: {
      clicks: k.clicks ?? 0,
      impressions: k.impressions ?? 0,
      clicksDelta: k.clicksDelta ?? null,
      impressionsDelta: k.impressionsDelta ?? null,
      shareOfSearchClicksPct: overview.data.compare?.bingShareClicks ?? null,
    },
    topQueries: (queries?.data?.queries || []).slice(0, 5).map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions })),
    note: 'Bing figures come from Bing Webmaster Tools (daily clicks and impressions; top queries are weekly). Report them only as given.',
  };
}

/** Stored health as of `end` (YYYY-MM-DD or Date), else the frozen snapshot of that month; null when neither. */
async function reportHealth(clientId, end) {
  if (!clientId || !end) return null;
  try {
    const live = await clientHealthAt(clientId, end);
    if (live) return live;
    const d = new Date(typeof end === 'string' ? `${end.slice(0, 10)}T00:00:00Z` : end);
    const snap = await prisma.workCycleAnalyticsSnapshot.findFirst({
      where: { clientId, workCycle: { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() } },
      select: { data: true },
    });
    const h = snap?.data?.health;
    return h && typeof h === 'object' ? h : null;
  } catch {
    return null;
  }
}

function shortenLabel(s, max = 36) {
  const t = String(s || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** GA4 bounceRate is often 0–1; convert to 0–100 when needed. */
function normalizeBouncePct(v) {
  if (v == null || Number.isNaN(Number(v))) return 0;
  const n = Number(v);
  return n <= 1 ? Number((n * 100).toFixed(1)) : Number(n.toFixed(1));
}
