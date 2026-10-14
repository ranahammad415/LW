/**
 * Interview agenda builder (plan §3 "Dynamic selection", Phase 1 sources).
 *
 * Phase 1 sources, in priority order:
 *   1. KB gaps — assessOkfIntakeCompleteness().missing and the latest SAVED
 *      gap report (never a fresh AI analysis; no network calls at all).
 *   2. Stale files — services/locations/company files older than 90 days get
 *      a "still accurate?" confirmation question.
 *   3. The template's question bank fills the remaining slots.
 * GSC, AI-visibility, content-map and review sources are Phase 2.
 *
 * Because this reads only local files and the DB, it is safe to call from a
 * public route (e.g. lazily building an agenda for a legacy invite).
 */
import { assessOkfIntakeCompleteness } from './businessIntakeService.js';
import { listClientFiles } from './knowledgeEngine.js';
import { latestSavedGapReport } from './interviewBriefing.js';
import { CAPTURE_FOLDERS } from './expertInterview.js';
import {
  INTERVIEW_TEMPLATES,
  QUESTION_BANK,
  bankForTemplate,
} from './interviewQuestionBank.js';

export const MAX_PRIMARY = 12;
export const MAX_FOLLOWUP = 8;
export const STALE_DAYS = 90;
const MAX_STALE = 3;
const MAX_GAPS = 5;
const MAX_DO_NOT_ASK = 40;

const MISSING_TO_BANK = {
  'company/profile.md': 'company-what-you-do',
  'voice/brand-voice.md': 'voice-tone',
  'company/approved-claims.md': 'company-approved-claims',
  'proof/testimonials.md or proof/case-studies.md': 'proof-recent-job',
};

/** Bank items whose subject is already covered get skipped (except on monthly updates). */
const COVERED_SKIP = {
  profileComplete: 'company-what-you-do',
  voiceComplete: 'voice-tone',
  approvedClaimsComplete: 'company-approved-claims',
};

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'q';
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function normaliseFolder(folder) {
  const f = String(folder || '').toLowerCase().trim();
  if (CAPTURE_FOLDERS.includes(f)) return f;
  const top = f.split('/')[0];
  if (CAPTURE_FOLDERS.includes(top)) return top;
  if (top === 'seo') return 'seo/local';
  return 'company';
}

function fromBank(item, extra = {}) {
  return {
    id: item.id,
    folder: item.folder,
    factType: item.factType,
    prompt: item.prompt,
    probe: item.probe || null,
    topic: item.topic,
    seoPurpose: item.seoPurpose || null,
    source: 'bank',
    ...extra,
  };
}

/** Cleans a question coming from the admin agenda editor. */
export function sanitizeQuestion(q, index = 0) {
  const prompt = clip(q?.prompt, 300);
  if (!prompt) return null;
  return {
    id: slug(q?.id || `custom-${index + 1}-${prompt}`),
    folder: normaliseFolder(q?.folder),
    factType: typeof q?.factType === 'string' ? q.factType.slice(0, 30) : 'fact',
    prompt,
    probe: q?.probe ? clip(q.probe, 200) : null,
    topic: clip(q?.topic || prompt, 120),
    seoPurpose: q?.seoPurpose ? clip(q.seoPurpose, 120) : null,
    source: q?.source && typeof q.source === 'string' ? q.source.slice(0, 20) : 'custom',
    kind: q?.kind === 'followup' ? 'followup' : 'primary',
    ...(q?.relPath ? { relPath: String(q.relPath).slice(0, 300) } : {}),
  };
}

/**
 * Pure agenda composition (exported for tests).
 *
 * @param {object} input
 * @param {string} input.templateKey
 * @param {object} input.assessment   assessOkfIntakeCompleteness() result
 * @param {object|null} input.gapReport latestSavedGapReport() result
 * @param {Array} input.files         listClientFiles() result
 * @param {object} [input.overrides]  {goals?, questions?, removeQuestionIds?, addQuestions?}
 * @param {Date}   [input.now]
 */
export function composeAgenda({ templateKey, assessment, gapReport, files = [], overrides = {}, now = new Date() }) {
  const template = INTERVIEW_TEMPLATES[templateKey] || INTERVIEW_TEMPLATES.CUSTOM;
  const key = template.key;
  const isMonthly = key === 'MONTHLY_UPDATE';
  const seen = new Set();
  const primary = [];

  const push = (q) => {
    if (!q || seen.has(q.id)) return;
    seen.add(q.id);
    primary.push(q);
  };

  // 1a. Required OKF files that are missing.
  if (!isMonthly) {
    for (const path of assessment?.missing || []) {
      const bankId = MISSING_TO_BANK[path];
      const item = bankId && QUESTION_BANK.find((b) => b.id === bankId);
      if (item) push(fromBank(item, { source: 'gap', priority: 'HIGH' }));
    }
  }

  // 1b. Saved gap report: HIGH severity first.
  const severityRank = { high: 0, medium: 1, low: 2 };
  const gapItems = [...(gapReport?.items || [])]
    .filter((g) => g?.description)
    .sort((a, b) => (severityRank[String(a.severity).toLowerCase()] ?? 3) - (severityRank[String(b.severity).toLowerCase()] ?? 3))
    .slice(0, MAX_GAPS);
  gapItems.forEach((g, i) => {
    const recommended = (gapReport?.recommendedQuestions || []).find(
      (r) => String(r.category || '').toLowerCase() === String(g.category || '').toLowerCase()
    );
    const prompt = recommended?.question || `We don't have this on file yet: ${clip(g.description, 200)} Can you tell me about it?`;
    push({
      id: `gap-${i + 1}-${slug(g.category)}`,
      folder: normaliseFolder(g.category),
      factType: 'fact',
      prompt: clip(prompt, 300),
      probe: 'Can you give me a specific example, number or name?',
      topic: clip(g.description, 120),
      seoPurpose: 'Knowledge gap',
      source: 'gap',
      priority: String(g.severity || 'MEDIUM').toUpperCase(),
    });
  });

  // 2. Stale files → confirmation questions.
  const staleCutoff = now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const stale = files
    .filter((f) => ['services', 'locations', 'company'].includes(String(f.folder).split('/')[0]))
    .filter((f) => {
      const t = Date.parse(f.updated_at);
      return Number.isFinite(t) && t < staleCutoff;
    })
    .slice(0, MAX_STALE);
  for (const f of stale) {
    const fname = String(f.filename || '').replace(/\.md$/, '');
    push({
      id: `confirm-${slug(`${f.folder}-${fname}`)}`,
      folder: normaliseFolder(f.folder),
      factType: 'fact',
      prompt: `Our notes on "${clip(f.title, 80)}" haven't been updated for a while — is it still accurate, or has anything changed?`,
      probe: 'What exactly changed, and since when?',
      topic: `${clip(f.title, 80)} — still accurate?`,
      seoPurpose: 'Freshness',
      source: 'stale',
      relPath: `${f.folder}/${fname}`,
    });
  }

  // 3. Template bank fills the remaining slots.
  const skip = new Set();
  if (!isMonthly) {
    for (const [flag, bankId] of Object.entries(COVERED_SKIP)) {
      if (assessment?.[flag]) skip.add(bankId);
    }
  }
  const bank = bankForTemplate(key).filter((b) => !skip.has(b.id));
  for (const item of bank) push(fromBank(item));

  let questions = primary.slice(0, MAX_PRIMARY).map((q) => ({ ...q, kind: 'primary' }));
  const followups = primary.slice(MAX_PRIMARY, MAX_PRIMARY + MAX_FOLLOWUP).map((q) => ({ ...q, kind: 'followup' }));
  questions = [...questions, ...followups];

  // Owner overrides from the agenda editor.
  if (Array.isArray(overrides?.questions) && overrides.questions.length) {
    questions = overrides.questions
      .map((q, i) => sanitizeQuestion(q, i))
      .filter(Boolean)
      .slice(0, MAX_PRIMARY + MAX_FOLLOWUP);
  } else {
    const removed = new Set(Array.isArray(overrides?.removeQuestionIds) ? overrides.removeQuestionIds : []);
    questions = questions.filter((q) => !removed.has(q.id));
    const added = (Array.isArray(overrides?.addQuestions) ? overrides.addQuestions : [])
      .map((q, i) => sanitizeQuestion({ ...q, source: 'custom' }, i))
      .filter(Boolean);
    questions = [...added, ...questions].slice(0, MAX_PRIMARY + MAX_FOLLOWUP);
  }

  // De-duplicate ids after editing.
  const ids = new Set();
  questions = questions.map((q, i) => {
    let id = q.id;
    while (ids.has(id)) id = `${q.id}-${i}`;
    ids.add(id);
    return { ...q, id };
  });

  const goals = Array.isArray(overrides?.goals) && overrides.goals.length
    ? overrides.goals.map((g) => clip(g, 200)).filter(Boolean).slice(0, 5)
    : [template.goal];

  const doNotAsk = files
    .filter((f) => !['knowledge-gaps', 'reports'].includes(String(f.folder).split('/')[0]))
    .map((f) => `${f.folder}/${String(f.filename || '').replace(/\.md$/, '')}: ${clip(f.title, 80)}`)
    .slice(0, MAX_DO_NOT_ASK);

  const primaryCount = questions.filter((q) => q.kind !== 'followup').length;
  return {
    version: 1,
    templateKey: key,
    goals,
    questions,
    doNotAsk,
    gaps: [],
    builtAt: now.toISOString(),
    // About 1.2 minutes per primary question, bounded to something sensible.
    estMinutes: Math.max(5, Math.min(30, Math.round(primaryCount * 1.2))),
  };
}

/**
 * Builds an agenda for a client. Reads local OKF files only; never fetches the
 * live website and never runs an AI gap analysis (plan §1 item 5).
 */
export async function buildInterviewAgenda({ clientId, templateKey = 'CUSTOM', overrides = {}, now = new Date() }) {
  let assessment = { missing: [] };
  let gapReport = null;
  let files = [];
  try {
    assessment = assessOkfIntakeCompleteness(clientId);
  } catch {
    // No knowledge base yet.
  }
  try {
    gapReport = latestSavedGapReport(clientId);
  } catch {
    gapReport = null;
  }
  try {
    files = listClientFiles(clientId);
  } catch {
    files = [];
  }
  return composeAgenda({ templateKey, assessment, gapReport, files, overrides, now });
}

/** Questions still open: not answered and not handed to a colleague. */
export function openQuestions(agenda) {
  return (agenda?.questions || []).filter((q) => !q.answeredBy && !q.delegatedTo);
}
