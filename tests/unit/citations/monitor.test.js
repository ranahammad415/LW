/**
 * Citations monitor (paid, CITATIONS_MONITOR_ENABLED) and the staff / client routes: flag off = no query and no call,
 * per-run cap, account-level stop, one DFS call per project with its cost stored, results written back as the system
 * actor, page check (free, opt-in, SSRF-guarded fetch injected here), HUMAN_ONLY on every write route, Check-now
 * cooldown, client scoping and allow-list.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const outside = vi.hoisted(() => ({ upserts: [], pulls: 0 }));

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
          if (method === 'count') return 0;
          if (method === 'create') return { id: 'run-1', createdAt: new Date(), ...(args?.data || {}) };
          if (method === 'updateMany') return { count: 1 };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/citations/citations.js', async (orig) => ({
  ...(await orig()),
  upsertCitations: async (projectId, items, actor) => {
    outside.upserts.push({ projectId, items, actor });
    return { rev: 2, applied: items.map((i) => ({ id: i.id, created: false, fields: ['nap_status'] })), rejected: [], warnings: [] };
  },
  pullCitations: async () => {
    outside.pulls += 1;
    return { rev: 1, count: 0 };
  },
}));

import {
  runCitationsMonitorJob,
  checkProjectCitations,
  pickListing,
  hoursFromWorkTime,
  pageNapCheck,
  pageText,
  DFS_LISTINGS_SEARCH_PATH,
} from '../../../src/lib/citations/monitor.js';
import { pmSeoMonitoringRoutes } from '../../../src/routes/pm/seoMonitoring.js';
import { clientSeoMonitoringRoutes } from '../../../src/routes/client/seoMonitoring.js';

const PROJECT = {
  id: 'p1', name: 'Oasis', clientId: 'c1', leadPmId: 'pm1', wpUrl: 'https://oasispoolspas.com', gmbCid: '111', gmbLocationName: 'Oasis Pool and Spa',
  gmbPhone: '262-667-6421', gmbAddress: '1 Main St, Waukesha, WI 53186', gmbLat: 43.01, gmbLng: -88.23, cmsType: 'EMDASH', cmsCapabilities: { seoCitations: true },
  client: { websiteUrl: null },
};
const LISTING = {
  type: 'business_listing', title: 'Oasis Pool & Spa', phone: '+1 262-667-6421', cid: '111', domain: 'oasispoolspas.com', url: 'https://oasispoolspas.com/',
  address_info: { zip: '53186', city: 'Waukesha' },
  work_time: { work_hours: { timetable: { monday: [{ open: { hour: 8, minute: 0 }, close: { hour: 18, minute: 0 } }], sunday: null } } },
};
const dfs = (items, cost = 0.0109) => vi.fn(async () => ({ status_code: 20000, tasks: [{ id: 't', status_code: 20000, cost, result: [{ items }] }] }));
const now = new Date('2026-11-02T05:15:00Z');

beforeEach(() => {
  db.calls = [];
  db.overrides = { 'seoCitationState.findUnique': async () => ({ projectId: 'p1', rev: 1, canonicalNap: null }) };
  outside.upserts = [];
  outside.pulls = 0;
});

describe('pure parts', () => {
  it('picks the business by CID, else the best fuzzy name; hours timetable to text', () => {
    expect(pickListing([{ title: 'Other', cid: '9' }, LISTING], { cid: '111', name: 'x' })).toMatchObject({ matchedBy: 'cid' });
    expect(pickListing([{ title: 'Desert Oasis Car Wash' }, LISTING], { cid: null, name: 'Oasis Pool and Spa' })).toMatchObject({ matchedBy: 'name', item: LISTING });
    expect(pickListing([{ title: 'Desert Oasis Car Wash' }], { name: 'Oasis Pool and Spa' })).toBeNull();
    expect(hoursFromWorkTime(LISTING.work_time)).toBe('Mon 08:00–18:00');
  });
  it('page check: no business name on the page → null (nothing written); name + phone + ZIP → correct; other phone → wrong', () => {
    const canon = { name: 'Oasis Pool and Spa', phone: '262-667-6421', zip: '53186' };
    expect(pageNapCheck(pageText('<html><body>Access denied</body></html>'), canon)).toBeNull();
    expect(pageNapCheck(pageText('<h1>Oasis Pool &amp; Spa</h1><p>Call (262) 667-6421, Waukesha WI 53186</p><script>x="414-555-0100"</script>'), canon)).toMatchObject({ napStatus: 'correct', checks: { name: true, phone: true, zip: true } });
    expect(pageNapCheck('Oasis Pool and Spa — call 414-555-0100 — 53186', canon)).toMatchObject({ napStatus: 'wrong', phoneSeen: '+14145550100', checks: { phone: false } });
  });
});

describe('monthly job: flag, caps, cost', () => {
  it('flag off (default) → no query and no paid call', async () => {
    const post = dfs([LISTING]);
    expect(await runCitationsMonitorJob({ env: {}, post })).toEqual({ skipped: 'DISABLED' });
    expect(await runCitationsMonitorJob({ env: { CITATIONS_MONITOR_ENABLED: 'false' }, post })).toEqual({ skipped: 'DISABLED' });
    expect(post).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it('flag on: one listings search per project, capped by CITATIONS_MAX_PER_RUN, cost stored, written as system', async () => {
    db.overrides['project.findMany'] = async () => [PROJECT, { ...PROJECT, id: 'p2' }, { ...PROJECT, id: 'p3' }, { ...PROJECT, id: 'p4', cmsCapabilities: {} }];
    db.overrides['seoCitationMirror.findUnique'] = async () => ({ id: 'row' });
    const post = dfs([LISTING]);
    const out = await runCitationsMonitorJob({ env: { CITATIONS_MONITOR_ENABLED: 'true', CITATIONS_MAX_PER_RUN: '2' }, post, now });
    expect(out).toMatchObject({ projects: 3, ran: 2, stopped: 'CAP', dfsCalls: 2, pageFetches: 0, costUsd: 0.0218 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe(DFS_LISTINGS_SEARCH_PATH);
    expect(post.mock.calls[0][1][0]).toMatchObject({ title: 'Oasis Pool and Spa', location_coordinate: '43.010000,-88.230000,25', limit: 10 });
    expect(outside.upserts[0].actor).toMatchObject({ kind: 'system' });
    expect(outside.upserts[0].items[0]).toMatchObject({ id: 'business.google.com', listed: true, nap_status: 'correct', phone_seen: '+1 262-667-6421', zip_seen: '53186', hours_seen: 'Mon 08:00–18:00' });
    expect(Object.keys(outside.upserts[0].items[0]).every((k) => ['id', 'listed', 'nap_status', 'name_seen', 'phone_seen', 'zip_seen', 'hours_seen', 'checks', 'last_checked'].includes(k))).toBe(true);
    const run = db.calls.find((c) => c.key === 'seoCitationCheckRun.create').args.data;
    expect(run).toMatchObject({ trigger: 'scheduled', period: '2026-11', status: 'running' });
    const fin = db.calls.find((c) => c.key === 'seoCitationCheckRun.update').args.data;
    expect(fin).toMatchObject({ status: 'ok', dfsCalls: 1, costUsd: 0.0109, checked: 1, written: 1 });
  });

  it('one scheduled run per project per month (unique period); an account-level error stops the job', async () => {
    db.overrides['project.findMany'] = async () => [PROJECT, { ...PROJECT, id: 'p2' }];
    db.overrides['seoCitationCheckRun.create'] = async () => {
      throw Object.assign(new Error('dup'), { code: 'P2002' });
    };
    const post = dfs([LISTING]);
    expect(await runCitationsMonitorJob({ env: { CITATIONS_MONITOR_ENABLED: 'true' }, post, now })).toMatchObject({ ran: 0, skipped: 2 });
    expect(post).not.toHaveBeenCalled();

    delete db.overrides['seoCitationCheckRun.create'];
    const bad = vi.fn(async () => ({ status_code: 40200, status_message: 'payment', tasks: [] }));
    const out = await runCitationsMonitorJob({ env: { CITATIONS_MONITOR_ENABLED: 'true' }, post: bad, now });
    expect(out.stopped).toBe('DFS_40200');
    expect(bad).toHaveBeenCalledTimes(1);
    expect(outside.upserts).toHaveLength(0);
  });

  it('not found on Google → listed false, missing; a site without a Google row gets one created (name / kind on create only)', async () => {
    const out = await checkProjectCitations(PROJECT, { post: dfs([{ title: 'Someone else' }]), now });
    expect(out.status).toBe('ok');
    expect(outside.upserts[0].items[0]).toEqual({ id: 'business.google.com', listed: false, nap_status: 'missing', last_checked: now.toISOString(), name: 'Google Business Profile', kind: 'maps' });
  });

  it('page check only with CITATIONS_PAGE_CHECK_ENABLED, capped, guarded fetch, ≥ 1.5 s apart; unreadable pages are not written', async () => {
    db.overrides['project.findMany'] = async () => [PROJECT];
    db.overrides['seoCitationMirror.findUnique'] = async () => ({ id: 'row' });
    db.overrides['seoCitationMirror.findMany'] = async (args) =>
      [{ siteCitationId: 'yelp.com', url: 'https://www.yelp.com/biz/oasis' }, { siteCitationId: 'bbb.org', url: 'https://www.bbb.org/x' }, { siteCitationId: 'porch.com', url: 'https://porch.com/x' }].slice(0, args.take);
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('yelp')) return new Response('<p>Forbidden</p>', { status: 403, headers: { 'content-type': 'text/html' } });
      return new Response('<h1>Oasis Pool and Spa</h1> 262-667-6421 Waukesha 53186', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    const sleep = vi.fn(async () => {});
    const off = await runCitationsMonitorJob({ env: { CITATIONS_MONITOR_ENABLED: 'true' }, post: dfs([LISTING]), fetchImpl, sleep, now });
    expect(off.pageFetches).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    db.overrides['seoCitationCheckRun.create'] = async (args) => ({ id: 'run-2', ...args.data });
    outside.upserts = [];
    const on = await runCitationsMonitorJob({ env: { CITATIONS_MONITOR_ENABLED: 'true', CITATIONS_PAGE_CHECK_ENABLED: 'true', CITATIONS_PAGE_CHECKS_MAX_PER_RUN: '2' }, post: dfs([LISTING]), fetchImpl, sleep, now });
    expect(on.pageFetches).toBe(2);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['https://www.yelp.com/biz/oasis', 'https://www.bbb.org/x']);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', maxBytes: 1.5 * 1024 * 1024 });
    expect(sleep).toHaveBeenCalledWith(1500);
    const ids = outside.upserts[0].items.map((i) => i.id);
    expect(ids).toEqual(['business.google.com', 'bbb.org']);
    expect(outside.upserts[0].items[1]).toMatchObject({ nap_status: 'correct', checks: { name: true, phone: true, zip: true } });
  });
});

describe('routes', () => {
  let app;
  let who;
  beforeAll(async () => {
    process.env.DATAFORSEO_LOGIN = 'l';
    process.env.DATAFORSEO_PASSWORD = 'p';
    app = Fastify();
    app.decorate('verifyJwt', async (request) => {
      request.user = who.user;
      if (who.token) request.authMethod = 'apiToken';
    });
    app.decorate('requireClient', async (request) => {
      request.clientAccountIds = who.clientIds || [];
    });
    await app.register(pmSeoMonitoringRoutes, { prefix: '/api/pm' });
    await app.register(clientSeoMonitoringRoutes, { prefix: '/api/client' });
    await app.ready();
  });
  afterAll(async () => {
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
    delete process.env.CITATIONS_MONITOR_ENABLED;
    await app.close();
  });
  beforeEach(() => {
    db.overrides['project.findUnique'] = async () => PROJECT;
    who = { user: { id: 'o', role: 'OWNER' } };
    delete process.env.CITATIONS_MONITOR_ENABLED;
  });

  const WRITES = [
    ['POST', '/api/pm/projects/p1/citations/pull', {}],
    ['PUT', '/api/pm/projects/p1/citations/canonical', { nap: { name: 'Oasis' } }],
    ['POST', '/api/pm/projects/p1/citations/upsert', { baseRev: 1, item: { id: 'yelp.com', listed: true } }],
    ['POST', '/api/pm/projects/p1/citations/check', {}],
  ];

  it('agents and API tokens get 403 HUMAN_ONLY on every write, before any site or vendor call', async () => {
    for (const actor of [{ user: { id: 'a', role: 'OWNER', isAgent: true } }, { user: { id: 't', role: 'OWNER' }, token: true }]) {
      who = actor;
      for (const [method, url, payload] of WRITES) {
        const res = await app.inject({ method, url, payload });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().code).toBe('HUMAN_ONLY');
      }
    }
    expect(outside.upserts).toHaveLength(0);
    expect(outside.pulls).toBe(0);
    expect(db.calls.some((c) => c.key.startsWith('seoCitationCheckRun'))).toBe(false);
  });

  it('TEAM_MEMBER / CONTRACTOR / CLIENT are refused on reads too', async () => {
    for (const role of ['TEAM_MEMBER', 'CONTRACTOR', 'CLIENT']) {
      who = { user: { id: 'x', role } };
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/citations' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/pm/projects/p1/ai-prompts' })).statusCode).toBe(403);
    }
  });

  it('Check now needs the flag (409 DISABLED) and has a DB cooldown (429)', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/citations/check', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('DISABLED');
    process.env.CITATIONS_MONITOR_ENABLED = 'true';
    db.overrides['seoCitationCheckRun.findFirst'] = async () => ({ startedAt: new Date(Date.now() - 60_000) });
    res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/citations/check', payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('COOLDOWN');
    delete db.overrides['seoCitationCheckRun.findFirst'];
    db.overrides['analyticsSyncRun.create'] = async (args) => ({ id: 'bg1', createdAt: new Date(), ...args.data });
    res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/citations/check', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().run).toMatchObject({ id: 'bg1', kind: 'citations_check' });
  });

  it('a site without seoCitations: upsert / pull answer 409 NO_CAPABILITY', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, cmsCapabilities: {} });
    const res = await app.inject({ method: 'POST', url: '/api/pm/projects/p1/citations/upsert', payload: { item: { id: 'yelp.com', listed: true } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_CAPABILITY');
  });

  it('client routes are scoped to the caller’s client accounts and send allow-lists only', async () => {
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['other'] };
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/business-listings' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/client/projects/p1/ai-answers' })).statusCode).toBe(404);
    who = { user: { id: 'cu', role: 'CLIENT' }, clientIds: ['c1'] };
    db.overrides['seoCitationMirror.findMany'] = async () => [{ name: 'Yelp', napStatus: 'wrong', checks: { phone: false }, lastChecked: now, rank: 1 }];
    const res = await app.inject({ method: 'GET', url: '/api/client/projects/p1/business-listings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, correct: 0, checked: 1, total: 1, missing: 0, label: '0 of 1 listings show your correct details', items: [{ text: 'Yelp shows an old or different phone number', kind: 'wrong' }], updatedAt: '2026-11-02' });
  });
});
