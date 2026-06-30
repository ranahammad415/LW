/**
 * Google Docs extraction (read-only).
 */
import { extractFromGoogleDoc } from './linkExtractor.js';
import { FILE_KIND } from './constants.js';

/**
 * @param {import('googleapis').docs_v1.Docs} docs
 * @param {string} fileId
 * @param {(fn: () => Promise<unknown>) => Promise<unknown>} rateLimited
 */
export async function extractDocument(docs, fileId, rateLimited) {
  const doc = await rateLimited(() => docs.documents.get({ documentId: fileId }));
  const title = doc.data.title || fileId;
  const { links, plainText } = extractFromGoogleDoc(doc.data);

  return {
    fileId,
    kind: FILE_KIND.DOCUMENT,
    title,
    plainText,
    markdown: docPlainToMarkdown(doc.data, plainText),
    links,
    raw: {
      revisionId: doc.data.revisionId,
      documentId: doc.data.documentId,
    },
  };
}

function docPlainToMarkdown(doc, plainText) {
  const title = doc.title || 'Untitled';
  const lines = [`# ${title}`, '', plainText || ''];
  return lines.join('\n').trimEnd() + '\n';
}

export function isDocsAccessError(err) {
  const code = err?.code || err?.response?.status;
  return code === 403 || code === 404;
}
