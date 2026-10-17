/**
 * Contract v1.4.0 §25: profile mirror, proposals from the OS (no decisions, D13), drift rows for OS-owned fields
 * (no silent overwrite, D14), the five seo.* events, and the "503 after a site restart never flags re-pair" rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
const site = vi.hoisted(() => ({ handler: null, bodies: [], routes: [] }));

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          if (method === 'findMany') return [];
          if (method === 'count') return 0;
          if (method === 'updateMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'row-1', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: vi.fn(async () => {}), reconcileProjectMapsSafe: vi.fn() }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn() }));
vi.mock('../../../src/lib/cmsStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadEmdashConnection: async () => ({ conn: { siteId: 'site_9f3c2a7b41d0', siteUrl: 'https://s.example' } }),
}));
vi.mock('../../../src/lib/siteAdapters/emdash.js', async (importOriginal) => {
  const orig = await importOriginal();
  const call = (route) => async (_c, body) => {
    site.routes.push(route);
    site.bodies.push(body);
    return site.handler(route, body);
  };
  return {
    ...orig,
    emdashRoutes: {
      ...orig.emdashRoutes,
      profilesList: call('profiles-list'),
      profileGet: call('profile-get'),
      keywordRegistry: call('keyword-registry'),
      briefGet: call('brief-get'),
      proposalCreate: call('proposal-create'),
    },
  };
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applySeoEvent, createProposal, listProfiles, profileErrorMessage } from '../../../src/lib/cmsSeoProfiles.js';
import { validateProposal, fieldOwner, osOwnedChanges, profileSummaryToRow, PROFILE_FIELD_OWNERSHIP } from '../../../src/lib/siteAdapters/profiles.js';
import { validateEvent, processEventBatch } from '../../../src/routes/webhooks/emdash.js';
import { handleSiteRejection } from '../../../src/lib/emdashSync.js';
import { CmsBridgeError, MUTATION_ROUTES } from '../../../src/lib/siteAdapters/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const calls = (key) => db.calls.filter((c) => c.key === key);
const seo = () => ex('events.request--seo').events;
const PROJECT = { id: 'p1', clientId: 'c1', leadPmId: 'pm-1', cmsType: 'EMDASH', cmsCapabilities: { seoProfiles: true }, cmsRepairNeededAt: null };

beforeEach(() => {
  db.calls = [];
  db.overrides = { 'project.findUnique': async () => PROJECT };
  site.bodies = [];
  site.routes = [];
  site.handler = null;
});

describe('pure helpers', () => {
  it('field ownership: most specific wins', () => {
    expect(fieldOwner('targeting.secondary_keywords')).toBe('os');
    expect(fieldOwner('contract.version')).toBe('site');
    expect(fieldOwner('contract.meta')).toBe('os-until-locked');
    expect(fieldOwner('lifecycle.status')).toBe('site');
    expect(fieldOwner('unknown.thing')).toBe('site');
    expect(PROFILE_FIELD_OWNERSHIP.brief).toBe('os');
    expect(osOwnedChanges([{ field: 'targeting.secondary_keywords', owner: 'os' }, { field: 'lifecycle.status', owner: 'site' }])).toEqual([{ field: 'targeting.secondary_keywords', owner: 'os' }]);
  });

  it('proposal validation: 1–20 add/remove/replace ops on contract/targeting/aeo/facts; reason 20–2000', () => {
    const ok = { pageId: 'P12', patch: [{ op: 'replace', path: '/contract/meta', value: 'x' }], reason: 'Client wants same-week visits in the meta' };
    expect(validateProposal(ok).ok).toBe(true);
    expect(validateProposal({ ...ok, reason: 'short' }).errors[0].path).toBe('$.reason');
    expect(validateProposal({ ...ok, patch: [{ op: 'replace', path: '/lifecycle/status', value: 'x' }] }).errors[0].path).toBe('$.patch[0].path');
    expect(validateProposal({ ...ok, patch: [{ op: 'move', path: '/contract/meta', from: '/x' }] }).errors[0].path).toBe('$.patch[0].op');
    expect(validateProposal({ ...ok, patch: [] }).ok).toBe(false);
    expect(validateProposal({ ...ok, patch: Array(21).fill(ok.patch[0]) }).ok).toBe(false);
    expect(validateProposal({ ...ok, pageId: '../x' }).ok).toBe(false);
    expect(['proposal-create', 'profile-upsert', 'brief-upsert'].every((r) => MUTATION_ROUTES.has(r))).toBe(true);
  });
});

describe('seo.* events (§25.4)', () => {
  it('validateEvent requires the object of each type; no seq needed', () => {
    for (const ev of seo()) expect(validateEvent(ev), ev.type).toBeNull();
    expect(validateEvent({ ...seo()[0], profile: undefined })).toMatch(/profile.page_id/);
    expect(validateEvent({ ...seo()[2], proposal: {} })).toMatch(/proposal_id/);
    expect(validateEvent({ ...seo()[4], check: null })).toMatch(/check.page_id/);
  });

  it('profile_changed with an OS-owned field: mirror + a PROFILE_CHANGED drift row on the matching node (no overwrite)', async () => {
    db.overrides['wpPage.findMany'] = async () => [{ id: 'wp1' }];
    db.overrides['contentMapNode.findMany'] = async () => [{ id: 'n1', mapId: 'm1', wpPageId: 'wp1' }];
    const ev = seo()[1];
    expect(await applySeoEvent('p1', ev)).toBe('applied');
    expect(calls('cmsSeoProfile.create')[0].args.data).toMatchObject({ projectId: 'p1', pageId: 'P12', primaryKeyword: 'hot tub repair', profileHash: ev.profile.profile_hash });
    const drift = calls('contentMapDrift.create')[0].args.data;
    expect(drift).toMatchObject({ mapId: 'm1', nodeId: 'n1', driftType: 'PROFILE_CHANGED', payload: { pageId: 'P12', fields: ['targeting.secondary_keywords'], changedBy: 'Site editor' } });
    expect(calls('contentMapNode.updateMany')[0].args.data).toEqual({ cmsPageId: 'P12' });
    // The OS never writes the node's planning fields from the site here.
    expect(calls('contentMapNode.update')).toHaveLength(0);
  });

  it('a second change merges into the pending drift; older events are stale', async () => {
    db.overrides['wpPage.findMany'] = async () => [{ id: 'wp1' }];
    db.overrides['contentMapNode.findMany'] = async () => [{ id: 'n1', mapId: 'm1', wpPageId: 'wp1' }];
    db.overrides['contentMapDrift.findFirst'] = async () => ({ id: 'd1', payload: { pageId: 'P12', fields: ['aeo.answers'] } });
    await applySeoEvent('p1', seo()[1]);
    expect(calls('contentMapDrift.create')).toHaveLength(0);
    expect(calls('contentMapDrift.update')[0].args.data.payload.fields).toEqual(['aeo.answers', 'targeting.secondary_keywords']);
    db.calls = [];
    db.overrides['cmsSeoProfile.findUnique'] = async () => ({ id: 'pr1', siteUpdatedAt: new Date('2026-12-01T00:00:00Z') });
    expect(await applySeoEvent('p1', seo()[1])).toBe('stale');
    expect(calls('contentMapDrift.create')).toHaveLength(0);
  });

  it('e2e O15: lifecycle.* moved by a publish raises no drift; other OS-owned changes in the same event still do', async () => {
    db.overrides['wpPage.findMany'] = async () => [{ id: 'wp1' }];
    db.overrides['contentMapNode.findMany'] = async () => [{ id: 'n1', mapId: 'm1', wpPageId: 'wp1' }];
    const life = { ...seo()[1], changed: [{ field: 'lifecycle.next_review_on', owner: 'os' }] };
    db.overrides['wpContentReview.count'] = async () => 1; // the entry was published around the event
    await applySeoEvent('p1', life);
    expect(calls('contentMapDrift.create')).toHaveLength(0);
    const where = calls('wpContentReview.count')[0].args.where;
    expect(where).toMatchObject({ projectId: 'p1', cmsEntryId: life.profile.entry_id });
    // no publish nearby, edited by a person → still drift
    db.overrides['wpContentReview.count'] = async () => 0;
    await applySeoEvent('p1', life);
    expect(calls('contentMapDrift.create')).toHaveLength(1);
    // the plugin itself (not a person) moving lifecycle → no drift
    db.calls = [];
    await applySeoEvent('p1', { ...life, actor: { kind: 'plugin', source: 'plugin' } });
    expect(calls('contentMapDrift.create')).toHaveLength(0);
    // mixed: the lifecycle part is dropped, the targeting change still drifts
    db.overrides['wpContentReview.count'] = async () => 1;
    await applySeoEvent('p1', { ...life, changed: [{ field: 'lifecycle.next_review_on', owner: 'os' }, { field: 'targeting.secondary_keywords', owner: 'os' }] });
    expect(calls('contentMapDrift.create').at(-1).args.data.payload.fields).toEqual(['targeting.secondary_keywords']);
  });

  it('site-owned changes and contract locks only update the mirror', async () => {
    const ev = { ...seo()[1], changed: [{ field: 'lifecycle.status', owner: 'site' }] };
    await applySeoEvent('p1', ev);
    expect(calls('contentMapDrift.create')).toHaveLength(0);
    await applySeoEvent('p1', seo()[0]);
    expect(calls('cmsSeoProfile.create').at(-1).args.data.contract).toMatchObject({ locked: true, version: 3, locked_by: 'Site editor' });
  });

  it('proposals: opened then decided (forward only); check_failed stored on the profile', async () => {
    expect(await applySeoEvent('p1', seo()[2])).toBe('applied');
    expect(calls('cmsSeoProposal.create')[0].args.data).toMatchObject({ proposalId: '01JAH0PROP00000000000000001', state: 'open', source: 'os', createdByName: 'Jane PM' });
    db.overrides['cmsSeoProposal.findUnique'] = async () => ({ id: 'x', state: 'approved' });
    expect(await applySeoEvent('p1', seo()[2])).toBe('stale');
    db.overrides['cmsSeoProposal.findUnique'] = async () => ({ id: 'x', state: 'open' });
    expect(await applySeoEvent('p1', seo()[3])).toBe('applied');
    expect(calls('cmsSeoProposal.update').at(-1).args.data).toMatchObject({ state: 'approved', decidedByName: 'Site editor', decisionNote: 'OK, contract v4' });
    expect(await applySeoEvent('p1', seo()[4])).toBe('applied');
    expect(calls('cmsSeoProfile.upsert')[0].args.update.lastCheck).toMatchObject({ variant: 'draft', trigger: 'save', summary: { block: 1, warn: 2 } });
    expect(await applySeoEvent('p1', { type: 'seo.redirect_proposed', actor: {} })).toBe('stored');
  });

  it('e2e O14: a decided proposal takes one off the mirrored open count (never below 0); opened / repeated do not', async () => {
    const dec = () => calls('cmsSeoProfile.updateMany').filter((c) => c.args.data?.openProposals?.decrement === 1);
    db.overrides['cmsSeoProposal.findUnique'] = async () => ({ id: 'x', state: 'open' });
    await applySeoEvent('p1', seo()[3]);
    expect(dec()).toHaveLength(1);
    expect(dec()[0].args.where).toMatchObject({ projectId: 'p1', openProposals: { gt: 0 } });
    db.overrides['cmsSeoProposal.findUnique'] = async () => ({ id: 'x', state: 'approved' });
    await applySeoEvent('p1', seo()[3]); // same decision again: no second decrement
    expect(dec()).toHaveLength(1);
    db.overrides['cmsSeoProposal.findUnique'] = async () => null;
    await applySeoEvent('p1', seo()[2]); // opened
    expect(dec()).toHaveLength(1);
  });

  it('processEventBatch routes seo.* to the store and accepts the batch', async () => {
    const outcomes = [];
    const store = {
      claimReceipt: async () => 'new',
      finalizeReceipt: async (_p, _id, o) => outcomes.push(o),
      releaseReceipt: async () => {},
      applySeoEvent: async (_p, ev) => (ev.type === 'seo.check_failed' ? 'applied' : 'stale'),
    };
    const r = await processEventBatch({ store, project: { id: 'p1', cmsSiteId: 'site_9f3c2a7b41d0' }, events: seo() });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(5);
    expect(outcomes).toEqual(['stale', 'stale', 'stale', 'stale', 'applied']);
  });
});

describe('reads and proposals from the OS', () => {
  it('profiles-list refreshes the mirror', async () => {
    site.handler = () => ex('profiles-list.response');
    const res = await listProfiles('p1');
    expect(res.items[0]).toMatchObject(profileSummaryToRow(ex('profiles-list.response').items[0]));
    expect(calls('cmsSeoProfile.create').length + calls('cmsSeoProfile.update').length).toBeGreaterThan(0);
  });

  it('proposal-create: human OWNER / lead PM only, validated before the call; never a decision', async () => {
    site.handler = () => ex('proposal-create.response');
    const patch = [{ op: 'replace', path: '/contract/meta', value: 'Same-week visits' }];
    const reason = 'Client wants same-week visits in the meta description';
    await expect(createProposal({ projectId: 'p1', pageId: 'P12', patch, reason, user: { id: 'tm', role: 'TEAM_MEMBER' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createProposal({ projectId: 'p1', pageId: 'P12', patch, reason, user: { id: 'other', role: 'PM' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createProposal({ projectId: 'p1', pageId: 'P12', patch, reason: 'short', user: { id: 'pm-1', role: 'PM' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(site.bodies).toHaveLength(0);
    const row = await createProposal({ projectId: 'p1', pageId: 'P12', patch, reason, user: { id: 'pm-1', role: 'PM', name: 'Jane PM' } });
    expect(site.routes).toEqual(['proposal-create']);
    expect(site.bodies[0]).toEqual({ page_id: 'P12', patch, reason, actor: { kind: 'human', osUserId: 'pm-1', name: 'Jane PM', role: 'PM' } });
    expect(row.state).toBe('open');
  });

  it('a site without seoProfiles answers NOT_IMPLEMENTED without any call', async () => {
    db.overrides['project.findUnique'] = async () => ({ ...PROJECT, cmsCapabilities: {} });
    await expect(listProfiles('p1')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(site.routes).toHaveLength(0);
  });

  it('a retryable 503 after a site restart gets a "try again shortly" message and never flags re-pair', async () => {
    const warm = new CmsBridgeError({ status: 503, code: 'UPSTREAM_UNAVAILABLE', message: 'emdash-seo warming up', retryable: true });
    expect(profileErrorMessage(warm)).toMatch(/not ready yet/);
    expect(await handleSiteRejection('p1', warm)).toBe(false);
    expect(await handleSiteRejection('p1', new CmsBridgeError({ status: 503, code: 'INTERNAL', retryable: true }))).toBe(false);
    expect(calls('project.updateMany').filter((c) => c.args?.data?.cmsRepairNeededAt)).toHaveLength(0);
  });
});

describe('v1.5.2 §28.3: matching order and late linking', () => {
  it('a node that already carries the page id wins over entry id / path', async () => {
    const { nodesForProfile } = await import('../../../src/lib/cmsSeoProfiles.js');
    db.overrides['contentMapNode.findMany'] = async (args) => (args.where.cmsPageId === 'P12' ? [{ id: 'byPage', mapId: 'm1', wpPageId: null }] : [{ id: 'other', mapId: 'm1' }]);
    const nodes = await nodesForProfile('p1', { pageId: 'P12', entryId: 'E', path: '/x/' });
    expect(nodes.map((n) => n.id)).toEqual(['byPage']);
    expect(calls('wpPage.findMany')).toHaveLength(0);
  });

  it('target (collection:slug) is used before path', async () => {
    const { nodesForProfile } = await import('../../../src/lib/cmsSeoProfiles.js');
    db.overrides['contentMapNode.findMany'] = async (args) => (args.where.wpPageId ? [{ id: 'byTarget', mapId: 'm1', wpPageId: 'wp9' }] : []);
    db.overrides['wpPage.findMany'] = async (args) => (args.where.cmsCollection === 'pages' && args.where.slug === 'hot-tub-repair' ? [{ id: 'wp9' }] : []);
    const nodes = await nodesForProfile('p1', { pageId: 'P99', entryId: null, target: 'pages:hot-tub-repair', path: null });
    expect(nodes.map((n) => n.id)).toEqual(['byTarget']);
  });

  it('a planned page (no entry, no path) drifts unlinked, then attaches when a node carries the page id', async () => {
    const ev = { ...seo()[1], profile: { ...seo()[1].profile, page_id: 'P30', entry_id: null, target: null, path: null } };
    db.overrides['contentMap.findMany'] = async () => [{ id: 'm1' }];
    await applySeoEvent('p1', ev);
    expect(calls('contentMapDrift.create')[0].args.data).toMatchObject({ mapId: 'm1', nodeId: null, payload: { pageId: 'P30' } });
    const { attachUnlinkedProfileDrifts } = await import('../../../src/lib/cmsSeoProfiles.js');
    db.overrides['contentMapDrift.findMany'] = async () => [{ id: 'd1', payload: { pageId: 'P30' } }, { id: 'd2', payload: { pageId: 'P31' } }];
    expect(await attachUnlinkedProfileDrifts('P30', [{ id: 'n5', mapId: 'm1', wpPageId: null }])).toBe(1);
    expect(calls('contentMapDrift.update').at(-1).args).toMatchObject({ where: { id: 'd1' }, data: { nodeId: 'n5' } });
  });
});

describe('v1.5.4 §30.10: seo.* cause decides drift (1.5.4+ sites)', () => {
  const causeEvents = () => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', 'events.request--seo-cause.json'), 'utf8')).events;
  const withNode = () => {
    db.overrides['wpPage.findMany'] = async () => [{ id: 'wp1' }];
    db.overrides['contentMapNode.findMany'] = async () => [{ id: 'n1', mapId: 'm1', wpPageId: 'wp1' }];
  };
  const drifts = () => calls('contentMapDrift.create').length + calls('contentMapDrift.update').length;
  const osOwned = (ev) => ({ ...ev, changed: [{ field: 'lifecycle.next_review_on', owner: 'os' }, { field: 'targeting.secondary_keywords', owner: 'os' }] });

  it('the contract example validates; site-admin → real drift (lifecycle included)', async () => {
    for (const ev of causeEvents()) expect(validateEvent(ev)).toBeNull();
    withNode();
    const admin = osOwned(causeEvents().find((e) => e.cause?.source === 'site-admin'));
    await applySeoEvent('p1', admin, { siteRevision: '1.5.4' });
    expect(calls('contentMapDrift.create')[0].args.data.payload.fields).toEqual(['lifecycle.next_review_on', 'targeting.secondary_keywords']);
    expect(calls('wpContentReview.count')).toHaveLength(0); // no heuristic needed
  });

  it('os with our osRequest → no drift; an unknown draft-upsert key → drift', async () => {
    withNode();
    const os = osOwned(causeEvents().find((e) => e.cause?.source === 'os'));
    db.overrides['cmsDraftPush.count'] = async (a) => (a.where.idempotencyKey === os.cause.osRequest.idempotencyKey ? 1 : 0);
    await applySeoEvent('p1', os, { siteRevision: '1.5.4' });
    expect(drifts()).toBe(0);
    db.overrides['cmsDraftPush.count'] = async () => 0;
    await applySeoEvent('p1', os, { siteRevision: '1.5.4' });
    expect(drifts()).toBe(1);
  });

  it('publish / scheduler / system / agent → lifecycle.* dropped, other OS-owned fields still drift', async () => {
    withNode();
    const pub = osOwned(causeEvents().find((e) => e.cause?.source === 'publish'));
    for (const source of ['publish', 'scheduler', 'system', 'agent']) {
      db.calls = [];
      await applySeoEvent('p1', { ...pub, cause: { ...pub.cause, source } }, { siteRevision: '1.5.4' });
      expect(calls('contentMapDrift.create')[0].args.data.payload.fields).toEqual(['targeting.secondary_keywords']);
    }
    db.calls = [];
    await applySeoEvent('p1', { ...pub, changed: [{ field: 'lifecycle.next_review_on', owner: 'os' }] }, { siteRevision: '1.5.4' });
    expect(drifts()).toBe(0);
  });

  it('older sites (or no cause): the O15 heuristic stays; a cause from a < 1.5.4 site is ignored', async () => {
    withNode();
    const admin = { ...causeEvents().find((e) => e.cause?.source === 'site-admin'), changed: [{ field: 'lifecycle.next_review_on', owner: 'os' }] };
    db.overrides['wpContentReview.count'] = async () => 1; // published around the event
    await applySeoEvent('p1', admin, { siteRevision: '1.5.3' });
    expect(drifts()).toBe(0); // heuristic: publish nearby → no drift, the (ignored) cause would have said drift
    expect(calls('wpContentReview.count')).toHaveLength(1);
  });
});

describe('v1.5.5 §31.2/31.4: one seo.* event per write and cause', () => {
  const perWrite = () => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', 'events.request--seo-cause-per-write.json'), 'utf8')).events;
  const withNode = () => {
    db.overrides['wpPage.findMany'] = async () => [{ id: 'wp1' }];
    db.overrides['contentMapNode.findMany'] = async () => [{ id: 'n1', mapId: 'm1', wpPageId: 'wp1' }];
  };

  it('a person\'s admin change right before an OS push stays drift; our own write and the publishes do not', async () => {
    withNode();
    const [admin, own, publish, , scheduled] = perWrite();
    for (const ev of perWrite()) expect(validateEvent(ev)).toBeNull();
    db.overrides['cmsDraftPush.count'] = async (a) => (a.where.idempotencyKey === own.cause.osRequest.idempotencyKey ? 1 : 0);
    await applySeoEvent('p1', admin, { siteRevision: '1.5.5' });
    expect(calls('contentMapDrift.create')).toHaveLength(1);
    expect(calls('contentMapDrift.create')[0].args.data.payload).toMatchObject({ fields: ['contract.title'], changedBy: 'Dev Admin' });
    db.calls = [];
    for (const ev of [own, publish, scheduled]) await applySeoEvent('p1', { ...ev, changed: [...ev.changed, { field: 'lifecycle.next_review_on', owner: 'os' }] }, { siteRevision: '1.5.5' });
    expect(calls('contentMapDrift.create').length + calls('contentMapDrift.update').length).toBe(0);
  });

  it('an "os" cause without a request of ours (no osRequest, or a key we never sent) is not dropped', async () => {
    withNode();
    const own = perWrite()[1];
    db.overrides['cmsDraftPush.count'] = async () => 0;
    const field = [{ field: 'targeting.intent', owner: 'os' }];
    await applySeoEvent('p1', { ...own, changed: field, cause: { source: 'os', actor: own.cause.actor } }, { siteRevision: '1.5.5' });
    await applySeoEvent('p1', { ...own, changed: field }, { siteRevision: '1.5.5' });
    expect(calls('contentMapDrift.create').length + calls('contentMapDrift.update').length).toBe(2);
  });
});
