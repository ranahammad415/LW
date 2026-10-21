/**
 * EmDash contract v1.5.9 (§35): reopen after client approval. The site sends `pipeline_reopened` (after
 * `pipeline_unscheduled {cause: "content_changed"}` for a scheduled review); the OS mirrors the Review, writes its own
 * timeline line, notifies the client (new round, client link only) and the project PM (in-app). No OS route requests
 * the transition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
          if (method === 'count') return 0;
          if (method === 'updateMany') return { count: 1 };
          if (method === 'create' || method === 'update' || method === 'upsert') return { id: 'r1', ...(args?.data || args?.create || {}) };
          return null;
        };
      },
    });
  return { prisma: new Proxy({}, { get: (_, n) => model(String(n)) }) };
});
const notified = vi.hoisted(() => []);
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async (n) => notified.push(n)), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn() }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: vi.fn(async () => {}), reconcileProjectMapsSafe: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn() }));

import { Prisma } from '@prisma/client';
import { applyReviewEvent } from '../../../src/lib/reviewEvents.js';
import { normalizeReviewEvent } from '../../../src/lib/siteAdapters/emdash.js';
import { processEventBatch } from '../../../src/routes/webhooks/emdash.js';
import { reopenEventMessage, reopenData, reopenNotice, siteActorText, changedBy } from '../../../src/lib/siteAdapters/reopen.js';
import { redactResponseSecrets, responseDropKeys } from '../../../src/lib/redactSecrets.js';
import { EVENT_LABELS } from '../../../src/lib/pipelineFormat.js';
import { CONTRACT_REVISION } from '../../../src/lib/siteAdapters/signing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (name) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${name}.json`), 'utf8'));
const calls = (key) => db.calls.filter((c) => c.key === key);
const flush = () => new Promise((r) => setTimeout(r, 0));

const SITE_URL = 'https://oasispoolspas.com';
const PROJECT = { id: 'p1', leadPmId: 'pm1', name: 'Oasis', wpUrl: SITE_URL, cmsType: 'EMDASH', cmsSiteId: 'site_9f3c2a7b41d0' };
const PM_LINK = `${SITE_URL}/_emdash/api/plugins/agency-os-bridge/review?t=PMTOKEN0123456789`;

const batch = () => ex('events.request--reopened');
const [savedEv, unscheduledEv, reopenedEv] = batch().events;

function reviewRow(status) {
  return { id: 'r1', isPublished: false, assignedWorkerId: null, status, clientReviewedAt: '2026-10-16T09:00:00Z', cmsReviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X' };
}

beforeEach(() => {
  db.calls = [];
  db.overrides = {
    'project.findUnique': async () => ({ clientId: 'c1', cmsSiteId: PROJECT.cmsSiteId }),
    'clientUser.findMany': async () => [{ userId: 'client-user' }],
    'user.findMany': async () => [{ id: 'owner-1' }],
  };
  notified.length = 0;
});

describe('contract fixtures and revision', () => {
  it('ships the v1.5.9 example and the OS claims contractRevision 1.6.1 (>= 1.5.9)', () => {
    expect(readdirSync(path.join(here, '../../fixtures/cms-contract/examples'))).toContain('events.request--reopened.json');
    expect(batch().events.map((e) => e.type)).toEqual(['content.saved', 'pipeline_unscheduled', 'pipeline_reopened']);
    expect(CONTRACT_REVISION).toBe('1.6.1');
    expect(EVENT_LABELS.pipeline_reopened).toBe('Back to client review');
  });
});

describe('reopen timeline line (OS wording, text only)', () => {
  it('names the round, who changed it (site-actor rule) and the changed paths', () => {
    expect(reopenEventMessage(reopenedEv)).toBe(
      'Back to client review (round 2): the content changed after client approval. Changed by Erin Editor: title, layout[faq1]'
    );
  });

  it('caps the list at 20 paths with "+X more" from changedTotal, and fits the 500-character column', () => {
    const changed = Array.from({ length: 20 }, (_, i) => `fields.f${i}`);
    const msg = reopenEventMessage({ ...reopenedEv, data: { ...reopenedEv.data, changed, changedTotal: 27 } });
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatch(/: fields\.f0, fields\.f1, .*fields\.f19 \(\+7 more\)$/);
    // Long paths: fewer listed, the rest counted.
    const long = Array.from({ length: 20 }, (_, i) => `fields.${'x'.repeat(250)}${i}`);
    const msg2 = reopenEventMessage({ ...reopenedEv, data: { ...reopenedEv.data, changed: long, changedTotal: 20 } });
    expect(msg2.length).toBeLessThanOrEqual(500);
    const shown = (msg2.match(/fields\./g) || []).length;
    expect(msg2).toContain(`(+${20 - shown} more)`);
    // More than 20 sent: only 20 kept; changedTotal never below what was listed.
    expect(reopenData({ data: { changed: Array.from({ length: 30 }, (_, i) => `p${i}`), changedTotal: 2 } })).toMatchObject({ changedTotal: 20 });
  });

  it('strips control characters; markup stays plain text (the UI renders text); no paths → who only', () => {
    const msg = reopenEventMessage({ ...reopenedEv, data: { ...reopenedEv.data, changed: ['title\u0000\n<script>x</script>'], changedTotal: 1 } });
    expect(msg).toContain('title <script>x</script>');
    expect(msg).not.toMatch(/[\u0000-\u001f]/);
    expect(reopenEventMessage({ type: 'pipeline_reopened', review: { round: 3 }, actor: { kind: 'agent', source: 'mcp' }, data: { by: { kind: 'agent', source: 'mcp' }, round: 3, changed: [] } })).toBe(
      'Back to client review (round 3): the content changed after client approval. Changed by an agent (agent).'
    );
  });

  it('site-actor display rule is the CONFLICT_REV one (names only; OS pushes named as such)', () => {
    expect(siteActorText({ kind: 'human', name: 'Jane PM', osUserId: 'u1', source: 'os' })).toBe('Jane PM from Agency OS');
    expect(siteActorText({ kind: 'human', source: 'api' })).toBe('a site editor');
    expect(siteActorText(null)).toBe('someone on the site');
    expect(changedBy({ kind: 'human', name: 'Site editor', id: 'SITEID', role: 'editor' })).toEqual({ name: 'Site editor', kind: 'human', viaOs: false });
  });

  it('notification bits carry no markup characters', () => {
    const n = reopenNotice({ ...reopenedEv, data: { ...reopenedEv.data, by: { kind: 'human', name: '<b>Eve</b>', source: 'api' }, changed: ['<img src=x>'], changedTotal: 3 } });
    expect(n).toEqual({ round: 2, from: 'scheduled', changedBy: 'bEve/b', changedSummary: 'img src=x (+2 more)' });
  });
});

describe('applyReviewEvent: pipeline_reopened is mirrored', () => {
  it('stores status, round, cleared decision, the new client link (host-checked) and the OS timeline line', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => reviewRow('client_approved');
    const n = normalizeReviewEvent(reopenedEv.review, { eventType: reopenedEv.type, seq: reopenedEv.seq, message: reopenEventMessage(reopenedEv) });
    n.reopen = reopenNotice(reopenedEv);
    const r = await applyReviewEvent({ project: PROJECT, event: n });
    expect(r.skipped).toBeUndefined();
    const [claim, state] = calls('wpContentReview.updateMany').map((c) => c.args);
    expect(claim.data).toEqual({ cmsSeq: 8 });
    expect(state.data).toMatchObject({
      status: 'pending_client_review',
      revisionNumber: 2,
      clientDecision: null,
      clientComment: null,
      clientReviewedAt: null,
      pmDecision: 'approved',
      clientPreviewUrl: reopenedEv.review.clientPreviewUrl,
      cmsScheduledAt: null,
      cmsClientDecisionSource: null,
      lastEventType: 'pipeline_reopened',
    });
    expect(state.data.cmsClientActor).toBe(Prisma.DbNull);
    expect(calls('wpContentReviewEvent.create')[0].args.data).toMatchObject({
      eventType: 'pipeline_reopened',
      status: 'pending_client_review',
      revisionNumber: 2,
      cmsSeq: 8,
      message: 'Back to client review (round 2): the content changed after client approval. Changed by Erin Editor: title, layout[faq1]',
    });
  });

  it('an off-host or http client link is dropped (safeEmdashLink), never stored', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => reviewRow('client_approved');
    const review = { ...reopenedEv.review, clientPreviewUrl: 'https://evil.example/_emdash/api/plugins/agency-os-bridge/review?t=x' };
    await applyReviewEvent({ project: PROJECT, event: normalizeReviewEvent(review, { eventType: 'pipeline_reopened', seq: 8 }) });
    const state = calls('wpContentReview.updateMany')[1].args;
    expect(state.data).not.toHaveProperty('clientPreviewUrl');
    const client = notified.find((x) => x.slug === 'content_ready_for_client_review');
    expect(client.actionUrl).toBe('/portal/admin/projects/p1?tab=content-reviews');
  });
});

describe('notifications', () => {
  it('client: the existing "ready for your review" path with the new client link; PM: in-app content_review_reopened', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => reviewRow('client_approved');
    // Even if the Review carried a PM link, the client notification never uses it.
    const review = { ...reopenedEv.review, pmPreviewUrl: PM_LINK };
    const n = normalizeReviewEvent(review, { eventType: 'pipeline_reopened', seq: 8 });
    n.reopen = reopenNotice(reopenedEv);
    await applyReviewEvent({ project: PROJECT, event: n });
    await flush();
    const client = notified.find((x) => x.slug === 'content_ready_for_client_review');
    expect(client).toBeDefined();
    expect(client.recipientIds).toEqual(['client-user']);
    expect(client.actionUrl).toBe(reopenedEv.review.clientPreviewUrl);
    expect(client.variables).toMatchObject({ contentTitle: 'Hot Tub Repair for Most Brands (round 2)', postType: 'Page · round 2: updated after your approval' });
    expect(JSON.stringify(client)).not.toContain('PMTOKEN');
    const pm = notified.find((x) => x.slug === 'content_review_reopened');
    expect(pm.recipientIds).toEqual(['pm1']);
    expect(pm.variables).toMatchObject({ round: '2', changedBy: 'Erin Editor', changedSummary: 'title, layout[faq1]' });
    expect(pm.actionUrl).toBe('/portal/admin/projects/p1?tab=content-reviews');
    // No other notification for a reopen (e.g. no "client approved" or "submitted").
    expect(notified.map((x) => x.slug).sort()).toEqual(['content_ready_for_client_review', 'content_review_reopened']);
  });

  it('pipeline_unscheduled (cause content_changed) notifies nobody', async () => {
    db.overrides['wpContentReview.findUnique'] = async () => reviewRow('scheduled');
    await applyReviewEvent({ project: PROJECT, event: normalizeReviewEvent(unscheduledEv.review, { eventType: unscheduledEv.type, seq: 7, message: unscheduledEv.message }) });
    await flush();
    expect(notified).toHaveLength(0);
  });
});

describe('events batch: content.saved, pipeline_unscheduled, pipeline_reopened in seq order', () => {
  function memoryStore({ storedSeq = 6, row = reviewRow('scheduled') } = {}) {
    const seen = new Map();
    const store = {
      order: [],
      async claimReceipt(_p, ev) { if (seen.has(ev.eventId)) return 'duplicate'; seen.set(ev.eventId, 'pending'); return 'claimed'; },
      async finalizeReceipt(_p, id, outcome) { seen.set(id, outcome); },
      async releaseReceipt(_p, id) { seen.delete(id); },
      async isTombstoned() { return false; },
      async getReviewSeq() { return storedSeq; },
      async getEntryUpdatedAt() { return null; },
      async applyContentEvent(_p, ev) { store.order.push(ev.type); },
      async applyPipelineEvent(project, n, log) {
        store.order.push(n.eventType);
        db.overrides['wpContentReview.findUnique'] = async () => row;
        const out = await applyReviewEvent({ project, event: n, log });
        // What the mirror now holds (the state write of applyEmdashReviewWrite).
        const state = calls('wpContentReview.updateMany').at(-1).args.data;
        row = { ...row, status: state.status };
        return out;
      },
      async applyReviewExtras() {},
    };
    return store;
  }

  it('applies them in cursor/seq order (sent shuffled): scheduled → client_approved (unscheduled) → pending_client_review', async () => {
    const store = memoryStore();
    const events = batch().events;
    const r = await processEventBatch({ store, project: PROJECT, events: [events[2], events[0], events[1]] });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual(events.map((e) => e.eventId));
    expect(r.lastCursor).toBe(142);
    expect(store.order).toEqual(['content.saved', 'pipeline_unscheduled', 'pipeline_reopened']);
    const timeline = calls('wpContentReviewEvent.create').map((c) => c.args.data);
    expect(timeline.map((t) => [t.eventType, t.status, t.cmsSeq])).toEqual([
      ['pipeline_unscheduled', 'client_approved', 7],
      ['pipeline_reopened', 'pending_client_review', 8],
    ]);
    expect(timeline[0].message).toBe('Unscheduled: the content changed after client approval');
    expect(timeline[1].message).toMatch(/^Back to client review \(round 2\).*Changed by Erin Editor: title, layout\[faq1\]$/);
    // The unschedule clears the OS scheduled state.
    const states = calls('wpContentReview.updateMany').map((c) => c.args.data).filter((d) => d.status);
    expect(states[0]).toMatchObject({ status: 'client_approved', cmsScheduledAt: null });
    expect(states[1]).toMatchObject({ status: 'pending_client_review', revisionNumber: 2, clientDecision: null });
    await flush();
    expect(notified.filter((x) => x.slug === 'content_ready_for_client_review')).toHaveLength(1);
  });

  it('a replay of the same batch is a duplicate: nothing applied or notified again', async () => {
    const store = memoryStore();
    await processEventBatch({ store, project: PROJECT, events: batch().events });
    await flush();
    const before = notified.length;
    store.order.length = 0;
    const again = await processEventBatch({ store, project: PROJECT, events: batch().events });
    expect(again.duplicate).toHaveLength(3);
    expect(store.order).toEqual([]);
    await flush();
    expect(notified.length).toBe(before);
  });

  it('a reopen at or below the stored seq is stale (no row, no notification)', async () => {
    const store = memoryStore({ storedSeq: 8 });
    const r = await processEventBatch({ store, project: PROJECT, events: [reopenedEv] });
    expect(r.accepted).toEqual([reopenedEv.eventId]);
    expect(store.order).toEqual([]);
    await flush();
    expect(notified).toHaveLength(0);
  });
});

describe('client responses never contain pmPreviewUrl', () => {
  it('a reopened row returned on /api/client/* (or to a CLIENT user) loses pmPreviewUrl; staff keep it', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = { role: request.headers['x-role'] };
    });
    app.addHook('preSerialization', async (request, _r, payload) => redactResponseSecrets(payload, 0, responseDropKeys(request)));
    const row = {
      id: 'r1',
      status: 'pending_client_review',
      revisionNumber: 2,
      clientDecision: null,
      clientPreviewUrl: reopenedEv.review.clientPreviewUrl,
      pmPreviewUrl: PM_LINK,
      history: [{ eventType: 'pipeline_reopened', pmPreviewUrl: PM_LINK }],
    };
    app.get('/api/client/projects/p1/pipeline', async () => ({ pipelines: [row] }));
    app.get('/api/pm/pipeline/p1', async () => ({ pipelines: [row] }));
    for (const [url, role] of [['/api/client/projects/p1/pipeline', 'CLIENT'], ['/api/client/projects/p1/pipeline', 'OWNER'], ['/api/pm/pipeline/p1', 'CLIENT']]) {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-role': role } });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('PMTOKEN');
      expect(res.json().pipelines[0].clientPreviewUrl).toBe(reopenedEv.review.clientPreviewUrl);
    }
    const staff = await app.inject({ method: 'GET', url: '/api/pm/pipeline/p1', headers: { 'x-role': 'PM' } });
    expect(staff.json().pipelines[0].pmPreviewUrl).toBe(PM_LINK);
    await app.close();
  });
});
