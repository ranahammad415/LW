/**
 * Health score v2 factors: one pure function per factor, `factorFn(slice, cfg) → FactorResult`.
 * docs/ledger/features/health-score.md §Factors.
 *
 *   FactorResult = { key, pillar, score: number|null, weight, raw: {cur, prev, yoy}, parts: {trend, level}, reason }
 *   reason: 'ok' | 'unlinked' | 'min_volume' | 'no_data' | 'stale_source'
 *
 * Missing data is never 50 and never a penalty: a factor without enough data is null and is left out.
 */
import { trend, pl, pctDelta, seasonDelta, factorScore, clamp, isNum } from './healthMath.js';

const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);

function result(key, cfg, { t = null, l = null, raw = {}, reason } = {}) {
  const fc = cfg.factors[key];
  const score = factorScore(t, l, cfg);
  let why = reason;
  if (!why) why = score == null ? 'no_data' : 'ok';
  if (score == null && why === 'ok') why = 'no_data';
  return {
    key,
    pillar: fc.pillar,
    score,
    weight: fc.weight,
    raw: { cur: raw.cur ?? null, prev: raw.prev ?? null, yoy: raw.yoy ?? null },
    parts: { trend: r1(t), level: r1(l) },
    reason: why,
  };
}

const unlinked = (key, cfg) => result(key, cfg, { reason: 'unlinked' });

/** Trend-only volume factor (clicks, impressions, leads, GMB actions/views) with optional YoY blend. */
function volumeTrend(key, cfg, src, pick, { yoy = true, stale = false } = {}) {
  const fc = cfg.factors[key];
  const cur = pick(src.cur);
  const prev = pick(src.prev);
  const yoyVal = yoy && src.yoy?.rows ? pick(src.yoy) : null;
  const raw = { cur, prev, yoy: yoyVal };
  if (!src.cur.rows && !src.prev.rows) return result(key, cfg, { raw, reason: 'no_data' });
  if (prev < (fc.minPrior ?? 0)) return result(key, cfg, { raw, reason: 'min_volume' });
  const delta = yoy ? seasonDelta(cur, prev, yoyVal, src.yoy?.rows || 0, cfg) : pctDelta(cur, prev);
  const t = trend(delta, cfg.trendK);
  return result(key, cfg, { t, raw, reason: t == null ? 'min_volume' : stale ? 'stale_source' : 'ok' });
}

// ── Visibility (Google Search Console) ──

/** V1: organic clicks, current vs previous window (YoY blended when a year of data exists). */
export function V1(s, cfg) {
  if (!s.gsc.linked) return unlinked('V1', cfg);
  return volumeTrend('V1', cfg, s.gsc, (x) => x.clicks, { stale: s.gsc.stale });
}

/** V2: search impressions. */
export function V2(s, cfg) {
  if (!s.gsc.linked) return unlinked('V2', cfg);
  return volumeTrend('V2', cfg, s.gsc, (x) => x.impressions, { stale: s.gsc.stale });
}

const avgPos = (x) => (x.impressions > 0 ? x.posW / x.impressions : null);

/** V3: impression-weighted average position. Level from the position curve; trend = −Δ% of position. */
export function V3(s, cfg) {
  if (!s.gsc.linked) return unlinked('V3', cfg);
  const fc = cfg.factors.V3;
  const cur = avgPos(s.gsc.cur);
  const prev = avgPos(s.gsc.prev);
  const raw = { cur: r1(cur), prev: r1(prev), yoy: s.gsc.yoy?.rows ? r1(avgPos(s.gsc.yoy)) : null };
  if (!s.gsc.cur.rows) return result('V3', cfg, { raw, reason: 'no_data' });
  if (s.gsc.cur.impressions < fc.minImpr) return result('V3', cfg, { raw, reason: 'min_volume' });
  const l = pl(cur, fc.level);
  const d = s.gsc.prev.impressions >= fc.minImpr ? pctDelta(cur, prev) : null;
  const t = d == null ? null : trend(-d, cfg.trendK);
  return result('V3', cfg, { t, l, raw, reason: s.gsc.stale ? 'stale_source' : 'ok' });
}

/** V4: CTR versus the CTR expected at that position (expectedA · pos^expectedB). Level only. */
export function V4(s, cfg) {
  if (!s.gsc.linked) return unlinked('V4', cfg);
  const fc = cfg.factors.V4;
  const ctrOf = (x) => (x.impressions > 0 ? x.clicks / x.impressions : null);
  const raw = { cur: r3(ctrOf(s.gsc.cur)), prev: r3(ctrOf(s.gsc.prev)), yoy: null };
  if (!s.gsc.cur.rows) return result('V4', cfg, { raw, reason: 'no_data' });
  if (s.gsc.cur.impressions < fc.minImpr) return result('V4', cfg, { raw, reason: 'min_volume' });
  const pos = Math.max(1, avgPos(s.gsc.cur) || 1);
  const expected = fc.expectedA * pos ** fc.expectedB;
  const ratio = ctrOf(s.gsc.cur) / expected;
  const l = clamp(ratio * fc.gain, 10, 100);
  return result('V4', cfg, { l, raw, reason: s.gsc.stale ? 'stale_source' : 'ok' });
}

// ── Engagement (GA4) ──

/** E1: sessions trend. A GA4 property younger than shortWindowUntilDays uses 14/14-day windows, no YoY. */
export function E1(s, cfg) {
  if (!s.ga4.linked) return unlinked('E1', cfg);
  if (s.ga4.young) {
    return volumeTrend('E1', cfg, { cur: s.ga4.shortCur, prev: s.ga4.shortPrev, yoy: null }, (x) => x.sessions, { yoy: false });
  }
  return volumeTrend('E1', cfg, s.ga4, (x) => x.sessions);
}

/**
 * Level (pl curve on the current 28 days) + trend (Δ% vs the prior 28 days, `invert` when lower is better) of a
 * session-weighted GA4 rate. Both halves need minSessions in their window; blend 0.6 / 0.4 when both exist.
 */
function ga4RateFactor(key, s, cfg, weighted, { invert = false } = {}) {
  if (!s.ga4.linked) return unlinked(key, cfg);
  const fc = cfg.factors[key];
  const v = (x) => (x.sessions > 0 ? x[weighted] / x.sessions : null);
  const cur = v(s.ga4.cur);
  const prev = v(s.ga4.prev);
  const raw = { cur: r1(cur), prev: r1(prev), yoy: null };
  if (!s.ga4.cur.rows) return result(key, cfg, { raw, reason: 'no_data' });
  if (s.ga4.cur.sessions < fc.minSessions) return result(key, cfg, { raw, reason: 'min_volume' });
  const l = pl(cur, fc.level);
  const d = s.ga4.prev.sessions >= fc.minSessions ? pctDelta(cur, prev) : null;
  const t = d == null ? null : trend(invert ? -d : d, cfg.trendK);
  return result(key, cfg, { t, l, raw });
}

/** E2: engagement quality, session-weighted average engagement time (s): level + trend. */
export function E2(s, cfg) {
  return ga4RateFactor('E2', s, cfg, 'engW');
}

/** E3: session-weighted bounce rate (%; GA4 0–1 fractions normalised): level + inverted trend (a drop is good). */
export function E3(s, cfg) {
  return ga4RateFactor('E3', s, cfg, 'bounceW', { invert: true });
}

// ── Leads ──

const leadTotal = (x) => (x.leads || 0) + (x.phoneClicks || 0) + (x.emailClicks || 0);

/** L1: first-party leads (forms + thank-you views) + phone clicks + email clicks, trend. */
export function L1(s, cfg) {
  if (!s.leads.linked) return unlinked('L1', cfg);
  return volumeTrend('L1', cfg, s.leads, leadTotal);
}

/** L2: lead conversion rate = L1 total / GA4 sessions × 100. Level only. */
export function L2(s, cfg) {
  if (!s.leads.linked || !s.ga4.linked) return unlinked('L2', cfg);
  const fc = cfg.factors.L2;
  const rate = (l, g) => (g.sessions > 0 ? (leadTotal(l) / g.sessions) * 100 : null);
  const raw = { cur: r3(rate(s.leads.cur, s.ga4.cur)), prev: r3(rate(s.leads.prev, s.ga4.prev)), yoy: null };
  if (s.ga4.cur.sessions < fc.minSessions) return result('L2', cfg, { raw, reason: 'min_volume' });
  return result('L2', cfg, { l: pl(rate(s.leads.cur, s.ga4.cur), fc.level), raw });
}

/** L3: GA4 conversions, 28 vs prior 28, trend only (often null: many properties report 0 conversions). */
export function L3(s, cfg) {
  if (!s.ga4.linked) return unlinked('L3', cfg);
  return volumeTrend('L3', cfg, s.ga4, (x) => x.conversions || 0, { yoy: false });
}

// ── Reputation (Google Business Profile reviews) ──

/**
 * R1: the profile rating (Project.gmbRating, live scores) when present, else the average star rating of the last
 * `lastN` stored reviews. Level only. The profile count (gmbReviewsCount) is the volume check for the profile rating.
 */
export function R1(s, cfg) {
  if (!s.reviews.linked) return unlinked('R1', cfg);
  const fc = cfg.factors.R1;
  const pr = s.reviews.profileRating;
  if (typeof pr === 'number' && Number.isFinite(pr)) {
    const raw = { cur: r1(pr), prev: null, yoy: null };
    const count = s.reviews.profileCount;
    if (count != null && count < fc.minReviews) return result('R1', cfg, { raw, reason: 'min_volume' });
    return result('R1', cfg, { l: pl(pr, fc.level), raw });
  }
  const list = [...s.reviews.list].sort((a, b) => (a.createTime < b.createTime ? 1 : -1)).slice(0, fc.lastN);
  const avg = list.length ? list.reduce((t, r) => t + (Number(r.starRating) || 0), 0) / list.length : null;
  const raw = { cur: r1(avg), prev: null, yoy: null };
  if (!list.length) return result('R1', cfg, { raw, reason: 'no_data' });
  if (list.length < fc.minReviews) return result('R1', cfg, { raw, reason: 'min_volume' });
  return result('R1', cfg, { l: pl(avg, fc.level), raw });
}

function inRange(iso, range) {
  const d = iso.slice(0, 10);
  return d >= range.from && d <= range.to;
}

/** R2: new reviews in the current window (level) and versus the previous window (trend when prev ≥ minPrior). */
export function R2(s, cfg) {
  if (!s.reviews.linked) return unlinked('R2', cfg);
  const fc = cfg.factors.R2;
  const cur = s.reviews.list.filter((r) => inRange(r.createTime, s.windows.cur)).length;
  const prev = s.reviews.list.filter((r) => inRange(r.createTime, s.windows.prev)).length;
  const raw = { cur, prev, yoy: null };
  const l = pl(cur, fc.level);
  const t = prev >= fc.minPrior ? trend(pctDelta(cur, prev), cfg.trendK) : null;
  return result('R2', cfg, { t, l, raw });
}

/** R3: share of reviews from the last `days` days that have an owner reply (%). Level only. */
export function R3(s, cfg) {
  if (!s.reviews.linked) return unlinked('R3', cfg);
  const fc = cfg.factors.R3;
  const from = new Date(Date.parse(`${s.date}T00:00:00Z`) - fc.days * 86_400_000).toISOString().slice(0, 10);
  const recent = s.reviews.list.filter((r) => r.createTime.slice(0, 10) > from);
  const rate = recent.length ? (recent.filter((r) => r.replied).length / recent.length) * 100 : null;
  const raw = { cur: r1(rate), prev: null, yoy: null };
  if (!recent.length) return result('R3', cfg, { raw, reason: 'no_data' });
  if (recent.length < fc.minReviews) return result('R3', cfg, { raw, reason: 'min_volume' });
  return result('R3', cfg, { l: pl(rate, fc.level), raw });
}

/** R4: Google Business Profile actions (calls + directions + website clicks), 28 vs prior 28 + YoY blend. */
export function R4(s, cfg) {
  if (!s.gmb.linked) return unlinked('R4', cfg);
  return volumeTrend('R4', cfg, s.gmb, (x) => (x.calls || 0) + (x.directions || 0) + (x.websiteClicks || 0));
}

// ── Website & security ──

/** Only these site states are scored by S1; anything else (`unknown`, the §38.9 check state `n/a`) is "no data". */
const S1_SCORED = new Set(['ok', 'warn', 'fail']);

/**
 * S1: site security state (EmDash security capability). A failing critical/high check is always `fail`.
 * `n/a` (contract v1.7.0 §38.9: a feature switched off) is treated like unknown: excluded, never scored.
 */
export function S1(s, cfg) {
  if (!s.security.linked) return unlinked('S1', cfg);
  const fc = cfg.factors.S1;
  const raw = s.security.criticalFail ? 'fail' : s.security.state;
  const state = S1_SCORED.has(raw) ? raw : null;
  const l = state && isNum(fc.states[state]) ? fc.states[state] : null;
  return result('S1', cfg, { l, raw: { cur: state || 'unknown', prev: null, yoy: null }, reason: l == null ? 'no_data' : 'ok' });
}

/** S2: backups over the last `days` days: worst failed/missed streak per destination; verified runs score highest. */
export function S2(s, cfg) {
  if (!s.backups.linked) return unlinked('S2', cfg);
  const fc = cfg.factors.S2;
  const runs = s.backups.runs || [];
  if (!runs.length) return result('S2', cfg, { raw: { cur: 0, prev: null, yoy: null }, reason: 'no_data' });
  const byDest = new Map();
  for (const r of runs) {
    if (!byDest.has(r.destinationId)) byDest.set(r.destinationId, []);
    byDest.get(r.destinationId).push(r);
  }
  let worst = 0;
  let allVerified = true;
  for (const list of byDest.values()) {
    list.sort((a, b) => (a.at < b.at ? 1 : -1));
    let streak = 0;
    for (const r of list) {
      if (r.result === 'ok') break;
      streak += 1;
    }
    worst = Math.max(worst, streak);
    const lastOk = list.find((r) => r.result === 'ok');
    if (!lastOk?.verified) allVerified = false;
  }
  const l = worst >= 2 ? fc.scores.miss2plus : worst === 1 ? fc.scores.miss1 : allVerified ? fc.scores.okVerified : fc.scores.ok;
  return result('S2', cfg, { l, raw: { cur: worst, prev: null, yoy: null } });
}

/** S3: site connection freshness (EmDash heartbeat / WordPress site-info sync). Not scored for backfilled dates. */
export function S3(s, cfg) {
  if (s.backfilled) return result('S3', cfg, { reason: 'no_data' });
  if (!s.connection.linked) return unlinked('S3', cfg);
  const fc = cfg.factors.S3;
  if (s.connection.broken) return result('S3', cfg, { l: fc.beyond, raw: { cur: 'broken', prev: null, yoy: null } });
  const age = s.connection.ageDays;
  if (!isNum(age)) return result('S3', cfg, { reason: 'no_data' });
  const step = [...fc.ageDays].sort((a, b) => a[0] - b[0]).find(([maxAge]) => age <= maxAge);
  return result('S3', cfg, { l: step ? step[1] : fc.beyond, raw: { cur: r1(age), prev: null, yoy: null } });
}

export const FACTOR_REGISTRY = Object.freeze({ V1, V2, V3, V4, E1, E2, E3, L1, L2, L3, R1, R2, R3, R4, S1, S2, S3 });

/** Every configured factor that has an implementation, in registry order. */
export function computeFactors(slice, cfg) {
  return Object.keys(FACTOR_REGISTRY)
    .filter((k) => cfg.factors?.[k])
    .map((k) => FACTOR_REGISTRY[k](slice, cfg));
}
