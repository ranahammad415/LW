import { parseCsv } from './csvTaskParser.js';
import { inferTaskType, normalizeStatus, slugRef } from './constants.js';
import { resolveAssigneeKey } from './phinixSheetConfig.js';
import { buildDeliverableComment, buildDeliverables } from './phinixTaskEnrichment.js';

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Detect Phinix assignee-sheet or master task-plan columns.
 */
export function detectPhinixColumnMap(headers) {
  const normalized = headers.map(normalizeHeader);
  const map = {};

  const find = (...aliases) => {
    for (const alias of aliases) {
      const i = normalized.findIndex((h) => h === alias || h.includes(alias));
      if (i >= 0) return i;
    }
    return undefined;
  };

  map.section = find('section', '# a');
  map.mainTask = find('main task');
  map.subTask = find('sub task', 'sub task / task name', 'sub task page list');
  map.goal = find('main goal', 'goal');
  map.description = find('task description');
  map.steps = find('steps');
  map.status = find('status', 'final status', 'priority status');
  map.completionDetails = find(
    'completion details',
    'task completiton details',
    'task completion details',
    'file link',
  );
  map.assignee = find('task asignee name', 'task assignee name', 'assignee');
  map.startDate = find("start's date", 'start date', 'starts date');
  map.endDate = find("end's date", 'end date');

  return map;
}

function cell(row, col) {
  if (col === undefined || col === null) return '';
  return String(row[col] ?? '').trim();
}

function parseSteps(stepsRaw) {
  if (!stepsRaw) return [];
  const parts = stepsRaw
    .split(/\s*\/\s*|\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((title) => ({
    ref: slugRef('step', title),
    title,
  }));
}

function parsePostedAt(endDate, startDate) {
  for (const raw of [endDate, startDate]) {
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    const m = String(raw).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const d2 = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
      if (!Number.isNaN(d2.getTime())) return d2.toISOString();
    }
  }
  return new Date().toISOString();
}

function mapSheetStatus(statusRaw) {
  const s = String(statusRaw || '').toLowerCase().trim();
  if (!s) return { status: 'TO_DO', isComplete: false };
  if (/complete|done|finished|working/.test(s) && !/in.?progress|pending/.test(s)) {
    return { status: 'COMPLETED', isComplete: true };
  }
  if (/pending|to.?do|not.?start|scheduled/.test(s)) {
    return { status: 'TO_DO', isComplete: false };
  }
  if (/progress|wip|ongoing|process/.test(s)) {
    return { status: 'IN_PROGRESS', isComplete: false };
  }
  if (/review|approval|client/.test(s)) {
    return { status: 'NEEDS_REVIEW', isComplete: true, needsPmReview: true };
  }
  if (/block/.test(s)) {
    return { status: 'BLOCKED', isComplete: false };
  }
  return { status: normalizeStatus(statusRaw), isComplete: false };
}

function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const joined = rows[i].map(normalizeHeader).join(' ');
    if (joined.includes('main task') || joined.includes('sub task')) return i;
  }
  return 0;
}

/**
 * Parse assignee-tab or master-tab CSV rows into task groups + project updates.
 */
export function parsePhinixSheetRows(rows, options = {}) {
  const {
    sourceLabel = 'sheet',
    defaultAssigneeKey = null,
    projectRef = 'proj',
    assigneeTabName = null,
    spreadsheetId = null,
    projectLabel = null,
    masterTab = null,
  } = options;

  if (!rows?.length) {
    return { taskGroups: [], taskUpdates: [], stats: { rows: 0, tasks: 0, skipped: 0 } };
  }

  const headerIdx = findHeaderRowIndex(rows);
  const headers = rows[headerIdx];
  const col = detectPhinixColumnMap(headers);
  const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c || '').trim()));

  const groups = new Map();
  const taskUpdates = [];
  let skipped = 0;

  for (const row of dataRows) {
    const section = cell(row, col.section);
    let mainTask = cell(row, col.mainTask);
    let subTask = cell(row, col.subTask);

    if (!mainTask && subTask) mainTask = subTask;
    if (!subTask && mainTask) subTask = mainTask;
    if (!subTask) {
      skipped++;
      continue;
    }

    const milestone = mainTask || '(Unspecified)';
    const title = subTask;

    const assigneeRaw = cell(row, col.assignee) || defaultAssigneeKey || '';
    const assigneeKey =
      resolveAssigneeKey(assigneeRaw) || resolveAssigneeKey(defaultAssigneeKey) || 'hamza';

    const goal = cell(row, col.goal) || undefined;
    const description = cell(row, col.description) || undefined;
    const stepsRaw = cell(row, col.steps);
    const statusRaw = cell(row, col.status);
    const completionDetails = cell(row, col.completionDetails);
    const startDate = cell(row, col.startDate);
    const endDate = cell(row, col.endDate);

    const steps = parseSteps(stepsRaw);
    const { status, isComplete, needsPmReview } = mapSheetStatus(statusRaw);

    const taskRef = slugRef('task', `${projectRef}-${milestone}-${title}-${assigneeKey}`);
    const tabLabel = assigneeTabName || defaultAssigneeKey || assigneeKey;

    if (!groups.has(milestone)) {
      groups.set(milestone, {
        ref: slugRef('grp', `${projectRef}-${milestone}`),
        milestone,
        tasks: [],
      });
    }

    const taskType = inferTaskType(`${milestone} ${title}`);

    const task = {
      ref: taskRef,
      title,
      taskType,
      priority: 'MEDIUM',
      assigneeKey,
      goal,
      description: [description, section ? `Section: ${section}` : ''].filter(Boolean).join('\n\n') || undefined,
      steps: steps.length
        ? steps.map((s, idx) => ({
            ...s,
            ref: slugRef('step', `${taskRef}-${idx}-${s.title}`),
            progress: { status },
          }))
        : [],
      progress: { status },
      comments: [],
      deliverables: buildDeliverables({
        spreadsheetId,
        assigneeTabName: tabLabel,
        completionDetails,
        assigneeKey,
        title,
      }),
      _completionDetails: completionDetails,
      _stepsRaw: stepsRaw,
      _statusRaw: statusRaw,
      _assigneeTab: tabLabel,
    };

    groups.get(milestone).tasks.push(task);

    if (completionDetails || statusRaw || stepsRaw || status !== 'TO_DO') {
      const postedAt = parsePostedAt(endDate, startDate);
      const richUpdate = buildDeliverableComment({
        milestone,
        title,
        goal,
        description,
        stepsRaw,
        completionDetails,
        statusRaw,
        assigneeKey,
        assigneeTabName: tabLabel,
        spreadsheetId,
        projectLabel,
        masterTab,
      });

      task.comments.push({
        authorKey: assigneeKey,
        content: richUpdate,
        createdAt: postedAt,
      });

      taskUpdates.push({
        ref: slugRef('tu', `${taskRef}-${status}`),
        taskRef,
        update: richUpdate,
        authorKey: assigneeKey,
        postedAt,
        completion: {
          isComplete,
          status: needsPmReview ? 'NEEDS_REVIEW' : status,
          ...(needsPmReview ? { needsPmReview: true } : {}),
        },
      });
    }
  }

  return {
    taskGroups: [...groups.values()].filter((g) => g.tasks.length),
    taskUpdates,
    stats: {
      rows: dataRows.length,
      tasks: [...groups.values()].reduce((n, g) => n + g.tasks.length, 0),
      skipped,
    },
  };
}

export function parsePhinixCsv(csvText, options = {}) {
  const rows = parseCsv(csvText);
  return parsePhinixSheetRows(rows, options);
}

/**
 * Merge task groups from multiple assignee tabs (dedupe by ref).
 */
export function mergeTaskGroups(groupLists) {
  const byMilestone = new Map();

  for (const groups of groupLists) {
    for (const g of groups) {
      const key = g.milestone;
      if (!byMilestone.has(key)) {
        byMilestone.set(key, { ref: g.ref, milestone: g.milestone, tasks: [] });
      }
      const existing = byMilestone.get(key);
      const seen = new Set(existing.tasks.map((t) => t.ref));
      for (const t of g.tasks) {
        if (!seen.has(t.ref)) {
          existing.tasks.push(t);
          seen.add(t.ref);
        }
      }
    }
  }

  return [...byMilestone.values()].filter((g) => g.tasks.length);
}
