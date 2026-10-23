/**
 * DataForSEO Bing ranks (Phase 4 piece, BING_RANK_ENABLED default off): flag off → nothing posted; flag on → one
 * standard-queue task per approved trackLocal keyword per day, claimed with a pending row first, costUsd stored on
 * the row and the LocalRankTask (kind `bing`), caps per run / per project, account-level stop; organic + local-pack
 * matching by name + domain; the shared collector fills the BingSerpRankDaily row from task_get.
 * No real DataForSEO call: post / get are fakes with the documented task shapes.
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
          if (method === 'updateMany') return { count: 0 };
          if (method === 'create') return { id: 'x', ...(args?.data || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});

import {
  runBingRankJob,
  runBingRankForProject,
  bingRankResultFromItems,
  bingTaskBody,
  DFS_BING_TASK_POST_PATH,
  staffBingRankView,
} from '../../../src/lib/bing/bingRank.js';
import { collectLocalRankTasks } from '../../../src/lib/localRank.js';

const NOW = new Date('2026-10-24T06:25:00Z');
const calls = (k) => db.calls.filter((c) => c.key === k);
const PROJECT = {
  id: 'p1', name: 'Joe', clientId: 'c1', wpUrl: 'https://www.joespizza.com', dataforseoDomain: null, gmbLocationName: "Joe's Pizza",
  localLocationCode: 1016367, localLanguageCode: 'en', client: { websiteUrl: null, agencyName: 'Joe Pizza LLC' },
};
const KW = [{ id: 'k1', keyword: 'pizza near me' }, { id: 'k2', keyword: 'pizza milwaukee' }, { id: 'k3', keyword: 'best pizza' }];
const posted = (id, cost = 0.0006) => ({ status_code: 20000, tasks: [{ id, status_code: 20100, cost, result: null }] });

beforeEach(() => {
  db.calls = [];
  db.overrides = { 'keywordTrack.findMany': async (args) => KW.slice(0, args.take) };
});

describe('flag', () => {
  it('BING_RANK_ENABLED off (default) → skipped, nothing posted, no DB read', async () => {
    const post = vi.fn();
    expect(await runBingRankJob({ env: {}, post })).toEqual({ skipped: 'DISABLED' });
    expect(await runBingRankJob({ env: { BING_RANK_ENABLED: 'false' }, post })).toEqual({ skipped: 'DISABLED' });
    expect(post).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it('on → posts one task per due keyword, claims first, logs costUsd per row, caps per run', async () => {
    db.overrides['project.findMany'] = async () => [PROJECT];
    let n = 0;
    const post = vi.fn(async (path, tasks) => {
      expect(path).toBe(DFS_BING_TASK_POST_PATH);
      expect(tasks[0]).toMatchObject({ keyword: expect.any(String), location_code: 1016367, language_code: 'en', depth: 10, priority: 1 });
      n += 1;
      return posted(`task-000${n}-abcdef`);
    });
    const out = await runBingRankJob({ now: NOW, env: { BING_RANK_ENABLED: 'true', BING_RANK_MAX_PER_RUN: '2' }, post });
    expect(out).toMatchObject({ projects: 1, checked: 2, posted: 2, errors: 0, costUsd: 0.0012, stopped: 'CAP' });
    const claims = calls('bingSerpRankDaily.create');
    expect(claims.map((c) => [c.args.data.keywordId, c.args.data.status])).toEqual([['k1', 'pending'], ['k2', 'pending']]);
    const tasks = calls('localRankTask.create').map((c) => c.args.data);
    expect(tasks.map((t) => [t.kind, t.taskId, t.costUsd])).toEqual([['bing', 'task-0001-abcdef', 0.0006], ['bing', 'task-0002-abcdef', 0.0006]]);
    const cost = calls('bingSerpRankDaily.updateMany').filter((c) => c.args.data.costUsd != null);
    expect(cost).toHaveLength(2);
    // the claim precedes the post for every keyword
    const order = db.calls.map((c) => c.key).filter((k) => k === 'bingSerpRankDaily.create' || k === 'localRankTask.create');
    expect(order).toEqual(['bingSerpRankDaily.create', 'localRankTask.create', 'bingSerpRankDaily.create', 'localRankTask.create']);
  });

  it('skips keywords done or pending today; caps per project; stops at an account-level error', async () => {
    db.overrides['bingSerpRankDaily.findMany'] = async () => [{ keywordId: 'k1' }];
    const post = vi.fn(async () => ({ status_code: 40200, status_message: 'Payment Required', tasks: [] }));
    const out = await runBingRankForProject(PROJECT, { now: NOW, post, env: { BING_RANK_MAX_PER_PROJECT: '3' } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ checked: 1, posted: 0, errors: 1, stopped: 'DFS_40200' });
    expect(calls('keywordTrack.findMany')[0].args).toMatchObject({ take: 3, where: { projectId: 'p1', trackLocal: true } });
    const errRow = calls('bingSerpRankDaily.updateMany').find((c) => c.args.data.status === 'error');
    expect(errRow.args.data.errorCode).toBe('DFS_40200');
  });

  it('a project without a website domain is skipped', async () => {
    const out = await runBingRankForProject({ ...PROJECT, wpUrl: null, client: { websiteUrl: null } }, { post: vi.fn() });
    expect(out.skipped).toBe('NO_DOMAIN');
  });
});

describe('matching', () => {
  const items = [
    { type: 'organic', rank_group: 1, url: 'https://xjoespizza.com/', domain: 'xjoespizza.com' },
    { type: 'local_pack', title: 'Pizza Hub', domain: 'pizzahub.com', url: 'https://pizzahub.com' },
    { type: 'local_pack', title: "Joe's Pizza", domain: 'www.joespizza.com', url: 'https://www.joespizza.com/' },
    { type: 'organic', rank_group: 4, url: 'https://www.joespizza.com/menu', domain: 'www.joespizza.com' },
  ];
  it('organic by registrable domain (look-alikes refused), pack by name + domain', () => {
    expect(bingRankResultFromItems(PROJECT, items)).toEqual({
      status: 'ok', organicRank: 4, organicUrl: 'https://www.joespizza.com/menu', localPackRank: 2, localPackPresent: true, matchedBy: 'name_domain',
    });
  });
  it('domain-only pack match is weak; nothing found → not_found', () => {
    const weak = bingRankResultFromItems(PROJECT, [{ type: 'local_pack', title: 'Totally different', url: 'https://joespizza.com' }]);
    expect(weak).toMatchObject({ localPackRank: 1, matchedBy: 'weak', organicRank: null });
    expect(bingRankResultFromItems(PROJECT, [{ type: 'organic', rank_group: 1, url: 'https://other.com' }])).toMatchObject({ status: 'not_found', localPackPresent: false });
  });
  it('task body uses the project location and language', () => {
    expect(bingTaskBody(PROJECT, 'pizza', {})).toEqual({ keyword: 'pizza', location_code: 1016367, language_code: 'en', depth: 10 });
  });
});

describe('collector (kind bing)', () => {
  it('reads the Bing task_get path and fills the pending BingSerpRankDaily row', async () => {
    db.overrides['localRankTask.findMany'] = async () => [
      { id: 't1', projectId: 'p1', keywordId: 'k1', kind: 'bing', date: new Date('2026-10-24'), gridId: null, pointIndex: null, taskId: 'task-0001-abcdef', postedAt: NOW, polls: 0 },
    ];
    db.overrides['project.findUnique'] = async () => PROJECT;
    const get = vi.fn(async (path) => {
      expect(path).toBe('/v3/serp/bing/organic/task_get/advanced/task-0001-abcdef');
      return { status_code: 20000, tasks: [{ id: 'task-0001-abcdef', status_code: 20000, result: [{ items: [{ type: 'organic', rank_group: 3, url: 'https://joespizza.com/' }] }] }] };
    });
    const out = await collectLocalRankTasks({ now: NOW, get, env: {} });
    expect(out).toMatchObject({ tasks: 1, done: 1 });
    const row = calls('bingSerpRankDaily.updateMany')[0].args;
    expect(row.where).toMatchObject({ keywordId: 'k1', status: 'pending' });
    expect(row.data).toMatchObject({ status: 'ok', organicRank: 3, localPackRank: null });
    expect(calls('localRankDaily.updateMany')).toHaveLength(0);
  });
  it('an expired bing task errors its row', async () => {
    db.overrides['localRankTask.findMany'] = async () => [
      { id: 't1', projectId: 'p1', keywordId: 'k1', kind: 'bing', date: new Date('2026-10-22'), gridId: null, pointIndex: null, taskId: 'task-0001-abcdef', postedAt: new Date('2026-10-22T00:00:00Z'), polls: 9 },
    ];
    const out = await collectLocalRankTasks({ now: NOW, get: vi.fn(), env: {} });
    expect(out.expired).toBe(1);
    expect(calls('bingSerpRankDaily.updateMany')[0].args.data).toMatchObject({ status: 'error', errorCode: 'DFS_EXPIRED' });
  });
});

describe('staff view', () => {
  it('keeps cost staff-side: estimate + 30-day spend', async () => {
    db.overrides['bingSerpRankDaily.findMany'] = async () => [
      { keywordId: 'k1', date: new Date('2026-10-23'), organicRank: 4, localPackRank: 2, localPackPresent: true, matchedBy: 'name_domain', status: 'ok', errorCode: null, costUsd: '0.00060', fetchedAt: new Date('2026-10-23T07:00:00Z') },
    ];
    const v = await staffBingRankView(PROJECT, { now: NOW });
    expect(v.enabled).toBe(false);
    expect(v.keywords[0]).toMatchObject({ keyword: 'pizza near me', latest: { organicRank: 4, localPackRank: 2 } });
    expect(v.cost).toMatchObject({ perCallUsd: 0.0006, dailyChecks: 3, monthlyUsd: 0.054, spent30dUsd: 0.0006 });
  });
});
