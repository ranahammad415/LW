import { describe, it, expect } from 'vitest';
import {
  calcValueScore,
  mergeDuplicateSites,
  normalizeBacklinkRow,
  normalizeDomain,
  normalizeMetric,
  normalizeSiteUrl,
  normalizeTraffic,
  parseLinkType,
  pkrToUsd,
} from '../../src/lib/dataImport/backlinkNormalize.js';
import {
  buildCatalogOrderBy,
  buildCatalogWhere,
  buildSiteWriteData,
  canTransition,
  serializeSiteForClient,
} from '../../src/lib/backlinksHub.js';

describe('pkrToUsd', () => {
  it('reproduces the agreed reference conversions', () => {
    expect(pkrToUsd(1000)).toBe(5);
    expect(pkrToUsd(1500)).toBe(8);
  });

  it('rounds up so a converted price never lands under cost', () => {
    expect(pkrToUsd(300)).toBe(2);
    expect(pkrToUsd(2500)).toBe(13);
    expect(pkrToUsd(7000)).toBe(35);
    expect(pkrToUsd(30000)).toBe(150);
  });

  it('accepts formatted strings and rejects non-positive input', () => {
    expect(pkrToUsd('1,000')).toBe(5);
    expect(pkrToUsd(' 2000 ')).toBe(10);
    expect(pkrToUsd(0)).toBeNull();
    expect(pkrToUsd(-500)).toBeNull();
    expect(pkrToUsd('')).toBeNull();
    expect(pkrToUsd(null)).toBeNull();
    expect(pkrToUsd('n/a')).toBeNull();
  });

  it('honours a custom rate', () => {
    expect(pkrToUsd(1000, 250)).toBe(4);
  });
});

describe('normalizeTraffic', () => {
  it('expands K/M/B suffixes', () => {
    expect(normalizeTraffic('137.4K')).toBe(137400);
    expect(normalizeTraffic('1.5M')).toBe(1500000);
    expect(normalizeTraffic('2B')).toBe(2000000000);
  });

  it('handles the sloppy formats found in the source sheet', () => {
    expect(normalizeTraffic('8.k')).toBe(8000);
    expect(normalizeTraffic('5k+')).toBe(5000);
    expect(normalizeTraffic('1,200')).toBe(1200);
    expect(normalizeTraffic('  14500 ')).toBe(14500);
    expect(normalizeTraffic(9000)).toBe(9000);
  });

  it('returns null for unusable values', () => {
    expect(normalizeTraffic('')).toBeNull();
    expect(normalizeTraffic(null)).toBeNull();
    expect(normalizeTraffic(undefined)).toBeNull();
    expect(normalizeTraffic('unknown')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('reduces any URL form to a bare lowercase hostname', () => {
    expect(normalizeDomain('https://www.Example.com/some/path?q=1')).toBe('example.com');
    expect(normalizeDomain('http://EXAMPLE.co.uk')).toBe('example.co.uk');
    expect(normalizeDomain('example.com')).toBe('example.com');
    expect(normalizeDomain('  https://sub.example.com/  ')).toBe('sub.example.com');
  });

  it('collapses www and non-www variants to the same key', () => {
    expect(normalizeDomain('https://www.example.com')).toBe(normalizeDomain('https://example.com'));
  });

  it('returns null when there is no parseable host', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain('https://')).toBeNull();
  });

  it('builds a canonical https url', () => {
    expect(normalizeSiteUrl('http://www.example.com/path')).toBe('https://example.com/');
  });
});

describe('parseLinkType', () => {
  it('maps the three values used by the source sheet', () => {
    expect(parseLinkType('2 Do Follow')).toEqual({
      dofollowLinks: 2,
      placementType: 'GUEST_POST',
    });
    expect(parseLinkType('1 Do Follow')).toEqual({
      dofollowLinks: 1,
      placementType: 'GUEST_POST',
    });
    expect(parseLinkType('Sample Link')).toEqual({
      dofollowLinks: 1,
      placementType: 'PROFILE',
    });
  });

  it('falls back to a single guest-post link when blank', () => {
    expect(parseLinkType('')).toEqual({ dofollowLinks: 1, placementType: 'GUEST_POST' });
    expect(parseLinkType(null)).toEqual({ dofollowLinks: 1, placementType: 'GUEST_POST' });
  });
});

describe('normalizeMetric', () => {
  it('rounds values inside the 0-100 authority range', () => {
    expect(normalizeMetric('52')).toBe(52);
    expect(normalizeMetric(52.4)).toBe(52);
    expect(normalizeMetric('0')).toBe(0);
    expect(normalizeMetric('100')).toBe(100);
  });

  it('rejects out-of-range values rather than clamping them', () => {
    expect(normalizeMetric(261)).toBeNull();
    expect(normalizeMetric(-5)).toBeNull();
    expect(normalizeMetric('')).toBeNull();
    expect(normalizeMetric(null)).toBeNull();
  });
});

describe('calcValueScore', () => {
  it('rewards authority and punishes price', () => {
    const cheap = calcValueScore({ da: 50, dr: 50, monthlyTraffic: 50000, priceUsd: 5 });
    const pricey = calcValueScore({ da: 50, dr: 50, monthlyTraffic: 50000, priceUsd: 50 });
    expect(cheap).toBeGreaterThan(pricey);
    expect(cheap / pricey).toBeCloseTo(10, 1);
  });

  it('scores traffic logarithmically so one huge site cannot dominate', () => {
    const big = calcValueScore({ da: 40, dr: 40, monthlyTraffic: 1_000_000, priceUsd: 10 });
    const small = calcValueScore({ da: 40, dr: 40, monthlyTraffic: 10_000, priceUsd: 10 });
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(small * 2);
  });

  it('returns 0 rather than Infinity when price is missing', () => {
    expect(calcValueScore({ da: 50, dr: 50, monthlyTraffic: 1000, priceUsd: 0 })).toBe(0);
    expect(calcValueScore({ da: 50, dr: 50, monthlyTraffic: 1000, priceUsd: null })).toBe(0);
  });
});

describe('normalizeBacklinkRow', () => {
  const goodRow = {
    website: 'https://www.TheActionElite.com/',
    da: '52',
    dr: '45',
    traffic: '137.4K',
    price: '1500',
    linkType: '2 Do Follow',
  };

  it('converts a clean source row into a catalog record', () => {
    const { site, error } = normalizeBacklinkRow(goodRow);
    expect(error).toBeUndefined();
    expect(site).toMatchObject({
      domain: 'theactionelite.com',
      url: 'https://theactionelite.com/',
      da: 52,
      dr: 45,
      monthlyTraffic: 137400,
      priceUsd: 8,
      dofollowLinks: 2,
      placementType: 'GUEST_POST',
    });
    expect(site.valueScore).toBeGreaterThan(0);
  });

  it('never carries supplier or source-currency fields through', () => {
    const { site } = normalizeBacklinkRow({
      ...goodRow,
      existingNew: 'New Added - 8 April',
      paymentTerms: 'Payment Advance',
      price: '1500',
    });
    expect(Object.keys(site).sort()).toEqual([
      'da',
      'dofollowLinks',
      'domain',
      'dr',
      'monthlyTraffic',
      'placementType',
      'priceUsd',
      'url',
      'valueScore',
    ]);
    expect(JSON.stringify(site)).not.toMatch(/price"?\s*:\s*"?1500/);
  });

  it('prefers an explicit priceUsd over source-currency conversion', () => {
    const { site } = normalizeBacklinkRow({ ...goodRow, priceUsd: 12, price: 1500 });
    expect(site.priceUsd).toBe(12);
  });

  it('quarantines the corrupt DA row instead of clamping it', () => {
    const { site, error } = normalizeBacklinkRow({ ...goodRow, da: '261', dr: '', traffic: '' });
    expect(site).toBeUndefined();
    expect(error).toMatch(/DA out of range/);
  });

  it('quarantines rows with a missing price', () => {
    const { error } = normalizeBacklinkRow({ ...goodRow, price: '' });
    expect(error).toMatch(/Missing or invalid price/);
  });

  it('quarantines rows with unparseable traffic and bad URLs', () => {
    expect(normalizeBacklinkRow({ ...goodRow, traffic: 'lots' }).error).toMatch(/traffic/);
    expect(normalizeBacklinkRow({ ...goodRow, website: 'not a url' }).error).toMatch(/website URL/);
    expect(normalizeBacklinkRow({ ...goodRow, website: '' }).error).toMatch(/website URL/);
  });

  it('accepts a bare hostname without a scheme', () => {
    const { site, error } = normalizeBacklinkRow({ ...goodRow, website: 'example.com' });
    expect(error).toBeUndefined();
    expect(site.domain).toBe('example.com');
  });
});

describe('mergeDuplicateSites', () => {
  it('keeps the highest price and the best metric from each duplicate', () => {
    const { sites, collisions } = mergeDuplicateSites([
      {
        domain: 'dup.com',
        url: 'https://dup.com/',
        da: 40,
        dr: 0,
        monthlyTraffic: 1000,
        priceUsd: 5,
        dofollowLinks: 1,
        placementType: 'GUEST_POST',
      },
      {
        domain: 'dup.com',
        url: 'https://dup.com/',
        da: 35,
        dr: 50,
        monthlyTraffic: 8000,
        priceUsd: 8,
        dofollowLinks: 2,
        placementType: 'GUEST_POST',
      },
    ]);

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      da: 40,
      dr: 50,
      monthlyTraffic: 8000,
      priceUsd: 8,
      dofollowLinks: 2,
    });
    expect(collisions).toEqual([
      { domain: 'dup.com', pricesUsd: [5, 8], resolvedPriceUsd: 8 },
    ]);
  });

  it('recomputes the value score after merging', () => {
    const { sites } = mergeDuplicateSites([
      { domain: 'a.com', da: 10, dr: 10, monthlyTraffic: 100, priceUsd: 5, dofollowLinks: 1, placementType: 'GUEST_POST' },
      { domain: 'a.com', da: 80, dr: 80, monthlyTraffic: 100, priceUsd: 5, dofollowLinks: 1, placementType: 'GUEST_POST' },
    ]);
    expect(sites[0].valueScore).toBe(
      calcValueScore({ da: 80, dr: 80, monthlyTraffic: 100, priceUsd: 5 }),
    );
  });

  it('leaves unique domains untouched and reports no collisions', () => {
    const input = [
      { domain: 'a.com', da: 1, dr: 1, monthlyTraffic: 1, priceUsd: 5, dofollowLinks: 1, placementType: 'GUEST_POST' },
      { domain: 'b.com', da: 2, dr: 2, monthlyTraffic: 2, priceUsd: 6, dofollowLinks: 1, placementType: 'GUEST_POST' },
    ];
    const { sites, collisions } = mergeDuplicateSites(input);
    expect(sites).toHaveLength(2);
    expect(collisions).toHaveLength(0);
  });

  it('tracks every price seen across three or more duplicates', () => {
    const row = (priceUsd) => ({
      domain: 'trip.com',
      da: 10,
      dr: 10,
      monthlyTraffic: 10,
      priceUsd,
      dofollowLinks: 1,
      placementType: 'GUEST_POST',
    });
    const { sites, collisions } = mergeDuplicateSites([row(5), row(13), row(8)]);
    expect(sites[0].priceUsd).toBe(13);
    expect(collisions[0].pricesUsd).toEqual([5, 13, 8]);
    expect(collisions[0].resolvedPriceUsd).toBe(13);
  });
});

describe('serializeSiteForClient', () => {
  const adminRow = {
    id: 'site-1',
    domain: 'example.com',
    url: 'https://example.com/',
    da: 40,
    dr: 45,
    monthlyTraffic: 12000,
    priceUsd: '8.00',
    valueScore: '61.20',
    dofollowLinks: 2,
    placementType: 'GUEST_POST',
    category: 'Tech',
    country: null,
    language: null,
    turnaroundDays: 3,
    sampleUrl: null,
    isFeatured: false,
    tags: null,
    isActive: true,
    internalNotes: 'Supplier contact: do not share',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('omits internalNotes and isActive from client payloads', () => {
    const result = serializeSiteForClient(adminRow);
    expect(result).not.toHaveProperty('internalNotes');
    expect(result).not.toHaveProperty('isActive');
    expect(JSON.stringify(result)).not.toContain('Supplier contact');
  });

  it('exposes only the whitelisted catalog fields', () => {
    expect(Object.keys(serializeSiteForClient(adminRow)).sort()).toEqual([
      'category',
      'country',
      'da',
      'dofollowLinks',
      'domain',
      'dr',
      'id',
      'isFeatured',
      'language',
      'monthlyTraffic',
      'placementType',
      'priceUsd',
      'sampleUrl',
      'tags',
      'turnaroundDays',
      'url',
      'valueScore',
    ]);
  });

  it('converts Decimal columns to plain numbers', () => {
    const result = serializeSiteForClient(adminRow);
    expect(result.priceUsd).toBe(8);
    expect(result.valueScore).toBe(61.2);
    expect(typeof result.priceUsd).toBe('number');
  });
});

describe('buildCatalogWhere', () => {
  it('forces active listings for the client catalog regardless of the query', () => {
    expect(buildCatalogWhere({ isActive: false }, { forceActive: true }).isActive).toBe(true);
  });

  it('lets admins filter by either status', () => {
    expect(buildCatalogWhere({ isActive: false }).isActive).toBe(false);
    expect(buildCatalogWhere({}).isActive).toBeUndefined();
  });

  it('translates min/max pairs into range clauses', () => {
    const where = buildCatalogWhere({ minDa: 30, maxDa: 60, maxPrice: 20 });
    expect(where.da).toEqual({ gte: 30, lte: 60 });
    expect(where.priceUsd).toEqual({ lte: 20 });
    expect(where.dr).toBeUndefined();
  });

  it('searches domain and url', () => {
    const where = buildCatalogWhere({ search: 'elite' });
    expect(where.OR).toEqual([{ domain: { contains: 'elite' } }, { url: { contains: 'elite' } }]);
  });
});

describe('buildCatalogOrderBy', () => {
  it('adds a stable tiebreaker so pagination cannot repeat rows', () => {
    expect(buildCatalogOrderBy({ sortBy: 'priceUsd', sortDir: 'asc' })).toEqual([
      { priceUsd: 'asc' },
      { domain: 'asc' },
    ]);
  });

  it('does not duplicate the tiebreaker when sorting by domain', () => {
    expect(buildCatalogOrderBy({ sortBy: 'domain', sortDir: 'asc' })).toEqual([{ domain: 'asc' }]);
  });
});

describe('buildSiteWriteData', () => {
  it('normalizes the domain and derives the canonical url', () => {
    const data = buildSiteWriteData({
      domain: 'https://www.Example.com/pricing',
      da: 40,
      dr: 40,
      monthlyTraffic: 1000,
      priceUsd: 10,
    });
    expect(data.domain).toBe('example.com');
    expect(data.url).toBe('https://example.com/');
  });

  it('recomputes valueScore from the merged row on a partial update', () => {
    const existing = { da: 60, dr: 60, monthlyTraffic: 50000, priceUsd: '20.00' };
    const data = buildSiteWriteData({ priceUsd: 10 }, existing);
    expect(data.valueScore).toBe(
      calcValueScore({ da: 60, dr: 60, monthlyTraffic: 50000, priceUsd: 10 }),
    );
  });

  it('rejects an unparseable domain', () => {
    expect(() => buildSiteWriteData({ domain: 'https://' })).toThrow(/Invalid domain/);
  });
});

describe('canTransition', () => {
  it('allows the documented order lifecycle', () => {
    expect(canTransition('PENDING_REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('PENDING_REVIEW', 'REJECTED')).toBe(true);
    expect(canTransition('APPROVED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('blocks moves that would rewrite a settled order', () => {
    expect(canTransition('COMPLETED', 'PENDING_REVIEW')).toBe(false);
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false);
    expect(canTransition('CANCELLED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('PENDING_REVIEW', 'COMPLETED')).toBe(false);
  });

  it('treats a no-op transition as allowed', () => {
    expect(canTransition('APPROVED', 'APPROVED')).toBe(true);
  });
});
