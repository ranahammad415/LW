import {
  PHINIX_PROJECTS,
  PHINIX_TEAM_ROSTER,
  PHINIX_MASTER_SPREADSHEET_ID,
  ASSIGNEE_TAB_NAMES,
  gvizCsvUrl,
} from './phinixSheetConfig.js';
import { parsePhinixCsv, mergeTaskGroups } from './phinixAssigneeParser.js';
import { resolveAssigneeKey } from './phinixSheetConfig.js';
import { buildClientPmUpdate } from './phinixPmUpdateBuilder.js';

const FETCH_TIMEOUT_MS = 60_000;

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function fetchSheetCsv(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const text = await res.text();
    if (text.includes('<!DOCTYPE') || text.includes('Sign in')) {
      throw new Error('Sheet requires Google sign-in (not publicly accessible)');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build agency-data v1.1 JSON from Phinix Google Sheets (all 7 projects).
 * @param {{ projects?: string[], fetchFn?: typeof fetchSheetCsv }} options
 */
export async function buildPhinixAgencyData(options = {}) {
  const { fetchFn = fetchSheetCsv } = options;
  const projectFilter = options.projects?.map((p) => p.toLowerCase()) || null;

  const selected = PHINIX_PROJECTS.filter((p) => {
    if (!projectFilter) return true;
    return projectFilter.some(
      (f) =>
        p.ref.includes(f) ||
        p.projectMatch.projectNameContains.toLowerCase().includes(f) ||
        p.name.toLowerCase().includes(f),
    );
  });

  const buildLog = [];
  const projects = [];

  for (const proj of selected) {
    const tabNames = proj.assigneeTabs || ASSIGNEE_TAB_NAMES;
    const allGroups = [];
    const allUpdates = [];
    const tabStats = [];

    for (const tabName of tabNames) {
      const url = gvizCsvUrl(proj.spreadsheetId, tabName);
      const assigneeKey = resolveAssigneeKey(tabName);

      try {
        const csv = await fetchFn(url);
        const parsed = parsePhinixCsv(csv, {
          sourceLabel: `${proj.ref}-${tabName}`,
          defaultAssigneeKey: assigneeKey,
          projectRef: proj.ref,
          assigneeTabName: tabName,
          spreadsheetId: proj.spreadsheetId,
          projectLabel: proj.name,
          masterTab: proj.masterTab,
        });

        if (parsed.stats.tasks > 0) {
          allGroups.push(parsed.taskGroups);
          allUpdates.push(...parsed.taskUpdates);
          tabStats.push({ tab: tabName, ...parsed.stats });
        }
      } catch (err) {
        tabStats.push({ tab: tabName, error: err.message });
        buildLog.push({ project: proj.name, tab: tabName, error: err.message });
      }

      await delay(150);
    }

    if (!allGroups.length && proj.masterTab) {
      try {
        const url = gvizCsvUrl(PHINIX_MASTER_SPREADSHEET_ID, proj.masterTab);
        const csv = await fetchFn(url);
        const parsed = parsePhinixCsv(csv, {
          sourceLabel: `${proj.ref}-master`,
          projectRef: proj.ref,
        });
        if (parsed.stats.tasks > 0) {
          allGroups.push(parsed.taskGroups);
          allUpdates.push(...parsed.taskUpdates);
          tabStats.push({ tab: `master:${proj.masterTab}`, ...parsed.stats });
        }
      } catch (err) {
        buildLog.push({ project: proj.name, tab: proj.masterTab, error: err.message });
      }
    }

    const taskGroups = mergeTaskGroups(allGroups);
    const taskCount = taskGroups.reduce((n, g) => n + g.tasks.length, 0);

    if (!taskCount) {
      buildLog.push({ project: proj.name, warning: 'No tasks parsed from any tab' });
      continue;
    }

    const reportedAt = new Date().toISOString();

    projects.push({
      ref: proj.ref,
      projectMatch: proj.projectMatch,
      project: {
        name: proj.name,
        projectType: proj.projectType,
        status: 'ACTIVE',
        leadPmKey: proj.leadPmKey,
        ...(proj.wpUrl ? { wpUrl: proj.wpUrl } : {}),
      },
      taskGroups,
      projectUpdates: [
        {
          ref: `${proj.ref}-pu-june-2026`,
          periodLabel: `${proj.planLabel} — imported from Google Sheets`,
          reportedAt,
          reportedByKey: proj.leadPmKey,
          narrative: `Imported ${taskCount} tasks from Phinix task plan spreadsheets. Status and completion notes synced from assignee sheets.`,
          taskUpdates: allUpdates,
        },
      ],
      pmUpdates: [
        {
          ref: `${proj.ref}-pmu-june`,
          message: buildClientPmUpdate({
            projectName: proj.name,
            planLabel: proj.planLabel,
            taskGroups,
            taskUpdates: allUpdates,
            authorKey: proj.leadPmKey,
          }),
          authorKey: proj.leadPmKey,
          createdAt: reportedAt,
          clientVisible: true,
        },
      ],
      businessUpdates: [],
      keywords: [],
      _importMeta: { tabStats, taskCount, updateCount: allUpdates.length },
    });

    buildLog.push({
      project: proj.name,
      taskGroups: taskGroups.length,
      tasks: taskCount,
      updates: allUpdates.length,
      tabs: tabStats,
    });
  }

  return {
    meta: {
      version: '1.1',
      planLabel: 'Phinix Solutions — June 2026 SEO Plans (All Projects)',
      importMode: 'plan_with_progress',
      generatedAt: new Date().toISOString(),
      generatedBy: 'build-phinix-agency-data',
      notes:
        'Built from Phinix Google Sheets assignee tabs. projectUpdates drive task comments and completion status.',
    },
    teamRoster: PHINIX_TEAM_ROSTER,
    projects,
    _buildLog: buildLog,
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
