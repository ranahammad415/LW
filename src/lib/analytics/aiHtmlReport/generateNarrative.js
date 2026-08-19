/**
 * AI narrative for the HTML performance report.
 * Positives first; weak metrics get contextual reasons (never invent numbers).
 */
import { generateChat, isAiConfigured } from '../../ai.js';

const SYSTEM_PROMPT = `You are a Senior SEO Account Manager at a premium digital growth agency writing a client-facing SEO/analytics performance report.

Tone: consultative, professional, confidence-inspiring. Lead with wins. Frame soft/negative metrics as Context (seasonality, SERP/AI Overview shifts, sample size, channel mix) — never alarmist blame. Never invent numbers not present in the facts JSON. Avoid AI filler words ("delve", "testament", "robust", "landscape").

Return ONLY valid JSON with exactly these keys:
{
  "winBanner": "One rich sentence (or two short ones) highlighting the biggest wins with specific numbers from facts.",
  "executiveSummary": ["paragraph1", "paragraph2"],
  "achievements": [
    { "icon": "single emoji", "stat": "short bold stat e.g. +24% Clicks", "title": "short title", "detail": "1-2 sentences with numbers" }
  ],
  "kpiNotes": { "<kpi.key>": "optional short note under that KPI card" },
  "whatsWorking": ["3 actionable items about what's working — prioritize & compound"],
  "actionItems": ["3 concrete next-period action items with specific pages/metrics when available"],
  "weakContext": [
    { "metric": "label of weak metric", "reason": "credible context reason grounded in facts — not invented causes" }
  ],
  "conclusion": "1-2 paragraph closing that stays confidence-first and reframes weak metrics as context.",
  "healthLabel": "short subtitle under the health score e.g. Clicks up, engagement improving"
}

Rules:
- achievements: 4-6 items drawn only from wins / strong facts. If few wins, still write honest achievements from available positives or stability.
- weakContext: one entry per weak metric in facts.weaks (or empty array if none). Reasons must be plausible from the data (e.g. impressions down while CTR/position improved = efficiency, not ranking collapse).
- kpiNotes: only for keys you want to annotate; keys must match facts KPI keys (clicks, impressions, ctr, position, users, sessions, bounceRate, conversions).
- Use the brand name from facts.`;

/**
 * @param {object} factsForAi
 * @param {{ userId?: string, clientId?: string }} [meta]
 */
export async function generateReportNarrative(factsForAi, meta = {}) {
  if (!isAiConfigured()) {
    throw Object.assign(new Error('AI is not configured. Set ANTHROPIC_API_KEY.'), { status: 503 });
  }

  const { parsed, text } = await generateChat({
    system: SYSTEM_PROMPT,
    user: `Write the performance report narrative from these facts:\n${JSON.stringify(factsForAi)}`,
    json: true,
    maxTokens: 4096,
    temperature: 0.4,
    feature: 'analytics_ai_html_report',
    userId: meta.userId || null,
    clientId: meta.clientId || null,
  });

  const narrative = normalizeNarrative(parsed, factsForAi);
  if (!narrative) {
    // Fallback if parse failed — build a minimal deterministic narrative
    return fallbackNarrative(factsForAi, text);
  }
  return narrative;
}

function normalizeNarrative(parsed, facts) {
  if (!parsed || typeof parsed !== 'object') return null;
  const achievements = Array.isArray(parsed.achievements)
    ? parsed.achievements
        .slice(0, 6)
        .map((a) => ({
          icon: String(a.icon || '📈').slice(0, 4),
          stat: String(a.stat || '').slice(0, 80),
          title: String(a.title || '').slice(0, 120),
          detail: String(a.detail || '').slice(0, 400),
        }))
        .filter((a) => a.title || a.stat)
    : [];

  const exec = Array.isArray(parsed.executiveSummary)
    ? parsed.executiveSummary.map((p) => String(p).slice(0, 1200)).filter(Boolean).slice(0, 3)
    : typeof parsed.executiveSummary === 'string'
      ? [String(parsed.executiveSummary).slice(0, 2000)]
      : [];

  return {
    winBanner: String(parsed.winBanner || '').slice(0, 800),
    executiveSummary: exec.length ? exec : fallbackNarrative(facts).executiveSummary,
    achievements: achievements.length ? achievements : fallbackNarrative(facts).achievements,
    kpiNotes: parsed.kpiNotes && typeof parsed.kpiNotes === 'object' ? parsed.kpiNotes : {},
    whatsWorking: Array.isArray(parsed.whatsWorking)
      ? parsed.whatsWorking.map((s) => String(s).slice(0, 500)).filter(Boolean).slice(0, 5)
      : [],
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map((s) => String(s).slice(0, 500)).filter(Boolean).slice(0, 5)
      : [],
    weakContext: Array.isArray(parsed.weakContext)
      ? parsed.weakContext
          .slice(0, 8)
          .map((w) => ({
            metric: String(w.metric || '').slice(0, 80),
            reason: String(w.reason || '').slice(0, 400),
          }))
          .filter((w) => w.metric || w.reason)
      : [],
    conclusion: String(parsed.conclusion || '').slice(0, 1500),
    healthLabel: String(parsed.healthLabel || '').slice(0, 120),
  };
}

function fallbackNarrative(facts) {
  const brand = facts?.brand || 'This property';
  const wins = facts?.wins || [];
  const weaks = facts?.weaks || [];
  const winBits = wins
    .slice(0, 4)
    .map((w) => `${w.label} ${w.value}${w.delta != null ? ` (${w.delta > 0 ? '+' : ''}${w.delta}%)` : ''}`)
    .join('; ');

  return {
    winBanner: winBits
      ? `Key positives this period: ${winBits}.`
      : `${brand} performance report for the selected period.`,
    executiveSummary: [
      `${brand} delivered measurable search and website activity across the selected date range. ${
        winBits ? `Standout movements include ${winBits}.` : 'Core KPIs are summarized below.'
      }`,
      weaks.length
        ? `A few metrics moved softer and are treated as context below — review them alongside ranking and engagement quality, not in isolation.`
        : `No major soft metrics stood out versus the comparison window; focus remains on compounding what's already working.`,
    ],
    achievements: wins.slice(0, 4).map((w) => ({
      icon: '📈',
      stat: w.delta != null ? `${w.delta > 0 ? '+' : ''}${w.delta}%` : String(w.value),
      title: w.label,
      detail: `${w.label} is ${w.value}${w.prevValue != null ? ` (was ${w.prevValue})` : ''}.`,
    })),
    kpiNotes: {},
    whatsWorking: wins.slice(0, 3).map((w) => `Protect and compound gains in ${w.label} (${w.value}).`),
    actionItems: [
      'Review top landing pages and queries for CTR and title/meta opportunities.',
      'Double down on channels or pages showing the strongest engagement.',
      'Set or verify conversion events so traffic gains map to business outcomes.',
    ],
    weakContext: weaks.map((w) => ({
      metric: w.label,
      reason: `${w.label} moved ${w.delta}% vs the prior window. Treat as context pending sample size and SERP demand shifts — check whether CTR/position or engagement improved alongside it.`,
    })),
    conclusion: `${brand}'s period results prioritize compounding proven wins while monitoring softer metrics as context rather than isolated setbacks.`,
    healthLabel: wins.length ? 'Positive momentum across key KPIs' : 'Stable period snapshot',
  };
}
