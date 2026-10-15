/**
 * Contract v1.1.0 §21 (Phase 2 stage 1): client review from the OS. Request building against the contract examples,
 * Review/Suggestion normalisation, the client-safe content view, the suggestion mirror (Prisma stand-in) and the
 * events path (review.suggestion_* ordered by seq, suggestions on pipeline_client_changes_requested).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], overrides: {} }));
function defaultsFor(method) {
  if (method === 'findMany') return [];
  if (method === 'updateMany' || method === 'deleteMany') return { count: 1 };
  if (method === 'upsert' || method === 'create' || method === 'update') return { id: 'row-1' };
  return null;
}
vi.mock('../../../src/lib/prisma.js', () => {
  const model = (name) =>
    new Proxy({}, {
      get(_, method) {
        const key = `${name}.${String(method)}`;
        return async (args) => {
          db.calls.push({ key, args });
          if (db.overrides[key]) return db.overrides[key](args);
          return defaultsFor(String(method));
        };
      },
    });
  const prisma = new Proxy({ $transaction: async (ops) => Promise.all(ops) }, { get: (t, n) => (n in t ? t[n] : model(String(n))) });
  return { prisma };
});
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(async () => {}), notifyTest: vi.fn(async () => []) }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ mirrorPipelineToMaps: vi.fn(async () => {}), reconcileProjectMapsSafe: vi.fn() }));
vi.mock('../../../src/lib/realtimeBus.js', () => ({ publish: vi.fn() }));
vi.mock('../../../src/lib/ai.js', () => ({ isAiConfigured: () => false, generateChat: vi.fn() }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildClientReviewBody,
  clientContentView,
  clientReviewErrorMessage,
  suggestionToRow,
  suggestionStateAdvances,
  emdashReviewExtras,
  CHANGES_PUBLISH_LABEL,
  CLIENT_REVIEW_LIMITS,
} from '../../../src/lib/siteAdapters/clientReview.js';
import { normalizeReviewEvent, reviewToMirrorData, MUTATION_ROUTES, hasClientReviewFromOs } from '../../../src/lib/siteAdapters/emdash.js';
import { ERROR_CODES, CONTRACT_REVISION } from '../../../src/lib/siteAdapters/signing.js';
import { storeEmdashSuggestions, applyEmdashSuggestionChange, applyEmdashReviewExtras } from '../../../src/lib/cmsStore.js';
import { processEventBatch, validateEvent } from '../../../src/routes/webhooks/emdash.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const calls = (key) => db.calls.filter((c) => c.key === key);

beforeEach(() => {
  db.calls = [];
  db.overrides = {};
});

describe('pipeline-client-review request (§21.2) reproduces the contract examples', () => {
  it('CLIENT, changes_publish with two suggestions', () => {
    const want = ex('pipeline-client-review.request');
    const body = buildClientReviewBody({
      reviewId: want.reviewId,
      expectedRound: want.expectedRound,
      expectedRev: want.expectedRev,
      decision: want.decision,
      comment: want.comment,
      suggestions: want.suggestions,
      user: { id: want.actor.osUserId, name: want.actor.name, role: 'CLIENT' },
    });
    expect(body).toEqual(want);
  });

  it('OWNER acting for the client carries onBehalfOf (no override)', () => {
    const want = ex('pipeline-client-review.request--owner-approved');
    const body = buildClientReviewBody({
      reviewId: want.reviewId,
      expectedRound: want.expectedRound,
      decision: 'approved',
      comment: want.comment,
      user: { id: want.actor.osUserId, name: want.actor.name, role: 'OWNER' },
      clientAccountId: want.onBehalfOf.clientAccountId,
    });
    expect(body).toEqual(want);
    expect(body).not.toHaveProperty('override');
  });

  it('validates like the site (decision, suggestions only with changes, comment-or-suggestion, limits, roles, plain text)', () => {
    const base = { reviewId: '01JAC7Q2HV5M8N3P4R6S9T0W1X', expectedRound: 1, user: { id: 'u', name: 'C', role: 'CLIENT' } };
    const sg = { target: { field: 'title' }, quote: 'a', proposedText: 'b' };
    const err = (input) => {
      try {
        buildClientReviewBody({ ...base, ...input });
        return null;
      } catch (e) {
        return e.code;
      }
    };
    expect(err({ decision: 'publish' })).toBe('VALIDATION');
    expect(err({ decision: 'approved', suggestions: [sg] })).toBe('VALIDATION');
    expect(err({ decision: 'changes_requested' })).toBe('VALIDATION');
    expect(err({ decision: 'changes_requested', comment: 'fix it' })).toBeNull();
    expect(err({ decision: 'changes_requested', suggestions: [sg] })).toBeNull();
    expect(err({ decision: 'changes_requested', suggestions: Array(51).fill(sg) })).toBe('VALIDATION');
    expect(err({ decision: 'changes_requested', suggestions: [{ ...sg, target: { field: 'title', blockKey: 'b1' } }] })).toBe('VALIDATION');
    expect(err({ decision: 'changes_requested', suggestions: [{ ...sg, quote: 'x'.repeat(501) }] })).toBe('VALIDATION');
    expect(err({ decision: 'approved', user: { id: 'u', name: 'P', role: 'PM' } })).toBe('FORBIDDEN');
    expect(err({ decision: 'approved', expectedRound: 0 })).toBe('VALIDATION');
    const big = Array(50).fill({ target: { field: 'body' }, quote: 'q'.repeat(500), proposedText: 'p'.repeat(2000), note: 'n'.repeat(1000) });
    expect(err({ decision: 'changes_requested', suggestions: big, comment: 'c'.repeat(10_000) })).toBe('PAYLOAD_TOO_LARGE');
    const clean = buildClientReviewBody({ ...base, decision: 'changes_requested', comment: 'a\u0000b\nc\td\u0007' });
    expect(clean.comment).toBe('ab\nc\td');
    expect(CLIENT_REVIEW_LIMITS).toMatchObject({ suggestionsPerDecision: 50, suggestionsPerReview: 200, bodyBytes: 65536 });
  });

  it('contract plumbing: mutation route, SUGGESTION_LIMIT, revision, capability', () => {
    expect(MUTATION_ROUTES.has('pipeline-client-review')).toBe(true);
    expect(MUTATION_ROUTES.has('pipeline-suggestions')).toBe(false);
    expect(ERROR_CODES.SUGGESTION_LIMIT).toEqual({ status: 422, retryable: false });
    expect(CONTRACT_REVISION).toBe('1.1.0');
    expect(hasClientReviewFromOs({ cmsCapabilities: { clientReviewFromOs: true } })).toBe(true);
    expect(hasClientReviewFromOs({ cmsCapabilities: {} })).toBe(false);
    expect(clientReviewErrorMessage({ code: 'SUGGESTION_LIMIT' })).toMatch(/maximum number of suggestions/);
    expect(clientReviewErrorMessage({ code: 'CONFLICT_REV' })).toMatch(/updated since you opened it/);
  });
});

describe('Review + Suggestion normalisation', () => {
  it('Review: rev, clientDecisionSource, suggestionCounts reach the mirror', () => {
    const review = ex('pipeline-client-review.response').review;
    const n = normalizeReviewEvent(review, { eventType: 'pipeline_client_changes_requested', seq: review.seq });
    expect(n.cms).toMatchObject({ rev: review.rev, clientDecisionSource: 'os', suggestionCounts: review.suggestionCounts });
    expect(reviewToMirrorData(review).data).toMatchObject({ cmsRev: review.rev, cmsClientDecisionSource: 'os', cmsSuggestionCounts: review.suggestionCounts });
  });

  it('Suggestion → row; states only move forward', () => {
    const sg = ex('pipeline-client-review.response').suggestions[0];
    expect(suggestionToRow(sg)).toMatchObject({ cmsSuggestionId: sg.suggestionId, targetField: sg.target.field, quote: sg.quote, state: 'open', source: 'os' });
    expect(suggestionStateAdvances('open', 'applied')).toBe(true);
    expect(suggestionStateAdvances('accepted', 'applied')).toBe(true);
    expect(suggestionStateAdvances('applied', 'open')).toBe(false);
    expect(suggestionStateAdvances('rejected', 'accepted')).toBe(false);
    expect(suggestionStateAdvances('open', 'closed')).toBe(true);
  });

  it('client content view: text only, no ids, edit URL, block keys or revision ids', () => {
    const entry = ex('entry-get.response--fields').entry;
    const view = clientContentView(entry);
    const json = JSON.stringify(view);
    expect(view.title).toBe(entry.entryFields.title);
    expect(view.seo.title).toBe(entry.entryFields['seo.title']);
    expect(view.blocks.length).toBe(entry.blocks.length);
    expect(view.blocks[0]).toEqual({ type: entry.blocks[0].type, fields: entry.blocks[0].fields });
    for (const secret of [entry.entryId, entry.editUrl, entry.draftRevisionId, entry.blocks[0].key]) expect(json).not.toContain(secret);
  });

  it('list extras: EmDash only; changes_publish label; "decided for the client"', () => {
    const r = { status: 'changes_requested_by_client', clientDecision: 'changes_publish', cmsClientActor: { name: 'Agency Owner', onBehalfOfClient: true, source: 'os' } };
    expect(emdashReviewExtras(r, { cmsType: 'WORDPRESS' })).toEqual({});
    expect(emdashReviewExtras(r, { cmsType: 'EMDASH', cmsCapabilities: { clientReviewFromOs: true } })).toMatchObject({
      clientReviewFromOs: true,
      statusLabel: CHANGES_PUBLISH_LABEL,
      clientDecidedBy: { name: 'Agency Owner', onBehalfOfClient: true },
    });
  });
});

describe('suggestion mirror (Prisma store)', () => {
  const ev = () => ex('events.request--suggestions').events;

  it('stores suggestions from pipeline_client_changes_requested; skips a foreign siteId; never regresses', async () => {
    db.overrides['wpContentReview.findFirst'] = async () => ({ id: 'rev-row' });
    const [first] = ev();
    const n = await storeEmdashSuggestions('p1', first.suggestions, { siteId: 'site_9f3c2a7b41d0', cmsReviewId: first.review.reviewId });
    expect(n).toBe(2);
    expect(calls('cmsReviewSuggestion.create')[0].args.data).toMatchObject({ projectId: 'p1', contentReviewId: 'rev-row', state: 'open', targetField: 'body', targetBlockKey: 'faq_b2' });
    db.calls = [];
    expect(await storeEmdashSuggestions('p1', first.suggestions, { siteId: 'site_other000001' })).toBe(0);
    db.overrides['cmsReviewSuggestion.findUnique'] = async () => ({ id: 's1', state: 'applied' });
    expect(await storeEmdashSuggestions('p1', first.suggestions, { siteId: 'site_9f3c2a7b41d0' })).toBe(0);
    expect(calls('cmsReviewSuggestion.update')).toHaveLength(0);
  });

  it('review.suggestion_* changes apply in seq order and forward only', async () => {
    const applied = ev()[1];
    db.overrides['cmsReviewSuggestion.findUnique'] = async () => ({ id: 's1', state: 'open', cmsSeq: null });
    expect(await applyEmdashSuggestionChange('p1', applied.suggestion, applied.seq)).toBe(true);
    expect(calls('cmsReviewSuggestion.updateMany')[0].args.data).toMatchObject({ state: 'applied', cmsSeq: 6, appliedRevisionId: applied.suggestion.draftRevisionId, decidedByName: 'Sam Worker' });
    db.overrides['cmsReviewSuggestion.findUnique'] = async () => ({ id: 's1', state: 'applied', cmsSeq: 6 });
    expect(await applyEmdashSuggestionChange('p1', applied.suggestion, 6)).toBe(false);
    db.overrides['cmsReviewSuggestion.findUnique'] = async () => null;
    expect(await applyEmdashSuggestionChange('p1', applied.suggestion, 9)).toBe(false);
  });

  it('records the client-decision actor (OWNER for the client) but not the worker\'s changes-updated', async () => {
    const owner = ex('events.request--owner-for-client').events[0];
    await applyEmdashReviewExtras('p1', owner, 'applied');
    expect(calls('wpContentReview.updateMany')[0].args.data.cmsClientActor).toEqual({ name: 'Agency Owner', role: 'OWNER', source: 'os', onBehalfOfClient: true });
    db.calls = [];
    const workerApproved = ev()[3];
    await applyEmdashReviewExtras('p1', workerApproved, 'applied');
    expect(calls('wpContentReview.updateMany')).toHaveLength(0);
    await applyEmdashReviewExtras('p1', owner, 'tombstoned');
    expect(db.calls).toHaveLength(0);
  });
});

describe('events: review.suggestion_* are review-ordered events (§21.3)', () => {
  it('validateEvent requires seq, the Review and the suggestion change', () => {
    const [, applied] = ex('events.request--suggestions').events;
    expect(validateEvent(applied)).toBeNull();
    expect(validateEvent({ ...applied, suggestion: undefined })).toMatch(/suggestionId/);
    expect(validateEvent({ ...applied, seq: undefined })).toMatch(/seq/);
  });

  it('processEventBatch applies the suggestions batch in order, with timeline messages and extras', async () => {
    const batch = ex('events.request--suggestions');
    const applied = [];
    const extras = [];
    const store = {
      claimReceipt: async () => 'new',
      finalizeReceipt: async () => {},
      releaseReceipt: async () => {},
      isTombstoned: async () => false,
      getReviewSeq: async () => 4,
      applyPipelineEvent: async (_p, n) => {
        applied.push(n);
        return {};
      },
      applyReviewExtras: async (_p, e, outcome) => extras.push([e.type, outcome]),
      suggestionQuote: async () => 'Most often a failed heater element',
    };
    const project = { id: 'p1', cmsSiteId: 'site_9f3c2a7b41d0' };
    const r = await processEventBatch({ store, project, events: batch.events });
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(4);
    expect(applied.map((n) => n.eventType)).toEqual([
      'pipeline_client_changes_requested',
      'review.suggestion_applied',
      'review.suggestion_rejected',
      'pipeline_client_approved',
    ]);
    expect(applied[1].logMessage).toBe('Sam Worker applied a client suggestion: "Most often a failed heater element"');
    expect(applied[2].logMessage).toMatch(/rejected a client suggestion.*locked SEO contract/);
    expect(applied[1].cms).toMatchObject({ seq: 6, suggestionCounts: { applied: 1, open: 1 } });
    expect(extras).toEqual([
      ['pipeline_client_changes_requested', 'applied'],
      ['review.suggestion_applied', 'applied'],
      ['review.suggestion_rejected', 'applied'],
      ['pipeline_client_approved', 'applied'],
    ]);
  });
});

describe('Stage 1 e2e fixes (oasis-astro e6fa491)', () => {
  it('O1: repeater text (FAQ question/answer, link labels) reaches the client view as plain text', () => {
    const view = clientContentView(ex('entry-get.response--fields').entry);
    const faq = view.blocks.find((b) => b.type === 'faq');
    expect(faq.fields.items).toEqual(['Why is my hot tub not heating?\nMost often a failed heater element, a tripped high-limit switch or low flow.']);
    expect(view.blocks.find((b) => b.type === 'related_links').fields.links[0]).toContain('Spa services');
    const deep = clientContentView({ blocks: [{ type: 'x', fields: { a: [{ b: [{ c: { d: { e: 'too deep' } } }], t: '<b>kept as text</b>' }] } }] });
    expect(deep.blocks[0].fields.a).toEqual(['<b>kept as text</b>']);
  });

  it('O3: VIEWER-only client users get canDecide:false', () => {
    const p = { cmsType: 'EMDASH', cmsCapabilities: { clientReviewFromOs: true } };
    expect(emdashReviewExtras({ status: 'pending_client_review' }, p, { clientCanDecide: false })).toMatchObject({ canDecide: false });
    expect(emdashReviewExtras({ status: 'pending_client_review' }, p)).not.toHaveProperty('canDecide');
  });

  it('O8: notification wording names "minor changes" and the OWNER acting for the client (EmDash only)', async () => {
    const { emdashPostTypeLabel } = await import('../../../src/lib/reviewEvents.js');
    const n = { source: 'EMDASH', clientDecision: 'changes_publish', cms: { clientActor: { name: 'Agency Owner', onBehalfOfClient: true } } };
    expect(emdashPostTypeLabel(n, 'Page', 'pipeline_client_changes_requested')).toBe(
      'Page · minor changes, then ready to publish · decided by Agency Owner for the client'
    );
    expect(emdashPostTypeLabel({ ...n, clientDecision: 'approved' }, 'Page', 'pipeline_client_approved')).toBe('Page · decided by Agency Owner for the client');
    expect(emdashPostTypeLabel({ ...n, source: 'WORDPRESS' }, 'Page', 'pipeline_client_changes_requested')).toBe('Page');
    expect(emdashPostTypeLabel(n, 'Page', 'pipeline_pm_approved')).toBe('Page');
  });

  it('O7: suggestion timeline lines are the OS wording even when the site sends a message', async () => {
    const batch = ex('events.request--suggestions');
    const applied = [];
    const store = {
      claimReceipt: async () => 'new',
      finalizeReceipt: async () => {},
      releaseReceipt: async () => {},
      isTombstoned: async () => false,
      getReviewSeq: async () => 5,
      applyPipelineEvent: async (_p, n) => (applied.push(n), {}),
      applyReviewExtras: async () => {},
      suggestionQuote: async () => 'a failed heater element',
    };
    const ev = { ...batch.events[1], message: 'Suggestion applied to the draft (not published)' };
    await processEventBatch({ store, project: { id: 'p1', cmsSiteId: 'site_9f3c2a7b41d0' }, events: [ev] });
    expect(applied[0].logMessage).toBe('Sam Worker applied a client suggestion: "a failed heater element"');
  });
});
