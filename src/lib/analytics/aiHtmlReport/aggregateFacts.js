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
} from '../sectionBuilders.js';

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
 * @param {{ clientIds: string[], start: string, end: string, compare?: boolean }} opts
 */
export async function aggregateReportFacts({ clientIds, start, end, compare = true }) {
  if (!clientIds?.length) {
    return { error: { status: 400, message: 'No client in scope', emptyReason: 'No client in scope' } };
  }

  const query = {
    start,
    end,
    compare: compare === false ? '0' : '1',
  };

  const [gsc, ga4, gmb, seo, llm, client] = await Promise.all([
    buildGscView(clientIds, 'all', query),
    buildGa4View(clientIds, 'channels', query),
    buildGmbView(clientIds, 'overview', query).catch(() => null),
    buildSeoView(clientIds, 'keywords', query).catch(() => null),
    buildLlmView(clientIds, 'visibility', query).catch(() => null),
    prisma.clientAccount.findUnique({
      where: { id: clientIds[0] },
      select: { id: true, agencyName: true, websiteUrl: true },
    }),
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

  // Channel surge as optional win card
  const topChannelGain = channels
    .map((c) => ({
      name: c.channel || c.name || c.sessionDefaultChannelGroup || 'Unknown',
      sessions: c.sessions ?? c.value ?? 0,
    }))
    .sort((a, b) => b.sessions - a.sessions)[0];

  const wins = kpiCards.filter((k) => k.tag === 'win');
  const weaks = kpiCards.filter((k) => k.tag === 'context');

  const scored = kpiCards.filter((k) => k.positive !== null);
  const winCount = scored.filter((k) => k.positive).length;
  const healthScore = scored.length ? Math.round((winCount / scored.length) * 100) : 50;

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

  const brandName = client?.agencyName || 'Performance Report';
  const websiteUrl = client?.websiteUrl || '';
  const sources = [];
  if (gscLinked) sources.push('GSC');
  if (ga4Linked) sources.push('GA4');
  if (seo?.linked) sources.push('DataForSEO');
  if (gmb?.linked) sources.push('GMB');
  if (llm?.linked !== false && llm?.data) sources.push('AI Visibility');

  const optional = {};
  if (seo?.linked && seo.data?.kpis) {
    optional.seo = {
      kpis: seo.data.kpis,
      topKeywords: (seo.data.keywords || []).slice(0, 12),
    };
  }
  if (gmb?.linked && gmb.data?.kpis) {
    optional.gmb = { kpis: gmb.data.kpis };
  }
  if (llm?.data?.kpis) {
    optional.llm = { kpis: llm.data.kpis };
  }

  // Compact AI payload
  const factsForAi = {
    brand: brandName,
    website: websiteUrl,
    range: { current: range, previous: prevRange },
    sources,
    healthScore,
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
      healthScore,
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
