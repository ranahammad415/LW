/**
 * Core rank lookups never fall back to an estimate; an account-level provider error stops the keyword loop.
 */
import { describe, it, expect, vi } from 'vitest';

const anthropicCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = { create: async () => { anthropicCalls.n += 1; return { content: [{ text: '{"position": 3}' }] }; } };
    }
  },
}));

import { lookupSerpPosition } from '../../../src/lib/omniSearch/serpProvider.js';
import { getKeywordRankings } from '../../../src/lib/analytics/providers.js';

describe('estimates', () => {
  it('allowEstimate:false with no real provider throws instead of estimating', async () => {
    delete process.env.SERP_PROVIDER;
    await expect(lookupSerpPosition({ keyword: 'k', domain: 'abc.com', allowEstimate: false })).rejects.toThrow(/No real SERP provider/);
    expect(anthropicCalls.n).toBe(0);
  });

  it('OmniSearch (default) still gets a labelled estimate', async () => {
    const r = await lookupSerpPosition({ keyword: 'k', domain: 'abc.com' });
    expect(r).toMatchObject({ dataSource: 'claude_estimated', position: 3 });
  });
});

describe('getKeywordRankings', () => {
  it('passes allowEstimate:false and the location; stops after an account-level error', async () => {
    const lookup = vi.fn(async ({ keyword }) => {
      if (keyword === 'b') throw Object.assign(new Error('DataForSEO 40210: insufficient funds'), { accountLevel: true });
      return { position: 2, url: 'https://abc.com', dataSource: 'dataforseo', costUsd: 0.002 };
    });
    const out = await getKeywordRankings({ domain: 'https://www.abc.com', keywords: ['a', 'b', 'c'], locationCode: 1023191, languageCode: 'en', lookup });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0][0]).toMatchObject({ domain: 'abc.com', locationCode: 1023191, languageCode: 'en', allowEstimate: false });
    expect(out.map((r) => r.dataSource)).toEqual(['dataforseo', 'error', 'error']);
    expect(out[2].error).toMatch(/account-level/);
  });
});
