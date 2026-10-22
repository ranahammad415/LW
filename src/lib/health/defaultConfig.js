/**
 * Health score v2, config version 1 (owner-approved 2026-10-22). docs/ledger/features/health-score.md.
 *
 * The migration 20261105_health_score_v2 and prisma/seed-health-config.cjs seed exactly this object as
 * HealthScoreConfig version 1 (tests/unit/health/healthConfig.test.js checks the migration copy is identical).
 * Never edit version 1 in place: OWNER edits create a new version (PUT /api/admin/health/config).
 */
export const DEFAULT_CONFIG_V1 = Object.freeze({
  version: 1,
  window: { days: 28, gscLagDays: 2, yoyMinCoverageDays: 20 },
  minCoverage: 40,
  minPillars: 2,
  factorFloor: 10,
  pillarFloor: 5,
  blend: { trend: 0.6, level: 0.4 },
  trendK: 25,
  yoyShare: 0.5,
  profiles: {
    SEO: { visibility: 25, engagement: 10, leads: 20, reputation: 15, aiVisibility: 10, site: 15, content: 5 },
    LOCAL: { visibility: 20, engagement: 10, leads: 20, reputation: 25, aiVisibility: 5, site: 15, content: 5 },
    AEO: { visibility: 20, engagement: 10, leads: 15, reputation: 10, aiVisibility: 30, site: 10, content: 5 },
    WEBSITE: { visibility: 15, engagement: 15, leads: 25, reputation: 0, aiVisibility: 0, site: 40, content: 5 },
  },
  factors: {
    V1: { pillar: 'visibility', weight: 1, minPrior: 50 },
    V2: { pillar: 'visibility', weight: 1, minPrior: 500 },
    V3: { pillar: 'visibility', weight: 1, level: [[8, 100], [20, 60], [40, 20]], minImpr: 200 },
    V4: { pillar: 'visibility', weight: 1, expectedA: 0.3, expectedB: -0.8, gain: 70, minImpr: 200 },
    E1: { pillar: 'engagement', weight: 1, minPrior: 100, shortWindowUntilDays: 56 },
    E2: { pillar: 'engagement', weight: 1, level: [[20, 20], [60, 70], [120, 100]], minSessions: 50 },
    E3: { pillar: 'engagement', weight: 1, level: [[35, 100], [60, 60], [85, 15]], minSessions: 50 },
    L1: { pillar: 'leads', weight: 1, minPrior: 10 },
    L2: { pillar: 'leads', weight: 1, level: [[0.5, 20], [2, 70], [5, 100]], minSessions: 100 },
    L3: { pillar: 'leads', weight: 1, minPrior: 10 },
    R1: { pillar: 'reputation', weight: 1, level: [[3.5, 10], [4.2, 60], [4.7, 100]], lastN: 90, minReviews: 3 },
    R2: { pillar: 'reputation', weight: 1, minPrior: 3, level: [[0, 30], [4, 100]] },
    R3: { pillar: 'reputation', weight: 1, level: [[0, 20], [50, 60], [90, 100]], days: 90, minReviews: 3 },
    R4: { pillar: 'reputation', weight: 1, minPrior: 20 },
    S1: { pillar: 'site', weight: 1, states: { ok: 100, warn: 60, fail: 25 } },
    S2: { pillar: 'site', weight: 1, days: 14, scores: { okVerified: 100, ok: 85, miss1: 50, miss2plus: 15 } },
    S3: { pillar: 'site', weight: 1, ageDays: [[1, 100], [3, 70], [7, 40]], beyond: 15 },
  },
  bands: [[80, 'excellent'], [60, 'healthy'], [40, 'at_risk'], [0, 'critical']],
  trendArrowDelta: 3,
  alerts: { sustainedDropPoints: 10, sustainedDays: 7, consecutiveRuns: 2, dedupeDays: 7, minCoverage: 60 },
});

export const PILLARS = Object.freeze(['visibility', 'engagement', 'leads', 'reputation', 'aiVisibility', 'site', 'content']);
export const PROFILES = Object.freeze(['SEO', 'LOCAL', 'AEO', 'WEBSITE']);
