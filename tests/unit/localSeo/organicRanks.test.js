/**
 * Organic rank tracking: estimates are never stored, failures keep the old value and are recorded, only approved
 * keywords are checked, the project location is used, strict domain match, account-level errors stop the loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], keywords: [] }));
const rankings = vi.hoisted(() => ({ results: [], args: null }));

vi.mock('../../../src/lib/prisma.js', async () => {
  const { shapeChecked } = await import('../../helpers/prismaShape.js');
  return {
    prisma: shapeChecked({
      keywordTrack: {
        findMany: async (a) => { db.calls.push(['keywordTrack.findMany', a]); return db.keywords; },
        update: async (a) => { db.calls.push(['keywordTrack.update', a]); return {}; },
      },
      keywordRankDaily: { upsert: async (a) => { db.calls.push(['keywordRankDaily.upsert', a]); return {}; } },
      project: { findMany: async (a) => { db.calls.push(['project.findMany', a]); return []; } },
    }),
  };
});
vi.mock('../../../src/lib/analytics/providers.js', async (orig) => ({
  ...(await orig()),
  hasRealSerpProvider: () => true,
  getKeywordRankings: async (args) => { rankings.args = args; return rankings.results; },
}));

import { syncDataForSeoProject, classifyRankResult, runDataForSeoSync, TRACKED_KEYWORD_STATUSES } from '../../../src/lib/analytics/dfsSync.js';
import { matchOrganicItems } from '../../../src/lib/omniSearch/serpProvider.js';

const PROJECT = { id: 'p1', dataforseoDomain: 'joespizza.com', localLocationCode: 1023191, localLocationName: 'Milwaukee,Wisconsin,United States', localLanguageCode: 'en' };
const now = new Date('2026-10-22T06:00:00Z');

beforeEach(() => {
  db.calls = [];
  db.keywords = [{ id: 'k1', keyword: 'pizza milwaukee' }, { id: 'k2', keyword: 'pizza near me' }, { id: 'k3', keyword: 'best pizza' }];
  rankings.results = [];
});

const updates = () => db.calls.filter(([k]) => k === 'keywordTrack.update').map(([, a]) => a);
const dailies = () => db.calls.filter(([k]) => k === 'keywordRankDaily.upsert');

describe('dfsSync stores only real provider results', () => {
  it('an estimate or an error never reaches currentRank / KeywordRankDaily; the failure is recorded', async () => {
    rankings.results = [
      { keyword: 'pizza milwaukee', position: 4, dataSource: 'dataforseo', costUsd: 0.002 },
      { keyword: 'pizza near me', position: 7, dataSource: 'claude_estimated' },
      { keyword: 'best pizza', position: null, dataSource: 'error', error: 'DataForSEO 40501: invalid field' },
    ];
    const out = await syncDataForSeoProject(PROJECT, { now });
    expect(out).toMatchObject({ status: 'ok', updated: 1, failed: 2, notFound: 0, costUsd: 0.002 });
    const u = updates();
    expect(u.find((x) => x.where.id === 'k1').data).toEqual({ currentRank: 4, rankStatus: 'ok', rankCheckedAt: now, rankError: null });
    const est = u.find((x) => x.where.id === 'k2').data;
    expect(est).not.toHaveProperty('currentRank');
    expect(est).toMatchObject({ rankStatus: 'error', rankError: expect.stringMatching(/claude_estimated/) });
    expect(u.find((x) => x.where.id === 'k3').data).not.toHaveProperty('currentRank');
    expect(dailies()).toHaveLength(1);
    expect(dailies()[0][1].create).toMatchObject({ keywordId: 'k1', rank: 4 });
  });

  it('a real "not in the top 100" clears currentRank (no daily row)', async () => {
    rankings.results = [{ keyword: 'pizza milwaukee', position: null, dataSource: 'serpapi' }];
    const out = await syncDataForSeoProject(PROJECT, { now });
    expect(out.notFound).toBe(1);
    expect(updates()[0].data).toEqual({ currentRank: null, rankStatus: 'not_found', rankCheckedAt: now, rankError: null });
    expect(dailies()).toHaveLength(0);
  });

  it('only approved keywords are checked (PROPOSED skipped) and the project location is used', async () => {
    rankings.results = [];
    await syncDataForSeoProject(PROJECT, { now });
    const find = db.calls.find(([k]) => k === 'keywordTrack.findMany')[1];
    expect(find.where.status).toEqual({ in: ['APPROVED', 'ACCEPTED', 'TRACKING'] });
    expect(TRACKED_KEYWORD_STATUSES).not.toContain('PROPOSED');
    expect(rankings.args).toMatchObject({ locationCode: 1023191, locationName: 'Milwaukee,Wisconsin,United States', languageCode: 'en' });
  });

  it('the run selects the location fields', async () => {
    await runDataForSeoSync();
    expect(db.calls.find(([k]) => k === 'project.findMany')[1].select).toMatchObject({ localLocationCode: true, localLanguageCode: true });
  });

  it('classifyRankResult', () => {
    expect(classifyRankResult({ dataSource: 'dataforseo', position: 3.6 })).toEqual({ kind: 'ok', rank: 4 });
    expect(classifyRankResult({ dataSource: 'claude_estimated', position: 2 }).kind).toBe('error');
    expect(classifyRankResult({ dataSource: 'dataforseo', position: null })).toEqual({ kind: 'not_found' });
    expect(classifyRankResult(null).kind).toBe('error');
  });
});

describe('serp provider', () => {
  it('strict domain match on organic items', () => {
    const items = [
      { type: 'featured_snippet', url: 'https://abc.com/a', rank_absolute: 1 },
      { type: 'organic', url: 'https://xabc.com/', rank_absolute: 2 },
      { type: 'organic', url: 'https://abc.com.evil.net/', rank_absolute: 3 },
      { type: 'organic', url: 'https://blog.abc.com/post', rank_absolute: 5, rank_group: 4 },
    ];
    expect(matchOrganicItems(items, 'abc.com')).toEqual({ position: 5, url: 'https://blog.abc.com/post' });
    expect(matchOrganicItems(items.slice(0, 3), 'abc.com')).toEqual({ position: null, url: null });
  });
});
