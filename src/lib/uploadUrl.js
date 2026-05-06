// Shared helpers for file-upload endpoints: safe base-URL resolution and
// MIME / size validation. Centralised so all upload handlers share the same
// allow-list and don't build URLs from spoofable Host headers in production.

const MAX_UPLOAD_SIZE_BYTES = Number(process.env.MAX_UPLOAD_SIZE_BYTES || 25 * 1024 * 1024);

const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const ALLOWED_MIME_EXACT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/rtf',
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
  // Browsers sometimes send octet-stream when they can't sniff the type; we
  // still block dangerous extensions below so this is safe to keep.
  'application/octet-stream',
]);

const BLOCKED_EXTS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'sh', 'jar', 'vbs', 'scr',
  'app', 'dll', 'so', 'dylib', 'pif', 'reg', 'apk', 'deb', 'rpm',
]);

/**
 * Returns the base URL that should prefix stored files.
 * Priority:
 *   1. APP_BASE_URL env var (recommended in production).
 *   2. FRONTEND_URL (if it points at the same origin as the API \u2014 rare; kept
 *      for dev convenience when frontend and backend share an origin).
 *   3. `${request.protocol}://${request.host}` \u2014 only trust this when
 *      TRUST_PROXY is enabled and a reverse proxy is setting the headers.
 */
export function resolveUploadBaseUrl(request) {
  const appBase = process.env.APP_BASE_URL;
  if (appBase) return appBase.replace(/\/$/, '');
  const trustProxy = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
  if (!trustProxy && process.env.NODE_ENV === 'production') {
    // Last-resort: refuse to spoof \u2014 return empty so handlers fall back to a
    // relative URL. Clients can prefix with their API base URL.
    return '';
  }
  return `${request.protocol}://${request.host}`;
}

/**
 * Validates an incoming upload's MIME type / size / extension.
 * Call with the fields returned by `@fastify/multipart` `request.file()`.
 */
export function validateUpload({ mimetype, filename, size }) {
  if (typeof size === 'number' && size > MAX_UPLOAD_SIZE_BYTES) {
    return {
      ok: false,
      message: `File exceeds ${Math.round(MAX_UPLOAD_SIZE_BYTES / 1024 / 1024)}MB limit`,
    };
  }
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (ext && BLOCKED_EXTS.has(ext)) {
    return { ok: false, message: 'File type not allowed (executable content)' };
  }
  const mt = String(mimetype || '').toLowerCase();
  const allowed =
    ALLOWED_MIME_PREFIXES.some((p) => mt.startsWith(p)) ||
    ALLOWED_MIME_EXACT.has(mt);
  if (!allowed) {
    return { ok: false, message: `File type not allowed: ${mt || 'unknown'}` };
  }
  return { ok: true };
}

/**
 * Normalises a filename for on-disk storage: removes directory separators
 * and characters that could cause issues on any filesystem.
 */
export function sanitizeUploadFilename(filename) {
  return String(filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

export { MAX_UPLOAD_SIZE_BYTES };
