/**
 * Site metrics, uptime: probe classification (timeout, TLS, 5xx, redirect to a private IP, ok), retries, DOWN after 2
 * failures / RECOVERED after 1 success, one alert per incident, TLS alert once a day, rollup math, retention batches,
 * overlap guard. Prisma (a small in-memory store) and notify are stubbed; no network.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { takeShapeViolations } from '../../helpers/prismaShape.js';
const db = vi.hoisted(() => ({ calls: [], overrides: {}, checks: [], incidents: [], alertLog: new Map() }));
const sent = vi.hoisted(() => ({ notify: [] }));

vi.mock('../../../src/lib/notificationService.js', () => ({ notify: async (n) => sent.notify.push(n) }));
vi.mock('../../../src/lib/prisma.js', async () => {
  const { assertPrismaArgs } = await import('../../helpers/prismaShape.js');
  const defaults = {
    'uptimeCheck.create': async ({ data }) => (db.checks.push({ ...data }), data),
    'uptimeCheck.findMany': async (a) =>
      db.checks.filter((c) => c.projectId === a.where.projectId && c.target === 'home').sort((x, y) => y.at - x.at).slice(0, a.take),
    'uptimeIncident.findUnique': async (a) => db.incidents.find((i) => i.openProjectId === a.where.openProjectId) || null,
    'uptimeIncident.create': async ({ data }) => {
      if (db.incidents.some((i) => i.openProjectId === data.openProjectId)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
      const row = { id: `inc${db.incidents.length + 1}`, closedAt: null, notifiedDownAt: null, notifiedUpAt: null, ...data };
      db.incidents.push(row);
      return row;
    },
    'uptimeIncident.update': async ({ where, data }) => Object.assign(db.incidents.find((i) => i.id === where.id), data),
    'uptimeIncident.updateMany': async ({ where, data }) => {
      const rows = db.incidents.filter((i) => i.id === where.id && Object.entries(where).every(([k, v]) => k === 'id' || i[k] === v));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    'user.findMany': async () => [{ id: 'owner1' }],
    'securityAlertLog.updateMany': async ({ where, data }) => {
      const k = `${where.projectId}|${where.alertKey}`;
      const at = db.alertLog.get(k);
      if (at && at < where.sentAt.lt) {
        db.alertLog.set(k, data.sentAt);
        return { count: 1 };
      }
      return { count: 0 };
    },
    'securityAlertLog.findUnique': async ({ where }) => (db.alertLog.has(`${where.projectId_alertKey.projectId}|${where.projectId_alertKey.alertKey}`) ? {} : null),
    'securityAlertLog.create': async ({ data }) => db.alertLog.set(`${data.projectId}|${data.alertKey}`, data.sentAt),
  };
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          assertPrismaArgs(name, method, args);
          if (db.overrides[key]) return db.overrides[key](args);
          if (defaults[key]) return defaults[key](args);
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'deleteMany') return { count: 0 };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import {
  probeOnce,
  probeWithRetry,
  classifyError,
  siteHomeUrl,
  probeStatusEndpoint,
  probeProject,
  computeDailyRollup,
  percentile,
  purgeUptime,
  uptimeAvailability,
  uptimeStatus,
  durationText,
  maybeAlertTls,
  runUptimeProbes,
  mapPool,
  uptimeCron,
  _resetUptimeState,
  USER_AGENT,
  SCHEDULER_STALE,
  staffUptimeView,
} from '../../../src/lib/uptime.js';

const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const resp = (status, extra = {}) => ({ status, location: null, cert: null, body: Buffer.from(''), ...extra });
const noSleep = async () => {};
const PROJECT = { id: 'p1', name: 'Acme', wpUrl: 'https://acme.example.com', cmsType: 'WORDPRESS' };

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  db.checks = [];
  db.incidents = [];
  db.alertLog = new Map();
  sent.notify = [];
  _resetUptimeState();
});

describe('probe classification', () => {
  it('ok (2xx / 206 / 416), 5xx, 4xx', async () => {
    expect(await probeOnce('https://a.com/', { request: async () => resp(206) })).toMatchObject({ ok: true, httpStatus: 206, errorClass: null });
    expect((await probeOnce('https://a.com/', { request: async () => resp(416) })).ok).toBe(true);
    expect(await probeOnce('https://a.com/', { request: async () => resp(503) })).toMatchObject({ ok: false, httpStatus: 503, errorClass: 'http_5xx' });
    expect((await probeOnce('https://a.com/', { request: async () => resp(404) })).errorClass).toBe('http_4xx');
  });

  it('timeouts, DNS, TLS and connection errors', async () => {
    for (const [e, cls] of [
      [err('LW_TIMEOUT'), 'timeout'],
      [err('ETIMEDOUT'), 'timeout'],
      [err('ENOTFOUND'), 'dns'],
      [err('CERT_HAS_EXPIRED'), 'tls'],
      [err('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls'],
      [err('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls'],
      [err('ECONNREFUSED'), 'connect'],
      [err('ECONNRESET'), 'connect'],
    ]) {
      expect((await probeOnce('https://a.com/', { request: async () => { throw e; } })).errorClass).toBe(cls);
    }
    expect(classifyError(err('EAI_BLOCKED'))).toBe('blocked');
  });

  it('sends the fixed User-Agent and a ranged GET', async () => {
    let opts;
    await probeOnce('https://a.com/', { request: async (_u, o) => ((opts = o), resp(200)) });
    expect(opts.headers.range).toBe('bytes=0-4095');
    expect(USER_AGENT).toBe('LocalWavesUptime/1.0 (+agency-os)');
  });

  it('follows ≤ 3 redirects; a redirect to a private IP / http / localhost is blocked before any request', async () => {
    const urls = [];
    const chain = { 'https://a.com/': 'https://www.a.com/', 'https://www.a.com/': '/home' };
    const ok = await probeOnce('https://a.com/', {
      request: async (u) => (urls.push(u), chain[u] ? resp(301, { location: chain[u] }) : resp(200)),
    });
    expect(ok).toMatchObject({ ok: true, hops: ['https://www.a.com/', 'https://www.a.com/home'] });

    for (const loc of ['https://10.0.0.1/', 'https://127.0.0.1/admin', 'http://a.com/', 'https://localhost/', 'https://[::1]/']) {
      const seen = [];
      const r = await probeOnce('https://a.com/', { request: async (u) => (seen.push(u), resp(302, { location: loc })) });
      expect(r).toMatchObject({ ok: false, errorClass: 'redirect' });
      expect(seen).toEqual(['https://a.com/']);
    }
    // the connect-time guard (EAI_BLOCKED) on a later hop is a redirect failure too
    let n = 0;
    const blocked = await probeOnce('https://a.com/', { request: async () => (n++ ? Promise.reject(err('EAI_BLOCKED')) : resp(302, { location: 'https://evil.example/' })) });
    expect(blocked.errorClass).toBe('redirect');

    const loop = await probeOnce('https://a.com/', { request: async (u) => resp(302, { location: `${u}x` }) });
    expect(loop).toMatchObject({ ok: false, errorClass: 'redirect' });
  });

  it('retries twice with backoff, reports the last attempt', async () => {
    let n = 0;
    const sleeps = [];
    const r = await probeWithRetry('https://a.com/', { request: async () => (++n < 3 ? Promise.reject(err('ECONNRESET')) : resp(200)), sleep: async (ms) => sleeps.push(ms) });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([1000, 3000]);
    n = 0;
    const f = await probeWithRetry('https://a.com/', { request: async () => (n++, resp(500)), sleep: noSleep });
    expect(f).toMatchObject({ ok: false, attempts: 3, errorClass: 'http_5xx' });
    expect(n).toBe(3);
  });

  it('site URL guard: https only, no localhost / private literal', () => {
    expect(siteHomeUrl({ wpUrl: 'https://Acme.com/blog' })).toBe('https://acme.com/');
    for (const bad of [null, 'http://acme.com', 'https://localhost', 'https://192.168.1.2', 'https://u:p@acme.com', 'nonsense']) {
      expect(siteHomeUrl({ wpUrl: bad })).toBeNull();
    }
  });

  it('EmDash status endpoint: 404 / non-JSON tolerated, bad state is a marker failure', async () => {
    expect(await probeStatusEndpoint('https://a.com/', { request: async () => resp(404) })).toBeNull();
    expect(await probeStatusEndpoint('https://a.com/', { request: async () => resp(200, { body: Buffer.from('<html>') }) })).toBeNull();
    const ok = await probeStatusEndpoint('https://a.com/', { request: async (u) => (expect(u).toBe('https://a.com/_agency/status'), resp(200, { body: Buffer.from('{"state":"ok","uptime":{"db":"ok","scheduler":"ok"}}') })) });
    expect(ok).toMatchObject({ ok: true, errorClass: null });
    const bad = await probeStatusEndpoint('https://a.com/', { request: async () => resp(200, { body: Buffer.from('{"state":"ok","uptime":{"db":"down"}}') }) });
    expect(bad).toMatchObject({ ok: false, errorClass: 'marker' });
  });

  it('O-R3-3: state is the security roll-up, never an uptime signal; reachable = 200 + db ok; stale scheduler = warning', async () => {
    const body = (o) => async () => resp(200, { body: Buffer.from(JSON.stringify(o)) });
    // A healthy, reachable site whose security roll-up is failing (e.g. a stale backup check) is ok.
    expect(await probeStatusEndpoint('https://a.com/', { request: body({ state: 'fail', uptime: { db: 'ok', scheduler: 'ok' } }) })).toMatchObject({ ok: true, errorClass: null });
    expect(await probeStatusEndpoint('https://a.com/', { request: body({ state: 'critical', uptime: { db: 'ok' } }) })).toMatchObject({ ok: true });
    // db must say ok
    expect(await probeStatusEndpoint('https://a.com/', { request: body({ state: 'ok', uptime: {} }) })).toMatchObject({ ok: false, errorClass: 'marker' });
    expect(await probeStatusEndpoint('https://a.com/', { request: body({ state: 'ok', uptime: { db: 'error', scheduler: 'ok' } }) })).toMatchObject({ ok: false, errorClass: 'marker' });
    // a down scheduler is a marker; a stale one is ok with the warning class
    expect(await probeStatusEndpoint('https://a.com/', { request: body({ uptime: { db: 'ok', scheduler: 'down' } }) })).toMatchObject({ ok: false, errorClass: 'marker' });
    expect(await probeStatusEndpoint('https://a.com/', { request: body({ state: 'fail', uptime: { db: 'ok', scheduler: 'stale' } }) })).toMatchObject({ ok: true, errorClass: SCHEDULER_STALE });
    // not HTTP 200 → not reachable in the status sense
    expect(await probeStatusEndpoint('https://a.com/', { request: async () => resp(203, { body: Buffer.from('{"uptime":{"db":"ok"}}') }) })).toMatchObject({ ok: false, errorClass: 'marker' });
  });

  it('O-R3-3: a stale scheduler is stored as an ok status row, opens no incident and shows as a staff warning', async () => {
    const project = { id: 'p9', name: 'Site', wpUrl: 'https://site.example', cmsType: 'EMDASH' };
    const request = async (u) =>
      u.endsWith('/_agency/status') ? resp(200, { body: Buffer.from('{"state":"fail","uptime":{"db":"ok","scheduler":"stale"}}') }) : resp(200);
    const out = await probeProject(project, { now: new Date('2026-10-22T08:00:00Z'), request, sleep: async () => {} });
    expect(out).toMatchObject({ ok: true });
    const status = db.checks.find((c) => c.projectId === 'p9' && c.target === 'status');
    expect(status).toMatchObject({ ok: true, errorClass: SCHEDULER_STALE });
    expect(db.incidents.filter((i) => i.projectId === 'p9')).toHaveLength(0);
    db.overrides['uptimeCheck.findFirst'] = async (a) => (a.where.target === 'status' ? { ok: true, at: new Date('2026-10-22T08:00:00Z'), errorClass: SCHEDULER_STALE, httpStatus: 200 } : null);
    const v = await staffUptimeView(project, { now: new Date('2026-10-22T08:01:00Z') });
    expect(v.statusEndpoint).toMatchObject({ ok: true, warning: 'scheduler_stale' });
  });
});

describe('incidents and alerts', () => {
  const at = (min) => new Date(Date.UTC(2026, 9, 22, 10, min));
  const probe = (ok, min) => probeProject(PROJECT, { now: at(min), request: async () => (ok ? resp(200) : resp(503)), sleep: noSleep });

  it('DOWN only after 2 failed probes; RECOVERED after 1 ok; one alert each', async () => {
    expect((await probe(false, 0)).incident).toBe('failing');
    expect(db.incidents).toHaveLength(0);
    expect((await probe(false, 2)).incident).toBe('down');
    expect(db.incidents).toHaveLength(1);
    expect(db.incidents[0]).toMatchObject({ openedAt: at(0), cause: 'http_5xx', openProjectId: 'p1' });
    expect((await probe(false, 4)).incident).toBe('still_down');
    expect(db.incidents).toHaveLength(1);
    expect(sent.notify.map((n) => n.slug)).toEqual(['site_down']);
    expect(sent.notify[0].recipientIds).toEqual(['owner1']);

    expect((await probe(true, 6)).incident).toBe('recovered');
    expect(db.incidents[0]).toMatchObject({ closedAt: at(6), durationSec: 360, openProjectId: null });
    expect((await probe(true, 8)).incident).toBe('up');
    expect(sent.notify.map((n) => n.slug)).toEqual(['site_down', 'site_recovered']);
    expect(sent.notify[1].variables.duration).toBe('about 6 minutes');
  });

  it('a fail, ok, fail sequence never opens an incident', async () => {
    await probe(false, 0);
    await probe(true, 2);
    await probe(false, 4);
    expect(db.incidents).toHaveLength(0);
    expect(sent.notify).toEqual([]);
  });

  it('dedupe: a second DOWN claim on the same incident sends nothing; the unique open slot refuses a duplicate', async () => {
    await probe(false, 0);
    await probe(false, 2);
    const { sendDownAlert } = await import('../../../src/lib/uptime.js');
    expect(await sendDownAlert(PROJECT, db.incidents[0], { now: at(3) })).toBe(false);
    expect(sent.notify).toHaveLength(1);
  });

  it('TLS expiring < 14 days alerts at most once a day', async () => {
    const now = new Date('2026-10-22T10:00:00Z');
    expect(await maybeAlertTls(PROJECT, new Date('2026-12-01T00:00:00Z'), { now })).toBe(false);
    expect(await maybeAlertTls(PROJECT, new Date('2026-10-30T00:00:00Z'), { now })).toBe(true);
    expect(await maybeAlertTls(PROJECT, new Date('2026-10-30T00:00:00Z'), { now: new Date('2026-10-22T18:00:00Z') })).toBe(false);
    expect(await maybeAlertTls(PROJECT, new Date('2026-10-30T00:00:00Z'), { now: new Date('2026-10-23T11:00:00Z') })).toBe(true);
    expect(sent.notify.map((n) => [n.slug, n.variables.daysLeft])).toEqual([['tls_expiring', '7'], ['tls_expiring', '6']]);
  });

  it('reads the certificate at most once an hour per site', async () => {
    const wants = [];
    const req = async (_u, o) => (wants.push(o.wantCert), resp(200, { cert: o.wantCert ? { validTo: new Date('2027-01-01') } : null }));
    await probeProject(PROJECT, { now: at(0), request: req, sleep: noSleep });
    await probeProject(PROJECT, { now: at(2), request: req, sleep: noSleep });
    await probeProject(PROJECT, { now: new Date(at(0).getTime() + 61 * 60_000), request: req, sleep: noSleep });
    expect(wants).toEqual([true, false, true]);
    expect(db.checks[0].tlsExpiresAt).toEqual(new Date('2027-01-01'));
    expect(db.checks[1].tlsExpiresAt).toBeNull();
  });
});

describe('rollup, retention, helpers', () => {
  it('daily rollup math', () => {
    const day = new Date('2026-10-21T00:00:00Z');
    const checks = [
      ...Array.from({ length: 18 }, (_, i) => ({ ok: true, ms: (i + 1) * 100 })),
      { ok: false, ms: 10000 },
      { ok: false, ms: null },
    ];
    const incidents = [
      { openedAt: new Date('2026-10-20T23:50:00Z'), closedAt: new Date('2026-10-21T00:10:00Z') }, // 10 min inside
      { openedAt: new Date('2026-10-21T12:00:00Z'), closedAt: new Date('2026-10-21T12:30:00Z') }, // 30 min
      { openedAt: new Date('2026-10-21T23:30:00Z'), closedAt: null }, // open: until end of day = 30 min
    ];
    const r = computeDailyRollup(checks, incidents, day, new Date('2026-10-22T05:00:00Z'));
    expect(r).toEqual({ checks: 20, okChecks: 18, availabilityPct: 90, avgMs: 950, p95Ms: 1800, incidents: 2, downtimeSec: 70 * 60 });
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 95)).toBeNull();
    expect(computeDailyRollup([], [], day).availabilityPct).toBeNull();
  });

  it('retention deletes raw checks in batches of ≤ 5000 and old daily rows', async () => {
    let remaining = 12000;
    db.overrides['uptimeCheck.findMany'] = async (a) => {
      expect(a.take).toBeLessThanOrEqual(5000);
      const n = Math.min(a.take, remaining);
      return Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
    };
    const sizes = [];
    db.overrides['uptimeCheck.deleteMany'] = async (a) => {
      sizes.push(a.where.id.in.length);
      remaining -= a.where.id.in.length;
      return { count: a.where.id.in.length };
    };
    const out = await purgeUptime({ now: new Date('2026-10-22T00:20:00Z') });
    expect(sizes).toEqual([5000, 5000, 2000]);
    expect(out.checks).toBe(12000);
    const daily = db.calls.find((c) => c.key === 'uptimeDaily.deleteMany');
    expect(daily.args.where.date.lt.toISOString().slice(0, 10)).toBe('2025-09-17');
  });

  it('availability + status helpers (Health v2 S6)', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const rows = [
      { date: new Date('2026-10-22'), checks: 360, okChecks: 360 },
      { date: new Date('2026-10-21'), checks: 720, okChecks: 712 },
      { date: new Date('2026-08-01'), checks: 720, okChecks: 0 },
    ];
    expect(uptimeAvailability(rows, 7, now)).toBe(99.259);
    expect(uptimeAvailability(rows, 1, now)).toBe(100);
    expect(uptimeAvailability([], 30, now)).toBeNull();
    expect(uptimeStatus({ openIncident: { id: 'i' }, lastCheckAt: now, availability30: 99.95, now })).toEqual({ state: 'down', rating: 'good' });
    expect(uptimeStatus({ lastCheckAt: new Date(now.getTime() - 60_000), availability30: 99.5, now })).toEqual({ state: 'up', rating: 'needs_improvement' });
    expect(uptimeStatus({ lastCheckAt: new Date(now.getTime() - 3600_000), availability30: 98, now })).toEqual({ state: 'unknown', rating: 'poor' });
    expect(durationText(30)).toBe('less than a minute');
    expect(durationText(4800)).toBe('1 hour 20 minutes');
    expect(durationText(2 * 86400 + 3 * 3600)).toBe('2 days 3 hours');
  });

  it('prober: disabled flag, cron interval, concurrency cap and the overlap guard', async () => {
    expect(await runUptimeProbes({ env: { UPTIME_ENABLED: 'false' } })).toEqual({ skipped: 'disabled' });
    expect(uptimeCron({})).toBe('*/2 * * * *');
    expect(uptimeCron({ UPTIME_INTERVAL_MIN: '5' })).toBe('*/5 * * * *');

    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }), 5, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    });
    expect(peak).toBe(5);

    let release;
    const gate = new Promise((r) => (release = r));
    db.overrides['project.findMany'] = async (a) => {
      expect(a.take).toBe(200);
      await gate;
      return [];
    };
    const first = runUptimeProbes({ env: {} });
    expect(await runUptimeProbes({ env: {} })).toEqual({ skipped: 'overlap' });
    release();
    expect(await first).toMatchObject({ sites: 0 });
  });
});

// Every Prisma call made by the code under test must match the real schema (tests/helpers/prismaShape.js).
afterEach(() => expect(takeShapeViolations()).toEqual([]));
