import { PHINIX_TEAM_ROSTER } from './phinixSheetConfig.js';

/** Detect auto-generated import messages so we can replace them. */
export const PM_IMPORT_MESSAGE_HINT = 'task plan imported into Agency OS';

export function clientDisplayName(projectName = '', planLabel = '') {
  if (planLabel) {
    const match = planLabel.match(/^(.+?)\s+(?:Q[12]|Local SEO)/i);
    if (match) return match[1].trim();
  }
  return String(projectName)
    .replace(/^SEO\s*-\s*/i, '')
    .replace(/^Local SEO\s*-\s*/i, '')
    .trim();
}

export function extractTaskHighlight(updateText = '') {
  if (!updateText) return null;
  let text = String(updateText)
    .replace(/\n?Sheet status:\s*Completed\s*$/i, '')
    .replace(/^Milestone summary:[\s\S]*/m, '')
    .trim();
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine || firstLine.length < 8) return null;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

function milestoneNarrative(milestone, tasks, highlightByRef) {
  const completed = tasks.filter((t) => t.progress?.status === 'COMPLETED');
  if (!completed.length) return null;

  const lower = milestone.toLowerCase();
  const highlights = completed
    .map((t) => highlightByRef.get(t.ref))
    .filter(Boolean)
    .slice(0, 2);

  let opener;
  if (lower.includes('local seo')) {
    opener = 'Your local search presence is stronger — we optimized how customers find you in Google Maps and local results';
  } else if (lower.includes('backlink') && lower.includes('opportunity')) {
    opener = 'We identified high-value backlink opportunities to support rankings on priority keywords';
  } else if (lower.includes('backlink') || lower.includes('authority')) {
    opener = 'Your domain authority received a meaningful lift through strategic link-building and competitor gap work';
  } else if (lower.includes('aeo') || lower.includes('geo')) {
    opener = 'Your content is better positioned for modern search — including AI and answer-engine visibility';
  } else if (lower.includes('content scaling') || lower.includes('content')) {
    opener = 'Content production and on-page optimization moved forward strongly';
  } else if (lower.includes('technical')) {
    opener = 'Technical SEO improvements strengthen site health, crawlability, and indexing';
  } else if (lower.includes('gsc') || lower.includes('monitoring') || lower.includes('crawl')) {
    opener = 'Proactive Search Console monitoring helps us catch issues early and protect rankings';
  } else if (lower.includes('quarterly') || lower.includes('1st quarterly')) {
    opener = 'Quarterly plan milestones were executed with strong team coordination';
  } else if (lower.includes('approval')) {
    opener = 'Client review items were prepared and progressed for your sign-off';
  } else {
    opener = `Excellent progress on ${milestone}`;
  }

  const workItems = completed.map((t) => t.title).slice(0, 4).join(', ');
  let line = `${opener}, with completed work on ${workItems}.`;
  if (highlights.length) {
    line += ` Key outcome: ${highlights.join(' ')}`;
  }
  return line;
}

/**
 * Build a client-facing PM dashboard update (plain text, positive tone).
 */
export function buildClientPmUpdate({
  projectName,
  planLabel,
  taskGroups = [],
  taskUpdates = [],
  authorKey = 'hamza',
}) {
  const clientName = clientDisplayName(projectName, planLabel);
  const pmName = PHINIX_TEAM_ROSTER[authorKey]?.name?.split(' ')[0] || 'Your PM';

  const allTasks = taskGroups.flatMap((g) =>
    (g.tasks || []).map((t) => ({ ...t, milestone: g.milestone })),
  );
  const completed = allTasks.filter((t) => t.progress?.status === 'COMPLETED');
  const inProgress = allTasks.filter((t) => t.progress?.status === 'IN_PROGRESS');
  const total = allTasks.length;
  const completedCount = completed.length;
  const completionPct = total ? Math.round((completedCount / total) * 100) : 0;

  const highlightByRef = new Map();
  for (const tu of taskUpdates) {
    if (!tu.completion?.isComplete) continue;
    const highlight = extractTaskHighlight(tu.update);
    if (highlight) highlightByRef.set(tu.taskRef, highlight);
  }

  const milestoneLines = [];
  for (const group of taskGroups) {
    const narrative = milestoneNarrative(group.milestone, group.tasks || [], highlightByRef);
    if (narrative) milestoneLines.push(`• ${narrative}`);
  }

  const impactLine =
    completionPct >= 80
      ? 'This puts your campaign in a strong position — visibility, trust signals, and technical foundations are all moving in the right direction.'
      : completionPct >= 50
        ? 'Solid momentum is building across your SEO program, with clear wins already in place and more value on the way.'
        : 'We have a strong foundation in place and are actively executing the next wave of improvements for your brand.';

  const progressLine =
    completedCount === total
      ? `Our team successfully completed all ${total} planned deliverables for this period — outstanding execution across the board.`
      : `Our team completed ${completedCount} of ${total} planned deliverables (${completionPct}%)${inProgress.length ? `, with ${inProgress.length} actively in progress` : ''}.`;

  const lines = [
    `Hello ${clientName} team,`,
    '',
    `We're excited to share a positive progress update on your ${planLabel || 'SEO'} campaign.`,
    '',
    progressLine,
    '',
    'Highlights from our recent work:',
    '',
    ...milestoneLines,
    '',
    `What this means for you: ${impactLine}`,
    '',
    "We're proud of the results delivered so far and remain fully focused on growing your visibility, leads, and local presence. Please reach out anytime — we're here and actively monitoring performance.",
    '',
    `Warm regards,`,
    `${pmName} & the Phinix Solutions SEO Team`,
  ];

  return lines.join('\n');
}
