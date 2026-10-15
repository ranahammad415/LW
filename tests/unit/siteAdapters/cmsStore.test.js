/**
 * Prisma-backed EmDash store + shared review-event upsert, against a Prisma stand-in
 * that records calls (the MySQL integration suite needs a database; not run locally).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));

function defaultsFor(method) {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  if (method === 'upsert' || method === 'create' || method === 'update') return { id: 'row-1' };
  return null;
}

vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy(
      {},
      {
        get(_, method) {
          const key = `${name}.${String(method)}`;
          return async (args) => {
            db.calls.push({ key, args });
            if (db.overrides[key]) return db.overrides[key](args);
            return defaultsFor(String(method));
          };
        },
      }
    );
  const prisma = new Proxy(
    {
      $transaction: async (ops) => Promise.all(ops),
      $executeRawUnsafe: async () => 0,
      $executeRaw: async () => 0,
      $queryRaw: async () => [],
    },
    { get: (target, name) => (name in target ? target[name] : model(String(name))) }
  );
  return { prisma };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({
  mirrorPipelineToMaps: vi.fn(async () => {}),
  reconcileProjectMapsSafe: vi.fn(),
}));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn() }));

import { prismaCmsStore, applyEmdashContentEvent, mirrorEmdashReview, backfillEmdashHistory } from '../../../src/lib/cmsStore.js';
import { applyReviewEvent } from '../../../src/lib/reviewEvents.js';
import { normalizeReviewEvent } from '../../../src/lib/siteAdapters/emdash.js';
import { normalizePipelineWebhook } from '../../../src/lib/siteAdapters/wordpress.js';
import { decryptCmsSecret, cmsAad } from '../../../src/lib/cmsKeyCrypto.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) =>
  JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));

const calls = (key) => db.calls.filter((c) => c.key === key);
const unique = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

beforeAll(() => {
  process.env.CMS_KEY_ENCRYPTION_KEY = 'test-cms-key-0123456789-abcdefghijklmnop';
});
beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('nonce store (DB unique index; PM2-safe)', () => {
  it('stores a fresh nonce, refuses a live duplicate and re-admits an expired one only via CAS', async () => {
    expect(await prismaCmsStore.nonceCache.checkAndStore('site_abcdefgh:n-1234567890abcdef', Date.now() + 600_000)).toBe(true);
    db.overrides['cmsNonce.create'] = async () => {
      throw unique();
    };
    db.overrides['cmsNonce.updateMany'] = async () => ({ count: 0 });
    expect(await prismaCmsStore.nonceCache.checkAndStore('site_abcdefgh:n-1234567890abcdef', Date.now() + 600_000)).toBe(false);
    db.overrides['cmsNonce.updateMany'] = async () => ({ count: 1 });
    expect(await prismaCmsStore.nonceCache.checkAndStore('site_abcdefgh:n-1234567890abcdef', Date.now() + 600_000)).toBe(true);
    const where = calls('cmsNonce.updateMany').at(-1).args.where;
    expect(where).toMatchObject({ siteId: 'site_abcdefgh', nonce: 'n-1234567890abcdef' });
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
  });
});

describe('event receipts', () => {
  const ev = { eventId: '01JAC8A0B1C2D3E4F5G6H7J8K9', type: 'pipeline_pm_approved', cursor: 56, seq: 3, review: { reviewId: 'R1' } };
  it('claims new events and reports a duplicate on the unique index', async () => {
    expect(await prismaCmsStore.claimReceipt('p1', ev)).toBe('new');
    expect(calls('cmsEventReceipt.create')[0].args.data).toMatchObject({ projectId: 'p1', eventId: ev.eventId, seq: 3, cursor: 56, cmsReviewId: 'R1', outcome: 'pending' });
    db.overrides['cmsEventReceipt.create'] = async () => {
      throw unique();
    };
    // Completed receipt → duplicate; a fresh pending claim → in flight elsewhere (v1.0.2 C4, review S4).
    db.overrides['cmsEventReceipt.findUnique'] = async () => ({ outcome: 'applied' });
    expect(await prismaCmsStore.claimReceipt('p1', ev)).toBe('duplicate');
    db.overrides['cmsEventReceipt.findUnique'] = async () => ({ outcome: 'pending' });
    expect(await prismaCmsStore.claimReceipt('p1', ev)).toBe('in_flight');
    // A claim left `pending` by a crashed worker can be re-taken (CAS on receivedAt).
    db.overrides['cmsEventReceipt.updateMany'] = async () => ({ count: 1 });
    expect(await prismaCmsStore.claimReceipt('p1', ev)).toBe('new');
  });
});

describe('pairing codes', () => {
  it('single use: consume is a CAS on usedAt and deletes the signing key', async () => {
    db.overrides['cmsPairingCode.updateMany'] = async () => ({ count: 1 });
    expect(await prismaCmsStore.consumePairingCode('c1')).toBe(true);
    const args = calls('cmsPairingCode.updateMany')[0].args;
    expect(args.where).toMatchObject({ id: 'c1', usedAt: null, burnedAt: null });
    expect(args.data).toMatchObject({ signingKeyEnc: null });
    db.overrides['cmsPairingCode.updateMany'] = async () => ({ count: 0 });
    expect(await prismaCmsStore.consumePairingCode('c1')).toBe(false);
  });

  it('burns the code at the 5th failure', async () => {
    db.overrides['cmsPairingCode.findUnique'] = async () => ({ failedAttempts: 5, burnedAt: null });
    const r = await prismaCmsStore.recordPairingFailure('c1');
    expect(r.attemptsLeft).toBe(0);
    const burn = calls('cmsPairingCode.updateMany').at(-1).args;
    expect(burn.data).toMatchObject({ signingKeyEnc: null });
    expect(burn.data.burnedAt).toBeInstanceOf(Date);
  });

  it('completePairing stores only encrypted keys (key id 1) and updates project metadata', async () => {
    await prismaCmsStore.completePairing({
      projectId: 'p1',
      siteInfo: ex('handshake.request'),
      contract: 1,
      inbound: 'aosk1_in',
      outbound: 'aosk1_out',
    });
    const up = calls('cmsCredential.upsert')[0].args;
    expect(up.create.keyId).toBe(1);
    expect(up.create.inboundKeyEnc).not.toContain('aosk1_in');
    expect(decryptCmsSecret(up.create.inboundKeyEnc, cmsAad('p1', 'inbound'))).toBe('aosk1_in');
    expect(decryptCmsSecret(up.create.outboundKeyEnc, cmsAad('p1', 'outbound'))).toBe('aosk1_out');
    const proj = calls('project.update')[0].args.data;
    expect(proj).toMatchObject({ cmsKeyId: 1, cmsContractVersion: 1, cmsPluginVersion: '1.0.0' });
    expect(proj.cmsCapabilities.publishFromOs).toBe(false);
    expect(JSON.stringify(proj)).not.toContain('aosk1_');
  });
});

describe('applyReviewEvent: one upsert for both CMSs', () => {
  const project = { id: 'p1', leadPmId: 'pm1', name: 'Oasis' };

  it('EmDash: writes cms* columns + cmsSeq and skips the WP stale-rewind guard (seq already ordered)', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: false, assignedWorkerId: null, status: 'client_approved', clientReviewedAt: '2026-10-15 12:00:00' });
    db.overrides['wpContentReview.updateMany'] = async () => ({ count: 1 });
    const ev = ex('events.request').events[1]; // pipeline_sent_to_client, seq 4
    const n = normalizeReviewEvent(ev.review, { eventType: ev.type, seq: ev.seq });
    const r = await applyReviewEvent({ project, event: n });
    expect(r.skipped).toBeUndefined();
    // Atomic seq claim first (review S5), then the state write gated by cmsMirrorSeq (C7).
    const [claim, state] = calls('wpContentReview.updateMany').map((c) => c.args);
    expect(claim.where).toEqual({ id: 'r1', OR: [{ cmsSeq: null }, { cmsSeq: { lt: 4 } }] });
    expect(claim.data).toEqual({ cmsSeq: 4 });
    expect(state.where).toEqual({ id: 'r1', OR: [{ cmsMirrorSeq: null }, { cmsMirrorSeq: { lte: 4 } }] });
    expect(calls('wpContentReview.upsert')).toHaveLength(0);
    const up = { update: state.data };
    expect(up.update).toMatchObject({
      status: 'pending_client_review',
      wpPostId: 118,
      cmsReviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X',
      cmsEntryId: '01JAB4M9ZQ7X3K2V8N5T6R1W0C',
      clientPreviewUrl: ev.review.clientPreviewUrl,
      pmDecision: 'approved',
    });
    expect(calls('wpContentReviewEvent.create')[0].args.data).toMatchObject({ eventType: 'pipeline_sent_to_client', cmsSeq: 4 });
  });

  it('EmDash: losing the atomic seq claim is a silent stale skip (no event row, no notification)', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: false, assignedWorkerId: null, status: 'pending_client_review' });
    db.overrides['wpContentReview.updateMany'] = async () => ({ count: 0 });
    const ev = ex('events.request').events[0];
    const r = await applyReviewEvent({ project, event: normalizeReviewEvent(ev.review, { eventType: ev.type, seq: ev.seq }) });
    expect(r).toEqual({ skipped: 'stale_seq' });
    expect(calls('wpContentReviewEvent.create')).toHaveLength(0);
  });

  it('WordPress: the stale client-rewind guard still applies and no cms* columns are written', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ isPublished: false, assignedWorkerId: null, status: 'client_approved', clientReviewedAt: '2026-10-15 12:00:00' });
    const n = normalizePipelineWebhook({ pipelineId: 7, eventType: 'pipeline_sent_to_client', status: 'pending_client_review', postId: 3 });
    expect(await applyReviewEvent({ project, event: n })).toEqual({ skipped: 'stale_client_rewind' });
    expect(calls('wpContentReview.upsert')).toHaveLength(0);

    db.overrides['wpContentReview.findUnique'] = async () => null;
    const n2 = normalizePipelineWebhook({ pipelineId: 7, eventType: 'pipeline_submitted', status: 'pending_pm_review', postId: 3, postTitle: 'T' });
    await applyReviewEvent({ project, event: n2 });
    const up = calls('wpContentReview.upsert')[0].args;
    expect(Object.keys(up.update).some((k) => k.startsWith('cms'))).toBe(false);
    expect(up.create.status).toBe('pending_pm_review');
  });
});

describe('content events and mirror', () => {
  const project = { id: 'p1', wpUrl: 'https://oasispoolspas.com' };

  it('creates a WpPage + snapshot from a content.saved event using snapshotText as content', async () => {
    const ev = ex('events.request').events[2];
    await applyEmdashContentEvent(project, ev);
    const page = calls('wpPage.create')[0].args.data;
    expect(page).toMatchObject({ projectId: 'p1', wpPostId: 118, cmsEntryId: ev.entry.entryId, content: ev.snapshotText, status: 'published' });
    const snap = calls('wpPageSnapshot.create')[0].args.data;
    expect(snap).toMatchObject({ eventType: 'created', cmsRevisionId: ev.entry.draftRevisionId, contentHash: ev.entry.contentHash });
  });

  it('mirror never rewinds below the stored seq and never regresses a published row', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: false, cmsSeq: 9, assignedWorkerId: null });
    const review = ex('review.response').review;
    await mirrorEmdashReview('p1', { ...review, seq: 5 });
    expect(calls('wpContentReview.upsert')).toHaveLength(0);

    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: false, cmsSeq: 2, cmsMirrorSeq: 7 });
    await mirrorEmdashReview('p1', { ...review, seq: 5 });
    expect(calls('wpContentReview.updateMany')).toHaveLength(0); // older than the last mirror (C7)

    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1', isPublished: true, publishedAt: new Date(), cmsSeq: 2 });
    db.overrides['wpContentReview.updateMany'] = async () => ({ count: 1 });
    await mirrorEmdashReview('p1', { ...review, seq: 5 });
    const up = calls('wpContentReview.updateMany')[0].args;
    expect(up.data).toMatchObject({ status: 'published', isPublished: true, cmsMirrorSeq: 5 });
    expect(up.data.cmsSeq).toBeUndefined();
    expect(up.where.AND).toEqual([
      { OR: [{ cmsSeq: null }, { cmsSeq: { lte: 5 } }] },
      { OR: [{ cmsMirrorSeq: null }, { cmsMirrorSeq: { lte: 5 } }] },
    ]);
  });

  it('backfills only history seqs the OS has not stored', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => ({ id: 'r1' });
    db.overrides['wpContentReviewEvent.findMany'] = async () => [{ cmsSeq: 1 }];
    const review = ex('pipeline-list.response').items[0];
    const created = await backfillEmdashHistory('p1', review);
    const seqs = calls('wpContentReviewEvent.create').map((c) => c.args.data.cmsSeq);
    expect(seqs).not.toContain(1);
    expect(created).toBe(seqs.length);
    expect(seqs.length).toBeGreaterThan(0);
  });
});

describe('review fixes in the Prisma store', () => {
  it('S6: content.deleted stores the deletion time as modifiedAt', async () => {
    db.overrides['wpPage.findUnique'] = async () => ({ id: 'pg1', title: 'T', contentHash: 'h', content: '' });
    const ev = ex('events.request--deleted').events.find((e) => e.type === 'content.deleted');
    await applyEmdashContentEvent({ id: 'p1', wpUrl: 'https://oasispoolspas.com' }, ev);
    const upd = calls('wpPage.update')[0].args.data;
    expect(upd.status).toBe('deleted');
    expect(upd.modifiedAt.toISOString()).toBe(new Date(ev.entry.updatedAt).toISOString());
  });

  it('S11/S12: same siteId keeps cmsLastCursor and receipts; a new siteId clears both and applies the pending URL', async () => {
    db.overrides['project.findUnique'] = async () => ({ cmsSiteId: 'site_same0001' });
    await prismaCmsStore.completePairing({ projectId: 'p1', siteId: 'site_same0001', siteUrl: 'https://a.example', siteInfo: {}, contract: 1, inbound: 'i', outbound: 'o' });
    let data = calls('project.update').at(-1).args.data;
    expect(data).not.toHaveProperty('cmsLastCursor');
    expect(data).toMatchObject({ cmsSiteId: 'site_same0001', wpUrl: 'https://a.example', cmsRepairNeededAt: null });
    expect(calls('cmsEventReceipt.deleteMany')).toHaveLength(0);

    await prismaCmsStore.completePairing({ projectId: 'p1', siteId: 'site_new00001', siteUrl: null, siteInfo: {}, contract: 1, inbound: 'i', outbound: 'o' });
    data = calls('project.update').at(-1).args.data;
    expect(data).toMatchObject({ cmsSiteId: 'site_new00001', cmsLastCursor: null });
    expect(data).not.toHaveProperty('wpUrl');
    expect(calls('cmsEventReceipt.deleteMany')[0].args).toEqual({ where: { projectId: 'p1' } });
  });

  it('v1.0.2 C1: findCounterRegression ignores known eventIds and detects cursor / seq / surrogate reuse', async () => {
    const [e1, e2] = ex('events.request').events;
    db.overrides['cmsEventReceipt.findMany'] = async () => [{ eventId: e1.eventId }, { eventId: e2.eventId }];
    expect(await prismaCmsStore.findCounterRegression('p1', [e1, e2])).toBeNull();

    db.overrides['cmsEventReceipt.findMany'] = async () => [];
    db.overrides['cmsEventReceipt.findFirst'] = async (args) => (args.where.cursor ? { cursor: 56 } : null);
    expect(await prismaCmsStore.findCounterRegression('p1', [e1])).toMatch(/cursor 56/);

    db.overrides['cmsEventReceipt.findFirst'] = async (args) => (args.where.seq ? { id: 'x' } : null);
    expect(await prismaCmsStore.findCounterRegression('p1', [e1])).toMatch(/seq 3/);

    db.overrides['cmsEventReceipt.findFirst'] = async () => null;
    db.overrides['wpContentReview.findUnique'] = async () => ({ cmsReviewId: '01OTHERREVIEW' });
    expect(await prismaCmsStore.findCounterRegression('p1', [e1])).toMatch(/reviewNo 42/);
  });

  it('flagRepairNeeded is a CAS: notifies OWNERs once', async () => {
    const { notify } = await import('../../../src/lib/notificationService.js');
    notify.mockClear();
    db.overrides['project.updateMany'] = async () => ({ count: 1 });
    db.overrides['user.findMany'] = async () => [{ id: 'o1' }];
    expect(await prismaCmsStore.flagRepairNeeded('p1', 'cursor 5 reused')).toBe(true);
    db.overrides['project.updateMany'] = async () => ({ count: 0 });
    expect(await prismaCmsStore.flagRepairNeeded('p1', 'cursor 5 reused')).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ slug: 'cms_repair_needed', recipientIds: ['o1'] });
  });
});
