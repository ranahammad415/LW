import { inferTaskType, normalizeStatus, slugRef } from './constants.js';

/**
 * Simple CSV parser (handles quoted fields).
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field.trim());
      field = '';
    } else if (c === '\n' || (c === '\r' && next === '\n')) {
      row.push(field.trim());
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      if (c === '\r') i++;
    } else if (c !== '\r') {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) rows.push(row);
  }

  return rows;
}

const COLUMN_ALIASES = {
  milestone: ['milestone', 'main task', 'main_task', 'category', 'phase', 'group', 'main'],
  title: ['sub task', 'subtask', 'sub_task', 'task', 'title', 'action item', 'action', 'work item'],
  assignee: ['assignee', 'owner', 'assigned to', 'assigned_to', 'who', 'team member'],
  status: ['status', 'state', 'progress'],
  goal: ['goal', 'main goal', 'main_goal', 'objective'],
  description: ['description', 'task description', 'task_description', 'details', 'notes'],
  priority: ['priority', 'prio'],
  taskType: ['task type', 'task_type', 'type'],
};

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function detectColumnMap(headers) {
  const map = {};
  const normalized = headers.map(normalizeHeader);

  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) {
        map[key] = i;
        break;
      }
    }
  }

  const stepCols = [];
  for (let i = 0; i < normalized.length; i++) {
    if (/^step\s*\d+$/i.test(normalized[i]) || normalized[i] === 'steps') {
      stepCols.push(i);
    }
  }
  if (stepCols.length) map.stepCols = stepCols;

  return map;
}

function cell(row, col) {
  if (col === undefined || col === null) return '';
  return String(row[col] ?? '').trim();
}

/**
 * Parse spreadsheet rows into taskGroups structure.
 */
export function rowsToTaskGroups(rows, sourceLabel = 'sheet') {
  if (!rows?.length) return [];

  const headers = rows[0];
  const col = detectColumnMap(headers);
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c || '').trim()));

  const groups = new Map();

  for (const row of dataRows) {
    const milestone = cell(row, col.milestone) || '(Unspecified)';
    const title = cell(row, col.title);
    if (!title) continue;

    if (!groups.has(milestone)) {
      groups.set(milestone, {
        ref: slugRef('grp', `${sourceLabel}-${milestone}`),
        milestone,
        tasks: [],
      });
    }

    const assigneeRaw = cell(row, col.assignee);
    const assigneeKey = assigneeRaw
      ? assigneeRaw.toLowerCase().split(/[@\s]+/)[0].replace(/[^a-z]/g, '')
      : undefined;

    const steps = [];
    if (col.stepCols?.length) {
      for (const sc of col.stepCols) {
        const stepTitle = cell(row, sc);
        if (!stepTitle) continue;
        if (sc === col.stepCols.find((i) => normalizeHeader(headers[i]) === 'steps')) {
          for (const line of stepTitle.split(/[\n;|]+/)) {
            const t = line.trim();
            if (t) steps.push({ ref: slugRef('step', t), title: t });
          }
        } else {
          steps.push({ ref: slugRef('step', stepTitle), title: stepTitle });
        }
      }
    }

    const statusRaw = cell(row, col.status);
    const progress = statusRaw ? { status: normalizeStatus(statusRaw) } : undefined;

    const taskTypeRaw = cell(row, col.taskType);
    const taskType = taskTypeRaw ? taskTypeRaw.toLowerCase().replace(/\s+/g, '-') : inferTaskType(title);

    groups.get(milestone).tasks.push({
      ref: slugRef('task', `${sourceLabel}-${title}`),
      title,
      taskType,
      priority: (cell(row, col.priority) || 'MEDIUM').toUpperCase(),
      assigneeKey,
      goal: cell(row, col.goal) || undefined,
      description: cell(row, col.description) || undefined,
      steps,
      progress,
    });
  }

  return [...groups.values()].filter((g) => g.tasks.length);
}
