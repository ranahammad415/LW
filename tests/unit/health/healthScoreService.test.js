import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures/bundle-harbor-dental.json'), 'utf8'));

const db = vi.hoisted(() => ({ calls: [], projects: [], healthRows: new Map(), clientRows: new Map(), accounts: new Map(), throwFor: new Set() }));

vi.mock('../../../src/lib/prisma.js', async () => {
  const { shapeChecked } = await import('../../helpers/prismaShape.js');
  const asDate = (s) => new Date(`${s}T00:00:00.000Z`);
  const inRange = (date, where) => (!where?.gte || date >= where.gte) && (!where?.lte || date <= where.lte);
  const daily = (key) => ({
    findMany: async ({ where }) => {
      db.calls.push(`${key}.findMany`);
      if (db.throwFor.has(where.projectId)) throw new Error('boom');
      return (FIXTURE[key] || []).map((r) => ({ ...r, date: asDate(r.date) })).filter((r) => inRange(r.date, where.date));
    },
  });
  return {
    prisma: shapeChecked({
      gscDailyMetric: daily('gsc'),
      ga4DailyMetric: daily('ga4'),
      gmbDailyMetric: daily('gmb'),
      siteLeadDailyMetric: daily('leads'),
      gmbReview: {
        findMany: async () => FIXTURE.reviews.map((r) => ({ starRating: r.starRating, replyComment: r.replied ? 'Thanks!' : null, createTime: new Date(r.createTime) })),
      },
      securitySiteStatus: { findUnique: async () => FIXTURE.security.status },
      securityDailyPoint: { findMany: async () => FIXTURE.security.points },
      securityCheckState: { findMany: async () => [] },
      securityBackupRun: {
        findMany: async () => FIXTURE.security.runs.map((r) => ({ destinationId: r.destinationId, result: r.result, verified: r.verified, createdAt: new Date(r.at), finishedAt: new Date(r.at) })),
      },
      healthScoreConfig: { findFirst: async () => null },
      project: {
        findMany: async ({ where }) => db.projects.filter((p) => (!where?.clientId || p.clientId === where.clientId)),
        findUnique: async ({ where }) => db.projects.find((p) => p.id === where.id) || null,
      },
      healthScoreDaily: {
        upsert: async ({ where, create, update }) => {
          const k = `${where.projectId_date.projectId}|${where.projectId_date.date}`;
          db.calls.push(`healthScoreDaily.upsert:${k}`);
          const row = db.healthRows.has(k) ? { ...db.healthRows.get(k), ...update } : { ...create };
          db.healthRows.set(k, row);
          return row;
        },
        findUnique: async ({ where }) => db.healthRows.get(`${where.projectId_date.projectId}|${where.projectId_date.date}`) || null,
        findMany: async ({ where }) => {
          const out = [];
          for (const [k, r] of db.healthRows) {
            const [pid, date] = k.split('|');
            if (where.projectId && pid !== where.projectId) continue;
            if (typeof where.date === 'string' && date !== where.date) continue;
            if (where.date?.gte && (date < where.date.gte || date > where.date.lte)) continue;
            if (where.project) {
              const p = db.projects.find((x) => x.id === pid);
              if (!p || p.clientId !== where.project.clientId || !where.project.status.in.includes(p.status)) continue;
            }
            out.push({ ...r, projectId: pid, date });
          }
          return out;
        },
      },
      clientHealthDaily: {
        findUnique: async ({ where }) => db.clientRows.get(`${where.clientId_date.clientId}|${where.clientId_date.date}`) || null,
        upsert: async ({ where, create, update }) => {
          const k = `${where.clientId_date.clientId}|${where.clientId_date.date}`;
          db.clientRows.set(k, { ...(db.clientRows.get(k) || create), ...update });
          return db.clientRows.get(k);
        },
      },
      clientAccount: {
        update: async ({ where, data }) => {
          db.accounts.set(where.id, { ...(db.accounts.get(where.id) || {}), ...data });
          return db.accounts.get(where.id);
        },
        updateMany: async () => ({ count: 0 }),
      },
    }),
  };
});

import {
  profileFor, scoreFromPillars, computeProjectHealth, runHealthScoreDaily, rollupRows, rollupClient, backfillProject, projectWeight,
} from '../../../src/lib/health/healthScoreService.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';
import { pillarScore } from '../../../src/lib/health/healthMath.js';

const CFG = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));
const NOW = Date.parse('2026-10-22T07:00:00Z');
const HARBOR = FIXTURE.project;

beforeEach(() => {
  db.calls = [];
  db.projects = [];
  db.healthRows = new Map();
  db.clientRows = new Map();
  db.accounts = new Map();
  db.throwFor = new Set();
});

describe('worked example (Harbor Dental, LOCAL)', () => {
  it('pillars 67/64/35/75/–/87/– → score 65, coverage 90%', () => {
    const r = scoreFromPillars({ visibility: 67, engagement: 64, leads: 35, reputation: 75, aiVisibility: null, site: 87, content: null }, 'LOCAL', CFG);
    expect(r.score).toBe(65);
    expect(r.coverage).toBe(90);
  });

  it('end to end from the fixture bundle: 65 / 90%, AI and content excluded', () => {
    const bundle = JSON.parse(JSON.stringify(FIXTURE));
    const row = computeProjectHealth(HARBOR, '2026-10-22', { bundle, config: CFG, now: NOW, base28: 60 });
    expect(row.profile).toBe('LOCAL');
    expect(row.score).toBe(65);
    expect(row.coverage).toBe(90);
    expect(row.trend28).toBe(5);
    expect(row.pillars.aiVisibility.score).toBeNull();
    expect(row.pillars.content.score).toBeNull();
    expect(row.pillars.leads.score).toBe(35);
    expect(row.pillars.engagement.score).toBe(64);
    expect(row.pillars.reputation.score).toBe(75);
    expect(row.factors.find((f) => f.key === 'L3').score).toBeNull();
    expect(row.factors).toHaveLength(17);
  });
});

describe('worked example at factor level (design §1)', () => {
  it('E1 64, E2 60, E3 67 → Engagement 64; R1 92, R2 91, R3 52, R4 66 → Reputation 75; L1 21, L2 48, L3 null → Leads 35', () => {
    const f = (pillar, score) => ({ pillar, score, weight: 1 });
    expect(pillarScore([f('e', 64), f('e', 60), f('e', 67)], CFG.pillarFloor)).toBe(64);
    expect(pillarScore([f('r', 92), f('r', 91), f('r', 52), f('r', 66)], CFG.pillarFloor)).toBe(75);
    expect(pillarScore([f('l', 21), f('l', 48), f('l', null)], CFG.pillarFloor)).toBe(35);
  });
});

describe('profileFor', () => {
  it('maps project types', () => {
    expect(profileFor({ projectType: 'AEO_GEO_CAMPAIGN' })).toBe('AEO');
    expect(profileFor({ projectType: 'SEO_CAMPAIGN', gmbLocationId: 'x' })).toBe('LOCAL');
    expect(profileFor({ projectType: 'SEO_CAMPAIGN', gmbLocationId: null })).toBe('SEO');
    expect(profileFor({ projectType: 'WEBSITE_DESIGN' })).toBe('WEBSITE');
    expect(profileFor({ projectType: 'WEBSITE_DEVELOPMENT' })).toBe('WEBSITE');
    expect(profileFor({ projectType: 'SOCIAL_MEDIA_CAMPAIGN' })).toBeNull();
    expect(profileFor({ projectType: 'ONE_OFF_PROJECT' })).toBeNull();
  });
});

describe('runHealthScoreDaily', () => {
  it('isolates a throwing project, skips non-scorable ones, upserts on projectId_date, rolls up the client', async () => {
    db.projects = [
      { ...HARBOR, id: 'p1' },
      { ...HARBOR, id: 'bad' },
      { ...HARBOR, id: 'social', projectType: 'SOCIAL_MEDIA_CAMPAIGN' },
    ];
    db.throwFor.add('bad');
    const out = await runHealthScoreDaily({ date: '2026-10-22', now: NOW, env: {}, alerts: false });
    expect(out).toMatchObject({ projects: 1, clients: 1, skipped: 1 });
    expect(out.errors).toEqual([{ projectId: 'bad', message: 'boom' }]);
    expect(db.healthRows.get('p1|2026-10-22').score).toBe(65);
    expect(db.accounts.get('c-harbor')).toMatchObject({ healthScore: 65, healthCoverage: 90 });
    // a second run upserts the same key (idempotent)
    await runHealthScoreDaily({ date: '2026-10-22', now: NOW, env: {}, alerts: false });
    expect(db.calls.filter((c) => c === 'healthScoreDaily.upsert:p1|2026-10-22')).toHaveLength(2);
    expect(db.healthRows.size).toBe(1);
  });

  it('HEALTH_SCORE_ENABLED=false does nothing', async () => {
    db.projects = [{ ...HARBOR, id: 'p1' }];
    const out = await runHealthScoreDaily({ date: '2026-10-22', env: { HEALTH_SCORE_ENABLED: 'false' } });
    expect(out.disabled).toBe(true);
    expect(db.healthRows.size).toBe(0);
  });

  it('unlinked sources are not queried', async () => {
    db.projects = [{ ...HARBOR, id: 'p1', gscSiteUrl: null, ga4PropertyId: null }];
    await runHealthScoreDaily({ date: '2026-10-22', now: NOW, env: {}, alerts: false });
    expect(db.calls).not.toContain('gsc.findMany');
    expect(db.calls).not.toContain('ga4.findMany');
    expect(db.calls).toContain('gmb.findMany');
  });
});

describe('rollup', () => {
  it('weights projects by 1 + log10(1 + clicks28 + sessions28) and ignores null scores in the score', () => {
    const big = { projectId: 'a', score: 80, coverage: 100, pillars: { visibility: { score: 80 } }, factors: [{ key: 'V1', raw: { cur: 9000 } }, { key: 'E1', raw: { cur: 999 } }] };
    const small = { projectId: 'b', score: 40, coverage: 50, pillars: { visibility: { score: 40 } }, factors: [] };
    const none = { projectId: 'c', score: null, coverage: 20, pillars: {}, factors: [] };
    expect(projectWeight(big)).toBeCloseTo(5, 6);
    expect(projectWeight(small)).toBe(1);
    const r = rollupRows([big, small, none]);
    expect(r.score).toBe(Math.round((5 * 80 + 40) / 6));
    expect(r.coverage).toBe(Math.round((5 * 100 + 50 + 20) / 7));
    expect(r.pillars.visibility.score).toBe(73);
    expect(r.projectWeights.map((p) => p.weight)).toEqual([5, 1, 1]);
  });

  it('only ACTIVE/PAUSED projects roll up; ClientAccount gets score, coverage, trend28', async () => {
    db.projects = [{ ...HARBOR, id: 'p1', status: 'ACTIVE' }, { ...HARBOR, id: 'p2', status: 'SETUP' }];
    db.healthRows.set('p1|2026-10-22', { score: 70, coverage: 90, pillars: {}, factors: [] });
    db.healthRows.set('p2|2026-10-22', { score: 10, coverage: 90, pillars: {}, factors: [] });
    db.clientRows.set('c-harbor|2026-09-24', { score: 60 });
    const out = await rollupClient('c-harbor', '2026-10-22', CFG);
    expect(out).toMatchObject({ score: 70, trend28: 10, projects: 1 });
    expect(db.accounts.get('c-harbor')).toMatchObject({ healthScore: 70, healthCoverage: 90, healthTrend28: 10 });
  });
});

describe('backfillProject', () => {
  it('caps days, flags rows as backfilled, keeps live rows, does not touch ClientAccount', async () => {
    db.projects = [{ ...HARBOR, id: 'p1' }];
    db.healthRows.set('p1|2026-10-20', { score: 50, coverage: 90, backfilled: false, pillars: {}, factors: [] });
    const out = await backfillProject('p1', { days: 500, env: { HEALTH_BACKFILL_MAX_DAYS: '5' }, now: NOW, config: CFG });
    expect(out).toMatchObject({ rows: 4, kept: 1, days: 5 });
    expect(db.healthRows.get('p1|2026-10-21').backfilled).toBe(true);
    expect(db.healthRows.get('p1|2026-10-20').score).toBe(50);
    expect(db.healthRows.has('p1|2026-10-22')).toBe(false);
    expect(db.accounts.size).toBe(0);
    // S3 is never scored on a backfilled day
    expect(db.healthRows.get('p1|2026-10-21').factors.find((f) => f.key === 'S3').score).toBeNull();
  });
});
