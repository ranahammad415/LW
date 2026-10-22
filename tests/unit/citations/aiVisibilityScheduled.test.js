/**
 * Monthly AI-visibility runs (contract 1.8.0 §39.5): prompt sanitizing and the documented selection rule, the flag
 * (off = no query, no call), the per-project prompt cap and the per-run project cap, one run per project per month,
 * the existing runner reused (one attempt per cell, cost and mention position stored, AiUsageLog, DFS snapshot off),
 * the client allow-list (isDemo and admin runs excluded) and the staff per-prompt view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ prompts: null, calls: 0 }));

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
          if (method === 'create') return { id: 'run-1', ...(args?.data || {}) };
          if (method === 'createMany' || method === 'deleteMany' || method === 'updateMany') return { count: 0 };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/cmsStore.js', () => ({ loadEmdashConnection: async () => ({ conn: { fake: true } }) }));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    emdashRoutes: {
      ...real.emdashRoutes,
      seoAiPrompts: async () => {
        site.calls += 1;
        return structuredClone(site.prompts);
      },
    },
  };
});

import {
  sanitizeAiPrompts,
  selectPrompts,
  runAiVisibilityMonthlyJob,
  runScheduledAiVisibility,
  clientAiAnswersView,
  staffAiPromptsView,
  promptOutcomes,
} from '../../../src/lib/analytics/aiVisibilityScheduled.js';
import { mentionPosition } from '../../../src/lib/analytics/aiVisibilityRunner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const PROJECT = { id: 'p1', clientId: 'c1', cmsType: 'EMDASH', cmsCapabilities: { seoAiPrompts: true } };
const now = new Date('2026-11-02T05:45:00Z');
const mk = (n, extra = {}) => ({ id: `p${n}`, text: `Question number ${n}?`, town: 'Waukesha', service: 'Closing', page_ids: [], branded: false, source: 'handoff', ...extra });

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
  site.prompts = ex('seo-ai-prompts.response');
  site.calls = 0;
  process.env.OPENROUTER_API_KEY = 'test-key';
});

describe('prompts', () => {
  it('sanitizes the example; drops entries without id / text / known source', () => {
    const p = sanitizeAiPrompts(ex('seo-ai-prompts.response'));
    expect(p).toHaveLength(5);
    expect(p[0]).toEqual({ id: 'p1', text: 'Who should I call to close my inground pool in Waukesha, WI this fall?', town: 'Waukesha', service: 'Closing', pageIds: [], branded: false, source: 'handoff' });
    expect(sanitizeAiPrompts({ prompts: [{ id: 'x', text: 'y', source: 'os' }, { id: '', text: 'y', source: 'handoff' }, { text: 'z', source: 'handoff' }] })).toEqual([]);
  });

  it('selection: dedupe, handoff before answer targets, non-branded first, a small branded sample (cap/10, ≥ 1)', () => {
    const list = [
      mk(1, { branded: true }),
      mk(2, { source: 'answer_target' }),
      mk(3),
      mk(4, { text: 'question NUMBER 3?' }),
      ...Array.from({ length: 30 }, (_, i) => mk(10 + i)),
      mk(90, { branded: true }),
      mk(91, { branded: true }),
      mk(92, { branded: true }),
    ];
    const s = selectPrompts(list, 25);
    expect(s).toHaveLength(25);
    expect(s.filter((p) => p.branded).map((p) => p.id)).toEqual(['p1', 'p90']);
    expect(s[0].id).toBe('p3');
    expect(s.some((p) => p.id === 'p4')).toBe(false);
    expect(s.some((p) => p.id === 'p2')).toBe(false); // answer targets come after 30 handoff prompts
    expect(selectPrompts([mk(1, { branded: true }), mk(2, { branded: true }), mk(3)], 25).map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    expect(selectPrompts([mk(1), mk(2, { branded: true })], 1).map((p) => p.id)).toEqual(['p1']);
  });

  it('mention position: index of the first listed item naming the brand or domain', () => {
    const text = 'Here are options:\n1. Rival Pools - rival.com\n2. Oasis Pool and Spa (oasispoolspas.com)\n3. Other';
    expect(mentionPosition(text, { domain: 'oasispoolspas.com', brands: [] })).toBe(2);
    expect(mentionPosition(text, { domain: null, brands: ['Oasis Pool and Spa'] })).toBe(2);
    expect(mentionPosition('Oasis Pool and Spa is good.', { brands: ['Oasis Pool and Spa'] })).toBeNull();
  });
});

describe('monthly job', () => {
  it('flag off (default) → nothing queried, nothing called', async () => {
    const probe = vi.fn();
    expect(await runAiVisibilityMonthlyJob({ env: {}, probe })).toEqual({ skipped: 'DISABLED' });
    expect(db.calls).toEqual([]);
    expect(site.calls).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it('flag on: projects capped; a month already run is skipped (unique period)', async () => {
    db.overrides['project.findMany'] = async () => [PROJECT, { ...PROJECT, id: 'p2' }, { ...PROJECT, id: 'p3' }, { ...PROJECT, id: 'p4', cmsCapabilities: {} }];
    let n = 0;
    db.overrides['aiVisibilityRun.create'] = async (args) => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('dup'), { code: 'P2002' });
      return { id: `run-${n}`, ...args.data };
    };
    db.overrides['aiVisibilityRun.findUnique'] = async () => ({ id: 'run-x', projectId: 'p2' });
    db.overrides['project.findUnique'] = async () => ({ id: 'p2', clientId: 'c1', name: 'Oasis', dataforseoDomain: 'oasispoolspas.com', client: { agencyName: 'Oasis Pool and Spa', websiteUrl: null } });
    const probe = vi.fn(async ({ query }) => ({ text: query.includes('Waukesha') ? '1. Oasis Pool and Spa - oasispoolspas.com\n2. Rival - rival.com' : 'No idea', model: 'm', usage: { prompt_tokens: 10, completion_tokens: 20 }, costUsd: 0.001 }));
    const out = await runAiVisibilityMonthlyJob({ env: { AI_VISIBILITY_MONTHLY_ENABLED: 'true', AI_VISIBILITY_MAX_PROJECTS_PER_RUN: '1', AI_VISIBILITY_MAX_PROMPTS: '3' }, probe, now });
    expect(out).toMatchObject({ projects: 3, skipped: 1, ran: 1, stopped: 'CAP' });
    const created = db.calls.filter((c) => c.key === 'aiVisibilityRun.create').map((c) => c.args.data);
    expect(created[0]).toMatchObject({ source: 'scheduled', period: '2026-11', isDemo: false });
    // 3 prompts (cap) × 4 platforms (default OpenRouter map), one attempt each, cost asked for.
    expect(probe).toHaveBeenCalledTimes(12);
    expect(probe.mock.calls[0][0]).toMatchObject({ maxAttempts: 1, includeCost: true });
    const rows = db.calls.find((c) => c.key === 'aiVisibilityResult.createMany').args.data;
    expect(rows[0]).toMatchObject({ promptId: 'p1', town: 'Waukesha', service: 'Closing', branded: false, cited: true, mentionPosition: 1, costUsd: 0.001 });
    expect(rows.find((r) => r.promptId === 'p2')).toMatchObject({ cited: false, mentionPosition: null });
    const fin = db.calls.filter((c) => c.key === 'aiVisibilityRun.update').pop().args.data;
    expect(fin).toMatchObject({ status: 'completed', costUsd: 0.012 });
    expect(db.calls.filter((c) => c.key === 'aiUsageLog.create')).toHaveLength(12);
    expect(db.calls.find((c) => c.key === 'aiUsageLog.create').args.data).toMatchObject({ feature: 'ai_visibility_monthly', tokensIn: 10, tokensOut: 20, success: true });
    // The paid DataForSEO LLM-mentions snapshot is not called on scheduled runs.
    expect(db.calls.find((c) => c.key === 'aiVisibilityDfsSnapshot.upsert').args.create.payload).toMatchObject({ skipped: true });
  });

  it('a site without prompts fails the run without any probe', async () => {
    site.prompts = { ok: true, prompts: [] };
    const probe = vi.fn();
    const r = await runScheduledAiVisibility(PROJECT, { now, probe });
    expect(r).toMatchObject({ status: 'failed', reason: 'NO_PROMPTS' });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('views', () => {
  const run = (period, cells) => ({ id: `r-${period}`, period, finishedAt: new Date(`${period}-02T06:00:00Z`), costUsd: 0.01, results: cells });
  const cell = (promptId, platform, cited, extra = {}) => ({ promptId, query: `Q ${promptId}`, town: 'Waukesha', service: 'Pool closing', branded: false, platform, cited, citationType: cited ? 'brand' : 'none', mentionPosition: cited ? 2 : null, competitorsJson: ['rival.com'], costUsd: 0.0005, ...extra });

  it('promptOutcomes: a prompt is mentioned when any platform cites it; error-only prompts are left out', () => {
    const out = promptOutcomes([cell('p1', 'chatgpt', false), cell('p1', 'gemini', true), cell('p2', 'chatgpt', false, { citationType: 'error' })]);
    expect(out.map((p) => [p.promptId, p.mentioned])).toEqual([['p1', true]]);
  });

  it('client tile: "Mentioned in X of Y questions…", trend; only scheduled, non-demo runs; no vendor, platform, cost or ids', async () => {
    db.overrides['aiVisibilityRun.findMany'] = async () => [
      run('2026-11', [cell('p1', 'chatgpt', true), cell('p2', 'chatgpt', false), cell('p3', 'chatgpt', true), cell('p9', 'chatgpt', true, { branded: true })]),
      run('2026-10', [cell('p1', 'chatgpt', false), cell('p2', 'chatgpt', false), cell('p3', 'chatgpt', true)]),
    ];
    const out = await clientAiAnswersView({ id: 'p1' });
    expect(out).toEqual({
      available: true,
      mentioned: 2,
      total: 3,
      label: 'Mentioned in 2 of 3 questions people ask AI about pool closing in Waukesha',
      trend: [{ month: '2026-10', mentioned: 1, total: 3 }, { month: '2026-11', mentioned: 2, total: 3 }],
      updatedAt: '2026-11-02',
    });
    const where = db.calls.find((c) => c.key === 'aiVisibilityRun.findMany').args.where;
    expect(where).toMatchObject({ isDemo: false, source: 'scheduled', status: 'completed' });
    const json = JSON.stringify(out).toLowerCase();
    for (const bad of ['chatgpt', 'openrouter', 'dataforseo', 'cost', 'rival.com', 'p1']) expect(json).not.toContain(bad);
  });

  it('staff view: per prompt and platform with cited, position, competitors, cost and last run’s outcome', async () => {
    db.overrides['aiVisibilityRun.findMany'] = async () => [run('2026-11', [cell('p1', 'chatgpt', true), cell('p1', 'gemini', false)]), run('2026-10', [cell('p1', 'chatgpt', false)])];
    const v = await staffAiPromptsView({ ...PROJECT }, { env: {} });
    expect(v.flags).toEqual({ monthlyEnabled: false, maxPrompts: 25 });
    expect(v.prompts[0]).toMatchObject({ promptId: 'p1', mentioned: true, mentionedLastRun: false });
    expect(v.prompts[0].platforms[0]).toEqual({ platform: 'chatgpt', cited: true, mentionPosition: 2, competitors: ['rival.com'], costUsd: 0.0005 });
  });
});
