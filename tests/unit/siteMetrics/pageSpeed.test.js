/**
 * Site metrics, page speed: PSI parser, CWV / lab status rule, URL guard, fetch error mapping, job cap and stop-on-429.
 * Prisma is stubbed; no network.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

import { takeShapeViolations } from '../../helpers/prismaShape.js';
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
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'deleteMany') return { count: 0 };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import {
  parsePsiResponse,
  pageSpeedStatus,
  worstPageSpeedStatus,
  pageSpeedTargetUrl,
  fetchPageSpeed,
  runPageSpeedJob,
  isPageSpeedEnabled,
  pageSpeedMaxPerRun,
  utcDay,
  staffPageSpeedView,
  clientPageSpeedView,
} from '../../../src/lib/pageSpeed.js';

const PSI = JSON.parse(readFileSync(new URL('../../fixtures/site-metrics/psi-mobile.json', import.meta.url), 'utf8'));
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('parsePsiResponse', () => {
  it('reads lab metrics and page-level field data (CLS percentile / 100)', () => {
    const r = parsePsiResponse(PSI);
    expect(r).toEqual({
      ok: true,
      data: {
        performanceScore: 72, lcpMs: 3457, cls: 0.0812, tbtMs: 310, fcpMs: 1500, speedIndexMs: 4020,
        fieldLcpP75: 2300, fieldInpP75: 180, fieldClsP75: 0.05, fieldCategory: 'FAST',
      },
    });
  });

  it('falls back to origin field data, then to none', () => {
    const origin = parsePsiResponse({ ...PSI, loadingExperience: { id: 'x' } });
    expect(origin.data).toMatchObject({ fieldLcpP75: 3100, fieldInpP75: null, fieldClsP75: null, fieldCategory: 'AVERAGE' });
    const none = parsePsiResponse({ lighthouseResult: PSI.lighthouseResult });
    expect(none.data).toMatchObject({ fieldLcpP75: null, fieldCategory: null });
  });

  it('runtime errors and missing score are errors', () => {
    expect(parsePsiResponse({ lighthouseResult: { runtimeError: { code: 'NO_FCP' } } })).toEqual({ ok: false, errorCode: 'NO_FCP' });
    expect(parsePsiResponse({ lighthouseResult: { categories: {} } }).ok).toBe(false);
    expect(parsePsiResponse({}).ok).toBe(false);
  });
});

describe('pageSpeedStatus', () => {
  it('field data wins with Google CWV thresholds', () => {
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 20, fieldLcpP75: 2500, fieldInpP75: 200, fieldClsP75: 0.1 })).toEqual({ status: 'good', source: 'field' });
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 99, fieldLcpP75: 2600 })).toEqual({ status: 'needs_improvement', source: 'field' });
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 99, fieldLcpP75: 1000, fieldInpP75: 501 })).toEqual({ status: 'poor', source: 'field' });
    expect(pageSpeedStatus({ status: 'ok', fieldClsP75: 0.26 }).status).toBe('poor');
  });

  it('lab score otherwise: ≥90 good, 50–89 needs improvement, <50 poor', () => {
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 90 })).toEqual({ status: 'good', source: 'lab' });
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 89 }).status).toBe('needs_improvement');
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 50 }).status).toBe('needs_improvement');
    expect(pageSpeedStatus({ status: 'ok', performanceScore: 49 }).status).toBe('poor');
  });

  it('error rows / no data are unknown; worst of several', () => {
    expect(pageSpeedStatus({ status: 'error', performanceScore: 99 }).status).toBe('unknown');
    expect(pageSpeedStatus(null).status).toBe('unknown');
    expect(worstPageSpeedStatus([{ status: 'ok', performanceScore: 95 }, { status: 'ok', performanceScore: 60 }])).toBe('needs_improvement');
    expect(worstPageSpeedStatus([])).toBe('unknown');
  });
});

describe('pageSpeedTargetUrl (SSRF / URL guard)', () => {
  it('home URL of a public https site', async () => {
    expect(await pageSpeedTargetUrl({ wpUrl: 'https://Example.com/blog/' }, { lookup: publicLookup })).toEqual({ ok: true, url: 'https://example.com/' });
  });

  it('refuses http, missing, private hosts and IP literals, even in development', async () => {
    const prev = { NODE_ENV: process.env.NODE_ENV, X: process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV };
    process.env.NODE_ENV = 'development';
    process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = 'true';
    try {
      expect(await pageSpeedTargetUrl({ wpUrl: null })).toEqual({ ok: false, reason: 'NO_URL' });
      expect((await pageSpeedTargetUrl({ wpUrl: 'http://example.com' }, { lookup: publicLookup })).reason).toBe('NOT_HTTPS');
      expect((await pageSpeedTargetUrl({ wpUrl: 'https://localhost' }, { lookup: publicLookup })).ok).toBe(false);
      expect((await pageSpeedTargetUrl({ wpUrl: 'https://10.0.0.5' }, { lookup: async (h) => [{ address: h, family: 4 }] })).ok).toBe(false);
      expect((await pageSpeedTargetUrl({ wpUrl: 'https://intranet.example' }, { lookup: async () => [{ address: '192.168.1.4', family: 4 }] })).ok).toBe(false);
    } finally {
      process.env.NODE_ENV = prev.NODE_ENV;
      if (prev.X === undefined) delete process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV;
      else process.env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV = prev.X;
    }
  });
});

describe('fetchPageSpeed', () => {
  it('sends strategy + key, maps 429 / quota 403 / Lighthouse errors / timeouts', async () => {
    let seen;
    const ok = await fetchPageSpeed('https://example.com/', 'desktop', {
      env: { PAGESPEED_API_KEY: 'k123' },
      fetchImpl: async (u) => ((seen = u), jsonRes(200, PSI)),
    });
    expect(ok.ok).toBe(true);
    expect(seen).toContain('strategy=desktop');
    expect(seen).toContain('key=k123');
    expect(seen).toContain('category=performance');

    expect(await fetchPageSpeed('https://e.com/', 'mobile', { env: {}, fetchImpl: async () => jsonRes(429, {}) })).toEqual({ ok: false, errorCode: 'RATE_LIMITED', rateLimited: true });
    const quota = await fetchPageSpeed('https://e.com/', 'mobile', { env: {}, fetchImpl: async () => jsonRes(403, { error: { status: 'RESOURCE_EXHAUSTED' } }) });
    expect(quota.rateLimited).toBe(true);
    const failed = await fetchPageSpeed('https://e.com/', 'mobile', { env: {}, fetchImpl: async () => jsonRes(500, { error: { message: 'Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable…' } }) });
    expect(failed).toEqual({ ok: false, errorCode: 'FAILED_DOCUMENT_REQUEST' });
    const timeout = await fetchPageSpeed('https://e.com/', 'mobile', { env: {}, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
    expect(timeout.errorCode).toBe('TIMEOUT');
  });
});

describe('runPageSpeedJob', () => {
  const projects = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, wpUrl: `https://site${i}.example.com` }));

  it('flag off → nothing; defaults', async () => {
    expect(await runPageSpeedJob({ env: { PAGESPEED_ENABLED: 'false' } })).toEqual({ skipped: 'disabled' });
    expect(isPageSpeedEnabled({})).toBe(true);
    expect(pageSpeedMaxPerRun({})).toBe(100);
    expect(pageSpeedMaxPerRun({ PAGESPEED_MAX_PER_RUN: '3' })).toBe(3);
  });

  it('caps projects per run, mobile then desktop, skips projects done today, oldest first', async () => {
    db.overrides['project.findMany'] = async (a) => {
      expect(a.where.status).toEqual({ in: ['ACTIVE', 'SETUP'] });
      return projects;
    };
    db.overrides['pageSpeedDaily.groupBy'] = async (a) =>
      a._count ? [{ projectId: 'p0', _count: { _all: 2 } }] : [{ projectId: 'p1', _max: { fetchedAt: new Date('2026-10-01') } }];
    const urls = [];
    const out = await runPageSpeedJob({
      env: { PAGESPEED_MAX_PER_RUN: '2' },
      lookup: publicLookup,
      fetchImpl: async (u) => (urls.push(u), jsonRes(200, PSI)),
    });
    expect(out).toMatchObject({ eligible: 5, alreadyDone: 1, attempted: 2, ok: 4, stopped: null });
    // p2 / p3 were never fetched (0) so they come before p1
    expect(urls.map((u) => new URL(u).searchParams.get('url'))).toEqual([
      'https://site2.example.com/', 'https://site2.example.com/', 'https://site3.example.com/', 'https://site3.example.com/',
    ]);
    expect(urls.map((u) => new URL(u).searchParams.get('strategy'))).toEqual(['mobile', 'desktop', 'mobile', 'desktop']);
    expect(db.calls.filter((c) => c.key === 'pageSpeedDaily.upsert')).toHaveLength(4);
    expect(db.calls.some((c) => c.key === 'pageSpeedDaily.deleteMany')).toBe(true);
  });

  it('stops the whole run on the first 429, no retry; the 429 is kept as a RATE_LIMITED error row (O-R3-6)', async () => {
    db.overrides['project.findMany'] = async () => projects;
    let n = 0;
    const out = await runPageSpeedJob({
      env: {},
      lookup: publicLookup,
      fetchImpl: async () => (++n === 2 ? jsonRes(429, {}) : jsonRes(200, PSI)),
    });
    expect(n).toBe(2);
    expect(out).toMatchObject({ attempted: 1, ok: 1, stopped: 'RATE_LIMITED' });
    const upserts = db.calls.filter((c) => c.key === 'pageSpeedDaily.upsert');
    expect(upserts).toHaveLength(2);
    expect(upserts[1].args.create).toMatchObject({ strategy: 'desktop', status: 'error', errorCode: 'RATE_LIMITED' });
  });

  it('staff view flags the quota (with or without an API key); the client view never sees it (O-R3-6)', async () => {
    const at = new Date('2026-10-22T02:30:00Z');
    db.overrides['pageSpeedDaily.findMany'] = async (a) =>
      a.where.status === 'ok' ? [] : [{ date: at, strategy: 'mobile', url: 'https://e.com/', status: 'error', errorCode: 'RATE_LIMITED', fetchedAt: at }];
    const p = { id: 'p1', wpUrl: 'https://e.com' };
    const v = await staffPageSpeedView(p, { now: at, env: {} });
    expect(v.quota).toEqual({ reached: true, at, keyConfigured: false });
    expect((await staffPageSpeedView(p, { now: at, env: { PAGESPEED_API_KEY: 'k' } })).quota.keyConfigured).toBe(true);
    expect(await clientPageSpeedView(p, { now: at })).toEqual({ available: false });
  });

  it('an error never overwrites an ok row of the same day', async () => {
    db.overrides['project.findMany'] = async () => [projects[0]];
    db.overrides['pageSpeedDaily.findUnique'] = async () => ({ status: 'ok' });
    await runPageSpeedJob({ env: {}, lookup: publicLookup, fetchImpl: async () => jsonRes(500, { error: { message: 'x' } }) });
    expect(db.calls.filter((c) => c.key === 'pageSpeedDaily.upsert')).toHaveLength(0);
  });

  it('utcDay is UTC midnight', () => {
    expect(utcDay(new Date('2026-10-22T23:59:00-05:00')).toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });
});

// Every Prisma call made by the code under test must match the real schema (tests/helpers/prismaShape.js).
afterEach(() => expect(takeShapeViolations()).toEqual([]));
