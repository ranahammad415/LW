/**
 * Parse Google Workspace URLs into file id and kind.
 */
import { FILE_KIND } from './constants.js';

const DOC_RE = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const SHEET_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const DRIVE_FILE_RE = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/;
const DRIVE_OPEN_RE = /drive\.google\.com\/(?:open|uc)\?[^#]*id=([a-zA-Z0-9_-]+)/;
const FOLDER_RE = /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/;

/**
 * @param {string} url
 * @returns {{ fileId: string, kind: string, normalizedUrl: string } | null}
 */
export function parseGoogleUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  let m = trimmed.match(DOC_RE);
  if (m) {
    const fileId = m[1];
    return {
      fileId,
      kind: FILE_KIND.DOCUMENT,
      normalizedUrl: `https://docs.google.com/document/d/${fileId}/edit`,
    };
  }
  m = trimmed.match(SHEET_RE);
  if (m) {
    const fileId = m[1];
    return {
      fileId,
      kind: FILE_KIND.SPREADSHEET,
      normalizedUrl: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
    };
  }
  m = trimmed.match(FOLDER_RE);
  if (m) {
    const fileId = m[1];
    return {
      fileId,
      kind: FILE_KIND.FOLDER,
      normalizedUrl: `https://drive.google.com/drive/folders/${fileId}`,
    };
  }
  m = trimmed.match(DRIVE_FILE_RE);
  if (m) {
    const fileId = m[1];
    return {
      fileId,
      kind: FILE_KIND.DRIVE_FILE,
      normalizedUrl: `https://drive.google.com/file/d/${fileId}/view`,
    };
  }
  m = trimmed.match(DRIVE_OPEN_RE);
  if (m) {
    const fileId = m[1];
    return {
      fileId,
      kind: FILE_KIND.DRIVE_FILE,
      normalizedUrl: `https://drive.google.com/open?id=${fileId}`,
    };
  }
  return null;
}

/**
 * @param {string} mimeType
 * @returns {string}
 */
export function kindFromMime(mimeType) {
  if (!mimeType) return FILE_KIND.UNKNOWN;
  if (mimeType === 'application/vnd.google-apps.document') return FILE_KIND.DOCUMENT;
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return FILE_KIND.SPREADSHEET;
  if (mimeType === 'application/vnd.google-apps.folder') return FILE_KIND.FOLDER;
  return FILE_KIND.DRIVE_FILE;
}

/**
 * Collect parseable Google links from arbitrary text.
 * @param {string} text
 * @returns {Array<{ fileId: string, kind: string, normalizedUrl: string, sourceUrl: string }>}
 */
export function extractGoogleUrlsFromText(text) {
  if (!text) return [];
  const urlRe = /https?:\/\/[^\s)\]"'<>]+/gi;
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(urlRe)) {
    let raw = match[0].replace(/[.,;]+$/, '');
    const parsed = parseGoogleUrl(raw);
    if (!parsed || seen.has(parsed.fileId)) continue;
    seen.add(parsed.fileId);
    out.push({ ...parsed, sourceUrl: raw });
  }
  return out;
}
