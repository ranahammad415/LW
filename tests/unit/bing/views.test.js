/**
 * Bing views: buildBingView per view (Google-vs-Bing share maths, weekly aggregation, crawl issues), the client
 * audience never gets crawl-issue URLs, the client tile and the frozen snapshot block are allow-lists (no ids, URLs,
 * costs, error text, keys), unknown / staff-only views 404, the AI-report facts are null when unlinked, the monthly
 * report line is plain words, and the response redaction drops the credential columns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', async () => {
  const { assertPrismaArgs } = await import('../../helpers/prismaShape.js');
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          assertPrismaArgs(name, method, args);
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'count') return 0;
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
const cycleState = vi.hoisted(() => ({ status: 'OPEN' }));
vi.mock('../../../src/lib/workCycle.js', () => ({
  resolveCycle: async () => ({ id: 'cy1', month: 10, year: 2026, label: 'October 2026', status: cycleState.status }),
}));
vi.mock('../../../src/lib/analytics/gscSeries.js', () => ({
  getClientTrafficSeries: async (_c, { start }) => ({
    totals: { clicks: 300, impressions: 9000, ctr: 3.33, position: 8 },
    series: [{ date: new Date(start).toISOString().slice(0, 10), clicks: 10 }],
    hasActivity: true,
  }),
}));

import { buildBingView } from '../../../src/lib/analytics/sectionBuilders.js';
import { clientBingSummary, clientBingSentence, staffWindows } from '../../../src/lib/bing/bingViews.js';
import { bingBlock } from '../../../src/lib/analytics/freezeSnapshot.js';
import { bingFactsForAi } from '../../../src/lib/analytics/aiHtmlReport/aggregateFacts.js';
import { bingReportLine, plainBingSummary } from '../../../src/lib/monthlyReport/generateForCycle.js';
import { redactResponseSecrets, CLIENT_DROP_KEYS } from '../../../src/lib/redactSecrets.js';

/** Keys / values a client audience must never see. */
const FORBIDDEN = /apikey|apiKeyEnc|accessTokenEnc|refreshTokenEnc|issuesRaw|urlHash|dailyQuota|bingSyncError|costUsd|errorCode|projectId|bingSiteUrl|https?:\/\//i;

const PROJECTS = [{ id: 'p1', name: 'Harbor', gscSiteUrl: 'https://www.example.com/', bingSiteUrl: 'https://www.example.com/', client: { agencyName: 'Harbor Dental', websiteUrl: 'https://harbordental.com' } }];
const daily = (from, n, clicks, impressions) =>
  Array.from({ length: n }, (_, i) => ({ projectId: 'p1', date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000), clicks, impressions }));

beforeEach(() => {
  db.calls = [];
  db.overrides = {
    'project.findMany': async () => PROJECTS,
    'bingDailyMetric.findMany': async (args) => {
      const s = args.where.date.gte.toISOString().slice(0, 10);
      if (s === '2026-10-01') return daily('2026-10-01', 31, 2, 50); // 62 clicks, 1550 impressions
      if (s === '2026-09-01') return daily('2026-09-01', 30, 1, 40); // 30 clicks
      return [];
    },
    'bingQueryWeekly.findMany': async () => [
      { weekStart: new Date('2026-10-02'), query: 'harbor dental', clicks: 5, impressions: 50, avgImpressionPosition: 2 },
      { weekStart: new Date('2026-10-09'), query: 'harbor dental', clicks: 3, impressions: 150, avgImpressionPosition: 4 },
      { weekStart: new Date('2026-10-09'), query: 'dentist near me', clicks: 1, impressions: 80, avgImpressionPosition: 12 },
    ],
    'bingCrawlIssue.findMany': async () => [
      { url: 'https://www.example.com/old', httpCode: 404, issues: [{ key: 'code4xx', label: 'Client error (4xx)' }], inLinks: 3, firstSeenAt: new Date('2026-10-01') },
    ],
    'bingCrawlIssue.count': async () => 2,
    'bingCrawlDaily.findMany': async () => [{ date: new Date('2026-10-20'), crawledPages: 100, inIndex: 90, inLinks: 5, code4xx: 2, code5xx: 1, crawlErrors: 0 }],
    'llmReferralDaily.findMany': async () => [{ sessions: 4 }, { sessions: 3 }],
  };
});

describe('buildBingView', () => {
  it('overview: KPIs, deltas vs the previous month, Google-vs-Bing share, Copilot referrals', async () => {
    const r = await buildBingView(['c1'], 'overview', {});
    expect(r.linked).toBe(true);
    expect(r.data.kpis).toMatchObject({ clicks: 62, impressions: 1550, ctr: 4, clicksDelta: 106.7 });
    expect(r.data.compare).toMatchObject({ google: { clicks: 300, impressions: 9000 }, bing: { clicks: 62 }, bingShareClicks: 17.1, bingShareImpressions: 14.7 });
    expect(r.data.compare.series[0]).toEqual({ date: '2026-10-01', googleClicks: 10, bingClicks: 2 });
    expect(r.data.copilotReferrals).toBe(7);
    // Copilot referrals = GA4 LlmReferralDaily platform copilot
    expect(db.calls.find((c) => c.key === 'llmReferralDaily.findMany').args.where.platform).toBe('copilot');
  });

  it('queries: weekly rows aggregated, impression-weighted position, brand tokens, the weekly note', async () => {
    const r = await buildBingView(['c1'], 'queries', {});
    expect(r.data.queries[0]).toMatchObject({ query: 'harbor dental', clicks: 8, impressions: 200, ctr: 4, position: 3.5, weeks: 2, brand: 'Brand' });
    expect(r.data.queries[1]).toMatchObject({ query: 'dentist near me', brand: 'Generic' });
    expect(r.data.rankings).toEqual({ top3: 0, top10: 1, top20: 2, rest: 0 });
    expect(r.data.weeks).toBe(2);
    expect(r.data.note).toMatch(/per week/);
  });

  it('crawl: staff sees issue URLs, the client audience only counts and labels', async () => {
    const staff = await buildBingView(['c1'], 'crawl', {}, { audience: 'staff' });
    expect(staff.data.issues.openIssues[0].url).toBe('https://www.example.com/old');
    const client = await buildBingView(['c1'], 'crawl', {}, { audience: 'client' });
    expect(client.data.issues).toEqual({ open: 1, byLabel: [{ label: 'Client error (4xx)', count: 1 }], resolved30d: 2 });
    expect(JSON.stringify(client)).not.toMatch(/example\.com\/old/);
    expect(client.data.latest).toMatchObject({ crawledPages: 100, code4xx: 2 });
  });

  it('unknown and staff-only views → 404; unlinked → empty with a reason', async () => {
    expect(await buildBingView(['c1'], 'ops', {})).toEqual({ status: 404, message: 'Unknown Bing view' });
    expect(await buildBingView(['c1'], 'links', {})).toMatchObject({ status: 404 });
    db.overrides['project.findMany'] = async () => [{ ...PROJECTS[0], bingSiteUrl: null }];
    const r = await buildBingView(['c1'], 'overview', {});
    expect(r).toMatchObject({ linked: false, data: null });
    expect(r.emptyReason).toMatch(/Bing/);
  });

  it('closed cycle with a frozen bing block: KPIs from the snapshot', async () => {
    cycleState.status = 'CLOSED';
    db.overrides['workCycleAnalyticsSnapshot.findUnique'] = async () => ({ data: { bing: { totals: { clicks: 11, impressions: 99, ctr: 11.11 }, deltas: { clicks: 10, impressions: 5, ctr: 1 }, yoyDeltas: null } } });
    const r = await buildBingView(['c1'], 'overview', {});
    cycleState.status = 'OPEN';
    expect(r.source).toBe('frozen');
    expect(r.data.kpis).toMatchObject({ clicks: 11, impressions: 99, clicksDelta: 10, clicksYoyDelta: null });
  });
});

describe('client tile (allow-list)', () => {
  it('numbers and one sentence; no URL, id, error or cost', async () => {
    const now = new Date('2026-10-24T12:00:00Z');
    const w = staffWindows(now);
    db.overrides['bingDailyMetric.findMany'] = async (args) =>
      args.where.date.gte.getTime() === w.cur.start.getTime() ? daily(w.cur.start.toISOString().slice(0, 10), 28, 2, 30) : daily(w.prev.start.toISOString().slice(0, 10), 28, 1, 20);
    db.overrides['gscDailyMetric.findMany'] = async () => [{ clicks: 168, impressions: 5000 }];
    const out = await clientBingSummary({ id: 'p1', clientId: 'c1', gscSiteUrl: 'x', bingSiteUrl: 'https://www.example.com/', bingLastSyncedAt: new Date('2026-10-24T05:50:00Z'), bingSyncError: 'secret text' }, { now });
    expect(Object.keys(out).sort()).toEqual(['clicks28', 'clicksChangePct', 'impressions28', 'linked', 'sentence', 'shareOfSearchClicksPct', 'trend', 'updatedAt'].sort());
    expect(out).toMatchObject({ linked: true, clicks28: 56, impressions28: 840, clicksChangePct: 100, shareOfSearchClicksPct: 25 });
    expect(out.sentence).toBe('Bing search brought 56 visits in the last 4 weeks, up 100% on the 4 weeks before. That is about 25% of your search visits from Google and Bing together.');
    expect(JSON.stringify(out)).not.toMatch(FORBIDDEN);
    expect(await clientBingSummary({ id: 'p1', bingSiteUrl: null })).toEqual({ linked: false });
    expect(clientBingSentence({ clicks: 0 })).toMatch(/not sent visits/);
  });
});

describe('frozen snapshot block / report facts / monthly line', () => {
  it('bingBlock: totals, deltas, share, series, top 5 queries — no URLs or ids', async () => {
    const b = await bingBlock(['p1'], { start: new Date('2026-10-01'), end: new Date('2026-10-31'), prev: { start: new Date('2026-09-01'), end: new Date('2026-09-30') }, yoy: null }, { clicks: 300, impressions: 9000 });
    expect(b.totals).toEqual({ clicks: 62, impressions: 1550, ctr: 4 });
    expect(b.deltas).toMatchObject({ clicks: 106.7 });
    expect(b.yoyDeltas).toBeNull();
    expect(b.share).toEqual({ clicksPct: 17.1, impressionsPct: 14.7 });
    expect(b.topQueries[0]).toEqual({ query: 'harbor dental', clicks: 8, impressions: 200 });
    expect(JSON.stringify(b)).not.toMatch(FORBIDDEN);
    expect(await bingBlock([], {}, null)).toBeNull();
  });
  it('AI-report facts are null when unlinked; the monthly line is plain words', () => {
    expect(bingFactsForAi({ linked: false }, null)).toBeNull();
    const f = bingFactsForAi({ linked: true, data: { kpis: { clicks: 62, impressions: 1550, clicksDelta: 12.5 }, compare: { bingShareClicks: 17.1 } } }, { data: { queries: [{ query: 'q', clicks: 1, impressions: 2, ctr: 50 }] } });
    expect(f.kpis).toEqual({ clicks: 62, impressions: 1550, clicksDelta: 12.5, impressionsDelta: null, shareOfSearchClicksPct: 17.1 });
    expect(f.topQueries).toEqual([{ query: 'q', clicks: 1, impressions: 2 }]);
    const s = plainBingSummary({ totals: { clicks: 1234, impressions: 9 }, deltas: { clicks: -12.4 }, share: { clicksPct: 9 } });
    expect(bingReportLine(s)).toBe('Bing search brought 1,234 visits, down 12% on last month.');
    expect(bingReportLine(null)).toBe('');
    expect(bingReportLine(plainBingSummary(null))).toBe('');
  });
});

describe('fleet', () => {
  it('one row per bound project, errors first, verified from the live site list', async () => {
    const { bingFleet } = await import('../../../src/lib/bing/bingViews.js');
    db.overrides['project.findMany'] = async () => [
      { id: 'p1', name: 'A', clientId: 'c1', bingSiteUrl: 'https://www.example.com/', bingLastSyncedAt: null, bingSyncError: null, client: { agencyName: 'Alpha' } },
      { id: 'p2', name: 'B', clientId: 'c2', bingSiteUrl: 'https://b.com/', bingLastSyncedAt: null, bingSyncError: 'Bing refused this site', client: { agencyName: 'Beta' } },
    ];
    db.overrides['bingDailyMetric.groupBy'] = async () => [{ projectId: 'p1', _sum: { clicks: 40 } }];
    db.overrides['bingCrawlIssue.groupBy'] = async () => [{ projectId: 'p2', _count: { _all: 3 } }];
    const out = await bingFleet({ sites: [{ siteUrl: 'https://www.example.com/', verified: true }] });
    expect(out.projects.map((r) => [r.projectId, r.verified, r.clicks28, r.openIssues, !!r.error])).toEqual([
      ['p2', false, 0, 3, true],
      ['p1', true, 40, 0, false],
    ]);
  });
});

describe('redaction', () => {
  it('credential columns never leave the API; Bing staff fields are dropped for client audiences', () => {
    const out = redactResponseSecrets({ connection: { id: 'x', apiKeyEnc: 'iv.tag.data', accessTokenEnc: 'a', refreshTokenEnc: 'r', accountLabel: 'me' } });
    expect(out).toEqual({ connection: { id: 'x', accountLabel: 'me' } });
    const client = redactResponseSecrets({ p: { bingSyncError: 'e', issuesRaw: 4, urlHash: 'h', name: 'n' } }, 0, CLIENT_DROP_KEYS);
    expect(client).toEqual({ p: { name: 'n' } });
  });
});
