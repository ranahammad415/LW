/**
 * BFS crawler over linked Google Docs, Sheets, and Drive files.
 */
import { FILE_KIND } from './constants.js';
import { parseGoogleUrl, kindFromMime } from './urlParser.js';
import { extractDocument, isDocsAccessError } from './docExtractor.js';
import { extractSpreadsheet, isSheetsAccessError } from './sheetExtractor.js';
import {
  extractDriveFile,
  getDriveFileMeta,
  resolveShortcut,
  isDriveAccessError,
} from './driveExtractor.js';

/**
 * @typedef {object} CrawlNode
 * @property {string} fileId
 * @property {string} kind
 * @property {number} depth
 * @property {string|null} parentFileId
 * @property {string} [url]
 * @property {object} [payload]
 * @property {string} [error]
 * @property {boolean} [accessNeeded]
 */

/**
 * @param {object} options
 * @param {import('googleapis').drive_v3.Drive} options.drive
 * @param {import('googleapis').docs_v1.Docs} options.docs
 * @param {import('googleapis').sheets_v4.Sheets} options.sheets
 * @param {string} options.rootUrl
 * @param {number} options.maxDepth
 * @param {number} options.maxFiles
 * @param {boolean} options.dryRun
 * @param {number} options.rateLimitMs
 * @param {Map<string, CrawlNode>} [options.existingNodes]
 * @param {string[]} [options.resumeFileIds] - only fetch these if not already successful
 * @param {(event: object) => void} [options.onProgress]
 */
export async function crawlGoogleKnowledge(options) {
  const {
    drive,
    docs,
    sheets,
    rootUrl,
    maxDepth,
    maxFiles,
    dryRun,
    rateLimitMs,
    existingNodes = new Map(),
    resumeFileIds = null,
    onProgress,
  } = options;

  const visited = new Set(existingNodes.keys());
  const nodes = new Map(existingNodes);
  const accessNeeded = [];
  const queue = [];

  const rootParsed = parseGoogleUrl(rootUrl);
  if (!rootParsed) {
    throw new Error(`Could not parse root Google URL: ${rootUrl}`);
  }

  if (resumeFileIds?.length) {
    for (const fileId of resumeFileIds) {
      const prev = existingNodes.get(fileId);
      queue.push({
        fileId,
        kind: prev?.kind || FILE_KIND.UNKNOWN,
        depth: prev?.depth ?? 0,
        parentFileId: prev?.parentFileId ?? null,
        url: prev?.url,
      });
    }
  } else if (!visited.has(rootParsed.fileId)) {
    queue.push({
      fileId: rootParsed.fileId,
      kind: rootParsed.kind,
      depth: 0,
      parentFileId: null,
      url: rootParsed.normalizedUrl,
    });
  }

  const rateLimited = createRateLimiter(rateLimitMs);

  while (queue.length > 0 && nodes.size < maxFiles) {
    const item = queue.shift();
    if (!item) break;
    if (item.depth > maxDepth) continue;

    const resumeOnly = resumeFileIds?.length;
    if (visited.has(item.fileId) && !resumeOnly) {
      const existing = nodes.get(item.fileId);
      if (existing && !existing.accessNeeded) continue;
    }

    if (dryRun) {
      const node = {
        fileId: item.fileId,
        kind: item.kind,
        depth: item.depth,
        parentFileId: item.parentFileId,
        url: item.url,
        dryRun: true,
        title: item.fileId,
      };
      nodes.set(item.fileId, node);
      visited.add(item.fileId);
      onProgress?.({ type: 'dry_run', fileId: item.fileId });
      continue;
    }

    let kind = item.kind;
    let url = item.url;

    try {
      if (kind === FILE_KIND.UNKNOWN || kind === FILE_KIND.DRIVE_FILE) {
        const meta = await getDriveFileMeta(drive, item.fileId, rateLimited);
        const resolved = resolveShortcut(meta);
        kind = kindFromMime(resolved.mimeType);
        url = meta.webViewLink || url;
        item.fileId = resolved.fileId;
      }

      const payload = await fetchByKind({
        kind,
        fileId: item.fileId,
        docs,
        sheets,
        drive,
        rateLimited,
      });

      const node = {
        fileId: item.fileId,
        kind,
        depth: item.depth,
        parentFileId: item.parentFileId,
        url: url || payload.webViewLink,
        title: payload.title,
        likelyRole: payload.likelyRole,
        payload,
        childFileIds: [],
        extractedAt: new Date().toISOString(),
      };

      nodes.set(item.fileId, node);
      visited.add(item.fileId);

      onProgress?.({ type: 'extracted', fileId: item.fileId, title: payload.title });

      if (item.depth < maxDepth) {
        for (const link of payload.links || []) {
          if (nodes.size + queue.length >= maxFiles) break;
          const childId = link.fileId;
          const parent = nodes.get(item.fileId);
          if (parent && !parent.childFileIds.includes(childId)) {
            parent.childFileIds.push(childId);
          }
          if (!visited.has(childId)) {
            queue.push({
              fileId: childId,
              kind: link.kind,
              depth: item.depth + 1,
              parentFileId: item.fileId,
              url: link.normalizedUrl,
            });
          }
        }
      }
    } catch (err) {
      const access = isAccessError(err, kind);
      const errNode = {
        fileId: item.fileId,
        kind: item.kind,
        depth: item.depth,
        parentFileId: item.parentFileId,
        url,
        error: err.message || String(err),
        accessNeeded: access,
      };
      nodes.set(item.fileId, errNode);
      visited.add(item.fileId);
      if (access) {
        accessNeeded.push({
          fileId: item.fileId,
          url: url || rootUrl,
          kind: item.kind,
          parentFileId: item.parentFileId,
          error: errNode.error,
        });
      }
      onProgress?.({ type: 'error', fileId: item.fileId, error: errNode.error, accessNeeded: access });
    }
  }

  return { nodes, accessNeeded, truncated: nodes.size >= maxFiles };
}

async function fetchByKind({ kind, fileId, docs, sheets, drive, rateLimited }) {
  if (kind === FILE_KIND.DOCUMENT) {
    return extractDocument(docs, fileId, rateLimited);
  }
  if (kind === FILE_KIND.SPREADSHEET) {
    return extractSpreadsheet(sheets, fileId, rateLimited);
  }
  return extractDriveFile(drive, fileId, rateLimited);
}

function isAccessError(err, kind) {
  if (kind === FILE_KIND.DOCUMENT) return isDocsAccessError(err);
  if (kind === FILE_KIND.SPREADSHEET) return isSheetsAccessError(err);
  return isDriveAccessError(err);
}

function createRateLimiter(ms) {
  let last = 0;
  return async function rateLimited(fn) {
    const now = Date.now();
    const wait = Math.max(0, last + ms - now);
    if (wait > 0) await sleep(wait);
    const result = await fn();
    last = Date.now();
    return result;
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
