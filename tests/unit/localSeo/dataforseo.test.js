/**
 * Local SEO: DataForSEO status codes (top level + task level), timeouts, reviews task polling (40601 / 40602 pending,
 * 20000 done, other 4xxxx fatal), profile parsing and Find-business candidates. Fixtures only, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseDfsTask,
  classifyDfsCode,
  postDataForSeo,
  DataForSeoError,
} from '../../../src/lib/dataforseo/client.js';
import {
  pollReviewsTask,
  getReviewsTask,
  fetchGmbInfo,
  searchBusinessCandidates,
  reviewsTaskBody,
  postReviewsTask,
  normalizeReview,
  locationCode,
  REVIEWS_POLL_DELAYS_S,
} from '../../../src/lib/omniSearch/businessDataProvider.js';

const task = (status_code, extra = {}) => ({ status_code: 20000, tasks: [{ id: 't-123456789', status_code, status_message: `msg ${status_code}`, cost: 0.0054, ...extra }] });

describe('DataForSEO status codes', () => {
  it('classifies codes', () => {
    expect(classifyDfsCode(20000)).toBe('ok');
    expect(classifyDfsCode(20100)).toBe('ok');
    expect(classifyDfsCode(40601)).toBe('pending');
    expect(classifyDfsCode(40602)).toBe('pending');
    expect(classifyDfsCode(40102)).toBe('no_results');
    expect(classifyDfsCode(40100)).toBe('account');
    expect(classifyDfsCode(40210)).toBe('account');
    expect(classifyDfsCode(50000)).toBe('account');
    expect(classifyDfsCode(40501)).toBe('error');
    expect(classifyDfsCode(40401)).toBe('error');
  });

  it('checks the task level even when HTTP and the top level are fine', () => {
    expect(parseDfsTask(task(20000, { result: [{ items: [1] }] }))).toMatchObject({ state: 'ok', result: { items: [1] }, costUsd: 0.0054 });
    expect(parseDfsTask(task(40602)).state).toBe('pending');
    expect(parseDfsTask(task(40601)).state).toBe('pending');
    expect(parseDfsTask(task(40102)).state).toBe('no_results');
    expect(() => parseDfsTask(task(40501))).toThrow(DataForSeoError);
    try {
      parseDfsTask(task(40210));
    } catch (e) {
      expect(e.accountLevel).toBe(true);
      expect(e.code).toBe('DFS_40210');
    }
  });

  it('a top-level error throws before the task is read', () => {
    expect(() => parseDfsTask({ status_code: 40100, status_message: 'not authorized', tasks: [] })).toThrow(/40100/);
    expect(() => parseDfsTask({ status_code: 20000, tasks: [] })).toThrow(/no task/);
  });

  it('every request has a timeout (abort → DataForSeoError, not accountLevel)', async () => {
    process.env.DATAFORSEO_LOGIN = 'l';
    process.env.DATAFORSEO_PASSWORD = 'p';
    const fetchImpl = (_url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    await expect(postDataForSeo('/v3/x', [{}], { timeoutMs: 20, fetchImpl })).rejects.toMatchObject({ name: 'DataForSeoError', accountLevel: false });
    const http402 = async () => ({ ok: false, status: 402 });
    await expect(postDataForSeo('/v3/x', [{}], { fetchImpl: http402 })).rejects.toMatchObject({ httpStatus: 402, accountLevel: true, message: 'DataForSEO 402' });
  });
});

describe('reviews task polling', () => {
  const ready = task(20000, { result: [{ reviews_count: 57, rating: { value: 4.6 }, items: [{ review_id: 'r1', profile_name: 'Ann', rating: { value: 5 }, review_text: 'Great', timestamp: '2026-10-01 09:12:44 +00:00', owner_answer: 'Thanks' }] }] });

  it('40601 and 40602 are pending; 20000 returns the reviews', async () => {
    const answers = [task(40601), task(40602), ready];
    const get = vi.fn(async () => answers.shift());
    const sleep = vi.fn(async () => {});
    const r = await pollReviewsTask('t-123456789', { get, sleep });
    expect(r.state).toBe('ok');
    expect(r.total).toBe(57);
    expect(r.reviews[0]).toMatchObject({ reviewId: 'r1', starRating: 5, replyComment: 'Thanks' });
    expect(r.reviews[0].createTime.toISOString()).toBe('2026-10-01T09:12:44.000Z');
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
  });

  it('any other 4xxxx task code is fatal (no further polling)', async () => {
    const get = vi.fn(async () => task(40401));
    await expect(pollReviewsTask('t-123456789', { get, sleep: async () => {} })).rejects.toThrow(/40401/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('budget ~3 minutes with back-off, then pending (task id kept by the caller, never re-posted)', async () => {
    expect(REVIEWS_POLL_DELAYS_S.reduce((s, d) => s + d, 0)).toBe(180);
    const get = vi.fn(async () => task(40602));
    const r = await pollReviewsTask('t-123456789', { get, sleep: async () => {} });
    expect(r).toEqual({ state: 'pending' });
    expect(get).toHaveBeenCalledTimes(REVIEWS_POLL_DELAYS_S.length + 1);
  });

  it('task ids are validated before building the path', async () => {
    await expect(getReviewsTask('../../evil', { get: async () => ready })).rejects.toThrow(/Invalid task id/);
  });

  it('task body: cid first, then place_id, then keyword; newest first', () => {
    expect(reviewsTaskBody({ cid: '123', placeId: 'ChIJx', depth: 20, locationCode: 1, languageCode: 'en' })).toEqual({ cid: '123', location_code: 1, language_code: 'en', depth: 20, sort_by: 'newest' });
    expect(reviewsTaskBody({ placeId: 'ChIJx', depth: 100, locationCode: 1 })).toMatchObject({ place_id: 'ChIJx', depth: 100 });
    expect(reviewsTaskBody({ keyword: 'Joe Pizza Milwaukee', depth: 20, locationCode: 1 })).toMatchObject({ keyword: 'Joe Pizza Milwaukee' });
  });

  it('task_post with a failed task throws (no task id stored)', async () => {
    await expect(postReviewsTask({ cid: '1', depth: 20 }, { post: async () => task(40501) })).rejects.toThrow(/40501/);
    expect(await postReviewsTask({ cid: '1', depth: 20 }, { post: async () => task(20100) })).toEqual({ taskId: 't-123456789', costUsd: 0.0054 });
  });

  it('normalises DataForSEO review items', () => {
    expect(normalizeReview({ review_id: 'x', rating: { value: 4 }, review_text: null, timestamp: 'bad' })).toMatchObject({ reviewId: 'x', starRating: 4, createTime: null });
  });
});

describe('profile and candidates', () => {
  const INFO_ITEM = {
    type: 'google_business_info', title: 'Joe Pizza', address: '1 Main St, Milwaukee', phone: '+1 414', url: 'https://www.joespizza.com/',
    domain: 'www.joespizza.com', category: 'Pizza restaurant', rating: { value: 4.6, votes_count: 212 }, cid: '194604053573767737',
    place_id: 'ChIJ_test_place_1234', feature_id: '0x1:0x2', latitude: 43.04, longitude: -87.9, is_claimed: true,
  };

  it('persists every identity field of a my_business_info item', async () => {
    const post = vi.fn(async () => task(20000, { result: [{ items: [INFO_ITEM] }] }));
    const info = await fetchGmbInfo({ identifier: 'cid:194604053573767737', locationCode: 1023191, post });
    expect(post.mock.calls[0][0]).toBe('/v3/business_data/google/my_business_info/live');
    expect(post.mock.calls[0][1][0]).toMatchObject({ keyword: 'cid:194604053573767737', location_code: 1023191, language_code: 'en' });
    expect(info).toMatchObject({
      title: 'Joe Pizza', cid: '194604053573767737', placeId: 'ChIJ_test_place_1234', featureId: '0x1:0x2', lat: 43.04, lng: -87.9,
      address: '1 Main St, Milwaukee', phone: '+1 414', category: 'Pizza restaurant', url: 'https://www.joespizza.com/', rating: 4.6, reviewsCount: 212, costUsd: 0.0054,
    });
  });

  it('no results (40102) is null, a task error throws', async () => {
    expect(await fetchGmbInfo({ identifier: 'cid:1', post: async () => task(40102) })).toBeNull();
    await expect(fetchGmbInfo({ identifier: 'cid:1', post: async () => task(40501) })).rejects.toThrow(/40501/);
  });

  it('Find business: one Maps search (depth 20), at most 5 candidates with an id', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ type: 'maps_search', title: `B${i}`, cid: String(1000 + i), place_id: `ChIJplace${i}xxxxxx`, rating: { value: 4, votes_count: i } }));
    items.splice(1, 0, { type: 'maps_search', title: 'no id' });
    const post = vi.fn(async () => task(20000, { result: [{ items }] }));
    const out = await searchBusinessCandidates({ query: 'Joe Pizza Milwaukee', post });
    expect(post.mock.calls[0][0]).toBe('/v3/serp/google/maps/live/advanced');
    expect(post.mock.calls[0][1][0].depth).toBe(20);
    expect(out.candidates).toHaveLength(5);
    expect(out.candidates.map((c) => c.cid)).toEqual(['1000', '1001', '1002', '1003', '1004']);
  });

  it('location: project location_code, else GMB_DFS_LOCATION_CODE, else US', () => {
    expect(locationCode({ localLocationCode: 1023191 }, {})).toBe(1023191);
    expect(locationCode({}, { GMB_DFS_LOCATION_CODE: '2826' })).toBe(2826);
    expect(locationCode(null, {})).toBe(2840);
  });
});
