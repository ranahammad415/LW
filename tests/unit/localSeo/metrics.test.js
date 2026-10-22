/**
 * Rating / count from the stored profile, owner metrics null (not 0) without native GBP — in the analytics view and
 * the AI report facts — and health gating with a DataForSEO identity (R1–R3 on, R4 native-only, LOCAL profile).
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
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          assertPrismaArgs(name, method, args);
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/workCycle.js', () => ({
  resolveCycle: async () => ({ id: 'cy', month: 10, year: 2026, status: 'OPEN', label: 'Oct 2026' }),
}));
vi.mock('../../../src/lib/analytics/freezeSnapshot.js', () => ({ buildClientAnalytics: async () => ({}) }));

import { profileTotals, periodReviewStats } from '../../../src/lib/analytics/gmbMetrics.js';
import { buildGmbView } from '../../../src/lib/analytics/sectionBuilders.js';
import { gmbFactsForAi } from '../../../src/lib/analytics/aiHtmlReport/aggregateFacts.js';
import { sliceBundle, loadHealthBundle, HEALTH_PROJECT_SELECT } from '../../../src/lib/health/healthBundle.js';
import { FACTOR_REGISTRY } from '../../../src/lib/health/healthFactors.js';
import { profileFor } from '../../../src/lib/health/healthScoreService.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('profile totals and period stats', () => {
  it('rating weighted by review count, totals summed, null when unknown', () => {
    expect(profileTotals([{ gmbRating: 4.8, gmbReviewsCount: 100 }, { gmbRating: 4.0, gmbReviewsCount: 300 }])).toEqual({ rating: 4.2, reviewsCount: 400 });
    expect(profileTotals([{ gmbRating: null, gmbReviewsCount: null }])).toEqual({ rating: null, reviewsCount: null });
  });
  it('period: new reviews, reply rate, average of the period only; removed reviews ignored', () => {
    const s = new Date('2026-10-01T00:00:00Z');
    const e = new Date('2026-10-31T00:00:00Z');
    const out = periodReviewStats([
      { starRating: 5, replyComment: 'thx', createTime: new Date('2026-10-05T10:00:00Z') },
      { starRating: 3, replyComment: null, createTime: new Date('2026-10-31T23:00:00Z') },
      { starRating: 1, replyComment: null, createTime: new Date('2026-09-30T23:00:00Z') },
      { starRating: 1, replyComment: null, createTime: new Date('2026-10-10T00:00:00Z'), removedAt: new Date() },
    ], s, e);
    expect(out).toEqual({ newReviews: 2, replyRate: 50, periodRating: 4 });
  });
});

describe('buildGmbView', () => {
  const PROJECTS = [{ id: 'p1', name: 'P', gmbLocationId: null, gmbCid: '123456789', gmbPlaceId: null, gmbLocationName: 'Joe', gmbRating: 4.6, gmbReviewsCount: 212, client: {} }];

  it('DataForSEO only: owner metrics null + metricsLimited; rating and total from the profile', async () => {
    db.overrides['project.findMany'] = async () => PROJECTS;
    db.overrides['gmbReview.count'] = async () => 3;
    db.overrides['gmbReview.findMany'] = async () => [
      { id: 'r1', starRating: 1, replyComment: null, createTime: new Date('2026-10-02T00:00:00Z') },
      { id: 'r2', starRating: 1, replyComment: 'ok', createTime: new Date('2026-10-03T00:00:00Z') },
    ];
    const out = await buildGmbView(['c1'], 'overview', {});
    const d = out.data;
    expect(d.metricsLimited).toBe(true);
    expect(d.metricsLimitedNote).toMatch(/Google Business Profile access/);
    for (const k of ['impressions', 'calls', 'directions', 'websiteClicks', 'callsDelta', 'searchShare']) expect(d.kpis[k]).toBeNull();
    expect(d.kpis.rating).toBe(4.6); // profile, not the 1-star sample
    expect(d.kpis.reviews).toBe(212);
    expect(d.kpis.storedReviews).toBe(2);
    expect(d.series).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/dataforseo/i);
    // Every stored-review read excludes soft-removed reviews.
    for (const c of db.calls.filter((x) => x.key.startsWith('gmbReview.'))) expect(c.args.where.removedAt).toBeNull();

    const actions = (await buildGmbView(['c1'], 'actions', {})).data;
    expect(actions.kpis).toMatchObject({ calls: null, total: null, totalDelta: null });
  });

  it('native data present: real numbers, not limited', async () => {
    db.overrides['project.findMany'] = async () => [{ ...PROJECTS[0], gmbLocationId: 'accounts/1/locations/2' }];
    db.overrides['gmbDailyMetric.findMany'] = async (a) =>
      a.where.date.gte.toISOString().startsWith('2026-10-01')
        ? [{ date: new Date('2026-10-02T00:00:00Z'), impressions: 100, impressionsSearch: 60, impressionsMaps: 40, websiteClicks: 3, directions: 2, calls: 0 }]
        : [];
    const d = (await buildGmbView(['c1'], 'overview', {})).data;
    expect(d.metricsLimited).toBe(false);
    expect(d.kpis.calls).toBe(0); // a real zero stays 0
    expect(d.kpis.impressions).toBe(100);
  });
});

describe('AI report facts', () => {
  it('missing owner metrics are null with a note, never 0', () => {
    const f = gmbFactsForAi({ metricsLimited: true, kpis: { impressions: 0, calls: 0, directions: 0, websiteClicks: 0, rating: 4.6, reviews: 212, newReviews: 3, replyRate: 66 } });
    expect(f.kpis).toMatchObject({ impressions: null, calls: null, directions: null, websiteClicks: null, rating: 4.6, reviewsTotal: 212, newReviews: 3, replyRate: 66 });
    expect(f.metricsLimited).toBe(true);
    expect(f.note).toMatch(/not zero/);
    expect(gmbFactsForAi({ metricsLimited: false, kpis: { calls: 0 } }).kpis.calls).toBe(0);
  });
});

describe('health gating with a DataForSEO identity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const FIXTURE = JSON.parse(readFileSync(join(here, '../health/fixtures/bundle-harbor-dental.json'), 'utf8'));
  const CFG = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));
  const NOW = Date.parse('2026-10-22T07:00:00Z');
  const dfsBundle = (mut) => {
    const b = JSON.parse(JSON.stringify(FIXTURE));
    b.project.gmbLocationId = null;
    b.project.gmbCid = '123456789';
    b.gmb = null;
    if (mut) mut(b);
    return b;
  };
  const run = (key, b, opts = {}) => FACTOR_REGISTRY[key](sliceBundle(b, '2026-10-22', CFG, { now: NOW, ...opts }), CFG);

  it('R1–R3 scored from either source; R4 stays native-only', () => {
    const b = dfsBundle();
    for (const k of ['R1', 'R2', 'R3']) expect(run(k, b).reason).not.toBe('unlinked');
    expect(run('R4', b).reason).toBe('unlinked');
  });

  it('R1 uses the profile rating when present (live), the review sample otherwise / when backfilled', () => {
    const b = dfsBundle((x) => { x.project.gmbRating = 3.6; x.project.gmbReviewsCount = 80; });
    expect(run('R1', b).raw.cur).toBe(3.6);
    expect(run('R1', b, { backfilled: true }).raw.cur).not.toBe(3.6);
    expect(run('R1', dfsBundle((x) => { x.project.gmbRating = 4.9; x.project.gmbReviewsCount = 1; })).reason).toBe('min_volume');
  });

  it('a bare name keyword is not an identity', () => {
    const b = dfsBundle((x) => { x.project.gmbCid = 'Harbor Dental Milwaukee'; });
    expect(run('R1', b).reason).toBe('unlinked');
  });

  it('loadHealthBundle reads reviews for a CID project (not for a project without identity) and skips removed ones', async () => {
    const p = { id: 'p1', projectType: 'SEO_CAMPAIGN', gmbLocationId: null, gmbCid: '123456789' };
    await loadHealthBundle(p, { from: '2026-10-22', to: '2026-10-22', cfg: CFG });
    const rv = db.calls.find((c) => c.key === 'gmbReview.findMany');
    expect(rv.args.where.removedAt).toBeNull();
    expect(db.calls.some((c) => c.key === 'gmbDailyMetric.findMany')).toBe(false);
    db.calls = [];
    await loadHealthBundle({ ...p, gmbCid: null }, { from: '2026-10-22', to: '2026-10-22', cfg: CFG });
    expect(db.calls.some((c) => c.key === 'gmbReview.findMany')).toBe(false);
    expect(HEALTH_PROJECT_SELECT).toMatchObject({ gmbCid: true, gmbPlaceId: true, gmbRating: true, gmbReviewsCount: true });
  });

  it('profileFor: LOCAL with native, CID or place_id', () => {
    expect(profileFor({ projectType: 'SEO_CAMPAIGN', gmbCid: '123456789' })).toBe('LOCAL');
    expect(profileFor({ projectType: 'SEO_CAMPAIGN', gmbPlaceId: 'ChIJplace1' })).toBe('LOCAL');
    expect(profileFor({ projectType: 'SEO_CAMPAIGN', gmbCid: 'Joe Pizza' })).toBe('SEO');
    expect(profileFor({ projectType: 'SEO_CAMPAIGN', gmbLocationId: 'x' })).toBe('LOCAL');
  });
});
