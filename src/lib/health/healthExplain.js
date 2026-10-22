/**
 * Health score v2 explanations: per-factor contributions, "why it changed" between two rows, and the fixed
 * plain-language sentences clients see. docs/ledger/features/health-score.md §Explain.
 *
 * Client sentences are fixed templates filled from factor values. Security sentences are words only: never a
 * number, a check id or a score (owner decision O-4).
 */
import { isNum, pctDelta } from './healthMath.js';

export const PILLAR_LABELS = Object.freeze({
  visibility: { staff: 'Visibility', client: 'Search visibility' },
  engagement: { staff: 'Engagement', client: 'Website engagement' },
  leads: { staff: 'Leads', client: 'Enquiries' },
  reputation: { staff: 'Reputation', client: 'Reviews' },
  aiVisibility: { staff: 'AI visibility', client: 'AI answers' },
  site: { staff: 'Site & security', client: 'Website & security' },
  content: { staff: 'Content', client: 'Content' },
});

export const FACTOR_LABELS = Object.freeze({
  V1: 'Google clicks', V2: 'Search impressions', V3: 'Average position', V4: 'CTR vs expected',
  E1: 'Sessions', E2: 'Engagement quality', E3: 'Bounce rate',
  L1: 'Leads (forms, calls, emails)', L2: 'Lead conversion rate', L3: 'GA4 conversions',
  R1: 'Average rating', R2: 'New reviews', R3: 'Review reply rate', R4: 'Google Business actions',
  S1: 'Security state', S2: 'Backups', S3: 'Site connection',
});

/**
 * Points each factor contributes to the project score: (pillar weight share among scored pillars) ×
 * (factor weight share among scored factors of the pillar) × factor score. Sums to the (unfloored) score.
 */
export function contributions(row) {
  const pillars = row?.pillars || {};
  const factors = Array.isArray(row?.factors) ? row.factors : [];
  const scoredPillars = Object.entries(pillars).filter(([, p]) => isNum(p?.score) && p.weight > 0);
  const totalW = scoredPillars.reduce((t, [, p]) => t + p.weight, 0);
  const out = {};
  for (const [key, p] of scoredPillars) {
    const fs = factors.filter((f) => f.pillar === key && isNum(f.score) && f.weight > 0);
    const fw = fs.reduce((t, f) => t + f.weight, 0);
    for (const f of fs) out[f.key] = totalW > 0 && fw > 0 ? (p.weight / totalW) * (f.weight / fw) * f.score : 0;
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Why the score moved from baseRow to todayRow: per factor, the change in contribution (points), sorted by size.
 * Factors that appeared or disappeared (coverage changes) are included with their full contribution.
 */
export function explainChange(todayRow, baseRow) {
  const now = contributions(todayRow);
  const base = contributions(baseRow);
  const nowF = new Map((todayRow?.factors || []).map((f) => [f.key, f]));
  const baseF = new Map((baseRow?.factors || []).map((f) => [f.key, f]));
  const keys = new Set([...Object.keys(now), ...Object.keys(base)]);
  return [...keys]
    .map((key) => {
      const f = nowF.get(key) || baseF.get(key);
      return {
        key,
        label: FACTOR_LABELS[key] || key,
        pillar: f?.pillar || null,
        delta: round1((now[key] || 0) - (base[key] || 0)),
        scoreNow: nowF.get(key)?.score ?? null,
        scoreBase: baseF.get(key)?.score ?? null,
        rawNow: nowF.get(key)?.raw ?? null,
        rawBase: baseF.get(key)?.raw ?? null,
      };
    })
    .filter((x) => x.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** Top n positive and negative movers from explainChange output. */
export function topMovers(explain, n = 3) {
  return {
    up: explain.filter((x) => x.delta > 0).slice(0, n),
    down: explain.filter((x) => x.delta < 0).slice(0, n),
  };
}

// ── client sentences ──

const MOVE_MIN = 5; // % change needed before a volume factor is worth a sentence

function moveSentence(f, what) {
  const d = pctDelta(Number(f.raw?.cur), Number(f.raw?.prev));
  if (!isNum(d) || Math.abs(d) < MOVE_MIN) return null;
  const abs = Math.round(Math.abs(d));
  return { kind: d > 0 ? 'up' : 'down', weight: Math.abs(d), text: `${what} ${d > 0 ? 'up' : 'down'} ${abs}% versus the previous 4 weeks` };
}

const level = (f, good, bad, { hi = 70, lo = 40 } = {}) => {
  if (!isNum(f.score)) return null;
  if (f.score >= hi) return { kind: 'up', weight: f.score - 50, text: good };
  if (f.score < lo) return { kind: 'down', weight: 50 - f.score, text: bad };
  return null;
};

/** One sentence (or null) per factor. Fixed templates; no ids; security sentences contain no numbers. */
export const SENTENCES = {
  V1: (f) => moveSentence(f, 'Google clicks are'),
  V2: (f) => moveSentence(f, 'Appearances in Google search are'),
  V3: (f) => {
    const d = pctDelta(Number(f.raw?.cur), Number(f.raw?.prev));
    if (!isNum(d) || Math.abs(d) < MOVE_MIN) return null;
    return d < 0
      ? { kind: 'up', weight: Math.abs(d), text: 'Your average position in Google improved' }
      : { kind: 'down', weight: Math.abs(d), text: 'Your average position in Google slipped' };
  },
  V4: (f) => level(f, 'Searchers click your Google listing more often than usual for its position', 'Fewer searchers click your Google listing than expected for its position'),
  E1: (f) => moveSentence(f, 'Website visits are'),
  E2: (f) => level(f, 'Visitors spend a good amount of time on your website', 'Visitors leave your website quickly'),
  E3: (f) => level(f, 'Most visitors go on to view more of your website', 'Many visitors leave after viewing one page'),
  L1: (f) => moveSentence(f, 'Enquiries (forms, calls and emails) are'),
  L2: (f) => level(f, 'A healthy share of website visitors get in touch', 'Few website visitors get in touch yet'),
  L3: (f) => moveSentence(f, 'Website conversions are'),
  R1: (f) => level(f, 'Your reviews have a strong average rating', 'Your average review rating is below where it should be'),
  R2: (f) => {
    if (!isNum(f.raw?.cur)) return null;
    if (f.raw.cur === 0) return { kind: 'down', weight: 20, text: 'No new reviews in the last 4 weeks' };
    if (f.raw.cur > (f.raw.prev || 0)) return { kind: 'up', weight: 10 + f.raw.cur, text: `You received ${f.raw.cur} new review${f.raw.cur === 1 ? '' : 's'} in the last 4 weeks` };
    return null;
  },
  R3: (f) => level(f, 'Recent reviews are being answered', 'Some recent reviews have no reply yet'),
  R4: (f) => moveSentence(f, 'Calls, direction requests and website clicks from your Google Business Profile are'),
  S1: (f) => {
    if (!isNum(f.score)) return null;
    if (f.raw?.cur === 'ok') return { kind: 'up', weight: 5, text: 'Your website is protected' };
    if (f.raw?.cur === 'fail' || f.raw?.cur === 'warn') return { kind: 'down', weight: f.raw.cur === 'fail' ? 60 : 30, text: 'Your website security needs attention' };
    return null;
  },
  S2: (f) => {
    if (!isNum(f.score)) return null;
    if (f.raw?.cur > 0) return { kind: 'down', weight: 40, text: 'A scheduled backup was missed' };
    return { kind: 'up', weight: 5, text: 'Website backups are up to date' };
  },
  S3: (f) => (isNum(f.score) && f.score <= 40 ? { kind: 'down', weight: 30, text: 'Your website has not checked in with us recently' } : null),
};

/** Top `limit` improving and attention sentences for a set of factor results (one or more projects). */
export function clientSentences(factors, { limit = 3 } = {}) {
  const up = [];
  const down = [];
  const seen = new Set();
  for (const f of factors || []) {
    if (f?.reason === 'unlinked') continue;
    const s = SENTENCES[f?.key]?.(f);
    if (!s || seen.has(s.text)) continue;
    seen.add(s.text);
    (s.kind === 'up' ? up : down).push(s);
  }
  const top = (list) => list.sort((a, b) => b.weight - a.weight).slice(0, limit).map((s) => s.text);
  return { improving: top(up), attention: top(down) };
}
