/**
 * Extract outbound Google links from structured doc content and plain text.
 */
import { extractGoogleUrlsFromText, parseGoogleUrl } from './urlParser.js';

/**
 * @param {object} doc - Google Docs API document resource
 * @returns {{ links: Array<{ fileId: string, kind: string, normalizedUrl: string, sourceUrl: string }>, plainText: string }}
 */
export function extractFromGoogleDoc(doc) {
  const links = [];
  const seen = new Set();
  const textParts = [];

  const body = doc?.body?.content;
  if (!Array.isArray(body)) {
    return { links: [], plainText: '' };
  }

  for (const el of body) {
    if (el.paragraph) {
      walkParagraph(el.paragraph, links, seen, textParts);
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellEl of cell.content || []) {
            if (cellEl.paragraph) walkParagraph(cellEl.paragraph, links, seen, textParts);
          }
        }
      }
      textParts.push('\n');
    }
  }

  const plainText = textParts.join('');
  for (const u of extractGoogleUrlsFromText(plainText)) {
    if (!seen.has(u.fileId)) {
      seen.add(u.fileId);
      links.push(u);
    }
  }

  return { links, plainText };
}

function walkParagraph(paragraph, links, seen, textParts) {
  for (const elem of paragraph.elements || []) {
    const tr = elem.textRun;
    if (!tr) continue;
    if (tr.content) textParts.push(tr.content);
    const url = tr.textStyle?.link?.url;
    if (url) {
      const parsed = parseGoogleUrl(url);
      if (parsed && !seen.has(parsed.fileId)) {
        seen.add(parsed.fileId);
        links.push({ ...parsed, sourceUrl: url });
      }
    }
  }
  textParts.push('\n');
}

/**
 * Merge link lists deduped by fileId.
 * @param {...Array<{ fileId: string }>} lists
 */
export function dedupeLinks(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      if (item?.fileId && !map.has(item.fileId)) map.set(item.fileId, item);
    }
  }
  return [...map.values()];
}
