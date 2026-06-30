import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { sanitizeUploadFilename, MAX_UPLOAD_SIZE_BYTES } from './uploadUrl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HTML_REPORTS_ROOT = join(__dirname, '..', '..', 'uploads');

const ALLOWED_HTML_MIMES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/octet-stream',
]);

const ALLOWED_HTML_EXTS = new Set(['html', 'htm']);

export function isValidReportMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '').trim());
}

export function validateHtmlReportUpload({ mimetype, filename, size }) {
  if (typeof size === 'number' && size > MAX_UPLOAD_SIZE_BYTES) {
    return {
      ok: false,
      message: `File exceeds ${Math.round(MAX_UPLOAD_SIZE_BYTES / 1024 / 1024)}MB limit`,
    };
  }
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (!ALLOWED_HTML_EXTS.has(ext)) {
    return { ok: false, message: 'Only .html or .htm files are allowed' };
  }
  const mt = String(mimetype || '').toLowerCase();
  if (!ALLOWED_HTML_MIMES.has(mt) && !mt.startsWith('text/')) {
    return { ok: false, message: `File type not allowed: ${mt || 'unknown'}` };
  }
  return { ok: true };
}

/**
 * Save HTML report file under uploads/reports/{projectId}/{month}/.
 * @returns {{ storedPath: string, absolutePath: string }}
 */
export function saveHtmlReportFile({ projectId, month, filename, buffer }) {
  const safeName = sanitizeUploadFilename(filename || 'report.html');
  const storedName = `${randomUUID()}-${safeName}`;
  const relDir = join('reports', projectId, month);
  const absDir = join(HTML_REPORTS_ROOT, relDir);
  mkdirSync(absDir, { recursive: true });
  const storedPath = join(relDir, storedName).replace(/\\/g, '/');
  const absolutePath = join(HTML_REPORTS_ROOT, storedPath);
  writeFileSync(absolutePath, buffer);
  return { storedPath, absolutePath };
}

export function getHtmlReportAbsolutePath(storedPath) {
  const normalized = String(storedPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (normalized.includes('..')) return null;
  return join(HTML_REPORTS_ROOT, normalized);
}

export function readHtmlReportFile(storedPath) {
  const absolutePath = getHtmlReportAbsolutePath(storedPath);
  if (!absolutePath || !existsSync(absolutePath)) {
    return null;
  }
  return readFileSync(absolutePath, 'utf-8');
}

export function deleteHtmlReportFile(storedPath) {
  const absolutePath = getHtmlReportAbsolutePath(storedPath);
  if (absolutePath && existsSync(absolutePath)) {
    unlinkSync(absolutePath);
  }
}

export const HTML_REPORT_VIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https:; img-src * data: https:; font-src * data: https:; connect-src 'none'; script-src 'none'; frame-src 'none'";
