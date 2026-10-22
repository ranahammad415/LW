/**
 * Maps rank tracking: matching (cid → place_id → weak title+domain), LocalRankDaily upsert (an error never overwrites
 * a good row), caps and flags, account-level stop, grid cap and cost estimate, client allow-list, health hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import {
  matchBusiness,
  competitorsFrom,
  mapsLocation,
  checkMapsRank,
  storeLocalRank,
  runLocalRankForProject,
  runLocalRankJob,
  gridPoints,
  clampGridSize,
  gridCostEstimate,
  runGridForKeyword,
  runLocalGridJob,
  clientMapsRankingView,
  localRankSummary,
  isLocalIntentKeyword,
  applyDefaultTrackLocal,
  LOCAL_PROJECT_SELECT,
  collectLocalRankTasks,
  gridOutcome,
  estCostPerCall,
} from '../../../src/lib/localRank.js';

const PROJECT = {
  id: 'p1', clientId: 'c1', wpUrl: 'https://www.joespizza.com', dataforseoDomain: null, gmbCid: '111111111', gmbPlaceId: 'ChIJjoe12345',
  gmbLocationName: "Joe's Pizza", gmbLat: 43.0389, gmbLng: -87.9065, localLanguageCode: 'en', localGridSize: 5, localGridSpacingKm: 1.5, client: { websiteUrl: null },
};
const ITEMS = [
  { type: 'maps_search', rank_group: 1, rank_absolute: 1, title: 'Rival One', cid: '900', rating: { value: 4.9, votes_count: 50 } },
  { type: 'maps_search', rank_group: 2, rank_absolute: 2, title: 'Rival Two', cid: '901', rating: { value: 4.1, votes_count: 9 } },
  { type: 'maps_search', rank_group: 3, rank_absolute: 3, title: "Joe's Pizza", cid: '111111111', place_id: 'ChIJjoe12345', domain: 'joespizza.com' },
  { type: 'maps_search', rank_group: 4, rank_absolute: 4, title: 'Rival Four', cid: '903' },
];
const dfsOk = (items) => async () => ({ status_code: 20000, tasks: [{ id: 't', status_code: 20000, cost: 0.002, result: [{ items }] }] });
let seq = 0;
const dfsPosted = () => async () => ({ status_code: 20000, tasks: [{ id: `task-${String(++seq).padStart(8, '0')}`, status_code: 20100, status_message: 'Task Created.', cost: 0.0006, result: null }] });
const dfsGet = (code, items = []) => async () => ({ status_code: 20000, tasks: [{ id: 'x', status_code: code, status_message: 'm', cost: 0, result: code === 20000 ? [{ items }] : null }] });
const now = new Date('2026-10-22T06:15:00Z');

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  seq = 0;
});

describe('matching', () => {
  it('cid first, then place_id, then weak title + domain', () => {
    expect(matchBusiness(ITEMS, { cid: '111111111' })).toMatchObject({ rank: 3, matchedBy: 'cid' });
    expect(matchBusiness(ITEMS, { cid: '0', placeId: 'ChIJjoe12345' })).toMatchObject({ rank: 3, matchedBy: 'place_id' });
    expect(matchBusiness(ITEMS, { name: "joe's pizza", siteDomain: 'joespizza.com' })).toMatchObject({ rank: 3, matchedBy: 'weak' });
    // Weak match needs BOTH title and site.
    expect(matchBusiness(ITEMS, { name: "Joe's Pizza", siteDomain: 'xjoespizza.com' })).toBeNull();
    expect(matchBusiness(ITEMS, { name: 'Other', siteDomain: 'joespizza.com' })).toBeNull();
  });

  it('top 3 competitors exclude the client', () => {
    const m = matchBusiness(ITEMS, { cid: '111111111' });
    expect(competitorsFrom(ITEMS, m.item).map((c) => c.title)).toEqual(['Rival One', 'Rival Two', 'Rival Four']);
    expect(competitorsFrom(ITEMS, m.item)[0]).toEqual({ title: 'Rival One', rating: 4.9, votes: 50, cid: '900' });
  });

  it('location: coordinates with zoom 14z, else the project location_code', () => {
    expect(mapsLocation(PROJECT)).toEqual({ mode: 'coordinate', params: { location_coordinate: '43.0389000,-87.9065000,14z' } });
    expect(mapsLocation({ localLocationCode: 1023191 }, null, {})).toEqual({ mode: 'location_code', params: { location_code: 1023191 } });
  });
});

describe('checks and storage', () => {
  it('one Maps live call (depth 20); 3-pack and competitors recorded', async () => {
    const post = vi.fn(dfsOk(ITEMS));
    const r = await checkMapsRank(PROJECT, 'pizza milwaukee', { post, env: {} });
    expect(post.mock.calls[0][0]).toBe('/v3/serp/google/maps/live/advanced');
    expect(post.mock.calls[0][1][0]).toMatchObject({ keyword: 'pizza milwaukee', depth: 20, language_code: 'en', location_coordinate: '43.0389000,-87.9065000,14z' });
    expect(r).toMatchObject({ status: 'ok', rank: 3, inPack: true, matchedBy: 'cid', costUsd: 0.002, locationMode: 'coordinate' });
  });

  it('not found within depth → rank null; an account-level error is flagged', async () => {
    expect(await checkMapsRank(PROJECT, 'k', { post: dfsOk(ITEMS.slice(0, 2)), env: {} })).toMatchObject({ status: 'not_found', rank: null, inPack: false });
    const r = await checkMapsRank(PROJECT, 'k', { post: async () => ({ status_code: 20000, tasks: [{ status_code: 40210, status_message: 'funds' }] }), env: {} });
    expect(r).toMatchObject({ status: 'error', errorCode: 'DFS_40210', accountLevel: true });
  });

  it('LocalRankDaily upsert keyed (keywordId, date); an error never overwrites a good row of the day', async () => {
    await storeLocalRank(PROJECT, 'k1', { status: 'ok', rank: 3, rankAbsolute: 3, inPack: true, matchedBy: 'cid', competitors: [], costUsd: 0.002, depth: 20, locationMode: 'coordinate' }, { now });
    const up = db.calls.find((c) => c.key === 'localRankDaily.upsert').args;
    expect(up.where).toEqual({ keywordId_date: { keywordId: 'k1', date: new Date('2026-10-22T00:00:00Z') } });
    expect(up.create).toMatchObject({ projectId: 'p1', keywordId: 'k1', rank: 3, inPack: true, status: 'ok', costUsd: 0.002 });
    db.calls = [];
    db.overrides['localRankDaily.findUnique'] = async () => ({ status: 'ok' });
    expect(await storeLocalRank(PROJECT, 'k1', { status: 'error', errorCode: 'DFS_50000' }, { now })).toEqual({ kept: true });
    expect(db.calls.some((c) => c.key === 'localRankDaily.upsert')).toBe(false);
  });

  it('per-project (standard queue): skips keywords done or pending today, claims before posting, respects the budget, stops at an account-level error', async () => {
    db.overrides['keywordTrack.findMany'] = async () => [{ id: 'k1', keyword: 'a' }, { id: 'k2', keyword: 'b' }, { id: 'k3', keyword: 'c' }, { id: 'k4', keyword: 'd' }];
    db.overrides['localRankDaily.findMany'] = async () => [{ keywordId: 'k1' }];
    db.overrides['localRankDaily.updateMany'] = async () => ({ count: 0 });
    const post = vi.fn(dfsPosted());
    const out = await runLocalRankForProject(PROJECT, { now, budget: 2, post, env: {} });
    expect(out).toMatchObject({ checked: 2, posted: 2, stopped: 'CAP', costUsd: 0.0012 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe('/v3/serp/google/maps/task_post');
    expect(post.mock.calls[0][1][0]).toMatchObject({ keyword: 'b', depth: 20, priority: 1, location_coordinate: '43.0389000,-87.9065000,14z' });
    const doneWhere = db.calls.find((c) => c.key === 'localRankDaily.findMany').args.where;
    expect(doneWhere.status).toEqual({ in: ['ok', 'not_found', 'pending'] });
    // Claim (pending row) BEFORE the task is posted; the task id is stored for the collector.
    const keys = db.calls.map((c) => c.key);
    expect(keys.indexOf('localRankDaily.create')).toBeLessThan(keys.indexOf('localRankTask.create'));
    expect(db.calls.find((c) => c.key === 'localRankDaily.create').args.data).toMatchObject({ keywordId: 'k2', status: 'pending' });
    expect(db.calls.find((c) => c.key === 'localRankTask.create').args.data).toMatchObject({ kind: 'daily', keywordId: 'k2', taskId: 'task-00000001', status: 'pending', costUsd: 0.0006 });
    const kwWhere = db.calls.find((c) => c.key === 'keywordTrack.findMany').args.where;
    expect(kwWhere).toEqual({ projectId: 'p1', trackLocal: true, status: { in: ['APPROVED', 'ACCEPTED', 'TRACKING'] } });

    db.overrides['localRankDaily.findMany'] = async () => [];
    const bad = vi.fn(async () => ({ status_code: 40100, status_message: 'auth', tasks: [] }));
    const stop = await runLocalRankForProject(PROJECT, { now, budget: 10, post: bad, env: {} });
    expect(stop).toMatchObject({ checked: 1, errors: 1, stopped: 'DFS_40100' });
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('never pays twice for one keyword-day: a claim lost to another instance posts nothing', async () => {
    db.overrides['keywordTrack.findMany'] = async () => [{ id: 'k1', keyword: 'a' }];
    db.overrides['localRankDaily.updateMany'] = async () => ({ count: 0 });
    db.overrides['localRankDaily.create'] = async () => {
      throw Object.assign(new Error('dup'), { code: 'P2002' });
    };
    const post = vi.fn(dfsPosted());
    const out = await runLocalRankForProject(PROJECT, { now, budget: 10, post, env: {} });
    expect(post).not.toHaveBeenCalled();
    expect(out).toMatchObject({ checked: 0, posted: 0 });
    // An error row of the day is taken over with a CAS on status (then posted once).
    db.overrides['localRankDaily.updateMany'] = async (args) => ({ count: args.where.status === 'error' ? 1 : 1 });
    const post2 = vi.fn(dfsPosted());
    await runLocalRankForProject(PROJECT, { now, budget: 10, post: post2, env: {} });
    expect(post2).toHaveBeenCalledTimes(1);
  });

  it('job is off unless LOCAL_RANK_ENABLED=true and capped by LOCAL_RANK_MAX_PER_RUN', async () => {
    expect(await runLocalRankJob({ env: {} })).toEqual({ skipped: 'DISABLED' });
    expect(db.calls).toEqual([]);
    db.overrides['project.findMany'] = async () => [PROJECT, { ...PROJECT, id: 'p2' }];
    db.overrides['keywordTrack.findMany'] = async () => [{ id: 'k1', keyword: 'a' }, { id: 'k2', keyword: 'b' }];
    db.overrides['localRankDaily.updateMany'] = async () => ({ count: 0 });
    const post = vi.fn(dfsPosted());
    const out = await runLocalRankJob({ env: { LOCAL_RANK_ENABLED: 'true', LOCAL_RANK_MAX_PER_RUN: '3' }, post, now });
    expect(post).toHaveBeenCalledTimes(3);
    expect(out).toMatchObject({ checked: 3, posted: 3, stopped: 'CAP' });
    expect(db.calls.find((c) => c.key === 'project.findMany').args.select).toEqual(LOCAL_PROJECT_SELECT);
  });

  it('a project without CID / place_id / name+site is skipped before any call', async () => {
    const post = vi.fn();
    const out = await runLocalRankForProject({ id: 'p9', gmbCid: null, gmbPlaceId: null, gmbLocationName: null }, { post });
    expect(out.skipped).toBe('NO_IDENTITY');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('geo-grid', () => {
  it('N×N points, odd sizes, capped at 7×7', () => {
    expect(clampGridSize(9)).toBe(7);
    expect(clampGridSize(4)).toBe(3);
    expect(clampGridSize(undefined)).toBe(5);
    const pts = gridPoints({ lat: 43, lng: -87.9 }, 5, 2);
    expect(pts).toHaveLength(25);
    expect(pts[12]).toMatchObject({ lat: 43, lng: -87.9, row: 2, col: 2 });
    expect(pts[0].lat).toBeGreaterThan(43);
    expect(gridPoints({ lat: 43, lng: -87.9 }, 15, 1)).toHaveLength(49);
  });

  it('cost estimate before enabling (standard queue default 0.0006 per check)', () => {
    expect(gridCostEstimate({ size: 5, keywords: 3, perCallUsd: 0.002 })).toEqual({ calls: 75, perRunUsd: 0.15, perMonthUsd: 0.6525, perCallUsd: 0.002 });
    expect(estCostPerCall({})).toBe(0.0006);
    expect(estCostPerCall({ LOCAL_RANK_EST_COST_USD: '0.001' })).toBe(0.001);
  });

  it('a grid larger than the remaining budget is not started', async () => {
    const post = vi.fn();
    expect(await runGridForKeyword(PROJECT, { id: 'k1', keyword: 'a' }, { post, maxPoints: 24 })).toEqual({ skipped: 'CAP' });
    expect(post).not.toHaveBeenCalled();
  });

  it('one grid run posts N² tasks on a pending grid row; the collector fills it and sets avgRank and coverage', async () => {
    const post = vi.fn(dfsPosted());
    db.overrides['localRankGrid.create'] = async (args) => ({ id: 'g1', ...args.data });
    const out = await runGridForKeyword({ ...PROJECT, localGridSize: 3 }, { id: 'k1', keyword: 'a' }, { post, now, env: {} });
    expect(post).toHaveBeenCalledTimes(9);
    expect(out).toMatchObject({ calls: 9, posted: 9, status: 'pending' });
    const row = db.calls.find((c) => c.key === 'localRankGrid.create').args.data;
    expect(row).toMatchObject({ gridSize: 3, status: 'pending', centerLat: 43.0389 });
    expect(row.points.every((p) => p.pending)).toBe(true);
    const tasks = db.calls.filter((c) => c.key === 'localRankTask.create').map((c) => c.args.data);
    expect(tasks.map((t) => t.pointIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tasks.every((t) => t.kind === 'grid' && t.gridId === 'g1')).toBe(true);
    const upd = db.calls.find((c) => c.key === 'localRankGrid.update').args.data;
    expect(upd).not.toHaveProperty('status'); // still pending until collected
    expect(upd.costUsd).toBe(0.0054);

    // Collection: 9 done tasks fill every point; the grid is finalised.
    db.calls = [];
    const points = row.points;
    db.overrides['localRankTask.findMany'] = async () => tasks.map((t, i) => ({ id: `lt${i}`, projectId: 'p1', keywordId: 'k1', kind: 'grid', date: t.date, gridId: 'g1', pointIndex: i, taskId: t.taskId, postedAt: now, polls: 0 }));
    db.overrides['project.findUnique'] = async () => PROJECT;
    db.overrides['localRankGrid.findUnique'] = async () => ({ id: 'g1', points, status: 'pending', errorCode: null });
    const sum = await collectLocalRankTasks({ now: new Date(now.getTime() + 20 * 60_000), get: dfsGet(20000, ITEMS), env: {} });
    expect(sum).toMatchObject({ tasks: 9, done: 9 });
    const fin = db.calls.find((c) => c.key === 'localRankGrid.update').args.data;
    expect(fin).toMatchObject({ avgRank: 3, coverage: 1, status: 'ok' });
    expect(fin.points.some((p) => p.pending)).toBe(false);
  });

  it('weekly job is off unless LOCAL_GRID_ENABLED=true', async () => {
    expect(await runLocalGridJob({ env: {} })).toEqual({ skipped: 'DISABLED' });
  });
});

describe('standard-queue collector', () => {
  const task = (over = {}) => ({ id: 'lt1', projectId: 'p1', keywordId: 'k1', kind: 'daily', date: new Date('2026-10-22T00:00:00Z'), gridId: null, pointIndex: null, taskId: 'task-00000001', postedAt: now, polls: 0, ...over });

  it('40601 / 40602 are pending (polls + 1, nothing stored); 20000 stores the rank on the pending day row only', async () => {
    db.overrides['localRankTask.findMany'] = async () => [task()];
    for (const code of [40601, 40602]) {
      db.calls = [];
      const out = await collectLocalRankTasks({ now: new Date(now.getTime() + 60_000), get: dfsGet(code), env: {} });
      expect(out).toMatchObject({ pending: 1, done: 0 });
      expect(db.calls.find((c) => c.key === 'localRankTask.update').args.data).toEqual({ polls: 1 });
      expect(db.calls.some((c) => c.key === 'localRankDaily.updateMany')).toBe(false);
    }
    db.calls = [];
    db.overrides['project.findUnique'] = async () => PROJECT;
    const get = vi.fn(dfsGet(20000, ITEMS));
    const out = await collectLocalRankTasks({ now: new Date(now.getTime() + 60_000), get, env: {} });
    expect(out).toMatchObject({ done: 1 });
    expect(get.mock.calls[0][0]).toBe('/v3/serp/google/maps/task_get/advanced/task-00000001');
    const upd = db.calls.find((c) => c.key === 'localRankDaily.updateMany').args;
    expect(upd.where).toEqual({ keywordId: 'k1', date: new Date('2026-10-22T00:00:00Z'), status: 'pending' });
    expect(upd.data).toMatchObject({ status: 'ok', rank: 3, inPack: true, matchedBy: 'cid' });
    expect(db.calls.find((c) => c.key === 'localRankTask.updateMany').args.data).toMatchObject({ status: 'done' });
  });

  it('a task older than 24 h is expired without a get call; an account-level error stops the tick and keeps the task', async () => {
    db.overrides['localRankTask.findMany'] = async () => [task()];
    const get = vi.fn(dfsGet(20000, ITEMS));
    const out = await collectLocalRankTasks({ now: new Date(now.getTime() + 24 * 3600_000 + 1), get, env: {} });
    expect(out).toMatchObject({ expired: 1 });
    expect(get).not.toHaveBeenCalled();
    expect(db.calls.find((c) => c.key === 'localRankTask.updateMany').args.data).toMatchObject({ status: 'expired', errorCode: 'DFS_EXPIRED' });
    expect(db.calls.find((c) => c.key === 'localRankDaily.updateMany').args.data).toMatchObject({ status: 'error', errorCode: 'DFS_EXPIRED' });

    db.calls = [];
    db.overrides['localRankTask.findMany'] = async () => [task(), task({ id: 'lt2', taskId: 'task-00000002' })];
    const acct = vi.fn(async () => ({ status_code: 40200, status_message: 'payment', tasks: [] }));
    const stop = await collectLocalRankTasks({ now: new Date(now.getTime() + 60_000), get: acct, env: {} });
    expect(stop.stopped).toBe('DFS_40200');
    expect(acct).toHaveBeenCalledTimes(1);
    expect(db.calls.some((c) => c.key === 'localRankTask.updateMany')).toBe(false);
  });

  it('without credentials (and no injected client) it does nothing', async () => {
    expect(await collectLocalRankTasks({ env: {} })).toEqual({ skipped: 'NO_CREDS' });
    expect(db.calls).toEqual([]);
  });

  it('gridOutcome: errors make it partial, all errors / a stop make it error', () => {
    expect(gridOutcome([{ rank: 2 }, { rank: null }, { rank: null, error: true }])).toEqual({ avgRank: 2, coverage: 0.5, status: 'partial' });
    expect(gridOutcome([{ rank: null, error: true }])).toMatchObject({ status: 'error' });
    expect(gridOutcome([{ rank: 1 }], 'DFS_40200')).toMatchObject({ status: 'error' });
  });
});

describe('client view and health hook', () => {
  it('client tile: keyword, position or "not in the top N", trend, competitor names — no ids, cost or vendor', async () => {
    db.overrides['keywordTrack.findMany'] = async () => [{ id: 'k1', keyword: 'pizza milwaukee' }, { id: 'k2', keyword: 'pizza near me' }];
    db.overrides['localRankDaily.findMany'] = async () => [
      { keywordId: 'k1', date: new Date('2026-09-20T00:00:00Z'), rank: 7, inPack: false, depth: 20, competitors: [] },
      { keywordId: 'k1', date: new Date('2026-10-22T00:00:00Z'), rank: 3, inPack: true, depth: 20, competitors: [{ title: 'Rival One', cid: '900', rating: 4.9, votes: 50 }] },
      { keywordId: 'k2', date: new Date('2026-10-22T00:00:00Z'), rank: null, inPack: false, depth: 20, competitors: [] },
    ];
    const out = await clientMapsRankingView({ id: 'p1' }, { now });
    expect(out.keywords[0]).toEqual({
      keyword: 'pizza milwaukee', position: 3, inTop3: true, label: '#3 on Google Maps', change: 4,
      trend: [{ date: '2026-09-20', position: 7 }, { date: '2026-10-22', position: 3 }], nearbyCompetitors: ['Rival One'], updatedAt: '2026-10-22',
    });
    expect(out.keywords[1].label).toBe('Not in the top 20');
    const json = JSON.stringify(out);
    for (const bad of ['cid', 'costUsd', 'matchedBy', 'dataforseo', 'errorCode', '900']) expect(json.toLowerCase()).not.toContain(bad.toLowerCase());
    const q = db.calls.find((c) => c.key === 'localRankDaily.findMany').args;
    expect(q.select).not.toHaveProperty('costUsd');
  });

  it('localRankSummary for a later Health factor', async () => {
    db.overrides['localRankDaily.findMany'] = async () => [
      { keywordId: 'k1', date: new Date('2026-10-20T00:00:00Z'), rank: 2, inPack: true },
      { keywordId: 'k1', date: new Date('2026-10-21T00:00:00Z'), rank: 4, inPack: false },
      { keywordId: 'k2', date: new Date('2026-10-21T00:00:00Z'), rank: null, inPack: false },
    ];
    expect(await localRankSummary('p1', '2026-10-01', '2026-10-22')).toEqual({ keywords: 2, checks: 3, found: 2, avgRank: 3, inPackShare: 0.333, days: 2 });
  });
});

describe('default trackLocal', () => {
  it('local intent: near me, or the project city / market in the keyword', () => {
    expect(isLocalIntentKeyword('pizza near me')).toBe(true);
    expect(isLocalIntentKeyword('pizza milwaukee', { targetMarket: 'Milwaukee' })).toBe(true);
    expect(isLocalIntentKeyword('pizza delivery', { localLocationName: 'Milwaukee,Wisconsin,United States' })).toBe(false);
    expect(isLocalIntentKeyword('milwaukee pizza', { localLocationName: 'Milwaukee,Wisconsin,United States' })).toBe(true);
  });

  it('turns on approved local keywords once; never overrides an existing choice', async () => {
    db.overrides['keywordTrack.findMany'] = async () => [{ id: 'k1', keyword: 'pizza near me' }, { id: 'k2', keyword: 'pizza recipe' }];
    db.overrides['keywordTrack.updateMany'] = async () => ({ count: 1 });
    expect(await applyDefaultTrackLocal(PROJECT)).toBe(1);
    expect(db.calls.find((c) => c.key === 'keywordTrack.updateMany').args).toEqual({ where: { id: { in: ['k1'] } }, data: { trackLocal: true } });
    db.calls = [];
    db.overrides['keywordTrack.count'] = async () => 2;
    expect(await applyDefaultTrackLocal(PROJECT)).toBe(0);
    expect(db.calls.some((c) => c.key === 'keywordTrack.updateMany')).toBe(false);
    expect(await applyDefaultTrackLocal({ id: 'x', gmbCid: 'Joe Pizza' })).toBe(0);
  });
});
