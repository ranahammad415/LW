/**
 * Reads a backlink inventory spreadsheet into a catalog document.
 *
 * The xlsx format is a zip of XML parts, so this parses it directly with node's
 * built-in zlib rather than pulling in a spreadsheet dependency for what is
 * essentially an occasional one-way import.
 *
 * Only the columns the catalog needs survive: website, DA, DR, traffic, price and
 * link type. Supplier bookkeeping (batch labels, payment terms, source-currency
 * amounts) is discarded here so it can never reach the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PKR_PER_USD, mergeDuplicateSites, normalizeBacklinkRow } from './backlinkNormalize.js';

// ---------------------------------------------------------------------------
// Minimal zip reader
// ---------------------------------------------------------------------------

export function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid xlsx file (no zip end-of-central-directory)');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Sheet parsing
// ---------------------------------------------------------------------------

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const item of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const run of item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += run[1];
    strings.push(decodeXml(text));
  }
  return strings;
}

function columnLetter(ref) {
  const match = ref.match(/^([A-Z]+)/);
  return match ? match[1] : '';
}

export function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cellMatch of rowMatch[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      const inlineMatch = body.match(/<is>([\s\S]*?)<\/is>/);

      let value = '';
      if (type === 's' && valueMatch) {
        value = sharedStrings[Number(valueMatch[1])] ?? '';
      } else if (type === 'inlineStr' && inlineMatch) {
        for (const run of inlineMatch[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) value += run[1];
        value = decodeXml(value);
      } else if (valueMatch) {
        value = decodeXml(valueMatch[1]);
      }
      cells[columnLetter(ref)] = value.replace(/[\r\n\t]+/g, ' ').trim();
    }
    rows.push({ rowNumber: Number(rowMatch[1]), cells });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  website: ['website', 'websites', 'site', 'domain', 'url'],
  da: ['da'],
  dr: ['dr'],
  traffic: ['traffic', 'monthly traffic'],
  price: ['price', 'cost'],
  linkType: ['link type', 'linktype'],
};

/** Locates the header row and maps each needed field to its column letter. */
export function detectColumns(rows) {
  for (const row of rows) {
    const entries = Object.entries(row.cells);
    const mapping = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const hit = entries.find(([, value]) => aliases.includes(value.trim().toLowerCase()));
      if (hit) mapping[field] = hit[0];
    }
    if (mapping.website && mapping.price && mapping.da) {
      return { headerRow: row.rowNumber, mapping };
    }
  }
  throw new Error('Could not find a header row containing Website, DA and Price columns');
}

export function convert(filePath, { rate = PKR_PER_USD } = {}) {
  const entries = readZipEntries(fs.readFileSync(filePath));
  const sheetName = [...entries.keys()].find((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name));
  if (!sheetName) throw new Error('Workbook has no xl/worksheets/sheet1.xml');

  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const rows = parseSheetRows(entries.get(sheetName).toString('utf8'), sharedStrings);
  const { headerRow, mapping } = detectColumns(rows);

  const accepted = [];
  const rejected = [];
  let skippedNonData = 0;

  for (const row of rows) {
    if (row.rowNumber <= headerRow) continue;
    const website = row.cells[mapping.website] || '';
    // Banner, branding and section rows have no URL in the website column.
    if (!/^https?:\/\//i.test(website)) {
      if (Object.values(row.cells).some((v) => v)) skippedNonData += 1;
      continue;
    }

    const raw = {
      website,
      da: row.cells[mapping.da],
      dr: row.cells[mapping.dr],
      traffic: row.cells[mapping.traffic],
      price: row.cells[mapping.price],
      linkType: row.cells[mapping.linkType],
    };
    const { site, error } = normalizeBacklinkRow(raw, { rate });
    if (error) {
      rejected.push({ rowNumber: row.rowNumber, website, reason: error, raw });
      continue;
    }
    accepted.push(site);
  }

  const { sites, collisions } = mergeDuplicateSites(accepted);
  sites.sort((a, b) => a.domain.localeCompare(b.domain));

  const generatedAt = new Date().toISOString();
  return {
    catalog: {
      version: 1,
      generatedAt,
      currency: 'USD',
      source: path.basename(filePath),
      sites,
    },
    report: {
      generatedAt,
      source: path.basename(filePath),
      conversionRatePkrPerUsd: rate,
      headerRow,
      columnMapping: mapping,
      totals: {
        dataRows: accepted.length + rejected.length,
        accepted: accepted.length,
        rejected: rejected.length,
        skippedNonDataRows: skippedNonData,
        uniqueSites: sites.length,
        mergedDuplicates: collisions.length,
      },
      duplicateCollisions: collisions.sort((a, b) => a.domain.localeCompare(b.domain)),
      rejectedRows: rejected,
    },
  };
}
