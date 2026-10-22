import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {} }));

import { clientHealthView, staffHealthView, siteWords, bandInfo } from '../../../src/lib/health/healthViews.js';
import { computeProjectHealth } from '../../../src/lib/health/healthScoreService.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures/bundle-harbor-dental.json'), 'utf8'));
const CFG = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));
const NOW = Date.parse('2026-10-22T07:00:00Z');
const rowFor = (mut) => {
  const b = JSON.parse(JSON.stringify(FIXTURE));
  if (mut) mut(b);
  return { ...computeProjectHealth(b.project, '2026-10-22', { bundle: b, config: CFG, now: NOW, base28: 61 }), computedAt: new Date(NOW) };
};

const CLIENT_KEYS = ['available', 'score', 'band', 'label', 'coverage', 'trend28', 'arrow', 'computedAt', 'pillars', 'improving', 'attention', 'history'].sort();

describe('clientHealthView (allow-list)', () => {
  const row = rowFor((b) => { b.security.failChecks = [{ checkId: 'tls.cert_valid', severity: 'critical' }]; });
  const view = clientHealthView({ ...row, pillars: row.pillars, history: [{ date: '2026-10-21', score: 64, extra: 'x' }] }, CFG);

  it('has exactly the documented keys', () => {
    expect(Object.keys(view).sort()).toEqual(CLIENT_KEYS);
    expect(view).toMatchObject({ score: row.score, band: 'healthy', label: 'On track', coverage: 90, trend28: row.score - 61, arrow: 'flat' });
  });

  it('never carries factors, raw values, weights, profile, config, security numbers or check ids', () => {
    const body = JSON.stringify(view);
    expect(body).not.toMatch(/"(factors|healthFactors|raw|parts|weight|profile|configVersion|reason|checkId|securityScore|projectId)"/);
    expect(body).not.toMatch(/tls\.cert_valid/);
    const site = view.pillars.find((p) => p.key === 'site');
    expect(site).toEqual({ key: 'site', label: 'Website & security', state: 'fail', backups: 'ok' });
    expect(view.history).toEqual([{ date: '2026-10-21', score: 64 }]);
  });

  it('plain pillar names and per-pillar coverage', () => {
    expect(view.pillars.map((p) => p.label)).toEqual(['Search visibility', 'Website engagement', 'Enquiries', 'Reviews', 'AI answers', 'Website & security', 'Content']);
    expect(view.pillars.find((p) => p.key === 'aiVisibility').score).toBeNull();
  });

  it('null score → no band/label (UI says "Not enough data yet")', () => {
    const v = clientHealthView({ score: null, coverage: 20, pillars: {}, factors: [], history: [] }, CFG);
    expect(v).toMatchObject({ available: true, score: null, band: null, label: null, coverage: 20 });
  });
});

describe('siteWords', () => {
  it('worst state across projects; unknown when no security; backups missed wins', () => {
    expect(siteWords([])).toEqual({ state: 'unknown', backups: 'unknown' });
    expect(siteWords([{ key: 'S1', reason: 'ok', score: 100, raw: { cur: 'ok' } }, { key: 'S1', reason: 'ok', score: 60, raw: { cur: 'warn' } }]).state).toBe('warn');
    expect(siteWords([{ key: 'S2', score: 85, raw: { cur: 0 } }, { key: 'S2', score: 50, raw: { cur: 1 } }]).backups).toBe('missed');
  });
});

describe('staffHealthView', () => {
  it('exposes factors as healthFactors with labels and contributions', () => {
    const v = staffHealthView(rowFor(), { cfg: CFG, compare: 7 });
    expect(v.row.healthFactors).toHaveLength(17);
    expect(v.row.healthFactors[0]).toMatchObject({ key: 'V1', label: 'Google clicks' });
    expect(v.row.healthFactors[0].contribution).toBeGreaterThan(0);
    expect(v.row).not.toHaveProperty('factors');
    expect(v).toMatchObject({ profile: 'LOCAL', config: { version: 1 }, compare: 7 });
  });
  it('band labels', () => {
    expect(bandInfo(85, CFG)).toEqual({ band: 'excellent', label: 'Excellent', clientLabel: 'Thriving' });
    expect(bandInfo(10, CFG).clientLabel).toBe('Needs urgent attention');
  });
});
