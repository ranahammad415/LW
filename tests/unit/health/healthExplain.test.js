import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {} }));

import { contributions, explainChange, topMovers, clientSentences, SENTENCES } from '../../../src/lib/health/healthExplain.js';
import { computeProjectHealth } from '../../../src/lib/health/healthScoreService.js';
import { DEFAULT_CONFIG_V1 } from '../../../src/lib/health/defaultConfig.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixtures/bundle-harbor-dental.json'), 'utf8'));
const CFG = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1));
const NOW = Date.parse('2026-10-22T07:00:00Z');
const rowFor = (mut) => {
  const b = JSON.parse(JSON.stringify(FIXTURE));
  if (mut) mut(b);
  return computeProjectHealth(b.project, '2026-10-22', { bundle: b, config: CFG, now: NOW });
};

describe('contributions', () => {
  it('sum to the unrounded project score', () => {
    const row = rowFor();
    const total = Object.values(contributions(row)).reduce((t, v) => t + v, 0);
    expect(Math.abs(total - row.score)).toBeLessThan(1);
  });
});

describe('explainChange / topMovers', () => {
  it('orders by absolute contribution change and finds the factor that moved', () => {
    const base = rowFor();
    const today = rowFor((b) => { b.security.status.overallState = 'fail'; });
    const ex = explainChange(today, base);
    expect(ex[0].key).toBe('S1');
    expect(ex[0].delta).toBeLessThan(0);
    for (let i = 1; i < ex.length; i += 1) expect(Math.abs(ex[i - 1].delta)).toBeGreaterThanOrEqual(Math.abs(ex[i].delta));
    const m = topMovers(ex, 2);
    expect(m.down[0].key).toBe('S1');
    expect(m.up.every((x) => x.delta > 0)).toBe(true);
  });
});

describe('client sentences', () => {
  it('fixed templates from factor values', () => {
    const s = clientSentences(rowFor().factors, { limit: 10 });
    expect(s.improving).toContain('Google clicks are up 11% versus the previous 4 weeks');
    expect(s.attention).toContain('Enquiries (forms, calls and emails) are down 20% versus the previous 4 weeks');
    expect(clientSentences(rowFor().factors).improving.length).toBeLessThanOrEqual(3);
    expect(clientSentences(rowFor().factors).attention.length).toBeLessThanOrEqual(3);
  });
  it('security sentences contain no numbers and no check ids', () => {
    const row = rowFor((b) => {
      b.security.failChecks = [{ checkId: 'tls.cert_valid', severity: 'critical' }];
      b.security.runs.push({ destinationId: 'agency-db', result: 'missed', verified: false, at: '2026-10-21T23:00:00.000Z' });
    });
    const s = clientSentences(row.factors, { limit: 10 });
    expect(s.attention).toContain('Your website security needs attention');
    expect(s.attention).toContain('A scheduled backup was missed');
    for (const key of ['S1', 'S2', 'S3']) {
      const f = row.factors.find((x) => x.key === key);
      const text = SENTENCES[key]({ ...f, score: f.score ?? 20 })?.text || '';
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/tls|cert|agency-db/);
    }
  });
  it('unlinked factors produce no sentence', () => {
    expect(clientSentences([{ key: 'V1', reason: 'unlinked', score: null, raw: { cur: 10, prev: 1 } }])).toEqual({ improving: [], attention: [] });
  });
});
