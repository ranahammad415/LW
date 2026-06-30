/**
 * Google Drive metadata and generic file handling.
 */
import { FILE_KIND, MIME } from './constants.js';
import { kindFromMime } from './urlParser.js';
import { extractGoogleUrlsFromText } from './urlParser.js';

/**
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {string} fileId
 * @param {(fn: () => Promise<unknown>) => Promise<unknown>} rateLimited
 */
export async function getDriveFileMeta(drive, fileId, rateLimited) {
  const res = await rateLimited(() =>
    drive.files.get({
      fileId,
      fields: 'id,name,mimeType,modifiedTime,createdTime,parents,shortcutDetails,webViewLink',
      supportsAllDrives: true,
    }),
  );
  return res.data;
}

/**
 * Resolve shortcut targets to the underlying file id and mime.
 */
export function resolveShortcut(meta) {
  if (meta.mimeType === MIME.GOOGLE_SHORTCUT && meta.shortcutDetails?.targetId) {
    return {
      fileId: meta.shortcutDetails.targetId,
      mimeType: meta.shortcutDetails.targetMimeType || meta.mimeType,
      name: meta.name,
      isShortcut: true,
      shortcutId: meta.id,
    };
  }
  return {
    fileId: meta.id,
    mimeType: meta.mimeType,
    name: meta.name,
    isShortcut: false,
  };
}

/**
 * List children of a folder (for BFS expansion).
 * @returns {Promise<Array<{ fileId: string, name: string, mimeType: string, webViewLink?: string }>>}
 */
export async function listFolderChildren(drive, folderId, rateLimited) {
  const items = [];
  let pageToken;
  do {
    const res = await rateLimited(() =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,mimeType,webViewLink,shortcutDetails)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      }),
    );
    for (const f of res.data.files || []) {
      const resolved = resolveShortcut(f);
      items.push({
        fileId: resolved.fileId,
        name: f.name,
        mimeType: resolved.mimeType,
        webViewLink: f.webViewLink,
        kind: kindFromMime(resolved.mimeType),
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Export non-native Drive file as text when possible.
 */
export async function exportDriveFileAsText(drive, fileId, mimeType, rateLimited) {
  const exportMime =
    mimeType === 'application/pdf'
      ? 'text/plain'
      : mimeType?.startsWith('text/')
        ? mimeType
        : null;
  if (!exportMime) {
    return { text: '', exported: false };
  }
  try {
    const res = await rateLimited(() =>
      drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' }),
    );
    const text = typeof res.data === 'string' ? res.data : '';
    return { text, exported: true };
  } catch {
    return { text: '', exported: false };
  }
}

/**
 * Build a minimal node for unknown/binary drive files.
 */
export async function extractDriveFile(drive, fileId, rateLimited) {
  const meta = await getDriveFileMeta(drive, fileId, rateLimited);
  const resolved = resolveShortcut(meta);
  const kind = kindFromMime(resolved.mimeType);
  const title = meta.name || fileId;
  let plainText = '';
  let links = [];

  if (kind === FILE_KIND.FOLDER) {
    const children = await listFolderChildren(drive, resolved.fileId, rateLimited);
    links = children.map((c) => ({
      fileId: c.fileId,
      kind: c.kind,
      normalizedUrl: c.webViewLink || `https://drive.google.com/open?id=${c.fileId}`,
      sourceUrl: c.webViewLink || '',
    }));
  } else if (kind === FILE_KIND.DRIVE_FILE) {
    const { text } = await exportDriveFileAsText(drive, resolved.fileId, resolved.mimeType, rateLimited);
    plainText = text;
    links = extractGoogleUrlsFromText(text);
  }

  return {
    fileId: resolved.fileId,
    shortcutId: resolved.isShortcut ? meta.id : undefined,
    kind,
    title,
    mimeType: resolved.mimeType,
    plainText,
    markdown: plainText ? `# ${title}\n\n${plainText}\n` : `# ${title}\n\n_(binary or unsupported file)_\n`,
    links,
    webViewLink: meta.webViewLink,
  };
}

export function isDriveAccessError(err) {
  const code = err?.code || err?.response?.status;
  return code === 403 || code === 404;
}
