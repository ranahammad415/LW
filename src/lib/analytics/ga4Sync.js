import { prisma } from '../prisma.js';
import { runGa4Report } from './ga4Client.js';

const LLM_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'copilot.microsoft.com'];

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

/** Health score v2 quick win: daily AI-assistant referrals (LlmReferralDaily). Source substrings → platform. */
const LLM_SOURCE_TOKENS = ['chatgpt', 'openai', 'claude', 'gemini', 'perplexity', 'copilot'];

export function llmPlatform(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('chatgpt') || s.includes('openai')) return 'chatgpt';
  if (s.includes('claude')) return 'claude';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('perplexity')) return 'perplexity';
  if (s.includes('copilot')) return 'copilot';
  return 'other';
}

/** GA4 FilterExpression: sessionSource contains any LLM token (case-insensitive). */
export const LLM_SOURCE_FILTER = Object.freeze({
  orGroup: {
    expressions: LLM_SOURCE_TOKENS.map((value) => ({
      filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value, caseSensitive: false } },
    })),
  },
});

/** Pure: GA4 rows {date: YYYYMMDD, sessionSource, sessions} → [{date: YYYY-MM-DD, platform, sessions}] summed per day+platform. */
export function llmReferralRows(rows) {
  const acc = new Map();
  for (const r of rows || []) {
    const d = String(r.date || '');
    if (d.length !== 8) continue;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const platform = llmPlatform(r.sessionSource);
    const key = `${date}|${platform}`;
    acc.set(key, (acc.get(key) || 0) + Math.round(Number(r.sessions) || 0));
  }
  return [...acc].map(([k, sessions]) => {
    const [date, platform] = k.split('|');
    return { date, platform, sessions };
  });
}

/** One extra GA4 report per project per sync (dimensions date × sessionSource, LLM sources only); upserts per day+platform. */
export async function syncLlmReferrals(project, start, end, { report = runGa4Report } = {}) {
  const rows = await report(project.ga4PropertyId, {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ['date', 'sessionSource'],
    metrics: ['sessions'],
    dimensionFilter: LLM_SOURCE_FILTER,
    limit: '5000',
  });
  const out = llmReferralRows(rows);
  for (const r of out) {
    const date = new Date(`${r.date}T00:00:00.000Z`);
    await prisma.llmReferralDaily.upsert({
      where: { projectId_date_platform: { projectId: project.id, date, platform: r.platform } },
      create: { projectId: project.id, date, platform: r.platform, sessions: r.sessions },
      update: { sessions: r.sessions },
    });
  }
  return out.length;
}

export async function syncGa4Project(project) {
  if (!project.ga4PropertyId) return { projectId: project.id, status: 'skipped' };

  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);

  const daily = await runGa4Report(project.ga4PropertyId, {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: ['date'],
    metrics: [
      'sessions',
      'totalUsers',
      'bounceRate',
      'averageSessionDuration',
      'conversions',
      'screenPageViews',
    ],
  });

  // Breakdowns for the full window (stored on the latest day row)
  let channels = [];
  let devices = [];
  let countries = [];
  let landingPages = [];
  let llmReferrers = [];
  try {
    channels = await runGa4Report(project.ga4PropertyId, {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions', 'conversions', 'bounceRate'],
      limit: '50',
    });
    devices = await runGa4Report(project.ga4PropertyId, {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['deviceCategory'],
      metrics: ['sessions', 'conversions'],
      limit: '10',
    });
    countries = await runGa4Report(project.ga4PropertyId, {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['country'],
      metrics: ['sessions', 'conversions'],
      limit: '50',
    });
    landingPages = await runGa4Report(project.ga4PropertyId, {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['landingPage'],
      metrics: ['sessions', 'conversions', 'bounceRate', 'averageSessionDuration'],
      limit: '100',
    });
    const sources = await runGa4Report(project.ga4PropertyId, {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['sessionSource'],
      metrics: ['sessions', 'conversions', 'bounceRate', 'averageSessionDuration'],
      limit: '200',
    });
    llmReferrers = sources.filter((r) =>
      LLM_HOSTS.some((h) => String(r.sessionSource || '').toLowerCase().includes(h.replace('.com', '').split('.')[0]) || String(r.sessionSource || '').toLowerCase().includes(h))
    );
  } catch {
    // breakdowns optional
  }

  let upserts = 0;
  const lastDateKey = daily.length ? daily[daily.length - 1].date : null;
  for (const row of daily) {
    const dateStr = row.date; // YYYYMMDD
    if (!dateStr || dateStr.length !== 8) continue;
    const iso = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const date = new Date(`${iso}T00:00:00.000Z`);
    const sessions = Math.round(row.sessions || 0);
    const conversions = Math.round(row.conversions || 0);
    const breakdowns =
      dateStr === lastDateKey
        ? { channels, devices, countries, landingPages, llmReferrers, range: { start: fmt(start), end: fmt(end) } }
        : undefined;

    await prisma.ga4DailyMetric.upsert({
      where: { projectId_date: { projectId: project.id, date } },
      create: {
        projectId: project.id,
        date,
        sessions,
        totalUsers: Math.round(row.totalUsers || 0),
        bounceRate: row.bounceRate || 0,
        avgEngagementSec: row.averageSessionDuration || 0,
        conversions,
        conversionRate: sessions > 0 ? conversions / sessions : 0,
        pageViews: Math.round(row.screenPageViews || 0),
        breakdowns: breakdowns || undefined,
      },
      update: {
        sessions,
        totalUsers: Math.round(row.totalUsers || 0),
        bounceRate: row.bounceRate || 0,
        avgEngagementSec: row.averageSessionDuration || 0,
        conversions,
        conversionRate: sessions > 0 ? conversions / sessions : 0,
        pageViews: Math.round(row.screenPageViews || 0),
        ...(breakdowns ? { breakdowns } : {}),
      },
    });
    upserts++;
  }

  // LLM referrals per day (optional: a failure never fails the GA4 sync).
  let llmRows = 0;
  try {
    llmRows = await syncLlmReferrals(project, start, end);
  } catch {
    llmRows = 0;
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { ga4LastSyncedAt: new Date() },
  });

  return { projectId: project.id, status: 'ok', days: upserts, llmRows };
}

export async function runGa4Sync() {
  const projects = await prisma.project.findMany({
    where: { ga4PropertyId: { not: null } },
    select: { id: true, ga4PropertyId: true, clientId: true },
  });
  const details = [];
  for (const p of projects) {
    try {
      details.push(await syncGa4Project(p));
    } catch (err) {
      details.push({ projectId: p.id, status: 'error', error: err.message });
    }
  }
  return {
    total: projects.length,
    success: details.filter((d) => d.status === 'ok').length,
    errors: details.filter((d) => d.status === 'error').length,
    details,
  };
}
