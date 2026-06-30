/**
 * Orchestrate Google Knowledge extraction: crawl, package, resume.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES,
  DEFAULT_RATE_LIMIT_MS,
  EXTRACTIONS_DIR_NAME,
} from './constants.js';
import { getAuthenticatedClients, isWorkspaceAuthConfigured, getServiceAccountEmail } from './auth.js';
import { parseGoogleUrl } from './urlParser.js';
import { crawlGoogleKnowledge } from './crawler.js';
import { writeExtractionPackage } from './writers/packageWriter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '../../..');

/**
 * @param {string} outDir
 * @returns {Promise<{ manifest: object, nodes: Map<string, object>, outDir: string }>}
 */
export async function loadExistingRun(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const nodes = new Map();

  const nodesDir = path.join(outDir, 'nodes');
  let files;
  try {
    files = await fs.readdir(nodesDir);
  } catch {
    files = [];
  }

  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const fileId = name.replace(/\.json$/, '');
    const nodeRaw = await fs.readFile(path.join(nodesDir, name), 'utf8');
    const stored = JSON.parse(nodeRaw);
    nodes.set(fileId, {
      fileId,
      kind: stored.kind,
      depth: stored.depth,
      parentFileId: stored.parentFileId,
      url: stored.url,
      title: stored.title,
      likelyRole: stored.likelyRole,
      payload: stored.payload,
      childFileIds: stored.childFileIds || [],
      extractedAt: stored.extractedAt,
      error: stored.error,
      accessNeeded: stored.accessNeeded,
      dryRun: stored.dryRun,
    });
  }

  return { manifest, nodes, outDir };
}

function defaultExtractionsRoot() {
  return path.join(BACKEND_ROOT, EXTRACTIONS_DIR_NAME);
}

async function collectResumeFileIds(nodes, outDir) {
  try {
    const raw = await fs.readFile(path.join(outDir, 'access-needed.json'), 'utf8');
    const list = JSON.parse(raw);
    const fromFile = list.map((a) => a.fileId).filter(Boolean);
    if (fromFile.length) return fromFile;
  } catch {
    // fall through
  }
  const ids = [];
  for (const [fileId, node] of nodes.entries()) {
    if (node.error || node.accessNeeded) ids.push(fileId);
  }
  return ids;
}

/**
 * @param {object} options
 * @param {string} options.rootUrl
 * @param {string} [options.outDir]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxFiles]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.resume]
 * @param {string} [options.monthFilter] - YYYY-MM
 * @param {(event: object) => void} [options.onProgress]
 */
export async function runExtraction(options) {
  const {
    rootUrl: rootUrlInput,
    outDir: outDirInput,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxFiles = DEFAULT_MAX_FILES,
    dryRun = false,
    resume = false,
    monthFilter = null,
    onProgress,
  } = options;

  if (!isWorkspaceAuthConfigured()) {
    throw new Error('Google Workspace auth is not configured (service account or OAuth refresh token).');
  }

  let runId;
  let rootUrl = rootUrlInput;
  let outDir = outDirInput;
  let existingNodes = new Map();
  let resumeFileIds = null;
  let startedAt = new Date().toISOString();

  if (resume) {
    if (!outDir) {
      throw new Error('resume requires --out pointing at an existing extraction directory');
    }
    const loaded = await loadExistingRun(outDir);
    runId = loaded.manifest.runId;
    rootUrl = rootUrl || loaded.manifest.rootUrl;
    existingNodes = loaded.nodes;
    startedAt = loaded.manifest.startedAt || startedAt;
    resumeFileIds = await collectResumeFileIds(existingNodes, outDir);
    if (!resumeFileIds.length) {
      onProgress?.({ type: 'resume', message: 'No failed nodes to retry; continuing crawl for new links only.' });
      resumeFileIds = null;
    }
  } else {
    if (!rootUrl) {
      throw new Error('rootUrl is required');
    }
    runId = randomUUID();
    outDir = outDir || path.join(defaultExtractionsRoot(), runId);
    await fs.mkdir(outDir, { recursive: true });
  }

  const rootParsed = parseGoogleUrl(rootUrl);
  if (!rootParsed) {
    throw new Error(`Could not parse root Google URL: ${rootUrl}`);
  }

  const { drive, docs, sheets } = await getAuthenticatedClients();

  const { nodes, accessNeeded, truncated } = await crawlGoogleKnowledge({
    drive,
    docs,
    sheets,
    rootUrl,
    maxDepth,
    maxFiles,
    dryRun,
    rateLimitMs: DEFAULT_RATE_LIMIT_MS,
    existingNodes,
    resumeFileIds,
    onProgress,
  });

  const shareWith = await getServiceAccountEmail();
  const accessNeededEnriched = accessNeeded.map((a) => ({
    ...a,
    linkedFrom: a.parentFileId || null,
    shareWith: shareWith || 'Use OAuth account with file access',
    title: nodes.get(a.fileId)?.title || a.fileId,
  }));

  const pkg = {
    runId,
    rootUrl,
    rootFileId: rootParsed.fileId,
    startedAt,
    nodes,
    accessNeeded: accessNeededEnriched,
    truncated,
    monthFilter,
    options: { maxDepth, maxFiles, dryRun, resume: Boolean(resume), monthFilter },
  };

  const writeResult = await writeExtractionPackage(outDir, pkg);

  return {
    runId,
    outDir,
    rootUrl,
    rootFileId: rootParsed.fileId,
    shareWith,
    manifest: writeResult.manifest,
    reportPath: writeResult.reportPath,
    stats: writeResult.manifest.stats,
    accessNeeded: accessNeededEnriched,
    truncated,
  };
}