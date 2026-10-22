/**
 * Health score v2 quick wins: KeywordRankDaily (DataForSEO sync) and LlmReferralDaily (GA4 sync).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    keywordTrack: {
      findMany: async () => [{ id: 'k1', keyword: 'dentist harbor' }, { id: 'k2', keyword: 'teeth whitening' }],
      update: async (a) => { db.calls.push(['keywordTrack.update', a]); return {}; },
    },
    keywordRankDaily: { upsert: async (a) => { db.calls.push(['keywordRankDaily.upsert', a]); return {}; } },
    llmReferralDaily: { upsert: async (a) => { db.calls.push(['llmReferralDaily.upsert', a]); return {}; } },
  },
}));
vi.mock('../../../src/lib/analytics/providers.js', () => ({
  domainFromUrl: (d) => d,
  hasRealSerpProvider: () => true,
  getKeywordRankings: async () => [{ keyword: 'dentist harbor', position: 3.4 }, { keyword: 'teeth whitening', position: null }],
}));
vi.mock('../../../src/lib/analytics/ga4Client.js', () => ({ runGa4Report: async () => [] }));

import { syncDataForSeoProject, utcToday } from '../../../src/lib/analytics/dfsSync.js';
import { llmPlatform, llmReferralRows, syncLlmReferrals, LLM_SOURCE_FILTER } from '../../../src/lib/analytics/ga4Sync.js';

beforeEach(() => { db.calls = []; });

describe('KeywordRankDaily', () => {
  it('one upsert per ranked keyword per UTC day, next to currentRank', async () => {
    const out = await syncDataForSeoProject({ id: 'p1', dataforseoDomain: 'harbordental.example' });
    expect(out).toMatchObject({ status: 'ok', updated: 1 });
    const up = db.calls.filter(([k]) => k === 'keywordRankDaily.upsert');
    expect(up).toHaveLength(1);
    const day = utcToday();
    expect(up[0][1]).toEqual({
      where: { keywordId_date: { keywordId: 'k1', date: day } },
      create: { keywordId: 'k1', projectId: 'p1', date: day, rank: 3 },
      update: { rank: 3 },
    });
    expect(day.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
});

describe('LlmReferralDaily', () => {
  it('maps sources to platforms', () => {
    expect(llmPlatform('chatgpt.com')).toBe('chatgpt');
    expect(llmPlatform('chat.openai.com')).toBe('chatgpt');
    expect(llmPlatform('claude.ai')).toBe('claude');
    expect(llmPlatform('gemini.google.com')).toBe('gemini');
    expect(llmPlatform('www.perplexity.ai')).toBe('perplexity');
    expect(llmPlatform('copilot.microsoft.com')).toBe('copilot');
    expect(llmPlatform('something')).toBe('other');
  });
  it('sums per day and platform', () => {
    expect(llmReferralRows([
      { date: '20261020', sessionSource: 'chatgpt.com', sessions: 3 },
      { date: '20261020', sessionSource: 'chat.openai.com', sessions: 2 },
      { date: '20261021', sessionSource: 'claude.ai', sessions: 1 },
      { date: 'bad', sessionSource: 'claude.ai', sessions: 9 },
    ])).toEqual([
      { date: '2026-10-20', platform: 'chatgpt', sessions: 5 },
      { date: '2026-10-21', platform: 'claude', sessions: 1 },
    ]);
  });
  it('one extra GA4 report (date × sessionSource, LLM filter), upsert per day+platform', async () => {
    const report = vi.fn(async () => [{ date: '20261020', sessionSource: 'perplexity.ai', sessions: 4 }]);
    const n = await syncLlmReferrals({ id: 'p1', ga4PropertyId: '123' }, new Date('2026-09-22T00:00:00Z'), new Date('2026-10-21T00:00:00Z'), { report });
    expect(n).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).toMatchObject({ dimensions: ['date', 'sessionSource'], metrics: ['sessions'], dimensionFilter: LLM_SOURCE_FILTER });
    expect(db.calls[0][1]).toEqual({
      where: { projectId_date_platform: { projectId: 'p1', date: new Date('2026-10-20T00:00:00.000Z'), platform: 'perplexity' } },
      create: { projectId: 'p1', date: new Date('2026-10-20T00:00:00.000Z'), platform: 'perplexity', sessions: 4 },
      update: { sessions: 4 },
    });
  });
});
