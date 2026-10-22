/**
 * Shared helpers of the signals module (contract v1.7.0 §38): UTC days, the dirty-date set, the Json null, the touch of a
 * session, the "AI assistants" channel grouping. No I/O except the dirty-date writes.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { AI_SOURCES } from './referrers.js';

/** Prisma needs DbNull (not null) to clear a nullable Json column. */
export const DB_NULL = Prisma.DbNull;

export const DAY_MS = 86_400_000;
/** Feature switch (SIGNALS_ENABLED, default on): off = ingest still stores (the site's outbox needs an answer), but
 *  the leader jobs do not run. */
export function signalsJobsEnabled(env = process.env) {
  return String(env.SIGNALS_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function utcDay(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
export const dayKey = (d) => utcDay(d).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);
export function addMonths(d, n) {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
}

/** Record days for the nightly rollup (per project). createdAt is bumped so a rollup that is running re-runs them. */
export async function markDirty(projectId, dates, db = prisma) {
  const keys = [...new Set((dates || []).filter(Boolean).map((d) => dayKey(d)))];
  for (const k of keys) {
    const date = new Date(`${k}T00:00:00.000Z`);
    await db.signalRollupDirty.upsert({
      where: { projectId_date: { projectId, date } },
      create: { projectId, date },
      update: { createdAt: new Date() },
    });
  }
  return keys.length;
}

/** Channel groups shown to clients (plan §6.1). */
export const CHANNELS = Object.freeze([
  { id: 'ai', label: 'AI assistants' },
  { id: 'google', label: 'Google Search' },
  { id: 'search', label: 'Other search' },
  { id: 'social', label: 'Social' },
  { id: 'referral', label: 'Referral sites' },
  { id: 'direct', label: 'Direct' },
  { id: 'email', label: 'Email' },
  { id: 'ads', label: 'Ads' },
  { id: 'other', label: 'Other' },
]);

/** refClass + refSource → client channel id. Google AI Mode cannot be separated from Google Search (§38.3). */
export function channelOf(refClass, refSource) {
  if (refClass === 'ai') return 'ai';
  if (refClass === 'search') return refSource === 'google' || refSource === 'gbp' ? 'google' : 'search';
  if (['social', 'referral', 'direct', 'email', 'ads'].includes(refClass)) return refClass;
  return 'other';
}

const SOURCE_LABELS = Object.freeze({
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  claude: 'Claude',
  gemini: 'Gemini',
  copilot: 'Copilot',
  you: 'You.com',
  'meta-ai': 'Meta AI',
  'duckduckgo-ai': 'Duck.ai',
  grok: 'Grok',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  poe: 'Poe',
  huggingchat: 'HuggingChat',
  google: 'Google Search',
  gbp: 'Google Business Profile',
  bing: 'Bing',
  yahoo: 'Yahoo',
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave Search',
  ecosia: 'Ecosia',
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  nextdoor: 'Nextdoor',
  gmail: 'Gmail',
  outlook: 'Outlook',
  'yahoo-mail': 'Yahoo Mail',
  'google-ads': 'Google Ads',
  'microsoft-ads': 'Microsoft Ads',
  'tiktok-ads': 'TikTok Ads',
  'meta-ads': 'Meta Ads',
  none: 'Direct',
});

/** Human label of a touch (plain text). */
export function sourceLabel(refClass, refSource) {
  if (refClass === 'direct' || refSource === 'none') return 'Direct visit';
  if (refSource && SOURCE_LABELS[refSource]) return SOURCE_LABELS[refSource];
  if (refSource) return refSource;
  return refClass === 'unknown' || !refClass ? 'Unknown source' : refClass;
}

export const isAiSource = (s) => AI_SOURCES.includes(s);

/**
 * The touch of a session from its visit signal (§38.5): `internal` is never a touch: a session that starts from the
 * site itself is direct / none.
 */
export function touchFromVisit({ at, refClass, refSource, utm, landing }) {
  const internal = refClass === 'internal';
  return {
    at: new Date(at).toISOString(),
    class: internal ? 'direct' : refClass || 'unknown',
    source: internal ? 'none' : refSource || (refClass === 'direct' ? 'none' : 'unknown'),
    campaign: utm?.campaign ?? null,
    medium: utm?.medium ?? null,
    landing: landing ?? null,
  };
}

export const isNonDirect = (t) => !!t && !['direct', 'internal', 'unknown'].includes(t.class);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
