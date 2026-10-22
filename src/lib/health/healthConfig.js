/**
 * Health score v2 config: the active HealthScoreConfig row (cached 5 min per PM2 instance), validation of OWNER
 * edits and new versions. docs/ledger/features/health-score.md §Config.
 */
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { DEFAULT_CONFIG_V1, DEFAULT_CONFIG_V2, PILLARS, PROFILES } from './defaultConfig.js';

export { DEFAULT_CONFIG_V1, DEFAULT_CONFIG_V2, PILLARS, PROFILES };

export const CONFIG_TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, config }

export function invalidateConfigCache() {
  cache = null;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * The active config (`version` taken from the row). Falls back to DEFAULT_CONFIG_V1 when the table is empty or
 * not migrated yet, so a missing row never stops the daily run.
 */
export async function getActiveConfig({ now = Date.now() } = {}) {
  if (cache && now - cache.at < CONFIG_TTL_MS) return cache.config;
  let config = null;
  try {
    const row = await prisma.healthScoreConfig.findFirst({ where: { isActive: true }, orderBy: { version: 'desc' } });
    if (row?.config && typeof row.config === 'object') config = { ...clone(row.config), version: row.version };
  } catch {
    config = null;
  }
  if (!config) config = clone(DEFAULT_CONFIG_V1);
  cache = { at: now, config };
  return config;
}

// ── validation ──

const pct = z.number().int().min(0).max(100);
const points = z.array(z.tuple([z.number().finite(), z.number().min(0).max(100)])).min(2).max(10);
const nonNegInt = z.number().int().min(0).max(1_000_000);
const factorBase = {
  pillar: z.enum(PILLARS),
  weight: z.number().min(0).max(10),
};

const FACTOR_SCHEMAS = {
  V1: z.object({ ...factorBase, minPrior: nonNegInt }),
  V2: z.object({ ...factorBase, minPrior: nonNegInt }),
  V3: z.object({ ...factorBase, level: points, minImpr: nonNegInt }),
  V4: z.object({ ...factorBase, expectedA: z.number().positive().max(1), expectedB: z.number().min(-5).max(0), gain: z.number().positive().max(500), minImpr: nonNegInt }),
  E1: z.object({ ...factorBase, minPrior: nonNegInt, shortWindowUntilDays: z.number().int().min(0).max(400) }),
  E2: z.object({ ...factorBase, level: points, minSessions: nonNegInt }),
  E3: z.object({ ...factorBase, level: points, minSessions: nonNegInt }),
  L1: z.object({ ...factorBase, minPrior: nonNegInt }),
  L2: z.object({ ...factorBase, level: points, minSessions: nonNegInt }),
  L3: z.object({ ...factorBase, minPrior: nonNegInt }),
  R1: z.object({ ...factorBase, level: points, lastN: z.number().int().min(1).max(500), minReviews: nonNegInt }),
  R2: z.object({ ...factorBase, minPrior: nonNegInt, level: points }),
  R3: z.object({ ...factorBase, level: points, days: z.number().int().min(7).max(365), minReviews: nonNegInt }),
  R4: z.object({ ...factorBase, minPrior: nonNegInt }),
  S1: z.object({ ...factorBase, states: z.object({ ok: pct, warn: pct, fail: pct }) }),
  S2: z.object({ ...factorBase, days: z.number().int().min(1).max(60), scores: z.object({ okVerified: pct, ok: pct, miss1: pct, miss2plus: pct }) }),
  S3: z.object({ ...factorBase, ageDays: z.array(z.tuple([z.number().min(0).max(365), pct])).min(1).max(10), beyond: pct }),
  // Config v2 (contract 1.8.0): optional, so version 1 (without them) stays valid and loadable.
  R5: z.object({ ...factorBase, level: points, minChecked: z.number().int().min(1).max(200) }).optional(),
  A1: z.object({ ...factorBase, level: points, maxAgeDays: z.number().int().min(7).max(120), minCells: z.number().int().min(1).max(1000) }).optional(),
};

const profileSchema = z
  .object(Object.fromEntries(PILLARS.map((p) => [p, pct])))
  .refine((w) => PILLARS.reduce((s, p) => s + w[p], 0) === 100, { message: 'Profile weights must add up to 100' });

export const configSchema = z.object({
  version: z.number().int().optional(),
  window: z.object({
    days: z.number().int().min(7).max(90),
    gscLagDays: z.number().int().min(0).max(7),
    yoyMinCoverageDays: z.number().int().min(0).max(90),
  }),
  minCoverage: pct,
  minPillars: z.number().int().min(1).max(PILLARS.length),
  factorFloor: pct,
  pillarFloor: pct,
  blend: z.object({ trend: z.number().min(0).max(1), level: z.number().min(0).max(1) })
    .refine((b) => Math.abs(b.trend + b.level - 1) < 1e-9, { message: 'blend.trend + blend.level must be 1' }),
  trendK: z.number().positive().max(1000),
  yoyShare: z.number().min(0).max(1),
  profiles: z.object(Object.fromEntries(PROFILES.map((p) => [p, profileSchema]))),
  factors: z.object(FACTOR_SCHEMAS),
  bands: z.array(z.tuple([pct, z.enum(['excellent', 'healthy', 'at_risk', 'critical'])])).length(4),
  trendArrowDelta: z.number().int().min(0).max(50),
  alerts: z.object({
    sustainedDropPoints: z.number().int().min(1).max(100),
    sustainedDays: z.number().int().min(1).max(60),
    consecutiveRuns: z.number().int().min(1).max(10),
    dedupeDays: z.number().int().min(1).max(60),
    minCoverage: pct,
  }),
});

/** → { ok: true, config } (unknown keys stripped) or { ok: false, errors: [{path, message}] }. */
export function validateConfig(json) {
  const res = configSchema.safeParse(json);
  if (res.success) return { ok: true, config: res.data };
  return { ok: false, errors: res.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })) };
}

/** Versions, newest first (staff config card). */
export async function listConfigVersions({ take = 20 } = {}) {
  return prisma.healthScoreConfig.findMany({
    orderBy: { version: 'desc' },
    take,
    select: { version: true, isActive: true, note: true, createdById: true, createdAt: true },
  });
}

/**
 * Store a validated config as version max+1 and make it the only active one (one transaction), then drop the
 * cache. Returns the new row.
 */
export async function createConfigVersion({ config, note = null, userId = null }) {
  const row = await prisma.$transaction(async (tx) => {
    const top = await tx.healthScoreConfig.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
    const version = (top?.version || 0) + 1;
    await tx.healthScoreConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });
    return tx.healthScoreConfig.create({
      data: { version, config: { ...config, version }, isActive: true, note: note ? String(note).slice(0, 500) : null, createdById: userId },
    });
  });
  invalidateConfigCache();
  return row;
}
