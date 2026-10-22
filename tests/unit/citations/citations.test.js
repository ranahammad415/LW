/**
 * Contract 1.8.0 §39 on the OS side: fixtures and shapes, the citation mirror by rev (+ gap pull), seo-citations-upsert
 * (allowed fields, FIELD_OWNED_BY_SITE, 409 CONFLICT_REV for system and human writes), citationSummary, the canonical
 * NAP and the client allow-list. Prisma is an in-memory stand-in checked with the prismaShape helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mem = vi.hoisted(() => ({ mirror: new Map(), state: new Map(), calls: [], project: null }));
const site = vi.hoisted(() => ({ list: null, upsert: null, calls: [] }));

vi.mock('../../../src/lib/prisma.js', async () => {
  const { assertPrismaArgs } = await import('../../helpers/prismaShape.js');
  const { Prisma } = await import('@prisma/client');
  const clean = (d) => Object.fromEntries(Object.entries(d || {}).map(([k, v]) => [k, v === Prisma.DbNull ? null : v]));
  const key = (projectId, id) => `${projectId}|${id}`;
  const wrap = (name, impl) =>
    new Proxy(impl, {
      get(t, method) {
        return async (args) => {
          mem.calls.push({ key: `${name}.${String(method)}`, args });
          assertPrismaArgs(name, method, args);
          if (!t[method]) return method === 'findMany' ? [] : null;
          return t[method](args);
        };
      },
    });
  const mirror = {
    findUnique: ({ where }) => mem.mirror.get(key(where.projectId_siteCitationId.projectId, where.projectId_siteCitationId.siteCitationId)) || null,
    findMany: ({ where }) => [...mem.mirror.values()].filter((r) => r.projectId === where.projectId),
    upsert: ({ where, create, update }) => {
      const k = key(where.projectId_siteCitationId.projectId, where.projectId_siteCitationId.siteCitationId);
      const prev = mem.mirror.get(k);
      const row = prev ? { ...prev, ...clean(update) } : { lastOsCheckAt: null, ...clean(create) };
      mem.mirror.set(k, row);
      return row;
    },
    updateMany: ({ where, data }) => {
      let count = 0;
      for (const [k, r] of mem.mirror) {
        if (r.projectId !== where.projectId) continue;
        if (where.siteCitationId && typeof where.siteCitationId === 'string' && r.siteCitationId !== where.siteCitationId) continue;
        if (where.siteCitationId?.in && !where.siteCitationId.in.includes(r.siteCitationId)) continue;
        mem.mirror.set(k, { ...r, ...clean(data) });
        count++;
      }
      return { count };
    },
    deleteMany: ({ where }) => {
      let count = 0;
      for (const [k, r] of mem.mirror) {
        if (r.projectId === where.projectId && !where.siteCitationId.notIn.includes(r.siteCitationId)) {
          mem.mirror.delete(k);
          count++;
        }
      }
      return { count };
    },
  };
  const state = {
    findUnique: ({ where }) => mem.state.get(where.projectId) || null,
    upsert: ({ where, create, update }) => {
      const prev = mem.state.get(where.projectId);
      const row = prev ? { ...prev, ...clean(update) } : clean(create);
      mem.state.set(where.projectId, row);
      return row;
    },
    updateMany: ({ where, data }) => {
      const prev = mem.state.get(where.projectId);
      if (!prev || (where.rev !== undefined && prev.rev !== where.rev)) return { count: 0 };
      mem.state.set(where.projectId, { ...prev, ...clean(data) });
      return { count: 1 };
    },
  };
  return {
    prisma: new Proxy(
      { seoCitationMirror: wrap('seoCitationMirror', mirror), seoCitationState: wrap('seoCitationState', state), project: wrap('project', { findUnique: () => mem.project }) },
      { get: (t, n) => t[n] || wrap(String(n), {}) }
    ),
  };
});

vi.mock('../../../src/lib/cmsStore.js', () => ({ loadEmdashConnection: async () => ({ conn: { fake: true } }) }));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    emdashRoutes: {
      ...real.emdashRoutes,
      seoCitationsList: async () => {
        site.calls.push(['list']);
        return structuredClone(site.list);
      },
      seoCitationsUpsert: async (conn, body, opts) => {
        site.calls.push(['upsert', body, opts]);
        return site.upsert(body, opts);
      },
    },
  };
});

import {
  sanitizeCitation,
  sanitizeCitationList,
  validateCitationEvent,
  replaceMirror,
  pullCitationsIfCapable,
  DAILY_CITATIONS_FRESH_MS,
  applyCitationChanged,
  upsertCitations,
  staffUpsertCitation,
  buildUpsertItem,
  citationSummary,
  summarizeCitations,
  canonicalNapFor,
  sanitizeCanonicalNap,
  clientListingsView,
  listingSentences,
  SYSTEM_ACTOR,
  SEO_CITATION_OS_FIELDS,
  SEO_CITATION_SITE_FIELDS,
} from '../../../src/lib/citations/citations.js';
import { CmsBridgeError, MUTATION_ROUTES, emdashRoutes as realRoutes } from '../../../src/lib/siteAdapters/emdash.js';
import { CONTRACT_REVISION } from '../../../src/lib/siteAdapters/signing.js';
import { validateEvent } from '../../../src/routes/webhooks/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const sch = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/schemas', `${n}.json`), 'utf8'));
const P = { id: 'p1', cmsType: 'EMDASH', cmsCapabilities: { seoCitations: true } };
const conflict = (rev, items) => new CmsBridgeError({ status: 409, code: 'CONFLICT_REV', message: 'rev', details: { currentRev: rev, items } });

beforeEach(() => {
  mem.mirror = new Map();
  mem.state = new Map();
  mem.calls = [];
  mem.project = null;
  site.calls = [];
  site.list = ex('seo-citations-list.response');
  site.upsert = () => ex('seo-citations-upsert.response');
});

describe('contract 1.8.0 fixtures and shapes', () => {
  it('claims 1.8.0; upsert is a mutation (idempotency key), the two reads are not; three route helpers exist', () => {
    expect(CONTRACT_REVISION).toBe('1.8.0');
    expect(MUTATION_ROUTES.has('seo-citations-upsert')).toBe(true);
    expect(MUTATION_ROUTES.has('seo-citations-list')).toBe(false);
    expect(MUTATION_ROUTES.has('seo-ai-prompts')).toBe(false);
    for (const k of ['seoCitationsList', 'seoCitationsUpsert', 'seoAiPrompts']) expect(typeof realRoutes[k]).toBe('function');
  });
  it('the 10 new examples are present; site-info advertises seoCitations / seoAiPrompts', () => {
    for (const n of ['seo-citations-list.request', 'seo-citations-list.response', 'seo-citations-upsert.request', 'seo-citations-upsert.request--pm', 'seo-citations-upsert.response', 'seo-ai-prompts.request', 'seo-ai-prompts.response', 'events.request--seo-citation-changed', 'error.response--seo-citations-conflict', 'site-info.response--seo-citations']) {
      expect(ex(n)).toBeTruthy();
    }
    const info = ex('site-info.response--seo-citations');
    expect(info.capabilities).toMatchObject({ seoCitations: true, seoAiPrompts: true });
    expect(info.contractRevision).toBe('1.8.0');
  });
  it('OS / site field lists match the schema: OS fields are upsert item properties, site fields never OS fields', () => {
    const common = sch('common');
    const itemProps = Object.keys(common.$defs.seoCitationUpsertItem.properties);
    for (const f of SEO_CITATION_OS_FIELDS) expect(itemProps).toContain(f);
    for (const f of SEO_CITATION_SITE_FIELDS) expect(SEO_CITATION_OS_FIELDS).not.toContain(f);
    expect(Object.keys(common.$defs.seoCitation.properties).sort()).toEqual(Object.keys(ex('seo-citations-list.response').items[0]).sort());
  });
  it('sanitizes every example listing unchanged in meaning; rejects bad ids, kinds and statuses', () => {
    const list = sanitizeCitationList(ex('seo-citations-list.response'));
    expect(list.rev).toBe(1);
    expect(list.items.map((c) => c.id)).toEqual(['business.google.com', 'yelp.com', 'facebook.com', 'bbb.org']);
    expect(list.items[1]).toMatchObject({ nap_status: 'wrong', phone_seen: '262-667-6421', checked_by: 'human' });
    const item = ex('seo-citations-list.response').items[0];
    expect(sanitizeCitation({ ...item, id: 'Yelp.com' })).toBeNull();
    expect(sanitizeCitation({ ...item, kind: 'store' })).toBeNull();
    expect(sanitizeCitation({ ...item, nap_status: 'ok' })).toBeNull();
    expect(sanitizeCitation({ ...item, url: 'javascript:alert(1)' }).url).toBeNull();
  });
  it('the webhook validator accepts the seo.citation_changed example and refuses bad data, snapshotText and lead', () => {
    const e = ex('events.request--seo-citation-changed').events[0];
    expect(validateEvent(e)).toBeNull();
    expect(validateCitationEvent({ ...e, data: { ...e.data, changes: [] } })).toMatch(/change/);
    expect(validateCitationEvent({ ...e, data: { ...e.data, source: 'import' } })).toMatch(/source/);
    expect(validateEvent({ ...e, snapshotText: 'x' })).toMatch(/snapshotText/);
    expect(validateEvent({ ...e, lead: {} })).toMatch(/lead/);
    const { data: _d, ...noData } = e;
    expect(validateEvent(noData)).toMatch(/data/);
  });
  it('a system upsert body has the request shape of the example (baseRev, 1–50 items, actor kind system with a uuid)', async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
    await upsertCitations('p1', [buildUpsertItem({ id: 'yelp.com', listed: true, nap_status: 'wrong', zip_seen: '53187', last_checked: '2026-11-01T06:00:00Z' })], SYSTEM_ACTOR);
    const [, body, opts] = site.calls.find((c) => c[0] === 'upsert');
    const req = ex('seo-citations-upsert.request');
    expect(Object.keys(body).sort()).toEqual(Object.keys(req).sort());
    expect(body.baseRev).toBe(1);
    expect(body.actor).toMatchObject({ kind: 'system', name: 'Agency OS listing monitor' });
    expect(body.actor.osUserId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(opts.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    expect(opts.retryDelays).toEqual([]);
  });
});

describe('mirror by rev', () => {
  const ev = (rev, citation, extra = {}) => {
    const base = ex('events.request--seo-citation-changed').events[0];
    return { ...base, data: { ...base.data, rev, citation: { ...base.data.citation, ...citation }, ...extra } };
  };

  it('replaceMirror stores the list and rev; rows the site dropped are deleted', async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
    expect(mem.mirror.size).toBe(4);
    expect(mem.state.get('p1')).toMatchObject({ rev: 1, stale: false });
    await replaceMirror('p1', { rev: 2, items: sanitizeCitationList(ex('seo-citations-list.response')).items.slice(0, 2) });
    expect([...mem.mirror.values()].map((r) => r.siteCitationId).sort()).toEqual(['business.google.com', 'yelp.com']);
  });

  it('rev + 1 applies and advances; the same rev (another listing of one request) applies; older is stale', async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
    const pull = vi.fn();
    expect(await applyCitationChanged(P, ev(2, { id: 'yelp.com', hours_seen: 'Mon 8–6' }), { schedulePull: pull })).toBe('applied');
    expect(mem.state.get('p1').rev).toBe(2);
    expect(mem.mirror.get('p1|yelp.com')).toMatchObject({ hoursSeen: 'Mon 8–6', checkedBy: 'os', rev: 2 });
    expect(await applyCitationChanged(P, ev(2, { id: 'facebook.com', name: 'Facebook', kind: 'social', nap_status: 'correct' }), { schedulePull: pull })).toBe('applied');
    expect(mem.mirror.get('p1|facebook.com').napStatus).toBe('correct');
    expect(await applyCitationChanged(P, ev(1, { id: 'yelp.com', hours_seen: 'old' }), { schedulePull: pull })).toBe('stale');
    expect(mem.mirror.get('p1|yelp.com').hoursSeen).toBe('Mon 8–6');
    expect(pull).not.toHaveBeenCalled();
  });

  it('a skipped rev (an admin edit we did not see) marks the mirror stale and pulls the list; no state yet → pull', async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
    const pull = vi.fn();
    await applyCitationChanged(P, ev(4, { id: 'yelp.com' }), { schedulePull: pull });
    expect(pull).toHaveBeenCalledWith('p1', undefined);
    expect(mem.state.get('p1')).toMatchObject({ stale: true, rev: 1 });
    mem.state = new Map();
    const pull2 = vi.fn();
    await applyCitationChanged({ id: 'p2' }, ev(1, { id: 'yelp.com' }), { schedulePull: pull2 });
    expect(pull2).toHaveBeenCalledTimes(1);
  });
});

describe('daily pull (O-C180-5)', () => {
  const now = new Date('2026-10-24T03:00:00Z');
  const daily = () => pullCitationsIfCapable('p1', { skipIfFreshMs: DAILY_CITATIONS_FRESH_MS, now });
  const ago = (h) => new Date(now.getTime() - h * 3600e3);

  it('re-pulls a rev-0 mirror stored at pairing even when it is fresh', async () => {
    mem.project = { ...P };
    mem.state.set('p1', { projectId: 'p1', rev: 0, stale: false, fetchedAt: ago(1) });
    const out = await daily();
    expect(site.calls).toEqual([['list']]);
    expect(out.rev).toBe(site.list.rev);
    expect(mem.state.get('p1').rev).toBe(site.list.rev);
  });

  it('skips a mirror fetched < 20 h ago with rev > 0; pulls once it is older or never fetched', async () => {
    mem.project = { ...P };
    mem.state.set('p1', { projectId: 'p1', rev: 3, stale: false, fetchedAt: ago(19) });
    expect(await daily()).toEqual({ skipped: 'FRESH' });
    expect(site.calls).toEqual([]);
    mem.state.set('p1', { projectId: 'p1', rev: 3, stale: false, fetchedAt: ago(21) });
    await daily();
    expect(site.calls).toEqual([['list']]);
    mem.state.clear();
    await daily();
    expect(site.calls).toHaveLength(2);
  });

  it('no capability → no call; without skipIfFreshMs (pairing) a fresh mirror is pulled', async () => {
    mem.project = { ...P, cmsCapabilities: {} };
    expect(await daily()).toEqual({ skipped: 'NO_CAPABILITY' });
    expect(site.calls).toEqual([]);
    mem.project = { ...P };
    mem.state.set('p1', { projectId: 'p1', rev: 3, stale: false, fetchedAt: ago(1) });
    await pullCitationsIfCapable('p1');
    expect(site.calls).toEqual([['list']]);
  });
});

describe('seo-citations-upsert', () => {
  beforeEach(async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
  });

  it('buildUpsertItem keeps OS fields only; name / url / kind only when creating; bad values are refused', () => {
    expect(buildUpsertItem({ id: 'yelp.com', nap_status: 'wrong', note: 'x', utm: 'y', rank: 2, name: 'Yelp!' })).toEqual({ id: 'yelp.com', nap_status: 'wrong' });
    expect(buildUpsertItem({ name: 'Porch', url: 'https://www.porch.com/x', kind: 'directory', listed: true }, { create: true })).toEqual({ name: 'Porch', url: 'https://www.porch.com/x', kind: 'directory', listed: true });
    expect(() => buildUpsertItem({ id: 'yelp.com', nap_status: 'fine' })).toThrow(/NAP/);
    expect(() => buildUpsertItem({ id: 'yelp.com' })).toThrow(/Nothing/);
    expect(() => buildUpsertItem({ listed: true }, { create: true })).toThrow(/name/);
    expect(() => buildUpsertItem({ id: 'Yelp.com', listed: true })).toThrow(/id/);
  });

  it('FIELD_OWNED_BY_SITE warnings are returned; applied rows are patched in the mirror (rev + 1, checked by os)', async () => {
    const items = [
      { id: 'yelp.com', listed: true, nap_status: 'wrong', hours_seen: 'Mon–Fri 8:00–18:00', last_checked: '2026-11-01T06:00:00Z' },
      { id: 'facebook.com', listed: true, nap_status: 'correct', last_checked: '2026-11-01T06:00:00Z' },
    ];
    const out = await upsertCitations('p1', items, SYSTEM_ACTOR);
    expect(out.warnings).toEqual([{ code: 'FIELD_OWNED_BY_SITE', message: 'Ignored site-owned fields: note' }]);
    expect(out.rev).toBe(2);
    expect(mem.state.get('p1').rev).toBe(2);
    expect(mem.mirror.get('p1|facebook.com')).toMatchObject({ napStatus: 'correct', checkedBy: 'os', rev: 2 });
  });

  it('409 CONFLICT_REV on a system write: the mirror is replaced from details.items and the call retried ONCE with the new rev', async () => {
    const fresh = ex('error.response--seo-citations-conflict').error.details;
    let n = 0;
    site.upsert = (body) => {
      n += 1;
      if (n === 1) throw conflict(fresh.currentRev, fresh.items);
      return { ok: true, rev: body.baseRev + 1, applied: [{ id: 'bbb.org', created: false, fields: ['nap_status'] }], rejected: [], warnings: [] };
    };
    const out = await upsertCitations('p1', [{ id: 'bbb.org', nap_status: 'missing' }], SYSTEM_ACTOR);
    const bodies = site.calls.filter((c) => c[0] === 'upsert');
    expect(bodies.map((c) => c[1].baseRev)).toEqual([1, 2]);
    expect(bodies[0][2].idempotencyKey).not.toBe(bodies[1][2].idempotencyKey);
    expect(out.retried).toBe(true);
    expect([...mem.mirror.keys()].sort()).toEqual(['p1|angi.com', 'p1|bbb.org']);

    // A second conflict after the retry is surfaced, never a third call.
    site.calls = [];
    site.upsert = () => {
      throw conflict(9, fresh.items);
    };
    await expect(upsertCitations('p1', [{ id: 'bbb.org', nap_status: 'missing' }], SYSTEM_ACTOR)).rejects.toMatchObject({ code: 'CONFLICT_REV' });
    expect(site.calls.filter((c) => c[0] === 'upsert')).toHaveLength(2);
  });

  it('409 on a human write: mirror replaced, no retry, the person is asked (details.currentRev)', async () => {
    const fresh = ex('error.response--seo-citations-conflict').error.details;
    site.upsert = () => {
      throw conflict(fresh.currentRev, fresh.items);
    };
    const user = { id: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM', role: 'PM' };
    const err = await staffUpsertCitation('p1', user, { baseRev: 1, item: { id: 'bbb.org', listed: true } }).catch((e) => e);
    expect(err.code).toBe('CONFLICT_REV');
    expect(err.details).toEqual({ currentRev: 2 });
    expect(site.calls.filter((c) => c[0] === 'upsert')).toHaveLength(1);
    expect(site.calls[0][1].actor).toEqual({ kind: 'human', osUserId: user.id, name: 'Jane PM', role: 'PM' });
    expect(mem.state.get('p1').rev).toBe(2);
  });

  it('a stale baseRev from the UI is refused before any site call', async () => {
    const err = await staffUpsertCitation('p1', { id: 'u', role: 'PM' }, { baseRev: 0, item: { id: 'bbb.org', listed: true } }).catch((e) => e);
    expect(err.code).toBe('CONFLICT_REV');
    expect(site.calls).toEqual([]);
  });

  it('an agent account is presented as kind agent (the site answers 403 HUMAN_ONLY; the routes refuse it first)', async () => {
    site.upsert = () => {
      throw new CmsBridgeError({ status: 403, code: 'HUMAN_ONLY', message: 'agents' });
    };
    const err = await staffUpsertCitation('p1', { id: 'a', role: 'PM', isAgent: true }, { item: { id: 'bbb.org', listed: true } }).catch((e) => e);
    expect(err.code).toBe('HUMAN_ONLY');
    expect(site.calls[0][1].actor.kind).toBe('agent');
  });
});

describe('summary, canonical NAP and client view', () => {
  it('citationSummary: consistency = correct / (correct + wrong); missing / unknown reported, not scored', async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
    expect(await citationSummary('p1')).toEqual({ total: 4, correct: 0, wrong: 2, missing: 1, unknown: 1, consistencyPct: 0 });
    expect(summarizeCitations([{ napStatus: 'correct' }, { napStatus: 'correct' }, { napStatus: 'wrong' }, { napStatus: 'unknown' }])).toMatchObject({ consistencyPct: 67 });
    expect(summarizeCitations([])).toEqual({ total: 0, correct: 0, wrong: 0, missing: 0, unknown: 0, consistencyPct: null });
  });

  it('canonical NAP: the staff override wins, else the Business Profile identity (ZIP from the address)', () => {
    const project = { name: 'Oasis', gmbLocationName: 'Oasis Pool and Spa', gmbPhone: '262-667-6421', gmbAddress: '1 Main St, Waukesha, WI 53186', gmbWebsite: 'https://oasispoolspas.com' };
    expect(canonicalNapFor(project, null)).toMatchObject({ name: 'Oasis Pool and Spa', phone: '262-667-6421', zip: '53186', source: 'gbp' });
    const override = { canonicalNap: { name: 'Oasis Pool & Spa', phone: '262-555-0100', address: null, zip: '53189', city: 'Waukesha', hours: null, website: null }, canonicalNapAt: new Date() };
    expect(canonicalNapFor(project, override)).toMatchObject({ name: 'Oasis Pool & Spa', zip: '53189', source: 'override' });
    expect(() => sanitizeCanonicalNap({ name: '' })).toThrow(/name/);
    expect(() => sanitizeCanonicalNap({ name: 'X', phone: '555' })).toThrow(/phone/);
    expect(sanitizeCanonicalNap({ name: 'X', phone: '262-667-6421' })).toMatchObject({ name: 'X', phone: '262-667-6421', zip: null });
  });

  it('client tile: X of Y correct and plain sentences; no vendor, cost, ids, URLs, notes or who checked', async () => {
    await replaceMirror('p1', sanitizeCitationList(ex('seo-citations-list.response')));
    mem.mirror.set('p1|yelp.com', { ...mem.mirror.get('p1|yelp.com'), checks: { name: false, phone: false, zip: false, hours: null, areas: null, site_link: true } });
    const out = await clientListingsView({ id: 'p1' });
    expect(out).toMatchObject({ available: true, correct: 0, checked: 2, total: 4, missing: 1 });
    expect(out.items.map((i) => i.text)).toEqual(expect.arrayContaining([
      'You are not listed on Google Business Profile yet',
      'Yelp shows an old or different phone number',
      'Yelp shows a different business name',
      'Facebook shows details that do not match your business',
    ]));
    const json = JSON.stringify(out).toLowerCase();
    for (const bad of ['dataforseo', 'cost', 'yelp.com', 'note', 'checkedby', 'http', 'rev', 'status in the plan']) expect(json).not.toContain(bad);
    const sel = mem.calls.find((c) => c.key === 'seoCitationMirror.findMany' && c.args.select).args.select;
    expect(Object.keys(sel).sort()).toEqual(['checks', 'lastChecked', 'name', 'napStatus', 'rank']);
    expect(listingSentences({ name: 'BBB', napStatus: 'unknown' })).toEqual([]);
  });
});
