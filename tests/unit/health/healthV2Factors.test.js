/**
 * Health config version 2 (contract-180): R5 "Listings consistency" and A1 "AI citation rate" maths, config v2 =
 * v1 + the two factors (migration copy identical), validation accepts v2 and still accepts v1, v1 configs never load
 * or score the new factors, the bundle only queries the new sources when the config has them.
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
import { R5, A1, computeFactors } from '../../../src/lib/health/healthFactors.js';
import { DEFAULT_CONFIG_V1, DEFAULT_CONFIG_V2, validateConfig } from '../../../src/lib/health/healthConfig.js';
import { FACTOR_LABELS, SENTENCES } from '../../../src/lib/health/healthExplain.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures/bundle-harbor-dental.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const V2 = clone(DEFAULT_CONFIG_V2);
const V1 = clone(DEFAULT_CONFIG_V1);
const NOW = Date.parse('2026-10-22T07:00:00Z');
const DATE = '2026-10-22';
const slice = (mut, opts = {}, cfg = V2) => {
  const b = clone(FIXTURE);
  if (mut) mut(b);
  return sliceBundle(b, DATE, cfg, { now: NOW, ...opts });
};

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('config version 2', () => {
  it('is version 1 plus R5 (reputation) and A1 (aiVisibility), weight 1 each; v1 is untouched', () => {
    const { R5: r5, A1: a1, ...rest } = V2.factors;
    expect(rest).toEqual(V1.factors);
    expect(r5).toMatchObject({ pillar: 'reputation', weight: 1, minChecked: 3 });
    expect(a1).toMatchObject({ pillar: 'aiVisibility', weight: 1, maxAgeDays: 45 });
    expect({ ...V2, version: 1, factors: V1.factors }).toEqual(V1);
    expect(V1.factors.R5).toBeUndefined();
  });
  it('the migration inserts exactly DEFAULT_CONFIG_V2 as version 2 (INSERT IGNORE) and activates it only over version 1', () => {
    const sql = readFileSync(join(here, '../../../prisma/migrations/20261108_contract_180/migration.sql'), 'utf8');
    const m = sql.match(/INSERT IGNORE INTO `healthscoreconfig`[\s\S]*?VALUES \(UUID\(\), 2, '(\{.*?\})', 0/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m[1])).toEqual(V2);
    expect(sql).toMatch(/WHERE @ours = 1 AND \(@active IS NULL OR @active = 1\)/);
  });
  it('validation accepts v2 and still accepts v1 (no R5 / A1); bad R5 / A1 values are refused', () => {
    expect(validateConfig(clone(V2)).ok).toBe(true);
    const v1 = validateConfig(clone(V1));
    expect(v1.ok).toBe(true);
    expect(v1.config.factors.R5).toBeUndefined();
    const bad = clone(V2);
    bad.factors.A1.maxAgeDays = 400;
    expect(validateConfig(bad).ok).toBe(false);
    const bad2 = clone(V2);
    bad2.factors.R5.pillar = 'nope';
    expect(validateConfig(bad2).ok).toBe(false);
  });
  it('labels and client sentences exist for both', () => {
    expect(FACTOR_LABELS.R5).toBe('Listings consistency');
    expect(FACTOR_LABELS.A1).toBe('AI citation rate');
    expect(SENTENCES.A1({ score: 20 }).text).toMatch(/rarely mention/);
  });
});

describe('R5 listings consistency', () => {
  it('level = pl(correct / (correct + wrong) %); null under 3 checked; unlinked without a mirror', () => {
    const s = slice((b) => (b.citations = ['correct', 'correct', 'correct', 'wrong', 'missing', 'unknown']));
    const f = R5(s, V2);
    expect(f.raw.cur).toBe(75);
    // pl(75) on [[50,20],[80,60],[100,100]] = 20 + 40·25/30 = 53.3 → level only → 53
    expect(f).toMatchObject({ score: 53, parts: { level: 53.3, trend: null }, reason: 'ok', pillar: 'reputation' });
    expect(R5(slice((b) => (b.citations = ['correct', 'wrong', 'missing', 'missing'])), V2)).toMatchObject({ score: null, reason: 'min_volume' });
    expect(R5(slice((b) => (b.citations = ['unknown'])), V2)).toMatchObject({ score: null, reason: 'no_data' });
    expect(R5(slice((b) => (b.citations = null)), V2).reason).toBe('unlinked');
    expect(R5(slice((b) => (b.citations = ['correct', 'correct', 'correct']), { backfilled: true }), V2)).toMatchObject({ score: null, reason: 'no_data' });
    expect(R5(slice((b) => (b.citations = ['correct', 'correct', 'correct'])), V2).score).toBe(100);
  });
});

describe('A1 AI citation rate', () => {
  const runs = (...list) => (b) => (b.aiRuns = list.map(([at, cells, cited]) => ({ at, cells, cited })));
  it('level from the latest run ≤ 45 days old, trend from Δ points vs the previous run', () => {
    const f = A1(slice(runs(['2026-09-02T06:00:00.000Z', 40, 8], ['2026-10-02T06:00:00.000Z', 40, 14])), V2);
    // rate 35 % → pl = 60 + 40·10/35 = 71.43; prev 20 % → Δ +15 pts → trend = 50 + 50·tanh(15/25) = 76.85
    expect(f.raw).toEqual({ cur: 35, prev: 20, yoy: null });
    expect(f.parts).toEqual({ trend: 76.9, level: 71.4 });
    expect(f.score).toBe(Math.round(0.6 * 76.852 + 0.4 * 71.4286));
    expect(f.pillar).toBe('aiVisibility');
  });
  it('null without a run in the window, under minCells, or unlinked (config without A1 loads no runs)', () => {
    expect(A1(slice(runs(['2026-08-20T06:00:00.000Z', 40, 10])), V2)).toMatchObject({ score: null, reason: 'no_data' });
    expect(A1(slice(runs()), V2)).toMatchObject({ score: null, reason: 'no_data' });
    expect(A1(slice(runs(['2026-10-02T06:00:00.000Z', 4, 4])), V2)).toMatchObject({ score: null, reason: 'min_volume' });
    expect(A1(slice((b) => (b.aiRuns = null)), V2).reason).toBe('unlinked');
    // A run finished after the score date is not seen (point in time).
    expect(A1(slice(runs(['2026-10-25T06:00:00.000Z', 40, 20])), V2).reason).toBe('no_data');
    // Level only when there is no previous run.
    expect(A1(slice(runs(['2026-10-02T06:00:00.000Z', 20, 0])), V2)).toMatchObject({ score: 15, parts: { trend: null, level: 15 } });
  });
});

describe('v1 vs v2 wiring', () => {
  it('a v1 config never computes R5 / A1 and never queries their sources', async () => {
    const keys = computeFactors(slice((b) => ((b.citations = ['correct', 'correct', 'correct']), (b.aiRuns = [])), {}, V1), V1).map((f) => f.key);
    expect(keys).not.toContain('R5');
    expect(keys).not.toContain('A1');
    await loadHealthBundle({ id: 'p1' }, { from: DATE, to: DATE, cfg: V1 });
    expect(db.calls.some((c) => c.key.startsWith('seoCitationMirror') || c.key.startsWith('aiVisibilityRun'))).toBe(false);
  });
  it('a v2 config loads the mirror and completed non-demo runs (error cells excluded from the counts)', async () => {
    db.overrides['seoCitationMirror.findMany'] = async () => [{ napStatus: 'correct' }, { napStatus: 'wrong' }];
    db.overrides['aiVisibilityRun.findMany'] = async () => [{ id: 'r', finishedAt: new Date('2026-10-02T06:00:00Z'), results: [{ cited: true, citationType: 'brand' }, { cited: false, citationType: 'none' }, { cited: false, citationType: 'error' }] }];
    const b = await loadHealthBundle({ id: 'p1' }, { from: DATE, to: DATE, cfg: V2 });
    expect(b.citations).toEqual(['correct', 'wrong']);
    expect(b.aiRuns).toEqual([{ at: '2026-10-02T06:00:00.000Z', cells: 2, cited: 1 }]);
    const where = db.calls.find((c) => c.key === 'aiVisibilityRun.findMany').args.where;
    expect(where).toMatchObject({ projectId: 'p1', status: 'completed', isDemo: false });
    const keys = computeFactors(sliceBundle({ ...clone(FIXTURE), citations: b.citations, aiRuns: b.aiRuns }, DATE, V2, { now: NOW }), V2).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['R5', 'A1']));
  });
});
