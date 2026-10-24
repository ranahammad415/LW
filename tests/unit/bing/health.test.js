/**
 * Health config v3 PROPOSAL (Bing): V5 "Bing clicks" (visibility, trend only) and S4 "Bing crawl health" (site, level
 * only), weight 0.5 each; config v3 = v2 + the two factors (migration copy identical, stored INACTIVE); null on missing
 * data (unlinked / no_data / min_volume); the Harbor Dental worked example is unchanged when Bing is unlinked; the bundle
 * queries Bing only when the config has the factor and the project is bound.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', async () => {
  const { assertPrismaArgs } = await import('../../helpers/prismaShape.js');
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        return async (args) => {
          db.calls.push({ key: `${name}.${String(method)}`, args });
          assertPrismaArgs(name, method, args);
          const o = db.overrides[`${name}.${String(method)}`];
          if (o) return o(args);
          return method === 'findMany' ? [] : null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import { sliceBundle, loadHealthBundle } from '../../../src/lib/health/healthBundle.js';
import { V5, S4, computeFactors } from '../../../src/lib/health/healthFactors.js';
import { DEFAULT_CONFIG_V2, DEFAULT_CONFIG_V3, validateConfig } from '../../../src/lib/health/healthConfig.js';
import { CONFIG_V3_NOTE, DEFAULT_CONFIG } from '../../../src/lib/health/defaultConfig.js';
import { FACTOR_LABELS, SENTENCES } from '../../../src/lib/health/healthExplain.js';
import { trend, addDays } from '../../../src/lib/health/healthMath.js';
import { computeProjectHealth } from '../../../src/lib/health/healthScoreService.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, '../health/fixtures/bundle-harbor-dental.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const V2 = clone(DEFAULT_CONFIG_V2);
const V3 = clone(DEFAULT_CONFIG_V3);
const NOW = Date.parse('2026-10-22T07:00:00Z');
const DATE = '2026-10-22';
const r1 = (v) => Math.round(v * 10) / 10;

/** Daily rows from `from` for `days` days. */
function days(from, n, row) {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), ...(typeof row === 'function' ? row(i) : row) }));
}
const slice = (mut, cfg = V3, opts = {}) => {
  const b = clone(FIXTURE);
  if (mut) mut(b);
  return sliceBundle(b, DATE, cfg, { now: NOW, ...opts });
};
const bound = (b) => (b.project.bingSiteUrl = 'https://harbordental.example/');

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('config version 3 proposal', () => {
  it('is version 2 plus V5 (visibility) and S4 (site) at weight 0.5; v2 untouched; not the default', () => {
    const { V5: v5, S4: s4, ...rest } = V3.factors;
    expect(rest).toEqual(V2.factors);
    expect(v5).toEqual({ pillar: 'visibility', weight: 0.5, minPrior: 20 });
    expect(s4).toEqual({ pillar: 'site', weight: 0.5, level: [[0, 100], [2, 70], [10, 20]], days: 7, minCrawled: 50 });
    expect({ ...V3, version: 2, factors: V2.factors }).toEqual(V2);
    expect(V2.factors.V5).toBeUndefined();
    expect(DEFAULT_CONFIG.version).toBe(2);
  });

  it('the migration stores exactly DEFAULT_CONFIG_V3 as the next version, INACTIVE, once (keyed by its note)', () => {
    const sql = readFileSync(join(here, '../../../prisma/migrations/20261114_bing_webmaster/migration.sql'), 'utf8');
    const m = sql.match(/INSERT INTO `healthscoreconfig`[\s\S]*?SELECT UUID\(\), @next, '(\{.*?\})', 0, '([^']+)', NOW\(3\)\s+FROM DUAL WHERE @have = 0;/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m[1])).toEqual(V3);
    expect(m[2]).toBe(CONFIG_V3_NOTE);
    expect(sql).toContain(`WHERE \`note\` = '${CONFIG_V3_NOTE}'`);
    expect(sql).toMatch(/SET @next := \(SELECT COALESCE\(MAX\(`version`\), 0\) \+ 1 FROM `healthscoreconfig`\)/);
    // Never activates anything.
    expect(sql).not.toMatch(/UPDATE `healthscoreconfig`/);
    expect(sql).not.toMatch(/isActive` = 1|SET `isActive`/);
  });

  it('validates v3 and still v2; bad V5 / S4 values are refused', () => {
    expect(validateConfig(clone(V3)).ok).toBe(true);
    expect(validateConfig(clone(V2)).ok).toBe(true);
    const bad = clone(V3);
    bad.factors.S4.days = 0;
    expect(validateConfig(bad).ok).toBe(false);
    const bad2 = clone(V3);
    bad2.factors.V5.pillar = 'nope';
    expect(validateConfig(bad2).ok).toBe(false);
  });

  it('labels and client sentences', () => {
    expect(FACTOR_LABELS.V5).toBe('Bing clicks');
    expect(FACTOR_LABELS.S4).toBe('Bing crawl health');
    expect(SENTENCES.V5({ raw: { cur: 130, prev: 100 } }).text).toBe('Your site is also gaining visits from Bing');
    expect(SENTENCES.V5({ raw: { cur: 70, prev: 100 } }).text).toMatch(/Bing search fell/);
    expect(SENTENCES.S4({ score: 90 }).text).toBe('Bing can read your site without problems');
    expect(SENTENCES.S4({ score: 20 }).text).toBe('Bing is hitting broken pages on your site');
  });
});

describe('V5 Bing clicks', () => {
  // windows for 2026-10-22 (lag 2): cur 2026-09-23 … 2026-10-20, prev 2026-08-26 … 2026-09-22
  it('trend of clicks, cur vs prev', () => {
    const s = slice((b) => {
      bound(b);
      b.bing = [...days('2026-08-26', 28, { clicks: 8, impressions: 100 }), ...days('2026-09-23', 28, { clicks: 10, impressions: 120 })];
    });
    const f = V5(s, V3);
    expect(f.raw).toEqual({ cur: 280, prev: 224, yoy: null });
    expect(f.parts).toEqual({ trend: r1(trend(25, V3.trendK)), level: null });
    expect(f).toMatchObject({ pillar: 'visibility', weight: 0.5, reason: 'ok' });
    expect(f.score).toBe(Math.round(trend(25, V3.trendK)));
  });
  it('null when unlinked, without rows, or under minPrior', () => {
    expect(V5(slice((b) => (b.bing = days('2026-09-23', 28, { clicks: 10, impressions: 1 }))), V3).reason).toBe('unlinked');
    expect(V5(slice((b) => { bound(b); b.bing = []; }), V3)).toMatchObject({ score: null, reason: 'no_data' });
    expect(V5(slice((b) => { bound(b); b.bing = [...days('2026-08-26', 28, { clicks: 0, impressions: 1 }), ...days('2026-09-23', 28, { clicks: 3, impressions: 9 })]; }), V3))
      .toMatchObject({ score: null, reason: 'min_volume' });
  });
});

describe('S4 Bing crawl health', () => {
  it('level = pl(error share over the last 7 crawl days)', () => {
    const s = slice((b) => {
      bound(b);
      b.bingCrawl = days('2026-10-16', 7, (i) => ({ crawledPages: 100, errors: i === 0 ? 7 : 0 }));
    });
    const f = S4(s, V3);
    expect(f.raw.cur).toBe(1);
    expect(f).toMatchObject({ score: 85, parts: { level: 85, trend: null }, reason: 'ok', pillar: 'site', weight: 0.5 });
    // a crawl day before the window does not count
    const old = slice((b) => { bound(b); b.bingCrawl = [...days('2026-10-01', 3, { crawledPages: 100, errors: 50 }), ...days('2026-10-16', 7, { crawledPages: 100, errors: 0 })]; });
    expect(S4(old, V3).score).toBe(100);
  });
  it('null without crawl rows in the window, under minCrawled, or unlinked', () => {
    expect(S4(slice((b) => { bound(b); b.bingCrawl = days('2026-09-01', 5, { crawledPages: 100, errors: 0 }); }), V3)).toMatchObject({ score: null, reason: 'no_data' });
    expect(S4(slice((b) => { bound(b); b.bingCrawl = days('2026-10-20', 3, { crawledPages: 10, errors: 0 }); }), V3)).toMatchObject({ score: null, reason: 'min_volume' });
    expect(S4(slice((b) => (b.bingCrawl = days('2026-10-20', 3, { crawledPages: 100, errors: 0 }))), V3).reason).toBe('unlinked');
  });
});

describe('scoring', () => {
  it('Harbor Dental worked example: identical score under v2 and v3 when Bing is unlinked', () => {
    const p = FIXTURE.project;
    const a = computeProjectHealth(p, DATE, { bundle: clone(FIXTURE), config: V2, now: NOW });
    const b = computeProjectHealth(p, DATE, { bundle: clone(FIXTURE), config: V3, now: NOW });
    expect(b.score).toBe(a.score);
    expect(b.coverage).toBe(a.coverage);
    expect(b.factors.find((f) => f.key === 'V5').reason).toBe('unlinked');
    expect(b.factors.find((f) => f.key === 'S4').reason).toBe('unlinked');
  });
  it('v2 never computes V5 / S4; v3 does', () => {
    const s = slice(bound);
    expect(computeFactors(s, V2).map((f) => f.key)).not.toContain('V5');
    expect(computeFactors(s, V3).map((f) => f.key)).toEqual(expect.arrayContaining(['V5', 'S4']));
  });
});

describe('loadHealthBundle', () => {
  const project = { ...FIXTURE.project, bingSiteUrl: 'https://harbordental.example/' };
  it('queries Bing tables only with a bound site and a config that has the factors', async () => {
    await loadHealthBundle(project, { from: DATE, to: DATE, cfg: V2 });
    expect(db.calls.some((c) => c.key.startsWith('bing'))).toBe(false);
    db.calls = [];
    await loadHealthBundle({ ...project, bingSiteUrl: null }, { from: DATE, to: DATE, cfg: V3 });
    expect(db.calls.some((c) => c.key.startsWith('bing'))).toBe(false);
    db.calls = [];
    db.overrides['bingDailyMetric.findMany'] = async () => [{ date: new Date('2026-10-01T00:00:00Z'), clicks: 4, impressions: 9 }];
    const b = await loadHealthBundle(project, { from: DATE, to: DATE, cfg: V3 });
    expect(db.calls.map((c) => c.key)).toEqual(expect.arrayContaining(['bingDailyMetric.findMany', 'bingCrawlDaily.findMany']));
    expect(b.bing).toEqual([{ clicks: 4, impressions: 9, date: '2026-10-01' }]);
  });
});
