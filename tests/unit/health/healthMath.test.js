import { describe, it, expect } from 'vitest';
import {
  trend, pl, blend, clamp, pctDelta, seasonDelta, factorScore, pillarScore, renormalize,
  windowsFor, addDays, dayDiff, sumRange, bandFor, bandRank, trendArrow,
} from '../../../src/lib/health/healthMath.js';
import { DEFAULT_CONFIG_V1 as CFG } from '../../../src/lib/health/defaultConfig.js';

describe('trend', () => {
  it('0 → 50, ±25 → ≈88 / ≈12, clamped to [10, 100]', () => {
    expect(trend(0)).toBe(50);
    expect(trend(25)).toBeCloseTo(88.08, 1);
    expect(trend(-25)).toBeCloseTo(11.92, 1);
    expect(trend(-1000)).toBe(10);
    expect(trend(1000)).toBeCloseTo(100, 5);
    expect(trend(null)).toBeNull();
  });
});

describe('pl', () => {
  const pts = [[8, 100], [20, 60], [40, 20]];
  it('clamps at the ends and interpolates', () => {
    expect(pl(1, pts)).toBe(100);
    expect(pl(99, pts)).toBe(20);
    expect(pl(14, pts)).toBe(80);
    expect(pl(30, pts)).toBe(40);
  });
  it('accepts unsorted points and descending y', () => {
    expect(pl(47.5, [[60, 60], [35, 100], [85, 15]])).toBe(80);
  });
  it('null for missing x', () => expect(pl(null, pts)).toBeNull());
});

describe('blend / factorScore / pillarScore', () => {
  it('null rules', () => {
    expect(blend(null, null)).toBeNull();
    expect(blend(70, null)).toBe(70);
    expect(blend(null, 40)).toBe(40);
    expect(blend(100, 50)).toBe(80);
  });
  it('factor floor and rounding', () => {
    expect(factorScore(0, 0, CFG)).toBe(10);
    expect(factorScore(null, null, CFG)).toBeNull();
    expect(factorScore(66.6, null, CFG)).toBe(67);
  });
  it('pillar: weighted mean over scored factors, floored, null when none', () => {
    expect(pillarScore([{ score: 80, weight: 1 }, { score: null, weight: 1 }, { score: 40, weight: 3 }])).toBe(50);
    expect(pillarScore([{ score: null, weight: 1 }])).toBeNull();
    expect(pillarScore([{ score: 1, weight: 1 }], 5)).toBe(5);
  });
  it('clamp / pctDelta', () => {
    expect(clamp(5, 10, 20)).toBe(10);
    expect(pctDelta(150, 100)).toBe(50);
    expect(pctDelta(5, 0)).toBeNull();
  });
});

describe('seasonDelta', () => {
  it('blends YoY when the year-ago window has enough rows', () => {
    expect(seasonDelta(120, 100, 80, 28, CFG)).toBeCloseTo(0.5 * 50 + 0.5 * 20, 6);
  });
  it('falls back to prev when YoY coverage is short or missing', () => {
    expect(seasonDelta(120, 100, 80, 10, CFG)).toBeCloseTo(20, 6);
    expect(seasonDelta(120, 100, null, 28, CFG)).toBeCloseTo(20, 6);
  });
});

describe('renormalize', () => {
  const W = CFG.profiles.LOCAL;
  it('missing pillars are excluded and lower coverage (Harbor Dental)', () => {
    const r = renormalize({ visibility: 67, engagement: 64, leads: 35, reputation: 75, aiVisibility: null, site: 87, content: null }, W, CFG);
    expect(r).toEqual({ score: 65, rawScore: 65, coverage: 90, scoredPillars: 5 });
  });
  it('minPillars and minCoverage gates', () => {
    expect(renormalize({ reputation: 80 }, W, CFG).score).toBeNull();
    const low = renormalize({ engagement: 80, content: 50 }, W, CFG);
    expect(low.coverage).toBe(15);
    expect(low.score).toBeNull();
    expect(low.rawScore).toBe(70);
  });
  it('weight-0 pillars are not counted in coverage', () => {
    const r = renormalize({ visibility: 50, engagement: 50, leads: 50, site: 50, content: 50 }, CFG.profiles.WEBSITE, CFG);
    expect(r.coverage).toBe(100);
  });
});

describe('windows and dates', () => {
  it('applies the GSC lag and 28-day windows', () => {
    const w = windowsFor('2026-10-22', CFG);
    expect(w.anchor).toBe('2026-10-20');
    expect(w.cur).toEqual({ from: '2026-09-23', to: '2026-10-20' });
    expect(w.prev).toEqual({ from: '2026-08-26', to: '2026-09-22' });
    expect(w.shortCur).toEqual({ from: '2026-10-07', to: '2026-10-20' });
    expect(w.shortPrev).toEqual({ from: '2026-09-23', to: '2026-10-06' });
  });
  it('YoY window is shifted 364 days (same weekdays)', () => {
    const w = windowsFor('2026-10-22', CFG);
    expect(new Date(`${w.yoy.from}T00:00:00Z`).getUTCDay()).toBe(new Date(`${w.cur.from}T00:00:00Z`).getUTCDay());
    expect(dayDiff(w.yoy.to, w.cur.to)).toBe(364);
  });
  it('leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(windowsFor('2028-03-02', CFG).anchor).toBe('2028-02-29');
  });
  it('sumRange counts rows and sums fields', () => {
    const m = new Map([['2026-01-01', { a: 1, b: 2 }], ['2026-01-03', { a: 3, b: 4 }], ['2026-01-09', { a: 100 }]]);
    expect(sumRange(m, { from: '2026-01-01', to: '2026-01-05' }, ['a', 'b'])).toEqual({ rows: 2, a: 4, b: 6 });
  });
});

describe('bands and arrows', () => {
  it('bands', () => {
    expect(bandFor(80, CFG.bands)).toBe('excellent');
    expect(bandFor(79, CFG.bands)).toBe('healthy');
    expect(bandFor(40, CFG.bands)).toBe('at_risk');
    expect(bandFor(0, CFG.bands)).toBe('critical');
    expect(bandFor(null, CFG.bands)).toBeNull();
    expect(bandRank('excellent', CFG.bands)).toBeGreaterThan(bandRank('healthy', CFG.bands));
  });
  it('arrow', () => {
    expect(trendArrow(3)).toBe('up');
    expect(trendArrow(-3)).toBe('down');
    expect(trendArrow(2)).toBe('flat');
    expect(trendArrow(null)).toBeNull();
  });
});
