/**
 * GmbReview storage shared by the native and DataForSEO paths (docs/ledger/features/local-seo.md §Reviews).
 *
 * - Dedupe across sources: the two sources use different review ids for the same review, so each review also gets a
 *   content fingerprint sha256(author | stars | sha256(text)). An incoming review matches an existing row by reviewId
 *   first, else by fingerprint with createTime within REVIEW_TIME_TOLERANCE_MS (sources round times differently).
 *   A match updates the existing row (its reviewId is kept), so switching sources never duplicates history.
 * - Soft removal: after a FULL fetch, rows that should have been in the list but were not get `removedAt` (never a
 *   hard delete). Complete list (fewer items than the depth asked for): every unmatched active row. Truncated list:
 *   only unmatched rows newer than the oldest review returned. A review seen again clears `removedAt`.
 * - Views, reports and health read `removedAt: null` rows only.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';

export const REVIEW_TIME_TOLERANCE_MS = 72 * 3600_000;
const EXISTING_TAKE = 5000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function normalizeReviewText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\(translated by google\)[\s\S]*?\(original\)/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 2000);
}

/** Content fingerprint (64 hex chars). Pure. */
export function reviewFingerprint(r) {
  const author = normalizeReviewText(r?.reviewerName);
  const stars = Number(r?.starRating) || 0;
  return sha(`${author}|${stars}|${sha(normalizeReviewText(r?.comment))}`);
}

function timeOf(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

export function timesClose(a, b, tol = REVIEW_TIME_TOLERANCE_MS) {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta == null || tb == null) return true;
  return Math.abs(ta - tb) <= tol;
}

/**
 * Plan the writes for one batch. Pure.
 * @param {Array} existing rows {id, reviewId, fingerprint, reviewerName, starRating, comment, createTime, removedAt}
 * @param {Array} incoming normalised reviews {reviewId, reviewerName, starRating, comment, replyComment, createTime, updateTime}
 * @param {{ source: string, now?: Date, full?: boolean, complete?: boolean }} opts
 * @returns {{ creates: object[], updates: {id: string, data: object}[], removals: string[], matched: number }}
 */
export function planReviewWrites(existing, incoming, { source, now = new Date(), full = false, complete = false } = {}) {
  const byId = new Map();
  const byFp = new Map();
  for (const row of existing || []) {
    byId.set(String(row.reviewId), row);
    const fp = row.fingerprint || reviewFingerprint(row);
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(row);
  }
  const claimed = new Set();
  const creates = [];
  const updates = [];
  const seenIncoming = new Set();
  let oldestIncoming = null;

  for (const r of incoming || []) {
    if (!r?.reviewId || !r.starRating) continue;
    const reviewId = String(r.reviewId).slice(0, 200);
    if (seenIncoming.has(reviewId)) continue;
    seenIncoming.add(reviewId);
    const fingerprint = reviewFingerprint(r);
    const t = timeOf(r.createTime);
    if (t != null && (oldestIncoming == null || t < oldestIncoming)) oldestIncoming = t;

    let row = byId.get(reviewId);
    if (row && claimed.has(row.id)) row = null;
    if (!row) {
      row = (byFp.get(fingerprint) || []).find((x) => !claimed.has(x.id) && timesClose(x.createTime, r.createTime)) || null;
    }
    const fields = {
      reviewerName: r.reviewerName ?? null,
      starRating: r.starRating,
      comment: r.comment ?? null,
      replyComment: r.replyComment ?? null,
      updateTime: r.updateTime ?? null,
      source,
      fingerprint,
      lastSeenAt: now,
      removedAt: null,
    };
    if (row) {
      claimed.add(row.id);
      // Keep the first known createTime (sources disagree by hours); fill it when missing.
      updates.push({ id: row.id, data: row.createTime ? fields : { ...fields, createTime: r.createTime ?? null } });
    } else {
      creates.push({ reviewId, createTime: r.createTime ?? null, ...fields });
    }
  }

  const removals = [];
  if (full) {
    for (const row of existing || []) {
      if (claimed.has(row.id) || row.removedAt) continue;
      const t = timeOf(row.createTime);
      if (complete || (t != null && oldestIncoming != null && t >= oldestIncoming)) removals.push(row.id);
    }
  }
  return { creates, updates, removals, matched: claimed.size };
}

/**
 * Store a batch for one project. `full` = the fetch asked for the full depth; `complete` = the source returned fewer
 * reviews than asked (so the list is the whole profile). Returns counts.
 */
export async function storeReviews(projectId, incoming, { source, now = new Date(), full = false, complete = false } = {}) {
  const existing = await prisma.gmbReview.findMany({
    where: { projectId },
    select: { id: true, reviewId: true, fingerprint: true, reviewerName: true, starRating: true, comment: true, createTime: true, removedAt: true },
    orderBy: { createTime: 'desc' },
    take: EXISTING_TAKE,
  });
  const plan = planReviewWrites(existing, incoming, { source, now, full, complete });
  for (const c of plan.creates) {
    await prisma.gmbReview.upsert({
      where: { projectId_reviewId: { projectId, reviewId: c.reviewId } },
      create: { projectId, ...c },
      update: { ...c },
    });
  }
  for (const u of plan.updates) {
    await prisma.gmbReview.update({ where: { id: u.id }, data: u.data });
  }
  if (plan.removals.length) {
    await prisma.gmbReview.updateMany({ where: { id: { in: plan.removals }, removedAt: null }, data: { removedAt: now } });
  }
  return { created: plan.creates.length, updated: plan.updates.length, removed: plan.removals.length };
}
