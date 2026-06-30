import {
  ENRICH_MARKER,
  masterPlanUrl,
  spreadsheetEditUrl,
  PHINIX_TEAM_ROSTER,
} from './phinixSheetConfig.js';

/** Internal idempotency marker — never include in user-visible comment text. */
export function isEnrichedPhinixComment(content) {
  if (!content) return false;
  if (content.includes(ENRICH_MARKER)) return true;
  if (content.includes('Source spreadsheets')) return true;
  if (/^Milestone summary:/m.test(content)) return true;
  return false;
}

/** Strip legacy marker and markdown from comments already stored in the DB. */
export function normalizePhinixCommentContent(content) {
  if (!content) return content;
  let text = content;
  const markerEscaped = ENRICH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text.replace(new RegExp(`^${markerEscaped}\\s*\\n?`, 'm'), '');
  text = text.replace(/^##\s+/gm, '');
  text = text.replace(/^###\s+/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/_([^_\n]+)_/g, '$1');
  return text.trim();
}

/**
 * Rich deliverable comment for reviewers/clients with sheet links (plain text).
 */
export function buildDeliverableComment({
  milestone,
  title,
  goal,
  description,
  stepsRaw,
  completionDetails,
  statusRaw,
  assigneeKey,
  assigneeTabName,
  spreadsheetId,
  projectLabel,
  masterTab,
}) {
  const assigneeName = PHINIX_TEAM_ROSTER[assigneeKey]?.name || assigneeKey || 'Assignee';
  const sheetUrl = spreadsheetId ? spreadsheetEditUrl(spreadsheetId) : null;
  const masterUrl = masterPlanUrl();

  const lines = [title, ''];

  if (milestone && milestone !== title) {
    lines.push(`Main task area: ${milestone}`, '');
  }
  if (goal) lines.push(`Goal: ${goal}`, '');
  if (description) lines.push(`Description: ${description}`, '');

  if (completionDetails) {
    lines.push('Deliverable / completion notes', completionDetails, '');
  } else if (statusRaw) {
    lines.push(`Status: ${statusRaw}`, '');
  }

  if (stepsRaw) {
    lines.push('Steps completed');
    for (const step of stepsRaw.split(/\s*\/\s*|\n|;/).map((s) => s.trim()).filter(Boolean)) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  lines.push('Source spreadsheets');
  if (sheetUrl) {
    lines.push(
      `- Assignee work sheet (${assigneeTabName || assigneeName}): ${sheetUrl}`,
      `  Open this link and select the "${assigneeTabName || assigneeName}" tab to see this task row.`,
    );
  }
  if (masterTab) {
    lines.push(`- Master task plan tab: ${masterUrl} → tab "${masterTab}"`);
  } else {
    lines.push(`- Master task index: ${masterUrl}`);
  }
  lines.push('');
  lines.push(`Completed by: ${assigneeName}`);
  if (projectLabel) lines.push(`Project: ${projectLabel}`);

  return lines.join('\n');
}

export function buildDeliverables({
  spreadsheetId,
  assigneeTabName,
  completionDetails,
  assigneeKey,
  title,
}) {
  if (!spreadsheetId) return [];
  const sheetUrl = spreadsheetEditUrl(spreadsheetId);
  return [
    {
      ref: `del-sheet-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      label: `Working sheet — ${assigneeTabName || 'assignee tab'}`,
      version: 1,
      fileUrl: sheetUrl,
      notes: completionDetails
        ? `Deliverable: ${completionDetails.slice(0, 200)}`
        : `June 2026 task plan — ${assigneeTabName || 'assignee'} tab`,
      uploadedByKey: assigneeKey,
      uploadedAt: new Date().toISOString(),
    },
  ];
}

export function buildMilestoneSummaryComment(milestone, tasks, projectLabel, spreadsheetId, masterTab) {
  const sheetUrl = spreadsheetId ? spreadsheetEditUrl(spreadsheetId) : null;
  const masterUrl = masterPlanUrl();

  const lines = [
    `Milestone summary: ${milestone}`,
    '',
    `Overview of completed work under ${milestone} for ${projectLabel || 'this project'}.`,
    '',
    'Sub-tasks & deliverables',
  ];

  for (const t of tasks) {
    const detail = t._completionDetails || t._statusRaw || t.progress?.status || '—';
    lines.push(`- ${t.title} (${t.assigneeKey || '—'}): ${String(detail).slice(0, 120)}`);
  }

  lines.push('', 'Source spreadsheets');
  if (sheetUrl) lines.push(`- Project task plan: ${sheetUrl}`);
  if (masterTab) lines.push(`- Master index: ${masterUrl} → ${masterTab}`);
  lines.push('', 'Open the assignee tabs in the project spreadsheet for full row-level detail.');

  return lines.join('\n');
}
