/**
 * DataForSEO location picker (features/local-seo.md §Location). `GET /v3/serp/google/locations/{country}` is free
 * (DataForSEO does not bill it) and returns every location of one country with location_code, location_name
 * ("Milwaukee,Wisconsin,United States"), location_type and the parent code. The list is cached in memory per country
 * for LOCATIONS_TTL_MS (one call per country per day per PM2 instance); postal codes are dropped to keep it small.
 */
import { parseDfsTask, getDataForSeo } from '../dataforseo/client.js';

export const LOCATIONS_TTL_MS = 24 * 3600_000;
const cache = new Map();
const TYPE_RANK = { City: 0, Neighborhood: 1, Municipality: 1, County: 2, 'DMA Region': 3, State: 4, Region: 4, Province: 4, Country: 5 };

export function isCountryCode(cc) {
  return /^[a-z]{2}$/.test(String(cc || ''));
}

/** Parse the locations payload. Pure. */
export function parseLocations(result) {
  const list = Array.isArray(result) ? result : [];
  const out = [];
  for (const r of list) {
    const code = Number(r?.location_code);
    if (!Number.isInteger(code) || code <= 0 || !r?.location_name) continue;
    const type = String(r.location_type || '');
    if (/postal/i.test(type)) continue;
    out.push({ code, name: String(r.location_name).slice(0, 255), type, countryCode: r.country_iso_code || null });
  }
  return out;
}

/** Locations of one country (cached). `get` is injectable for tests. */
export async function countryLocations(country, { get = getDataForSeo, now = Date.now() } = {}) {
  const cc = String(country || '').toLowerCase();
  if (!isCountryCode(cc)) throw new Error('Invalid country code');
  const hit = cache.get(cc);
  if (hit && now - hit.at < LOCATIONS_TTL_MS) return hit.list;
  // The locations endpoint returns the list as `result` itself (one entry per location), not result[0].items.
  const json = await get(`/v3/serp/google/locations/${cc}`);
  parseDfsTask(json); // top-level + task-level status check (throws on errors)
  const list = parseLocations(json?.tasks?.[0]?.result);
  cache.set(cc, { at: now, list });
  return list;
}

/** Search one country's locations by name: cities first, prefix matches first. Pure over the list. */
export function filterLocations(list, q, limit = 20) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const scored = [];
  for (const l of list) {
    const name = l.name.toLowerCase();
    const idx = name.indexOf(needle);
    if (idx < 0) continue;
    scored.push({ l, score: (idx === 0 ? 0 : 10) + (TYPE_RANK[l.type] ?? 6) + name.length / 1000 });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, Math.min(50, limit)).map((s) => s.l);
}

export async function searchLocations({ country, q, limit = 20, get } = {}) {
  return filterLocations(await countryLocations(country, { get }), q, limit);
}

/** The canonical location for a code within a country, or null. */
export async function findLocation(country, code, { get } = {}) {
  const list = await countryLocations(country, { get });
  return list.find((l) => l.code === Number(code)) || null;
}

export function _clearLocationCache() {
  cache.clear();
}
