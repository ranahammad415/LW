/**
 * Reviews: fingerprint dedupe across sources, soft removal after full fetches, cost caps (daily newest 20, weekly
 * full 100, profile once a day), pending task reuse (never a second paid task_post), post-all-then-collect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [], reviews: [], projects: [] }));
vi.mock('../../../src/lib/prisma.js', async () => {
  const { shapeChecked } = await import('../../helpers/prismaShape.js');
  const rec = (k, ret) => async (a) => { db.calls.push([k, a]); return typeof ret === 'function' ? ret(a) : ret; };
  return {
    prisma: shapeChecked({
      gmbReview: {
        findMany: rec('gmbReview.findMany', () => db.reviews),
        upsert: rec('gmbReview.upsert', {}),
        update: rec('gmbReview.update', {}),
        updateMany: rec('gmbReview.updateMany', { count: 1 }),
      },
      project: {
        update: rec('project.update', {}),
        findMany: rec('project.findMany', () => db.projects),
      },
      gmbDailyMetric: { upsert: rec('gmbDailyMetric.upsert', {}) },
    }),
  };
});
const dfs = vi.hoisted(() => ({ posts: 0, info: 0, polls: [] }));
vi.mock('../../../src/lib/omniSearch/businessDataProvider.js', async (orig) => ({
  ...(await orig()),
  fetchGmbInfo: async () => { dfs.info += 1; return { title: 'Joe', cid: '123456789', placeId: 'ChIJplace1', rating: 4.6, reviewsCount: 212, lat: 1, lng: 2, costUsd: 0.0054 }; },
  postReviewsTask: async (args) => { dfs.posts += 1; dfs.lastPost = args; dfs.events.push('post'); return { taskId: `task-${dfs.posts}-abcdef`, costUsd: 0.001 }; },
  pollReviewsTask: async (taskId) => { dfs.polls.push(taskId); dfs.events.push('poll'); return dfs.pollAnswer; },
}));

import { reviewFingerprint, planReviewWrites, storeReviews, REVIEW_TIME_TOLERANCE_MS } from '../../../src/lib/analytics/gmbReviews.js';
import {
  reviewsPlan,
  profileDue,
  pendingTask,
  syncGmbProjectViaDataForSeo,
  runGmbSync,
  GMB_SYNC_PROJECT_SELECT,
} from '../../../src/lib/analytics/gmbSync.js';

const now = new Date('2026-10-22T05:30:00Z');
const day = (n) => new Date(now.getTime() - n * 86_400_000);

beforeEach(() => {
  db.calls = [];
  db.reviews = [];
  db.projects = [];
  dfs.posts = 0;
  dfs.info = 0;
  dfs.polls = [];
  dfs.events = [];
  dfs.pollAnswer = { state: 'ok', reviews: [] };
  process.env.DATAFORSEO_LOGIN = 'l';
  process.env.DATAFORSEO_PASSWORD = 'p';
});

describe('fingerprint dedupe', () => {
  const native = { id: 'row1', reviewId: 'accounts/1/locations/2/reviews/AbC', reviewerName: 'Ann Smith', starRating: 5, comment: 'Great pizza!', createTime: day(10), removedAt: null };

  it('the same review from the other source updates the existing row (no duplicate)', () => {
    const fromDfs = { reviewId: 'ChdDSUhNMG9nS0VJQ0FnSURXX0xu', reviewerName: 'ann smith', starRating: 5, comment: 'Great pizza', createTime: new Date(day(10).getTime() + 5 * 3600_000) };
    const plan = planReviewWrites([native], [fromDfs], { source: 'dataforseo', now });
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ id: 'row1', data: { source: 'dataforseo', removedAt: null, fingerprint: reviewFingerprint(fromDfs) } });
    expect(plan.updates[0].data).not.toHaveProperty('reviewId');
  });

  it('outside the time tolerance or with other stars it is a different review', () => {
    const later = { reviewId: 'x1', reviewerName: 'Ann Smith', starRating: 5, comment: 'Great pizza!', createTime: new Date(day(10).getTime() + REVIEW_TIME_TOLERANCE_MS + 1000) };
    expect(planReviewWrites([native], [later], { source: 'dataforseo', now }).creates).toHaveLength(1);
    const otherStars = { ...later, reviewId: 'x2', starRating: 4, createTime: day(10) };
    expect(planReviewWrites([native], [otherStars], { source: 'dataforseo', now }).creates).toHaveLength(1);
  });

  it('a full, complete fetch soft-removes reviews that disappeared; a truncated one only newer than its oldest', () => {
    const rows = [
      native,
      { id: 'row2', reviewId: 'gone-new', reviewerName: 'B', starRating: 1, comment: 'bad', createTime: day(2), removedAt: null },
      { id: 'row3', reviewId: 'old-beyond-depth', reviewerName: 'C', starRating: 4, comment: 'ok', createTime: day(400), removedAt: null },
    ];
    const incoming = [{ reviewId: native.reviewId, reviewerName: 'Ann Smith', starRating: 5, comment: 'Great pizza!', createTime: day(10) }];
    expect(planReviewWrites(rows, incoming, { source: 'google', now, full: true, complete: false }).removals).toEqual(['row2']);
    expect(planReviewWrites(rows, incoming, { source: 'google', now, full: true, complete: true }).removals.sort()).toEqual(['row2', 'row3']);
    expect(planReviewWrites(rows, incoming, { source: 'google', now, full: false }).removals).toEqual([]);
  });

  it('a removed review seen again is restored; history is never hard-deleted', async () => {
    db.reviews = [{ ...native, removedAt: day(3) }];
    const out = await storeReviews('p1', [{ reviewId: native.reviewId, reviewerName: 'Ann Smith', starRating: 5, comment: 'Great pizza!', createTime: day(10) }], { source: 'google', now, full: true, complete: true });
    expect(out).toEqual({ created: 0, updated: 1, removed: 0 });
    expect(db.calls.find(([k]) => k === 'gmbReview.update')[1].data.removedAt).toBeNull();
    expect(db.calls.some(([k]) => /delete/i.test(k))).toBe(false);
  });
});

describe('cost caps', () => {
  it('reviews: newest 20 daily, full 100 when the last full refresh is ≥ 7 days old', () => {
    expect(reviewsPlan({ gmbReviewsFullAt: day(1) }, { now })).toEqual({ depth: 20, full: false });
    expect(reviewsPlan({ gmbReviewsFullAt: day(7) }, { now })).toEqual({ depth: 100, full: true });
    expect(reviewsPlan({ gmbReviewsFullAt: null }, { now })).toEqual({ depth: 100, full: true });
    expect(reviewsPlan({ gmbReviewsFullAt: day(1) }, { now, env: { GMB_REVIEWS_DAILY_DEPTH: '30' } }).depth).toBe(30);
  });

  it('profile (my_business_info) at most once per 20 h unless forced', () => {
    expect(profileDue({ gmbProfileSyncedAt: new Date(now.getTime() - 3 * 3600_000) }, { now })).toBe(false);
    expect(profileDue({ gmbProfileSyncedAt: new Date(now.getTime() - 21 * 3600_000) }, { now })).toBe(true);
    expect(profileDue({ gmbProfileSyncedAt: new Date(now.getTime() - 60_000) }, { now, force: true })).toBe(true);
  });

  it('a pending task is reused instead of posting a new one', async () => {
    const project = { id: 'p1', gmbCid: '123456789', gmbProfileSyncedAt: now, gmbReviewsFullAt: day(1), gmbReviewsTaskId: 'task-old-abcdef', gmbReviewsTaskAt: day(1), gmbReviewsTaskDepth: 20 };
    expect(pendingTask(project, now)).toMatchObject({ taskId: 'task-old-abcdef', depth: 20, full: false });
    dfs.pollAnswer = { state: 'pending' };
    const out = await syncGmbProjectViaDataForSeo(project, { now });
    expect(dfs.posts).toBe(0);
    expect(dfs.info).toBe(0); // profile fresh
    expect(dfs.polls).toEqual(['task-old-abcdef']);
    expect(out.reviewsStatus).toBe('pending');
    // The pending task id is not cleared.
    expect(db.calls.filter(([k]) => k === 'project.update').some(([, a]) => a.data.gmbReviewsTaskId === null)).toBe(false);
  });

  it('a done full fetch stores reviews, clears the task and stamps gmbReviewsFullAt', async () => {
    const project = { id: 'p1', gmbCid: '123456789', gmbProfileSyncedAt: null, gmbReviewsFullAt: null };
    dfs.pollAnswer = { state: 'ok', reviews: [{ reviewId: 'r1', reviewerName: 'A', starRating: 5, comment: 'x', createTime: day(1) }] };
    const out = await syncGmbProjectViaDataForSeo(project, { now });
    expect(dfs.info).toBe(1);
    expect(dfs.posts).toBe(1);
    expect(dfs.lastPost).toMatchObject({ cid: '123456789', depth: 100 });
    expect(out).toMatchObject({ status: 'ok', fullRefresh: true, reviews: 1 });
    const last = db.calls.filter(([k]) => k === 'project.update').pop()[1];
    expect(last.data).toMatchObject({ gmbReviewsTaskId: null, gmbReviewsFullAt: now });
    // The profile write persisted the identity fields.
    const profileWrite = db.calls.find(([k, a]) => k === 'project.update' && a.data.gmbRating != null)[1];
    expect(profileWrite.data).toMatchObject({ gmbRating: 4.6, gmbReviewsCount: 212, gmbPlaceId: 'ChIJplace1', gmbLat: 1, gmbLng: 2, gmbSyncError: null });
  });

  it('runGmbSync posts every project first, then collects (shared wait)', async () => {
    db.projects = [
      { id: 'a', gmbCid: '111111111', gmbProfileSyncedAt: now, gmbReviewsFullAt: day(1) },
      { id: 'b', gmbPlaceId: 'ChIJplace2xx', gmbProfileSyncedAt: now, gmbReviewsFullAt: day(1) },
    ];

    dfs.pollAnswer = { state: 'ok', reviews: [] };

    const out = await runGmbSync({ now });
    expect(out.total).toBe(2);
    expect(dfs.posts).toBe(2);
    expect(dfs.events).toEqual(['post', 'post', 'poll', 'poll']);
    expect(db.calls.find(([k]) => k === 'project.findMany')[1].select).toEqual(GMB_SYNC_PROJECT_SELECT);

  });
});
