import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {} }));

import { sliceBundle, bouncePct } from '../../../src/lib/health/healthBundle.js';
import { FACTOR_REGISTRY, computeFactors } from '../../../src/lib/health/healthFactors.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures/bundle-harbor-dental.json'), 'utf8'));
const CFG = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));
const NOW = Date.parse('2026-10-22T07:00:00Z');
const DATE = '2026-10-22';

const bundle = (mut) => {
  const b = JSON.parse(JSON.stringify(FIXTURE));
  if (mut) mut(b);
  return b;
};
const slice = (b = bundle(), opts = {}) => sliceBundle(b, DATE, CFG, { now: NOW, ...opts });
const run = (key, b, opts) => FACTOR_REGISTRY[key](slice(b, opts), CFG);
const inCur = (date) => date >= '2026-09-23' && date <= '2026-10-20';
const inPrev = (date) => date >= '2026-08-26' && date <= '2026-09-22';

describe('Harbor Dental fixture: every factor', () => {
  it('scores all 17 factors with reason ok', () => {
    const out = Object.fromEntries(computeFactors(slice(), CFG).map((f) => [f.key, f.score]));
    expect(out).toEqual({ V1: 81, V2: 61, V3: 62, V4: 39, E1: 64, E2: 62, E3: 66, L1: 21, L2: 48, L3: null, R1: 92, R2: 91, R3: 52, R4: 65, S1: 100, S2: 85, S3: 100 });
  });
  it('design §1 raw values', () => {
    expect(run('E2').raw).toMatchObject({ cur: 48, prev: 44 });
    expect(run('E3').raw).toMatchObject({ cur: 52, prev: 55 });
    expect(run('R4').raw).toMatchObject({ cur: 410, prev: 380 });
    expect(run('L3')).toMatchObject({ raw: { cur: 0, prev: 0 }, score: null, reason: 'min_volume' });
  });
  it('factor contract shape', () => {
    const f = run('V1');
    expect(f).toMatchObject({ key: 'V1', pillar: 'visibility', weight: 1, raw: { cur: 560, prev: 504, yoy: 448 }, parts: { trend: 80.9, level: null }, reason: 'ok' });
  });
});

describe('visibility', () => {
  it('V1 blends YoY when the year-ago window has ≥ 20 rows, else prev only', () => {
    const noYoy = run('V1', bundle((b) => { b.gsc = b.gsc.filter((r) => r.date >= '2026-01-01'); }));
    expect(noYoy.raw.yoy).toBeNull();
    expect(noYoy.parts.trend).toBeCloseTo(50 + 50 * Math.tanh((560 / 504 - 1) * 100 / 25), 1);
    expect(run('V1').parts.trend).toBeGreaterThan(noYoy.parts.trend);
  });
  it('V1 min_volume → null (prev clicks below minPrior)', () => {
    const f = run('V1', bundle((b) => { b.gsc.forEach((r) => { if (inPrev(r.date)) r.clicks = 1; }); }));
    expect(f).toMatchObject({ score: null, reason: 'min_volume' });
  });
  it('V3 position is impression-weighted', () => {
    const f = run('V3', bundle((b) => {
      b.gsc.forEach((r) => {
        if (!inCur(r.date)) return;
        const odd = Number(r.date.slice(8)) % 2;
        r.position = odd ? 4 : 30;
        r.impressions = odd ? 1500 : 500;
      });
    }));
    // 14 odd days ×1500 at 4 + 14 even days ×500 at 30 → (4·1500 + 30·500)/2000 = 10.5
    expect(f.raw.cur).toBe(10.5);
  });
  it('V4 level is clamped to [10, 100]', () => {
    const hi = run('V4', bundle((b) => b.gsc.forEach((r) => { if (inCur(r.date)) r.clicks = 900; })));
    expect(hi.parts.level).toBe(100);
    const lo = run('V4', bundle((b) => b.gsc.forEach((r) => { if (inCur(r.date)) r.clicks = 0; })));
    expect(lo.parts.level).toBe(10);
  });
  it('stale GSC (newest row > 5 days old) re-anchors and flags stale_source', () => {
    const f = run('V1', bundle((b) => { b.gsc = b.gsc.filter((r) => r.date <= '2026-10-10'); }));
    expect(f.reason).toBe('stale_source');
    expect(f.score).not.toBeNull();
  });
  it('unlinked GSC → reason unlinked, score null', () => {
    const f = run('V2', bundle((b) => { b.project.gscSiteUrl = null; b.gsc = null; }));
    expect(f).toMatchObject({ score: null, reason: 'unlinked' });
  });
});

describe('engagement', () => {
  it('E1 uses 14/14 windows while GA4 is younger than 56 days', () => {
    const f = run('E1', bundle((b) => {
      b.ga4 = b.ga4.filter((r) => r.date >= '2026-09-10').map((r) => ({ ...r, sessions: r.date >= '2026-10-07' ? 80 : 40 }));
    }));
    expect(f.raw).toMatchObject({ cur: 14 * 80, prev: 14 * 40, yoy: null });
    expect(f.parts.trend).toBeCloseTo(50 + 50 * Math.tanh(100 / 25), 1);
  });
  it('E3 bounce accepts fractions and percents alike', () => {
    expect(bouncePct(0.5)).toBe(50);
    expect(bouncePct(50)).toBe(50);
    const pct = run('E3', bundle((b) => b.ga4.forEach((r) => { r.bounceRate = Math.round(r.bounceRate * 100); })));
    expect(pct.score).toBe(run('E3').score);
  });
  it('E2: level on the current 28 days + trend vs the prior 28, blended 0.6 / 0.4', () => {
    const f = run('E2');
    expect(f.parts.level).toBe(55); // pl(48 s)
    expect(f.parts.trend).toBeCloseTo(50 + 50 * Math.tanh(((48 - 44) / 44) * 100 / 25), 1);
    expect(f.score).toBe(Math.round(0.6 * f.parts.trend + 0.4 * f.parts.level));
  });
  it('E3: a drop in bounce is a positive (inverted) trend', () => {
    const f = run('E3');
    expect(f.parts.trend).toBeGreaterThan(50);
    expect(f.parts.trend).toBeCloseTo(50 + 50 * Math.tanh(((55 - 52) / 55) * 100 / 25), 1);
    const worse = run('E3', bundle((b) => b.ga4.forEach((r) => { r.bounceRate = r.bounceRate === 0.52 ? 0.6 : r.bounceRate; })));
    expect(worse.parts.trend).toBeLessThan(50);
  });
  it('E2/E3 trend half needs minSessions in the prior window (level only otherwise)', () => {
    const f = run('E2', bundle((b) => b.ga4.forEach((r) => { if (inPrev(r.date)) r.sessions = 1; })));
    expect(f.parts).toEqual({ trend: null, level: 55 });
  });
  it('E2 below minSessions → min_volume', () => {
    const f = run('E2', bundle((b) => b.ga4.forEach((r) => { r.sessions = 1; })));
    expect(f.reason).toBe('min_volume');
  });
});

describe('leads', () => {
  it('L1 total = leads + phone clicks + email clicks', () => {
    expect(run('L1').raw).toMatchObject({ cur: 20, prev: 24 });
  });
  it('L3: GA4 conversions trend; zeros → null (min_volume); no YoY', () => {
    expect(run('L3')).toMatchObject({ score: null, reason: 'min_volume' });
    const f = run('L3', bundle((b) => b.ga4.forEach((r) => { r.conversions = inCur(r.date) ? 2 : 1; })));
    expect(f.raw).toEqual({ cur: 56, prev: 28, yoy: null });
    expect(f.parts.trend).toBeCloseTo(50 + 50 * Math.tanh(100 / 25), 1);
    expect(run('L3', bundle((b) => { b.project.ga4PropertyId = null; b.ga4 = null; })).reason).toBe('unlinked');
  });
  it('no lead rows ever → unlinked', () => {
    expect(run('L1', bundle((b) => { b.leads = []; })).reason).toBe('unlinked');
    expect(run('L2', bundle((b) => { b.leads = []; })).reason).toBe('unlinked');
  });
});

describe('reputation', () => {
  it('R1 needs minReviews', () => {
    const f = run('R1', bundle((b) => { b.reviews = b.reviews.slice(0, 2); }));
    expect(f).toMatchObject({ score: null, reason: 'min_volume' });
  });
  it('R2 blends trend and level when prev ≥ minPrior, falls back to the level otherwise', () => {
    expect(run('R2').raw).toMatchObject({ cur: 11, prev: 9 });
    expect(run('R2').parts.trend).not.toBeNull();
    const f = run('R2', bundle((b) => { b.reviews = b.reviews.filter((r) => !inPrev(r.createTime.slice(0, 10))).concat(b.reviews.filter((r) => inPrev(r.createTime.slice(0, 10))).slice(0, 2)); }));
    expect(f.raw).toMatchObject({ cur: 11, prev: 2 });
    expect(f.parts).toEqual({ trend: null, level: 100 });
  });
  it('R4: GBP actions (calls + directions + website clicks) with the YoY blend when a year of rows exists', () => {
    const plain = run('R4');
    expect(plain.parts.trend).toBeCloseTo(50 + 50 * Math.tanh(((410 - 380) / 380) * 100 / 25), 1);
    const withYoy = run('R4', bundle((b) => {
      for (let t = Date.parse('2025-09-24T00:00:00Z'); t <= Date.parse('2025-10-21T00:00:00Z'); t += 86400000) {
        b.gmb.push({ date: new Date(t).toISOString().slice(0, 10), impressions: 300, calls: 10, directions: 0, websiteClicks: 0 });
      }
    }));
    expect(withYoy.raw.yoy).toBe(280);
    expect(withYoy.parts.trend).toBeGreaterThan(plain.parts.trend);
  });
  it('R3 response rate over the last 90 days', () => {
    expect(run('R3').raw.cur).toBe(40);
  });
  it('no GMB location → reputation factors unlinked', () => {
    const b = bundle((x) => { x.project.gmbLocationId = null; x.reviews = null; x.gmb = null; });
    for (const k of ['R1', 'R2', 'R3', 'R4']) expect(run(k, b).reason).toBe('unlinked');
    expect(run('L3', b).reason).toBe('min_volume'); // L3 is GA4, not GBP
  });
});

describe('website & security', () => {
  it('S1 maps the state; a failing critical/high check forces fail (unless disabled)', () => {
    expect(run('S1', bundle((b) => { b.security.status.overallState = 'warn'; })).score).toBe(60);
    const crit = bundle((b) => { b.security.failChecks = [{ checkId: 'tls.valid', severity: 'critical' }]; });
    expect(run('S1', crit).score).toBe(25);
    crit.security.status.disabled = ['tls.valid'];
    expect(run('S1', crit).score).toBe(100);
    expect(run('S1', bundle((b) => { b.security.status.overallState = 'unknown'; })).score).toBeNull();
  });
  it('S2 streaks per destination; empty → null; verified → 100', () => {
    const one = bundle((b) => { b.security.runs.push({ destinationId: 'agency-db', result: 'missed', verified: false, at: '2026-10-21T23:00:00.000Z' }); });
    expect(run('S2', one).score).toBe(50);
    const two = bundle((b) => {
      b.security.runs.push({ destinationId: 'nas', result: 'failed', verified: false, at: '2026-10-20T03:00:00.000Z' });
      b.security.runs.push({ destinationId: 'nas', result: 'failed', verified: false, at: '2026-10-21T03:00:00.000Z' });
    });
    expect(run('S2', two).score).toBe(15);
    expect(run('S2', bundle((b) => { b.security.runs = []; }))).toMatchObject({ score: null, reason: 'no_data' });
    expect(run('S2', bundle((b) => { b.security.runs.forEach((r) => { r.verified = true; }); })).score).toBe(100);
  });
  it('S3 ages, broken connection, backfilled → null, WordPress sync age', () => {
    expect(run('S3', undefined, { now: NOW + 2 * 86400000 }).score).toBe(70);
    expect(run('S3', undefined, { now: NOW + 5 * 86400000 }).score).toBe(40);
    expect(run('S3', undefined, { now: NOW + 30 * 86400000 }).score).toBe(15);
    expect(run('S3', bundle((b) => { b.project.cmsRepairNeededAt = '2026-10-20T00:00:00.000Z'; })).score).toBe(15);
    expect(run('S3', undefined, { backfilled: true })).toMatchObject({ score: null, reason: 'no_data' });
    const wp = bundle((b) => { b.project.cmsType = 'WORDPRESS'; b.project.wpSiteInfoSyncedAt = '2026-10-21T07:00:00.000Z'; });
    expect(run('S3', wp).score).toBe(100);
  });
  it('backfilled S1 uses that day\'s SecurityDailyPoint', () => {
    const f = FACTOR_REGISTRY.S1(sliceBundle(bundle(), '2026-08-20', CFG, { now: NOW, backfilled: true }), CFG);
    expect(f.score).toBe(60);
  });
  it('no security capability → S1/S2 unlinked', () => {
    const b = bundle((x) => { x.security = { security: false, backups: false, status: null, points: [], failChecks: [], runs: [] }; });
    expect(run('S1', b).reason).toBe('unlinked');
    expect(run('S2', b).reason).toBe('unlinked');
  });
});
