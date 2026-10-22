import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const db = vi.hoisted(() => ({ rows: [], findFirst: 0 }));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    healthScoreConfig: {
      findFirst: async () => {
        db.findFirst += 1;
        return db.rows[0] || null;
      },
    },
  },
}));

import { DEFAULT_CONFIG_V1, validateConfig, getActiveConfig, invalidateConfigCache } from '../../../src/lib/health/healthConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const clone = (v) => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  db.rows = [];
  db.findFirst = 0;
  invalidateConfigCache();
});

describe('config v1', () => {
  it('the migration seeds exactly DEFAULT_CONFIG_V1', () => {
    const sql = readFileSync(join(here, '../../../prisma/migrations/20261105_health_score_v2/migration.sql'), 'utf8');
    const m = sql.match(/INSERT IGNORE INTO `healthscoreconfig`[\s\S]*?VALUES \(UUID\(\), 1, '(\{.*?\})', 1/);
    expect(m).toBeTruthy();
    expect(JSON.parse(m[1])).toEqual(clone(DEFAULT_CONFIG_V1));
  });

  it('default config is valid; every profile sums to 100', () => {
    expect(validateConfig(clone(DEFAULT_CONFIG_V1)).ok).toBe(true);
  });

  it('rejects a profile that does not sum to 100, bad ranges and unknown pillars', () => {
    const c = clone(DEFAULT_CONFIG_V1);
    c.profiles.SEO.visibility = 30;
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    expect(r.errors[0].path).toBe('profiles.SEO');
    const d = clone(DEFAULT_CONFIG_V1);
    d.minCoverage = 140;
    expect(validateConfig(d).ok).toBe(false);
    const e = clone(DEFAULT_CONFIG_V1);
    e.factors.V1.pillar = 'nope';
    expect(validateConfig(e).ok).toBe(false);
    const f = clone(DEFAULT_CONFIG_V1);
    f.profiles.SEO.visibility = 24.5;
    f.profiles.SEO.content = 5.5;
    expect(validateConfig(f).ok).toBe(false);
  });
});

describe('getActiveConfig', () => {
  it('falls back to the defaults when no row exists, and caches', async () => {
    const a = await getActiveConfig();
    expect(a.version).toBe(1);
    expect(a.profiles.LOCAL.reputation).toBe(25);
    await getActiveConfig();
    expect(db.findFirst).toBe(1);
  });
  it('uses the active row (version from the row), re-read after invalidate or TTL', async () => {
    db.rows = [{ version: 4, config: { ...clone(DEFAULT_CONFIG_V1), minCoverage: 50 } }];
    const a = await getActiveConfig({ now: 1000 });
    expect(a.version).toBe(4);
    expect(a.minCoverage).toBe(50);
    await getActiveConfig({ now: 1000 + 6 * 60 * 1000 });
    expect(db.findFirst).toBe(2);
    invalidateConfigCache();
    await getActiveConfig({ now: 1000 + 6 * 60 * 1000 });
    expect(db.findFirst).toBe(3);
  });
});
