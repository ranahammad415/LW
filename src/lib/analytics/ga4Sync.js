import { prisma } from '../prisma.js';
import { runGa4Report } from './ga4Client.js';

const LLM_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'copilot.microsoft.com'];

function fmt(d) {
  return d.toISOString().slice(0, 10);
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

  await prisma.project.update({
    where: { id: project.id },
    data: { ga4LastSyncedAt: new Date() },
  });

  return { projectId: project.id, status: 'ok', days: upserts };
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
