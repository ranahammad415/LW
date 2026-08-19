import { describe, it, expect } from 'vitest';
import { stripTrailingIncomplete } from '../../src/lib/analytics/seriesUtils.js';

const keys = ['clicks', 'impressions'];

function day(date, clicks, impressions) {
  return { date, clicks, impressions };
}

describe('stripTrailingIncomplete', () => {
  it('strips trailing zero days after the last active day', () => {
    const series = [
      day('2026-08-10', 10, 100),
      day('2026-08-11', 8, 90),
      day('2026-08-12', 12, 110),
      day('2026-08-13', 0, 0),
      day('2026-08-14', 0, 0),
      day('2026-08-15', 0, 0),
    ];
    const out = stripTrailingIncomplete(series, keys);
    expect(out.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('keeps interior zeros', () => {
    const series = [
      day('2026-08-10', 10, 100),
      day('2026-08-11', 0, 0),
      day('2026-08-12', 12, 110),
      day('2026-08-13', 9, 80),
    ];
    const out = stripTrailingIncomplete(series, keys);
    expect(out).toEqual(series);
  });

  it('caps how many trailing days are dropped', () => {
    const series = [
      day('2026-08-01', 10, 100),
      ...Array.from({ length: 9 }, (_, i) => day(`2026-08-${String(i + 2).padStart(2, '0')}`, 0, 0)),
    ];
    const out = stripTrailingIncomplete(series, keys, { maxDays: 7 });
    expect(out).toHaveLength(series.length - 7);
    expect(out[0].clicks).toBe(10);
    expect(out[out.length - 1].clicks).toBe(0);
  });

  it('leaves an all-zero series unchanged', () => {
    const series = [
      day('2026-08-10', 0, 0),
      day('2026-08-11', 0, 0),
      day('2026-08-12', 0, 0),
    ];
    expect(stripTrailingIncomplete(series, keys)).toEqual(series);
  });

  it('returns empty / missing input unchanged', () => {
    expect(stripTrailingIncomplete([], keys)).toEqual([]);
    expect(stripTrailingIncomplete(null, keys)).toBe(null);
    expect(stripTrailingIncomplete(undefined, keys)).toBe(undefined);
  });

  it('treats a day as active when any activity key is > 0', () => {
    const series = [
      day('2026-08-10', 0, 50),
      day('2026-08-11', 0, 0),
    ];
    expect(stripTrailingIncomplete(series, keys).map((r) => r.date)).toEqual(['2026-08-10']);
  });
});
