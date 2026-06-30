import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv, rowsToTaskGroups } from './csvTaskParser.js';
import { slugRef } from './constants.js';
import { generateChat, isAiConfigured } from '../ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_IMPORT_DIR = path.resolve(__dirname, '../../../prisma/data-import');

const DEFAULT_TEAM_ROSTER = {
  hamza: { email: 'hamza@thephinixsolutions.com', name: 'Hamza Ashraf', required: true },
  sami: { email: 'sami@thephinixsolutions.com', name: 'Sami Ullah', required: true },
  mudassar: { email: 'mudassar@thephinixsolutions.com', name: 'Mudassar Nazar', required: true },
  bisma: { email: 'bisma@thephinixsolutions.com', name: 'Bisma Syed', required: true },
  awais: { email: 'awais@thephinixsolutions.com', name: 'Awais Sadiq', required: true },
};

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function findSheetCsvs(extractionDir, fileId) {
  const dir = path.join(extractionDir, 'sheets', fileId);
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.csv')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function readNodeText(extractionDir, fileId) {
  const jsonPath = path.join(extractionDir, 'nodes', `${fileId}.json`);
  try {
    const node = await readJson(jsonPath);
    return node.payload?.plainText || node.payload?.markdown || node.title || '';
  } catch {
    return '';
  }
}

/**
 * Heuristic map: extraction package → agency-data v1.1 JSON.
 */
export async function mapExtractionPackageHeuristic(extractionDir, options = {}) {
  const {
    projectNameContains,
    clientNameContains,
    planLabel = 'Imported plan',
    importMode = 'plan_with_progress',
    teamRoster = DEFAULT_TEAM_ROSTER,
  } = options;

  const taskSourcesPath = path.join(extractionDir, 'organized', 'task-sources.json');
  const updateSourcesPath = path.join(extractionDir, 'organized', 'update-sources.json');

  let taskSources = [];
  let updateSources = [];
  try {
    taskSources = (await readJson(taskSourcesPath)).items || [];
  } catch {
    const indexPath = path.join(extractionDir, 'index.json');
    const index = await readJson(indexPath);
    taskSources = index.filter((e) => e.likelyRole === 'task_plan' || e.kind === 'spreadsheet');
  }
  try {
    updateSources = (await readJson(updateSourcesPath)).items || [];
  } catch {
    updateSources = [];
  }

  const taskGroups = [];
  for (const src of taskSources) {
    if (src.kind !== 'spreadsheet' && src.type !== 'spreadsheet') {
      const text = await readNodeText(extractionDir, src.fileId);
      if (text.length > 100) {
        taskGroups.push({
          ref: slugRef('grp', src.title || src.fileId),
          milestone: src.title || 'Imported from doc',
          tasks: [
            {
              ref: slugRef('task', src.fileId),
              title: src.title || 'Review imported doc content',
              taskType: 'reporting',
              description: text.slice(0, 2000),
              steps: [],
            },
          ],
        });
      }
      continue;
    }

    const csvPaths = await findSheetCsvs(extractionDir, src.fileId);
    for (const csvPath of csvPaths) {
      const csv = await fs.readFile(csvPath, 'utf8');
      const rows = parseCsv(csv);
      const sheetLabel = path.basename(csvPath, '.csv');
      const groups = rowsToTaskGroups(rows, `${src.fileId}-${sheetLabel}`);
      taskGroups.push(...groups);
    }
  }

  const projectUpdates = [];
  for (const src of updateSources) {
    const text = await readNodeText(extractionDir, src.fileId);
    if (!text.trim()) continue;
    projectUpdates.push({
      ref: slugRef('pu', src.fileId),
      periodLabel: src.title || 'Progress update',
      reportedAt: new Date().toISOString(),
      narrative: text.slice(0, 500),
      taskUpdates: [],
    });
  }

  let manifest = {};
  try {
    manifest = await readJson(path.join(extractionDir, 'manifest.json'));
  } catch {
    /* optional */
  }

  return {
    meta: {
      version: '1.1',
      planLabel,
      importMode,
      generatedAt: new Date().toISOString(),
      generatedBy: 'extraction-mapper-heuristic',
      sourceRunId: manifest.runId || null,
      notes: 'Auto-mapped from Google extraction. Review taskGroups and add projectUpdates.taskUpdates before import.',
    },
    teamRoster,
    projects: [
      {
        ref: slugRef('proj', projectNameContains || 'import'),
        projectMatch: {
          projectNameContains: projectNameContains || undefined,
          clientNameContains: clientNameContains || undefined,
        },
        taskGroups,
        projectUpdates,
        pmUpdates: [],
        businessUpdates: [],
        keywords: [],
      },
    ],
  };
}

/**
 * AI-assisted map: extraction package → agency-data v1.1 JSON.
 */
export async function mapExtractionPackageAi(extractionDir, options = {}) {
  if (!isAiConfigured()) {
    throw new Error('AI not configured. Set ANTHROPIC_API_KEY or use heuristic mapping.');
  }

  const heuristic = await mapExtractionPackageHeuristic(extractionDir, options);

  let agentPrompt = '';
  try {
    agentPrompt = await fs.readFile(path.join(DATA_IMPORT_DIR, 'DATA_AGENT_PROMPT.md'), 'utf8');
  } catch {
    agentPrompt = 'Produce agency-data v1.1 JSON with taskGroups and projectUpdates.';
  }

  const manifest = await readJson(path.join(extractionDir, 'manifest.json')).catch(() => ({}));
  const sampleTexts = [];
  for (const src of heuristic.projects[0]?.taskGroups?.slice(0, 3) || []) {
    sampleTexts.push(JSON.stringify(src, null, 2));
  }
  for (const pu of heuristic.projects[0]?.projectUpdates?.slice(0, 2) || []) {
    sampleTexts.push(pu.narrative || '');
  }

  const userPayload = {
    extractionRunId: manifest.runId,
    rootUrl: manifest.rootUrl,
    projectMatch: heuristic.projects[0]?.projectMatch,
    heuristicTaskGroups: heuristic.projects[0]?.taskGroups,
    updateNarratives: (heuristic.projects[0]?.projectUpdates || []).map((p) => p.narrative),
    instructions:
      'Refine into complete agency-data v1.1 JSON. Add projectUpdates.taskUpdates with taskRef matching refs in taskGroups. Use teamRoster from heuristic.',
  };

  const { parsed, text } = await generateChat({
    system: agentPrompt.slice(0, 12000),
    user: JSON.stringify(userPayload, null, 2),
    json: true,
    maxTokens: 8192,
    feature: 'extraction_to_agency_data',
  });

  if (parsed?.projects) return parsed;
  if (parsed?.meta && parsed?.teamRoster) return parsed;

  throw new Error(`AI mapping did not return valid agency-data JSON. Raw: ${text?.slice(0, 300)}`);
}

export async function mapExtractionPackage(extractionDir, options = {}) {
  if (options.useAi) return mapExtractionPackageAi(extractionDir, options);
  return mapExtractionPackageHeuristic(extractionDir, options);
}
