/**
 * Google Sheets extraction (read-only) — metadata + per-tab CSV.
 */
import { FILE_KIND } from './constants.js';
import { extractGoogleUrlsFromText } from './urlParser.js';

const MAX_ROWS_PER_TAB = Number(process.env.EXTRACT_MAX_SHEET_ROWS || 500);

/**
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @param {string} fileId
 * @param {(fn: () => Promise<unknown>) => Promise<unknown>} rateLimited
 */
export async function extractSpreadsheet(sheets, fileId, rateLimited) {
  const meta = await rateLimited(() =>
    sheets.spreadsheets.get({
      spreadsheetId: fileId,
      includeGridData: false,
    }),
  );

  const title = meta.data.properties?.title || fileId;
  const sheetTabs = meta.data.sheets || [];
  const csvSheets = [];
  const links = [];
  const seen = new Set();

  for (const tab of sheetTabs) {
    const sheetTitle = tab.properties?.title || 'Sheet';
    const sheetId = tab.properties?.sheetId;
    const range = `'${sheetTitle.replace(/'/g, "''")}'`;
    let values;
    try {
      const res = await rateLimited(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId: fileId,
          range,
          valueRenderOption: 'FORMATTED_VALUE',
        }),
      );
      values = res.data.values || [];
    } catch {
      values = [];
    }
    const truncated = values.length > MAX_ROWS_PER_TAB;
    if (truncated) values = values.slice(0, MAX_ROWS_PER_TAB);
    const csv = valuesToCsv(values);
    for (const u of extractGoogleUrlsFromText(csv)) {
      if (!seen.has(u.fileId)) {
        seen.add(u.fileId);
        links.push(u);
      }
    }
    csvSheets.push({
      sheetId,
      title: sheetTitle,
      rowCount: values.length,
      truncated,
      csv,
    });
  }

  return {
    fileId,
    kind: FILE_KIND.SPREADSHEET,
    title,
    links,
    sheets: csvSheets,
    plainText: csvSheets.map((s) => `# ${s.title}\n${s.csv}`).join('\n\n'),
    markdown: `# ${title}\n\n${csvSheets.map((s) => `## ${s.title}\n\n\`\`\`csv\n${s.csv}\n\`\`\``).join('\n\n')}\n`,
  };
}

function valuesToCsv(rows) {
  return rows
    .map((row) =>
      (row || []).map((cell) => {
        const s = cell == null ? '' : String(cell);
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      }).join(','),
    )
    .join('\n');
}

export function isSheetsAccessError(err) {
  const code = err?.code || err?.response?.status;
  return code === 403 || code === 404;
}
