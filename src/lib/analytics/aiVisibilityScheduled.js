/**
 * Monthly AI-visibility runs over the site's prompt set (EmDash contract 1.8.0 §39.5 `seo-ai-prompts`).
 * docs/ledger/features/analytics.md §AI visibility, features/health-score.md (factor A1).
 *
 * Paid and OFF by default: AI_VISIBILITY_MONTHLY_ENABLED (default 'false'). Leader-only monthly job. It reuses the
 * existing admin-run machinery (`executeAiVisibilityRun`: OpenRouter probes per platform of OPENROUTER_MODEL_MAP,
 * detectCitation, competitor domains, PromptLog sync) with the site's prompts instead of GSC probes; the paid
 * DataForSEO LLM-mentions snapshot is skipped unless AI_VISIBILITY_DFS_SNAPSHOT_ENABLED=true.
 *
 * Caps: ≤ AI_VISIBILITY_MAX_PROMPTS prompts per project (default 25), ≤ AI_VISIBILITY_MAX_PROJECTS_PER_RUN projects
 * (default 20), one attempt per probe cell (no retries in the loop), one run per project per month (unique
 * projectId + period: a second instance or a re-run inserts nothing). Each cell stores cited, mention position,
 * competitors and the provider-reported cost; the run stores the total. AiUsageLog rows, feature ai_visibility_monthly.
 *
 * Prompt selection (selectPrompts): de-duplicate by normalised text; the site already orders the set by importance
 * (handoff prompts p1…pN first, then each profile's answer targets), so that order is kept, with `handoff` before
 * `answer_target`. Non-branded prompts fill the cap first, keeping room for a small branded sample:
 * max(1, floor(cap / 10)) branded prompts (2 at the default 25). If there are too few non-branded prompts, more
 * branded ones fill the rest.
 */
import { prisma } from '../prisma.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { emdashRoutes } from '../siteAdapters/emdash.js';
import { hasSeoAiPrompts } from '../citations/citations.js';
import { isOpenRouterConfigured } from '../openrouter/client.js';
import { executeAiVisibilityRun } from './aiVisibilityRunner.js';

export const SEO_AI_PROMPT_LIMITS = Object.freeze({ prompts: 500, text: 500, id: 120, pageIds: 50 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bool = (v) => String(v ?? 'false').toLowerCase() === 'true';
function intEnv(env, name, def, min, max) {
  const n = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}
export const isAiVisibilityMonthlyEnabled = (env = process.env) => bool(env.AI_VISIBILITY_MONTHLY_ENABLED);
export const aiVisibilityMaxPrompts = (env = process.env) => intEnv(env, 'AI_VISIBILITY_MAX_PROMPTS', 25, 1, 100);
export const aiVisibilityMaxProjects = (env = process.env) => intEnv(env, 'AI_VISIBILITY_MAX_PROJECTS_PER_RUN', 20, 1, 500);
export const periodOf = (now = new Date()) => now.toISOString().slice(0, 7);

/** seo-ai-prompts response → bounded prompts (invalid entries dropped). Pure. */
export function sanitizeAiPrompts(res) {
  const list = Array.isArray(res?.prompts) ? res.prompts.slice(0, SEO_AI_PROMPT_LIMITS.prompts) : [];
  const out = [];
  for (const p of list) {
    if (!isObj(p) || typeof p.id !== 'string' || !p.id || typeof p.text !== 'string' || !p.text.trim()) continue;
    if (!['handoff', 'answer_target'].includes(p.source)) continue;
    out.push({
      id: p.id.slice(0, SEO_AI_PROMPT_LIMITS.id),
      text: p.text.trim().slice(0, SEO_AI_PROMPT_LIMITS.text),
      town: typeof p.town === 'string' && p.town.trim() ? p.town.trim().slice(0, 100) : null,
      service: typeof p.service === 'string' && p.service.trim() ? p.service.trim().slice(0, 200) : null,
      pageIds: Array.isArray(p.page_ids) ? p.page_ids.filter((x) => typeof x === 'string').slice(0, SEO_AI_PROMPT_LIMITS.pageIds) : [],
      branded: p.branded === true,
      source: p.source,
    });
  }
  return out;
}

const normText = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The documented selection rule (see the file header). Pure. */
export function selectPrompts(prompts, cap = 25) {
  const seen = new Set();
  const uniq = [];
  for (const p of prompts || []) {
    const k = normText(p.text);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  const order = (p) => (p.source === 'handoff' ? 0 : 1);
  const ranked = uniq.map((p, i) => ({ p, i })).sort((a, b) => order(a.p) - order(b.p) || a.i - b.i).map((x) => x.p);
  const nonBranded = ranked.filter((p) => !p.branded);
  const branded = ranked.filter((p) => p.branded);
  const max = Math.max(0, cap);
  const sample = Math.min(branded.length, max >= 2 ? Math.max(1, Math.floor(max / 10)) : 0);
  const pickedNb = nonBranded.slice(0, max - sample);
  const pickedB = branded.slice(0, max - pickedNb.length);
  return [...pickedNb, ...pickedB];
}

/**
 * One project's monthly run: claim (unique period), read the site's prompts, select, execute. Never throws for an
 * expected skip. → { status: 'completed'|'failed'|'skipped', runId?, reason?, prompts?, cells?, costUsd? }
 */
export async function runScheduledAiVisibility(project, { now = new Date(), env = process.env, conn = null, probe, log = console } = {}) {
  const period = periodOf(now);
  let run;
  try {
    run = await prisma.aiVisibilityRun.create({
      data: { projectId: project.id, clientId: project.clientId, status: 'pending', source: 'scheduled', period, isDemo: false },
    });
  } catch (err) {
    if (err?.code === 'P2002') return { status: 'skipped', reason: 'ALREADY_RAN' };
    throw err;
  }
  let prompts;
  try {
    const c = conn || (await loadEmdashConnection(project.id)).conn;
    prompts = selectPrompts(sanitizeAiPrompts(await emdashRoutes.seoAiPrompts(c, { retryDelays: [] })), aiVisibilityMaxPrompts(env));
  } catch (err) {
    await prisma.aiVisibilityRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), error: `seo-ai-prompts failed (${err?.code || 'error'})`.slice(0, 1000) } });
    return { status: 'failed', runId: run.id, reason: err?.code || 'PROMPTS_FAILED' };
  }
  if (!prompts.length) {
    await prisma.aiVisibilityRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), error: 'The site has no AI-visibility prompts' } });
    return { status: 'failed', runId: run.id, reason: 'NO_PROMPTS' };
  }
  try {
    const out = await executeAiVisibilityRun(run.id, { prompts, probe });
    return { status: 'completed', runId: run.id, prompts: prompts.length, cells: out.probedCells, errorCells: out.errorCells, costUsd: out.costUsd };
  } catch (err) {
    log?.warn?.({ projectId: project.id, err: { message: err?.message } }, 'Scheduled AI visibility run failed');
    return { status: 'failed', runId: run.id, reason: 'RUN_FAILED' };
  }
}

/** Monthly leader job. Flag off → no query, no call. */
export async function runAiVisibilityMonthlyJob({ now = new Date(), env = process.env, log = console, probe } = {}) {
  if (!isAiVisibilityMonthlyEnabled(env)) return { skipped: 'DISABLED' };
  if (!probe && !isOpenRouterConfigured()) return { skipped: 'NOT_CONFIGURED' };
  const rows = await prisma.project.findMany({
    where: {
      cmsType: 'EMDASH',
      cmsPairedAt: { not: null },
      cmsRepairNeededAt: null,
      status: { in: ['ACTIVE', 'SETUP'] },
      client: { isActive: true },
    },
    select: { id: true, clientId: true, cmsType: true, cmsCapabilities: true },
    orderBy: { createdAt: 'asc' },
  });
  const projects = rows.filter(hasSeoAiPrompts);
  const max = aiVisibilityMaxProjects(env);
  const summary = { projects: projects.length, ran: 0, skipped: 0, failed: 0, cells: 0, costUsd: 0, stopped: null };
  for (const p of projects) {
    if (summary.ran >= max) {
      summary.stopped = 'CAP';
      break;
    }
    const r = await runScheduledAiVisibility(p, { now, env, probe, log });
    if (r.status === 'skipped') {
      summary.skipped++;
      continue;
    }
    summary.ran++;
    if (r.status === 'failed') summary.failed++;
    summary.cells += r.cells || 0;
    summary.costUsd += r.costUsd || 0;
  }
  summary.costUsd = Number(summary.costUsd.toFixed(5));
  return summary;
}

// ── views ──

/** Latest completed, non-demo, scheduled run with its prompt-level results (staff + client views). */
async function latestScheduledRuns(projectId, take = 6) {
  return prisma.aiVisibilityRun.findMany({
    where: { projectId, status: 'completed', isDemo: false, source: 'scheduled' },
    orderBy: { finishedAt: 'desc' },
    take,
    select: {
      id: true,
      period: true,
      finishedAt: true,
      costUsd: true,
      results: {
        select: { promptId: true, query: true, town: true, service: true, branded: true, promptSource: true, platform: true, cited: true, citationType: true, mentionPosition: true, competitorsJson: true, costUsd: true },
      },
    },
  });
}

/** Per prompt: mentioned on any platform (error cells ignored); prompts with only error cells are left out. Pure. */
export function promptOutcomes(results) {
  const byPrompt = new Map();
  for (const r of results || []) {
    if (r.citationType === 'error') continue;
    const key = r.promptId || r.query;
    if (!byPrompt.has(key)) byPrompt.set(key, { promptId: r.promptId, text: r.query, town: r.town, service: r.service, branded: !!r.branded, source: r.promptSource ?? null, cells: [] });
    byPrompt.get(key).cells.push(r);
  }
  return [...byPrompt.values()].map((p) => ({ ...p, mentioned: p.cells.some((c) => c.cited) }));
}

const mostCommon = (list) => {
  const m = new Map();
  for (const v of list) if (v) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

const QUESTION_START_RE = /^(how|what|why|when|where|who|which|can|do|does|is|are)\b/i;
export const LABEL_VALUE_MAX = 40;

/** A service / town short enough to read as a name (not a question or a page title). Pure. */
export function isPlainLabelValue(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return !!s && s.length <= LABEL_VALUE_MAX && !s.endsWith('?') && !QUESTION_START_RE.test(s);
}

/**
 * " about <service> in <town>" from the handoff prompts only (answer_target prompts may carry a page title in
 * `service`, O-C180-2 / S-C180-1). The part is dropped when a picked value looks like a question or a title. Pure.
 */
export function aboutPart(outcomes) {
  const handoff = (outcomes || []).filter((p) => p.source === 'handoff');
  const service = mostCommon(handoff.map((p) => p.service));
  const town = mostCommon(handoff.map((p) => p.town));
  if ((service && !isPlainLabelValue(service)) || (town && !isPlainLabelValue(town))) return '';
  if (service && town) return ` about ${service.trim().toLowerCase()} in ${town.trim()}`;
  if (service) return ` about ${service.trim().toLowerCase()}`;
  if (town) return ` about services in ${town.trim()}`;
  return '';
}

/**
 * Client "AI answers" tile: allow-list. "Mentioned in X of Y questions people ask AI about <service> in <town>" (the
 * most common service / town of the handoff questions asked; see aboutPart) or, without that part, "Mentioned in X of
 * Y questions people ask AI assistants"; non-branded questions only; plus a monthly trend. No vendor, model,
 * platform, cost, prompt ids, answers or competitor domains.
 */
export async function clientAiAnswersView(project) {
  const runs = await latestScheduledRuns(project.id, 6);
  if (!runs.length) return { available: false };
  const points = runs
    .map((run) => {
      const outcomes = promptOutcomes(run.results).filter((p) => !p.branded);
      return { run, outcomes, month: run.period || (run.finishedAt ? new Date(run.finishedAt).toISOString().slice(0, 7) : null) };
    })
    .filter((x) => x.outcomes.length);
  if (!points.length) return { available: false };
  const latest = points[0];
  const mentioned = latest.outcomes.filter((p) => p.mentioned).length;
  const total = latest.outcomes.length;
  const about = aboutPart(latest.outcomes);
  return {
    available: true,
    mentioned,
    total,
    label: `Mentioned in ${mentioned} of ${total} questions people ask ${about ? `AI${about}` : 'AI assistants'}`,
    trend: points
      .map((p) => ({ month: p.month, mentioned: p.outcomes.filter((o) => o.mentioned).length, total: p.outcomes.length }))
      .reverse(),
    updatedAt: latest.run.finishedAt ? new Date(latest.run.finishedAt).toISOString().slice(0, 10) : null,
  };
}

/** Staff view: the latest scheduled run per prompt and platform (cited, position, competitors, cost) + flags. */
export async function staffAiPromptsView(project, { env = process.env } = {}) {
  const runs = await latestScheduledRuns(project.id, 2);
  const latest = runs[0] || null;
  const prev = runs[1] || null;
  const prevByPrompt = new Map(prev ? promptOutcomes(prev.results).map((p) => [p.promptId || p.text, p.mentioned]) : []);
  return {
    capability: hasSeoAiPrompts(project),
    flags: { monthlyEnabled: isAiVisibilityMonthlyEnabled(env), maxPrompts: aiVisibilityMaxPrompts(env) },
    run: latest
      ? { id: latest.id, period: latest.period, finishedAt: latest.finishedAt, costUsd: latest.costUsd != null ? Number(latest.costUsd) : null }
      : null,
    prompts: latest
      ? promptOutcomes(latest.results).map((p) => ({
          promptId: p.promptId,
          text: p.text,
          town: p.town,
          service: p.service,
          branded: p.branded,
          mentioned: p.mentioned,
          mentionedLastRun: prevByPrompt.has(p.promptId || p.text) ? prevByPrompt.get(p.promptId || p.text) : null,
          platforms: p.cells.map((c) => ({
            platform: c.platform,
            cited: c.cited,
            mentionPosition: c.mentionPosition,
            competitors: Array.isArray(c.competitorsJson) ? c.competitorsJson.slice(0, 5) : [],
            costUsd: c.costUsd != null ? Number(c.costUsd) : null,
          })),
        }))
      : [],
  };
}
