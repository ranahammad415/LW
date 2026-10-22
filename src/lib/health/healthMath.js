/**
 * Health score v2: pure maths (no I/O). docs/ledger/features/health-score.md §Formula.
 * Dates are `YYYY-MM-DD` UTC strings throughout.
 */

export const MS_DAY = 86_400_000;

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** trend(delta%) = clamp(50 + 50·tanh(delta / k), 10, 100); null in → null out. */
export function trend(delta, k = 25) {
  if (!isNum(delta)) return null;
  return clamp(50 + 50 * Math.tanh(delta / k), 10, 100);
}

/** Piecewise-linear through [x, y] points (sorted by x here), clamped at the ends. */
export function pl(x, points) {
  if (!isNum(x) || !Array.isArray(points) || !points.length) return null;
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** blend(t, l): both null → null; one null → the other; else wt·t + wl·l. */
export function blend(t, l, weights = { trend: 0.6, level: 0.4 }) {
  const tn = isNum(t) ? t : null;
  const ln = isNum(l) ? l : null;
  if (tn == null && ln == null) return null;
  if (tn == null) return ln;
  if (ln == null) return tn;
  return weights.trend * tn + weights.level * ln;
}

/** (cur − prev) / prev · 100, or null when prev is not positive. */
export function pctDelta(cur, prev) {
  if (!isNum(cur) || !isNum(prev) || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * Season-aware delta: when a year-ago window has enough rows, blend the YoY and the previous-window delta
 * (yoyShare · YoY + (1 − yoyShare) · prev); otherwise just the previous-window delta.
 */
export function seasonDelta(cur, prev, yoy, yoyRows, cfg) {
  const dPrev = pctDelta(cur, prev);
  const minRows = cfg?.window?.yoyMinCoverageDays ?? 20;
  const share = cfg?.yoyShare ?? 0.5;
  const dYoy = yoy != null && yoyRows >= minRows ? pctDelta(cur, yoy) : null;
  if (dYoy == null) return dPrev;
  if (dPrev == null) return dYoy;
  return share * dYoy + (1 - share) * dPrev;
}

/** Final factor score: max(floor, round(blend)) or null. */
export function factorScore(t, l, cfg) {
  const b = blend(t, l, cfg?.blend);
  if (b == null) return null;
  return Math.max(cfg?.factorFloor ?? 10, Math.round(b));
}

/** Weighted mean of the scored items ({score, weight}), floored; null when none scored. */
export function pillarScore(items, floor = 5) {
  let num = 0;
  let den = 0;
  for (const it of items || []) {
    if (!isNum(it?.score) || !isNum(it?.weight) || it.weight <= 0) continue;
    num += it.weight * it.score;
    den += it.weight;
  }
  if (den <= 0) return null;
  return Math.max(floor, Math.round(num / den));
}

/**
 * Renormalise pillar scores over the profile weights. Pillars with weight 0 are ignored (not in coverage);
 * a pillar with a null score is excluded from the score and lowers coverage. No score unless
 * coverage ≥ minCoverage and at least minPillars pillars are scored.
 * @returns {{ score: number|null, rawScore: number|null, coverage: number, scoredPillars: number }}
 */
export function renormalize(pillarScores, weights, { minCoverage = 40, minPillars = 2 } = {}) {
  let all = 0;
  let scoredW = 0;
  let num = 0;
  let scoredPillars = 0;
  for (const [pillar, w] of Object.entries(weights || {})) {
    if (!isNum(w) || w <= 0) continue;
    all += w;
    const s = pillarScores?.[pillar];
    if (!isNum(s)) continue;
    scoredW += w;
    num += w * s;
    scoredPillars += 1;
  }
  const coverage = all > 0 ? Math.round((100 * scoredW) / all) : 0;
  const rawScore = scoredW > 0 ? Math.round(num / scoredW) : null;
  const show = rawScore != null && coverage >= minCoverage && scoredPillars >= minPillars;
  return { score: show ? rawScore : null, rawScore, coverage, scoredPillars };
}

// ── dates ──

export function toDateStr(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  const t = Date.parse(`${toDateStr(dateStr)}T00:00:00.000Z`) + n * MS_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from a to b (b − a). */
export function dayDiff(a, b) {
  return Math.round((Date.parse(`${toDateStr(b)}T00:00:00.000Z`) - Date.parse(`${toDateStr(a)}T00:00:00.000Z`)) / MS_DAY);
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Windows for a score date: anchor = date − gscLagDays; cur = [anchor−(days−1), anchor];
 * prev = the `days` before cur; yoy = cur shifted −364 days (same weekdays). short = 14/14 split of cur+prev
 * for sources younger than two windows (E1).
 */
export function windowsFor(dateStr, cfg) {
  const days = cfg?.window?.days ?? 28;
  const lag = cfg?.window?.gscLagDays ?? 2;
  const anchor = addDays(dateStr, -lag);
  const cur = { from: addDays(anchor, -(days - 1)), to: anchor };
  const prev = { from: addDays(anchor, -(2 * days - 1)), to: addDays(anchor, -days) };
  const yoy = { from: addDays(cur.from, -364), to: addDays(cur.to, -364) };
  const half = Math.floor(days / 2);
  const shortCur = { from: addDays(anchor, -(half - 1)), to: anchor };
  const shortPrev = { from: addDays(anchor, -(2 * half - 1)), to: addDays(anchor, -half) };
  return { date: toDateStr(dateStr), anchor, cur, prev, yoy, shortCur, shortPrev, days };
}

/**
 * Sum fields over [from, to] of a Map(dateStr → row). Returns { rows, ...sums } where `rows` counts days that
 * had a row. A day without a row adds nothing.
 */
export function sumRange(byDate, range, fields) {
  const out = { rows: 0 };
  for (const f of fields) out[f] = 0;
  if (!byDate || !range) return out;
  let d = range.from;
  for (let i = 0; i < 400 && d <= range.to; i += 1) {
    const r = byDate.get(d);
    if (r) {
      out.rows += 1;
      for (const f of fields) out[f] += Number(r[f]) || 0;
    }
    d = addDays(d, 1);
  }
  return out;
}

/** Band key for a score from config bands ([[80,'excellent'],…]); null score → null. */
export function bandFor(score, bands) {
  if (!isNum(score)) return null;
  const sorted = [...(bands || [])].sort((a, b) => b[0] - a[0]);
  for (const [min, key] of sorted) if (score >= min) return key;
  return sorted.length ? sorted[sorted.length - 1][1] : null;
}

/** Band rank (higher = better) for alert comparisons. */
export function bandRank(band, bands) {
  const sorted = [...(bands || [])].sort((a, b) => a[0] - b[0]);
  return sorted.findIndex((b) => b[1] === band);
}

/** ▲ / ▼ / → for score − score 28 days ago. */
export function trendArrow(delta, threshold = 3) {
  if (!isNum(delta)) return null;
  if (delta >= threshold) return 'up';
  if (delta <= -threshold) return 'down';
  return 'flat';
}
