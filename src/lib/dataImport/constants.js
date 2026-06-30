/**
 * Shared task-type → WP preset mapping (matches seed-may-2026-tasks.cjs).
 */
export const TASKTYPE_TO_PRESET = {
  'content-writing': 'Content Writing',
  'content-audit': 'Monthly Report (Read-Only)',
  'on-page-seo': 'Meta Optimisation',
  'technical-seo': 'Technical SEO',
  'local-seo': 'Technical SEO',
  'keyword-research': 'Monthly Report (Read-Only)',
  'link-building': 'Technical SEO',
  'aeo-geo': 'Technical SEO',
  'ux-audit': 'Monthly Report (Read-Only)',
  'cro': 'Meta Optimisation',
  'reporting': 'Monthly Report (Read-Only)',
  'crawl-fix': 'Crawl Fix',
  schema: 'Schema Deployment',
  'schema-deployment': 'Schema Deployment',
  'meta-optimisation': 'Meta Optimisation',
  'monthly-report': 'Monthly Report (Read-Only)',
  'strategy-call': 'Strategy Call (Read-Only)',
  'onboarding-task': 'Onboarding / Full Setup',
};

export const VALID_TASK_TYPES = new Set(Object.keys(TASKTYPE_TO_PRESET));

export const VALID_STATUSES = new Set([
  'TO_DO',
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'REVISION_NEEDED',
  'BLOCKED',
  'WAITING_DEPENDENCY',
  'COMPLETED',
  'CANCELLED',
]);

export const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export function slugRef(prefix, text) {
  return `${prefix}-${String(text || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)}`;
}

export function buildDescription(task) {
  const goal = (task.goal || '').trim();
  const desc = (task.description || '').trim();
  if (goal && desc) return `**Goal:** ${goal}\n\n${desc}`;
  if (goal) return `**Goal:** ${goal}`;
  if (desc) return desc;
  return null;
}

export function buildMainDescription(groupTasks) {
  const blocks = [];
  for (const t of groupTasks) {
    const parts = [`### ${t.title}`];
    const goal = (t.goal || '').trim();
    const desc = (t.description || '').trim();
    if (goal) parts.push(`**Goal:** ${goal}`);
    if (desc) parts.push(desc);
    const steps = Array.isArray(t.steps) ? t.steps : [];
    if (steps.length) {
      parts.push('**Steps:**');
      for (const s of steps) {
        const title = typeof s === 'string' ? s : s.title;
        if (title) parts.push(`- ${title}`);
      }
    }
    blocks.push(parts.join('\n\n'));
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

export function normalizeStatus(raw) {
  if (!raw) return 'TO_DO';
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '_');
  if (VALID_STATUSES.has(s)) return s;
  const lower = String(raw).toLowerCase();
  if (/complete|done|finished/.test(lower)) return 'COMPLETED';
  if (/progress|wip|working/.test(lower)) return 'IN_PROGRESS';
  if (/review/.test(lower)) return 'NEEDS_REVIEW';
  if (/block/.test(lower)) return 'BLOCKED';
  if (/cancel/.test(lower)) return 'CANCELLED';
  return 'TO_DO';
}

export function inferTaskType(title = '', fallback = 'reporting') {
  const t = title.toLowerCase();
  if (/link|backlink|outreach/.test(t)) return 'link-building';
  if (/meta|title|description/.test(t)) return 'on-page-seo';
  if (/content|blog|article|writing/.test(t)) return 'content-writing';
  if (/technical|crawl|schema/.test(t)) return 'technical-seo';
  if (/local seo|gbp|maps/.test(t)) return 'local-seo';
  if (/report|monthly/.test(t)) return 'monthly-report';
  if (/keyword/.test(t)) return 'keyword-research';
  return VALID_TASK_TYPES.has(fallback) ? fallback : 'reporting';
}
