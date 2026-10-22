/**
 * Site metrics, backlinks: DataForSEO summary parser, new/lost delta, trend, job flag / cap / stop rules.
 * Prisma and the DataForSEO client are stubbed (no paid call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import {
  parseDfsSummary,
  fillNewLost,
  authorityTrend,
  backlinkTarget,
  normalizeDomain,
  runBacklinkSnapshotJob,
  fetchBacklinkSummary,
  isBacklinkSnapshotEnabled,
  backlinksMaxPerRun,
  DFS_SUMMARY_PATH,
} from '../../../src/lib/backlinkSnapshots.js';

const DFS = JSON.parse(readFileSync(new URL('../../fixtures/site-metrics/dfs-backlinks-summary.json', import.meta.url), 'utf8'));
const CREDS = { BACKLINKS_SNAPSHOT_ENABLED: 'true', DATAFORSEO_LOGIN: 'l', DATAFORSEO_PASSWORD: 'p' };
const NOW = new Date('2026-11-01T04:30:00Z');

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('parseDfsSummary', () => {
  it('reads the summary fields and the task cost', () => {
    expect(parseDfsSummary(DFS)).toEqual({
      ok: true,
      costUsd: 0.02003,
      data: {
        rank: 312, backlinks: 4821, referringDomains: 214, referringMainDomains: 198,
        newReferringDomains: null, lostReferringDomains: null, backlinksSpamScore: 7, brokenBacklinks: 33,
      },
    });
  });

  it('account-level vs per-target errors', () => {
    expect(parseDfsSummary({ status_code: 40100 })).toMatchObject({ ok: false, errorCode: 'DFS_40100', accountLevel: true });
    expect(parseDfsSummary({ status_code: 20000, tasks: [{ status_code: 40204, cost: 0 }] })).toMatchObject({ errorCode: 'DFS_40204', accountLevel: true, costUsd: 0 });
    expect(parseDfsSummary({ status_code: 20000, tasks: [{ status_code: 40501 }] })).toMatchObject({ errorCode: 'DFS_40501', accountLevel: false });
    expect(parseDfsSummary({ status_code: 20000, tasks: [{ status_code: 20000, result: [] }] }).errorCode).toBe('DFS_NO_RESULT');
  });

  it('HTTP failures from the shared client are account-level', async () => {
    const r = await fetchBacklinkSummary('example.com', { post: async () => { throw new Error('DataForSEO 401'); } });
    expect(r).toMatchObject({ ok: false, errorCode: 'HTTP_401', accountLevel: true });
  });
});

describe('new/lost + trend + target', () => {
  it('fills new/lost from the net delta only when the summary has none', () => {
    expect(fillNewLost({ referringDomains: 220, newReferringDomains: null, lostReferringDomains: null }, { referringDomains: 200 })).toMatchObject({ newReferringDomains: 20, lostReferringDomains: 0 });
    expect(fillNewLost({ referringDomains: 190, newReferringDomains: null, lostReferringDomains: null }, { referringDomains: 200 })).toMatchObject({ newReferringDomains: 0, lostReferringDomains: 10 });
    expect(fillNewLost({ referringDomains: 190, newReferringDomains: 5, lostReferringDomains: 3 }, { referringDomains: 200 })).toMatchObject({ newReferringDomains: 5, lostReferringDomains: 3 });
    expect(fillNewLost({ referringDomains: 190, newReferringDomains: null, lostReferringDomains: null }, null).newReferringDomains).toBeNull();
  });

  it('authorityTrend', () => {
    expect(authorityTrend([]).direction).toBe('unknown');
    expect(authorityTrend([{ month: '2026-10', referringDomains: 100, status: 'ok' }]).direction).toBe('new');
    expect(authorityTrend([{ month: '2026-11', referringDomains: 120, status: 'ok' }, { month: '2026-10', referringDomains: 100, status: 'ok' }])).toEqual({ direction: 'up', latest: 120, previous: 100, change: 20, changePct: 20 });
    expect(authorityTrend([{ month: '2026-10', referringDomains: 100 }, { month: '2026-11', referringDomains: 98 }]).direction).toBe('flat');
    expect(authorityTrend([{ month: '2026-10', referringDomains: 100 }, { month: '2026-11', referringDomains: 80 }]).direction).toBe('down');
    expect(authorityTrend([{ month: '2026-10', referringDomains: 100 }, { month: '2026-11', referringDomains: null, status: 'error' }]).direction).toBe('new');
  });

  it('target: dataforseoDomain, else the site host; never a bad host', () => {
    expect(backlinkTarget({ dataforseoDomain: 'https://www.Acme.com/x', wpUrl: 'https://other.com' })).toBe('acme.com');
    expect(backlinkTarget({ wpUrl: 'https://www.site.co.uk/' })).toBe('site.co.uk');
    expect(normalizeDomain('localhost')).toBe('');
    expect(normalizeDomain('10.0.0.1')).toBe('');
  });
});

describe('runBacklinkSnapshotJob', () => {
  const projects = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, wpUrl: `https://site${i}.com`, dataforseoDomain: null }));

  it('off by default (costs money); needs credentials', async () => {
    expect(isBacklinkSnapshotEnabled({})).toBe(false);
    expect(backlinksMaxPerRun({})).toBe(50);
    expect(await runBacklinkSnapshotJob({ env: {} })).toEqual({ skipped: 'disabled' });
    expect(await runBacklinkSnapshotJob({ env: { BACKLINKS_SNAPSHOT_ENABLED: 'true' } })).toEqual({ skipped: 'no_credentials' });
  });

  it('caps per run, skips projects with an ok snapshot this month, sums cost, stores delta new/lost', async () => {
    db.overrides['project.findMany'] = async () => projects;
    db.overrides['backlinkSnapshotMonthly.findMany'] = async (a) => {
      expect(a.where.month).toBe('2026-11');
      return [{ projectId: 'p0' }];
    };
    db.overrides['backlinkSnapshotMonthly.findFirst'] = async () => ({ referringDomains: 200 });
    const targets = [];
    const out = await runBacklinkSnapshotJob({
      env: { ...CREDS, BACKLINKS_MAX_PER_RUN: '2' },
      now: NOW,
      post: async (path, body) => {
        expect(path).toBe(DFS_SUMMARY_PATH);
        targets.push(body[0].target);
        return DFS;
      },
    });
    expect(targets).toEqual(['site1.com', 'site2.com']);
    expect(out).toMatchObject({ month: '2026-11', attempted: 2, ok: 2, errors: 0, stopped: null, costUsd: 0.04006 });
    const up = db.calls.find((c) => c.key === 'backlinkSnapshotMonthly.upsert');
    expect(up.args.create).toMatchObject({ projectId: 'p1', month: '2026-11', referringDomains: 214, newReferringDomains: 14, lostReferringDomains: 0, costUsd: 0.02003, status: 'ok' });
  });

  it('stops at the first account-level error (no retry, no further calls)', async () => {
    db.overrides['project.findMany'] = async () => projects;
    let n = 0;
    const out = await runBacklinkSnapshotJob({ env: CREDS, now: NOW, post: async () => (n++, { status_code: 40200 }) });
    expect(n).toBe(1);
    expect(out).toMatchObject({ attempted: 1, errors: 1, stopped: 'DFS_40200' });
  });

  it('stops after 3 per-target errors in a row', async () => {
    db.overrides['project.findMany'] = async () => projects;
    let n = 0;
    const out = await runBacklinkSnapshotJob({ env: CREDS, now: NOW, post: async () => (n++, { status_code: 20000, tasks: [{ status_code: 40501 }] }) });
    expect(n).toBe(3);
    expect(out.stopped).toBe('TOO_MANY_ERRORS');
  });
});
