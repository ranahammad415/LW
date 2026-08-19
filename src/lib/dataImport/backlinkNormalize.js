/**
 * Pure normalization helpers for backlink inventory ingestion.
 *
 * Source inventory arrives as a spreadsheet with human-typed metrics (traffic as
 * "137.4K", prices in PKR). Everything here converts that into the canonical
 * shape stored by BacklinkSite. No provider, cost or PKR data survives this layer.
 */

/** Source sheet quotes prices in PKR; the catalog only ever stores whole USD. */
export const PKR_PER_USD = 200;

export const PLACEMENT_TYPES = ['GUEST_POST', 'PROFILE'];

/**
 * 1000 PKR -> $5, 1500 PKR -> $8. Rounds up so a converted price never lands
 * below the source cost.
 */
export function pkrToUsd(pkr, rate = PKR_PER_USD) {
  const amount = typeof pkr === 'number' ? pkr : Number(String(pkr ?? '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.ceil(amount / rate);
}

/** "137.4K" -> 137400, "1.5M" -> 1500000, "5k+" -> 5000, "1,200" -> 1200. */
export function normalizeTraffic(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/[,\s+]/g, '');
  if (!raw) return null;
  const match = raw.match(/^([\d.]+)([kmb])?/i);
  if (!match) return null;
  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num)) return null;
  const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
  const multiplier = match[2] ? multipliers[match[2].toLowerCase()] : 1;
  return Math.round(num * multiplier);
}

/** Lowercased hostname without a leading "www.", so duplicates collapse. */
export function normalizeDomain(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Canonical https URL for a domain, dropping any path/query from the source. */
export function normalizeSiteUrl(input) {
  const domain = normalizeDomain(input);
  return domain ? `https://${domain}/` : null;
}

/**
 * The source sheet only ever uses "2 Do Follow", "1 Do Follow" or "Sample Link".
 * Sample links are profile placements rather than guest posts.
 */
export function parseLinkType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return { dofollowLinks: 1, placementType: 'GUEST_POST' };
  if (raw.includes('sample')) return { dofollowLinks: 1, placementType: 'PROFILE' };
  const match = raw.match(/(\d+)/);
  const count = match ? Number.parseInt(match[1], 10) : 1;
  return {
    dofollowLinks: Math.min(Math.max(count, 1), 10),
    placementType: 'GUEST_POST',
  };
}

/** Authority metrics are 0-100; anything else is a typo in the source sheet. */
export function normalizeMetric(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const num = Number.parseFloat(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

/**
 * Blended desirability metric so clients can sort by value rather than raw price.
 * Traffic is scored logarithmically, otherwise a single 1.5M-visit site would
 * dominate every ranking.
 */
export function calcValueScore({ da, dr, monthlyTraffic, priceUsd }) {
  const price = Number(priceUsd);
  if (!Number.isFinite(price) || price <= 0) return 0;
  const trafficPoints = Math.min(
    100,
    Math.max(0, (Math.log10(Math.max(Number(monthlyTraffic) || 1, 1)) / 6) * 100),
  );
  const authority = (Number(da) || 0) * 0.4 + (Number(dr) || 0) * 0.4 + trafficPoints * 0.2;
  return Math.round((authority / price) * 10 * 100) / 100;
}

/**
 * Builds a BacklinkSite payload from one raw spreadsheet row.
 * Returns { site } on success or { error } describing why the row was rejected.
 */
export function normalizeBacklinkRow(row, options = {}) {
  const { rate = PKR_PER_USD } = options;
  const domain = normalizeDomain(row.website);
  if (!domain) return { error: 'Unparseable website URL' };

  const priceUsd = row.priceUsd != null ? Math.ceil(Number(row.priceUsd)) : pkrToUsd(row.price, rate);
  if (!priceUsd || priceUsd <= 0) return { error: 'Missing or invalid price' };

  const da = normalizeMetric(row.da);
  if (da === null) return { error: `DA out of range or missing (got "${row.da ?? ''}")` };

  const dr = normalizeMetric(row.dr);
  if (dr === null) return { error: `DR out of range or missing (got "${row.dr ?? ''}")` };

  const monthlyTraffic = normalizeTraffic(row.traffic);
  if (monthlyTraffic === null) return { error: `Unparseable traffic (got "${row.traffic ?? ''}")` };

  const { dofollowLinks, placementType } = parseLinkType(row.linkType);
  const site = {
    domain,
    url: normalizeSiteUrl(row.website),
    da,
    dr,
    monthlyTraffic,
    priceUsd,
    dofollowLinks,
    placementType,
  };
  site.valueScore = calcValueScore(site);
  return { site };
}

/**
 * Collapses repeated domains into a single listing, keeping the highest price so
 * the catalog never undercharges, and the strongest metric seen for each field so
 * blanks in one row are filled from its twin.
 */
export function mergeDuplicateSites(sites) {
  const byDomain = new Map();
  const collisions = [];

  for (const site of sites) {
    const existing = byDomain.get(site.domain);
    if (!existing) {
      byDomain.set(site.domain, { ...site });
      continue;
    }
    const merged = {
      ...existing,
      da: Math.max(existing.da, site.da),
      dr: Math.max(existing.dr, site.dr),
      monthlyTraffic: Math.max(existing.monthlyTraffic, site.monthlyTraffic),
      priceUsd: Math.max(existing.priceUsd, site.priceUsd),
      dofollowLinks: Math.max(existing.dofollowLinks, site.dofollowLinks),
      placementType: existing.placementType === 'PROFILE' ? site.placementType : existing.placementType,
    };
    merged.valueScore = calcValueScore(merged);
    byDomain.set(site.domain, merged);

    const record = collisions.find((c) => c.domain === site.domain);
    if (record) {
      record.pricesUsd.push(site.priceUsd);
      record.resolvedPriceUsd = merged.priceUsd;
    } else {
      collisions.push({
        domain: site.domain,
        pricesUsd: [existing.priceUsd, site.priceUsd],
        resolvedPriceUsd: merged.priceUsd,
      });
    }
  }

  return { sites: [...byDomain.values()], collisions };
}
