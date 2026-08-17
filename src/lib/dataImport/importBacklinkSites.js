import { prisma } from '../prisma.js';
import {
  PLACEMENT_TYPES,
  calcValueScore,
  normalizeBacklinkRow,
  mergeDuplicateSites,
} from './backlinkNormalize.js';

const MAX_ERRORS_REPORTED = 200;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Accepts either the canonical catalog shape produced by convert-backlinks-xlsx
 * (already normalized, priceUsd present) or looser hand-authored rows, and
 * returns validated BacklinkSite payloads plus per-row errors.
 */
function normalizeIncoming(sites) {
  const valid = [];
  const errors = [];

  sites.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      errors.push({ index, reason: 'Entry is not an object' });
      return;
    }

    const { site, error } = normalizeBacklinkRow(
      {
        website: entry.domain || entry.url || entry.website,
        da: entry.da,
        dr: entry.dr,
        traffic: entry.monthlyTraffic ?? entry.traffic,
        priceUsd: entry.priceUsd,
        price: entry.price,
        linkType: entry.linkType,
      },
      {},
    );

    if (error) {
      errors.push({ index, domain: entry.domain || entry.url || null, reason: error });
      return;
    }

    // Optional descriptive fields pass through untouched when supplied.
    if (entry.placementType && PLACEMENT_TYPES.includes(entry.placementType)) {
      site.placementType = entry.placementType;
    }
    if (toNumber(entry.dofollowLinks) !== null) {
      site.dofollowLinks = Math.min(Math.max(Math.round(toNumber(entry.dofollowLinks)), 1), 10);
    }
    site.valueScore = calcValueScore(site);

    for (const field of ['category', 'country', 'language', 'sampleUrl']) {
      if (typeof entry[field] === 'string' && entry[field].trim()) site[field] = entry[field].trim();
    }
    if (toNumber(entry.turnaroundDays) !== null) {
      site.turnaroundDays = Math.round(toNumber(entry.turnaroundDays));
    }
    if (Array.isArray(entry.tags) && entry.tags.length) site.tags = entry.tags;
    if (typeof entry.isActive === 'boolean') site.isActive = entry.isActive;
    if (typeof entry.isFeatured === 'boolean') site.isFeatured = entry.isFeatured;

    valid.push(site);
  });

  return { valid, errors };
}

/**
 * Imports a backlink catalog document into BacklinkSite, keyed on domain.
 *
 * @param {object} data - `{ sites: [...] }` catalog document
 * @param {{ dryRun?: boolean, mode?: 'merge'|'replace', deactivateMissing?: boolean }} options
 *   mode 'merge' (default) leaves untouched rows alone; 'replace' deactivates any
 *   existing site absent from the payload rather than deleting order history.
 */
export async function importBacklinkSites(data, options = {}) {
  const { dryRun = false, mode = 'merge' } = options;
  const incoming = Array.isArray(data) ? data : data?.sites;

  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new Error('Catalog payload must contain a non-empty "sites" array');
  }

  const { valid, errors } = normalizeIncoming(incoming);
  const { sites, collisions } = mergeDuplicateSites(valid);

  const domains = sites.map((s) => s.domain);
  const existing = await prisma.backlinkSite.findMany({
    where: { domain: { in: domains } },
    select: { id: true, domain: true, priceUsd: true, da: true, dr: true, isActive: true },
  });
  const existingByDomain = new Map(existing.map((row) => [row.domain, row]));

  const summary = {
    dryRun,
    mode,
    received: incoming.length,
    valid: valid.length,
    uniqueSites: sites.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    mergedDuplicates: collisions.length,
    duplicateCollisions: collisions.slice(0, MAX_ERRORS_REPORTED),
    priceChanges: [],
    errors: errors.slice(0, MAX_ERRORS_REPORTED),
    errorCount: errors.length,
  };

  for (const site of sites) {
    const current = existingByDomain.get(site.domain);
    if (!current) {
      summary.created += 1;
      if (!dryRun) await prisma.backlinkSite.create({ data: site });
      continue;
    }

    const previousPrice = Number(current.priceUsd);
    const changed =
      previousPrice !== site.priceUsd || current.da !== site.da || current.dr !== site.dr;

    if (previousPrice !== site.priceUsd) {
      summary.priceChanges.push({
        domain: site.domain,
        fromUsd: previousPrice,
        toUsd: site.priceUsd,
      });
    }

    if (changed) summary.updated += 1;
    else summary.unchanged += 1;

    if (!dryRun) {
      await prisma.backlinkSite.update({ where: { id: current.id }, data: site });
    }
  }

  if (mode === 'replace') {
    const stale = await prisma.backlinkSite.findMany({
      where: { isActive: true, domain: { notIn: domains } },
      select: { id: true },
    });
    summary.deactivated = stale.length;
    if (!dryRun && stale.length) {
      await prisma.backlinkSite.updateMany({
        where: { id: { in: stale.map((row) => row.id) } },
        data: { isActive: false },
      });
    }
  }

  summary.priceChanges = summary.priceChanges.slice(0, MAX_ERRORS_REPORTED);
  return summary;
}
