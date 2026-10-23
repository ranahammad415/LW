/**
 * Bing sync: upserts hit the right unique keys and only write changed days, weekly rows are capped and replace only
 * the returned weeks, the crawl-issue diff (new / still open / resolved / reopened), the weekly step is skipped when
 * fresh, `auth` stops the run and writes lastError, `site` marks the project and goes on, `throttle` stops with
 * throttled: true, unverified sites spend no calls, retention purge batches. Fixtures = documented JSON samples.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

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
          if (['updateMany', 'deleteMany', 'createMany'].includes(method)) return { count: args?.data?.length ?? 1 };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import { encryptSecret } from '../../../src/lib/analytics/tokenCrypto.js';
import { resetBingThrottle } from '../../../src/lib/bing/client.js';
import { invalidateBingSitesCache } from '../../../src/lib/bing/bingBinding.js';
import { runBingSync, storeDailyRows, storeWeeklyRows, storeCrawlIssues, purgeOldBing } from '../../../src/lib/bing/bingSync.js';
import { bingFetch, jsonRes, KEY } from './fixtures.js';

const NOW = new Date('2026-10-24T05:45:00Z');
const noSleep = async () => {};
const calls = (k) => db.calls.filter((c) => c.key === k);
const P1 = { id: 'p1', name: 'Harbor', clientId: 'c1', bingSiteUrl: 'https://www.example.com/', bingLastSyncedAt: null };
const P2 = { id: 'p2', name: 'Other', clientId: 'c2', bingSiteUrl: 'https://example.org/', bingLastSyncedAt: null };
const P3 = { id: 'p3', name: 'Third', clientId: 'c3', bingSiteUrl: 'https://www.example.com/', bingLastSyncedAt: null };

let encKey;
beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-secret-0123456789';
  encKey = encryptSecret(KEY, { purpose: 'bing' });
});

beforeEach(() => {
  db.calls = [];
  db.overrides = {
    'agencyBingConnection.findFirst': async (args) => (args?.select?.apiKeyEnc ? { id: 'conn1', authType: 'api_key', apiKeyEnc: encKey } : { id: 'conn1' }),
  };
  resetBingThrottle();
  invalidateBingSitesCache();
  delete process.env.BING_WEBMASTER_ENABLED;
});

describe('storeDailyRows', () => {
  it('creates new days, updates only changed days, by (projectId, date)', async () => {
    db.overrides['bingDailyMetric.findMany'] = async () => [{ date: new Date('2026-10-01T00:00:00Z'), clicks: 3, impressions: 30, ctr: 0.1 }, { date: new Date('2026-10-02T00:00:00Z'), clicks: 5, impressions: 50, ctr: 0.1 }];
    const out = await storeDailyRows('traffic', 'p1', [
      { date: '2026-10-01', clicks: 3, impressions: 30 },
      { date: '2026-10-02', clicks: 6, impressions: 50 },
      { date: '2026-10-03', clicks: 1, impressions: 10 },
    ]);
    expect(out).toEqual({ rows: 3, created: 1, updated: 1 });
    expect(calls('bingDailyMetric.createMany')[0].args).toMatchObject({ skipDuplicates: true, data: [{ projectId: 'p1', clicks: 1, impressions: 10, ctr: 0.1 }] });
    const upd = calls('bingDailyMetric.update')[0].args;
    expect(upd.where).toEqual({ projectId_date: { projectId: 'p1', date: new Date('2026-10-02T00:00:00Z') } });
    expect(upd.data).toEqual({ clicks: 6, impressions: 50, ctr: 0.12 });
  });
  it('crawl rows go to BingCrawlDaily', async () => {
    await storeDailyRows('crawl', 'p1', [{ date: '2026-10-01', crawledPages: 10, code4xx: 1 }]);
    expect(calls('bingCrawlDaily.createMany')[0].args.data[0]).toMatchObject({ crawledPages: 10, code4xx: 1, code5xx: null });
  });
});

describe('storeWeeklyRows', () => {
  it('caps by impressions, merges case-insensitive duplicates and replaces only the returned weeks', async () => {
    const rows = [
      { weekStart: '2026-10-02', query: 'Dentist', clicks: 1, impressions: 10 },
      { weekStart: '2026-10-02', query: 'dentist', clicks: 2, impressions: 20 },
      { weekStart: '2026-10-02', query: 'small', clicks: 0, impressions: 1 },
      { weekStart: '2026-10-09', query: 'big', clicks: 9, impressions: 900 },
    ];
    const out = await storeWeeklyRows('queries', 'p1', rows, { cap: 2, now: NOW });
    expect(out).toEqual({ rows: 2, weeks: 2, capped: true });
    const del = calls('bingQueryWeekly.deleteMany')[0].args;
    expect(del.where.weekStart.in.map((d) => d.toISOString().slice(0, 10)).sort()).toEqual(['2026-10-02', '2026-10-09']);
    const data = calls('bingQueryWeekly.createMany')[0].args.data;
    expect(data.map((r) => [r.query, r.impressions])).toEqual([['big', 900], ['Dentist', 30]]);
  });
  it('pages are keyed by urlHash', async () => {
    await storeWeeklyRows('pages', 'p1', [{ weekStart: '2026-10-02', url: 'https://x.com/a', clicks: 1, impressions: 2 }]);
    expect(calls('bingPageWeekly.createMany')[0].args.data[0]).toMatchObject({ url: 'https://x.com/a', urlHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('storeCrawlIssues', () => {
  it('new → create, unchanged → touch lastSeenAt, missing → resolvedAt, resolved and back → reopened', async () => {
    const { urlHash } = await import('../../../src/lib/bing/client.js');
    db.overrides['bingCrawlIssue.findMany'] = async () => [
      { id: 'i1', urlHash: urlHash('https://x.com/still'), httpCode: 404, issuesRaw: 4, inLinks: 1, resolvedAt: null },
      { id: 'i2', urlHash: urlHash('https://x.com/fixed'), httpCode: 500, issuesRaw: 8, inLinks: 1, resolvedAt: null },
      { id: 'i3', urlHash: urlHash('https://x.com/back'), httpCode: 404, issuesRaw: 4, inLinks: 1, resolvedAt: new Date('2026-09-01') },
    ];
    const out = await storeCrawlIssues('p1', [
      { url: 'https://x.com/still', httpCode: 404, issuesRaw: 4, inLinks: 1 },
      { url: 'https://x.com/back', httpCode: 404, issuesRaw: 4, inLinks: 1 },
      { url: 'https://x.com/new', httpCode: 404, issuesRaw: 4, inLinks: 2 },
    ], { now: NOW });
    expect(out).toEqual({ open: 3, created: 1, reopened: 1, resolved: 1 });
    expect(calls('bingCrawlIssue.createMany')[0].args.data[0]).toMatchObject({ url: 'https://x.com/new', issues: [{ key: 'code4xx', label: 'Client error (4xx)' }] });
    expect(calls('bingCrawlIssue.update')[0].args).toMatchObject({ where: { id: 'i3' }, data: { resolvedAt: null } });
    const resolved = calls('bingCrawlIssue.updateMany').find((c) => c.args.data.resolvedAt);
    expect(resolved.args.where.id.in).toEqual(['i2']);
  });
});

describe('runBingSync', () => {
  it('skips when disabled or not connected', async () => {
    expect(await runBingSync({ env: { BING_WEBMASTER_ENABLED: 'false' } })).toEqual({ skipped: 'DISABLED' });
    db.overrides['agencyBingConnection.findFirst'] = async () => null;
    expect(await runBingSync({ fetchImpl: bingFetch(), sleep: noSleep })).toEqual({ skipped: 'NOT_CONNECTED' });
  });

  it('syncs a verified project: daily + weekly steps, state, project status; unverified sites spend no calls', async () => {
    db.overrides['project.findMany'] = async () => [P1, P2];
    const seen = [];
    const out = await runBingSync({ now: NOW, fetchImpl: bingFetch({}, seen), sleep: noSleep, purge: false });
    expect(out).toMatchObject({ total: 2, success: 1, errors: 1, throttled: false, stopped: null });
    expect(seen).toEqual(['GetUserSites', 'GetRankAndTrafficStats', 'GetCrawlStats', 'GetQueryStats', 'GetPageStats', 'GetCrawlIssues']);
    expect(out.calls).toBe(6);
    const p2 = out.details.find((d) => d.projectId === 'p2');
    expect(p2).toMatchObject({ status: 'error', calls: 0, error: 'BING_SiteNotVerified' });
    const projUpd = calls('project.update');
    expect(projUpd.find((c) => c.args.where.id === 'p1').args.data).toEqual({ bingLastSyncedAt: NOW, bingSyncError: null });
    expect(projUpd.find((c) => c.args.where.id === 'p2').args.data.bingSyncError).toMatch(/verified/);
    const state = calls('bingSiteState.upsert').find((c) => c.args.where.projectId === 'p1').args;
    expect(state.update).toMatchObject({ isVerified: true, lastQueriesAt: NOW, lastIssuesAt: NOW, errorCode: null });
    expect(calls('agencyBingConnection.update').at(-1).args.data).toMatchObject({ lastOkAt: NOW, lastError: null });
    // The query filter: bound, active client, syncable statuses, least recently synced first, capped.
    const q = calls('project.findMany')[0].args;
    expect(q.where).toMatchObject({ bingSiteUrl: { not: null }, status: { in: ['ACTIVE', 'SETUP', 'PAUSED'] }, client: { isActive: true } });
    expect(q.orderBy).toEqual({ bingLastSyncedAt: 'asc' });
    expect(q.take).toBe(200);
  });

  it('skips the weekly step when the last weekly fetch is < 6 days old (unless full)', async () => {
    db.overrides['project.findMany'] = async () => [P1];
    db.overrides['bingSiteState.findUnique'] = async () => ({ lastQueriesAt: new Date(NOW.getTime() - 2 * 86_400_000) });
    const seen = [];
    const out = await runBingSync({ now: NOW, fetchImpl: bingFetch({}, seen), sleep: noSleep, purge: false });
    expect(seen).toEqual(['GetUserSites', 'GetRankAndTrafficStats', 'GetCrawlStats']);
    expect(out.details[0].steps.queries).toBe('fresh');
    const seen2 = [];
    await runBingSync({ now: NOW, full: true, fetchImpl: bingFetch({}, seen2), sleep: noSleep, purge: false });
    expect(seen2).toContain('GetQueryStats');
  });

  it('auth error stops the run and writes the connection lastError', async () => {
    db.overrides['project.findMany'] = async () => [P1, P3];
    const out = await runBingSync({ now: NOW, fetchImpl: bingFetch({ GetUserSites: jsonRes(400, { ErrorCode: 3, Message: 'InvalidApiKey' }) }), sleep: noSleep, purge: false });
    expect(out).toMatchObject({ stopped: 'AUTH', success: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls('agencyBingConnection.update').at(-1).args.data.lastError).toMatch(/rejected the API key/);
    expect(calls('project.findMany')).toHaveLength(0);
  });

  it('site error marks that project and continues; throttle stops at once with throttled: true', async () => {
    db.overrides['project.findMany'] = async () => [P1, P3];
    let traffic = 0;
    const out = await runBingSync({
      now: NOW,
      fetchImpl: bingFetch({
        GetRankAndTrafficStats: () => {
          traffic += 1;
          return traffic === 1 ? jsonRes(400, { ErrorCode: 7, Message: 'InvalidParameter' }) : jsonRes(200, { d: [] });
        },
      }),
      sleep: noSleep,
      purge: false,
    });
    expect(out).toMatchObject({ total: 2, success: 1, errors: 1, throttled: false });
    expect(calls('project.update').find((c) => c.args.where.id === 'p1').args.data.bingSyncError).toMatch(/InvalidParameter/);

    db.calls = [];
    const seen = [];
    const out2 = await runBingSync({
      now: NOW,
      fetchImpl: bingFetch({ GetCrawlStats: jsonRes(400, { ErrorCode: 0, Message: 'ThrottleUser' }) }, seen),
      sleep: noSleep,
      purge: false,
    });
    expect(out2).toMatchObject({ throttled: true, stopped: 'THROTTLED', success: 0 });
    expect(out2.details).toHaveLength(1);
    expect(seen.filter((m) => m === 'GetRankAndTrafficStats')).toHaveLength(1); // the second project never ran
  });

  it('respects BING_SYNC_MAX_PER_RUN and the projectIds filter', async () => {
    await runBingSync({ now: NOW, projectIds: ['p1'], env: { BING_SYNC_MAX_PER_RUN: '5' }, fetchImpl: bingFetch(), sleep: noSleep, purge: false });
    const q = calls('project.findMany')[0].args;
    expect(q.take).toBe(5);
    expect(q.where.id).toEqual({ in: ['p1'] });
  });
});

describe('purgeOldBing', () => {
  it('deletes in id batches with the 400-day / 90-day cutoffs', async () => {
    let n = 0;
    db.overrides['bingDailyMetric.findMany'] = async () => (n++ === 0 ? [{ id: 'a' }, { id: 'b' }] : []);
    db.overrides['bingDailyMetric.deleteMany'] = async (args) => ({ count: args.where.id.in.length });
    const out = await purgeOldBing({ now: NOW, batch: 2 });
    expect(out.bingDailyMetric).toBe(2);
    const first = calls('bingDailyMetric.findMany')[0].args;
    expect(first.take).toBe(2);
    expect(first.where.date.lt.toISOString().slice(0, 10)).toBe('2025-09-19');
    const issues = calls('bingCrawlIssue.findMany')[0].args;
    expect(issues.where.resolvedAt.lt.toISOString().slice(0, 10)).toBe('2026-07-26');
    expect(calls('bingDailyMetric.deleteMany')[0].args.where).toEqual({ id: { in: ['a', 'b'] } });
  });
});
