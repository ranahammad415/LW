import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../../src/lib/dataImport/backlinkXlsx.js';

// The real supplier workbook lives beside the repo rather than inside it, so
// these assertions only run where it is available.
const SOURCE_XLSX = path.resolve(
  import.meta.dirname,
  '../../../Backlinks Hub Personal Authors .xlsx',
);
const hasSource = fs.existsSync(SOURCE_XLSX);

describe.skipIf(!hasSource)('convert-backlinks-xlsx against the real workbook', () => {
  const { catalog, report } = convert(SOURCE_XLSX, { rate: 200 });

  it('finds the header row and maps the columns it needs', () => {
    expect(report.headerRow).toBe(5);
    expect(report.columnMapping).toMatchObject({
      website: expect.any(String),
      da: expect.any(String),
      dr: expect.any(String),
      traffic: expect.any(String),
      price: expect.any(String),
      linkType: expect.any(String),
    });
  });

  it('produces one record per unique domain', () => {
    const domains = catalog.sites.map((s) => s.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(catalog.sites.length).toBeGreaterThan(3300);
  });

  it('merges the duplicate domains and reports each collision', () => {
    expect(report.totals.mergedDuplicates).toBeGreaterThan(0);
    for (const collision of report.duplicateCollisions) {
      expect(collision.resolvedPriceUsd).toBe(Math.max(...collision.pricesUsd));
    }
  });

  it('quarantines the corrupt rows instead of importing them', () => {
    const reasons = report.rejectedRows.map((row) => row.reason);
    expect(report.rejectedRows.length).toBeGreaterThan(0);
    expect(reasons.some((r) => /DA out of range/.test(r))).toBe(true);
    expect(reasons.some((r) => /Missing or invalid price/.test(r))).toBe(true);
    for (const row of report.rejectedRows) {
      expect(catalog.sites.find((s) => row.website.includes(s.domain))).toBeUndefined();
    }
  });

  it('emits only USD prices, all positive whole dollars', () => {
    expect(catalog.currency).toBe('USD');
    for (const site of catalog.sites) {
      expect(site.priceUsd).toBeGreaterThan(0);
      expect(Number.isInteger(site.priceUsd)).toBe(true);
    }
  });

  it('keeps every metric inside its valid range', () => {
    for (const site of catalog.sites) {
      expect(site.da).toBeGreaterThanOrEqual(0);
      expect(site.da).toBeLessThanOrEqual(100);
      expect(site.dr).toBeGreaterThanOrEqual(0);
      expect(site.dr).toBeLessThanOrEqual(100);
      expect(site.monthlyTraffic).toBeGreaterThanOrEqual(0);
    }
  });

  it('drops every supplier column, so no record carries one', () => {
    const allowed = [
      'domain',
      'url',
      'da',
      'dr',
      'monthlyTraffic',
      'priceUsd',
      'dofollowLinks',
      'placementType',
      'valueScore',
    ].sort();
    for (const site of catalog.sites) {
      expect(Object.keys(site).sort()).toEqual(allowed);
    }
  });

  it('normalizes domains to lowercase without a www prefix', () => {
    for (const site of catalog.sites) {
      expect(site.domain).toBe(site.domain.toLowerCase());
      expect(site.domain.startsWith('www.')).toBe(false);
    }
  });

  it('maps link types onto the two supported placements', () => {
    const placements = new Set(catalog.sites.map((s) => s.placementType));
    expect([...placements].sort()).toEqual(['GUEST_POST', 'PROFILE']);
  });

  it('converts the reference prices exactly as agreed', () => {
    // The sheet's PKR ladder starts at 300 and tops out at 30000.
    const prices = catalog.sites.map((s) => s.priceUsd);
    expect(Math.min(...prices)).toBe(2);
    expect(Math.max(...prices)).toBe(150);
    expect(prices.filter((p) => p === 5).length).toBeGreaterThan(1000);
  });
});
