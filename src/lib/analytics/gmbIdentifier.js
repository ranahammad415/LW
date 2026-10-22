/**
 * Google Business Profile identifiers (docs/ledger/features/local-seo.md "Which identifier to use").
 *
 * - CID (decimal, also called ludocid) is the primary key: stable, accepted by every DataForSEO Business Data and
 *   SERP Maps call, and present on each Maps result item (matching). Stored digits-only in Project.gmbCid.
 * - place_id is the second choice (Project.gmbPlaceId). It can change when Google merges listings.
 * - A business name (+ city) is only used to FIND the CID (Find business flow); legacy rows may still hold a name
 *   keyword in gmbCid and keep working.
 *
 * normalizeGmbIdentifier keeps reading every legacy form: "cid:<n>", "place_id:<id>", bare digits, "ChIJ…", Maps URLs
 * and names. maps.app.goo.gl / goo.gl/maps short links come back as kind 'short_link' and are resolved by
 * resolveMapsShortLink (SSRF-guarded, google maps hosts only, max MAX_SHORT_LINK_REDIRECTS hops).
 */
import { guardedFetch } from '../siteAdapters/netGuard.js';

export const MAX_SHORT_LINK_REDIRECTS = 5;

const SHORT_LINK_RE = /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)(\/|$)/i;

/**
 * @param {string|null|undefined} raw
 * @param {{ targetMarket?: string|null, displayName?: string|null }} [opts]
 * @returns {{ identifier: string|null, displayName: string|null, kind: string, cid?: string|null, placeId?: string|null, url?: string }}
 */
export function normalizeGmbIdentifier(raw, opts = {}) {
  const targetMarket = String(opts.targetMarket || '').trim();
  let input = String(raw || '').trim();
  if (!input) {
    return { identifier: null, displayName: opts.displayName || null, kind: 'empty' };
  }

  // Already prefixed
  if (/^place_id:/i.test(input)) {
    const id = input.replace(/^place_id:/i, '').trim();
    return {
      identifier: id ? `place_id:${id}` : null,
      displayName: opts.displayName || null,
      kind: 'place_id',
      placeId: id || null,
    };
  }
  if (/^cid:/i.test(input)) {
    const id = input.replace(/^cid:/i, '').trim().replace(/\D/g, '');
    return {
      identifier: id ? `cid:${id}` : null,
      displayName: opts.displayName || null,
      kind: 'cid',
      cid: id || null,
    };
  }

  // Pure numeric CID
  if (/^\d{8,}$/.test(input.replace(/[\s,]/g, ''))) {
    const id = input.replace(/[\s,]/g, '');
    return { identifier: `cid:${id}`, displayName: opts.displayName || null, kind: 'cid', cid: id };
  }

  // ChIJ… / GhIJ… place id without prefix
  if (/^(ChIJ|GhIJ|EiI|Ej)[\w-]{10,}$/.test(input)) {
    return {
      identifier: `place_id:${input}`,
      displayName: opts.displayName || null,
      kind: 'place_id',
      placeId: input,
    };
  }

  // Short links need a network hop (resolveMapsShortLink) before they mean anything.
  if (SHORT_LINK_RE.test(input)) {
    return {
      identifier: null,
      displayName: opts.displayName || null,
      kind: 'short_link',
      url: input.startsWith('http') ? input : `https://${input}`,
    };
  }

  let displayName = opts.displayName ? String(opts.displayName).trim() : null;

  // URL parsing
  if (/^https?:\/\//i.test(input) || /google\.[^/]+\/maps/i.test(input)) {
    try {
      const url = new URL(input.startsWith('http') ? input : `https://${input}`);
      const q = url.searchParams;

      const placeIdParam = q.get('place_id') || q.get('query_place_id');
      if (placeIdParam) {
        return {
          identifier: `place_id:${placeIdParam}`,
          displayName: displayName || decodePlaceNameFromPath(url.pathname),
          kind: 'place_id',
          placeId: placeIdParam,
        };
      }

      // !1s0x…:0xHEX often encodes CID in hex after colon
      const cidFromData = extractCidFromMapsData(url.href);
      if (cidFromData) {
        return {
          identifier: `cid:${cidFromData}`,
          displayName: displayName || decodePlaceNameFromPath(url.pathname),
          kind: 'cid',
          cid: cidFromData,
        };
      }

      const cidParam = q.get('cid') || q.get('ludocid');
      if (cidParam && /^\d+$/.test(cidParam)) {
        return {
          identifier: `cid:${cidParam}`,
          displayName: displayName || decodePlaceNameFromPath(url.pathname),
          kind: 'cid',
          cid: cidParam,
        };
      }

      const fromPath = decodePlaceNameFromPath(url.pathname);
      const qParam = q.get('q') || q.get('query');
      const name = fromPath || (qParam ? safeDecode(qParam).replace(/\+/g, ' ') : null);
      if (name) {
        displayName = displayName || name;
        input = name;
      }
    } catch {
      // fall through to name keyword
    }
  }

  // Business name keyword (+ target market)
  let keyword = input.replace(/\s+/g, ' ').trim();
  if (targetMarket && !keyword.toLowerCase().includes(targetMarket.toLowerCase())) {
    keyword = `${keyword} ${targetMarket}`;
  }
  return {
    identifier: keyword.slice(0, 200) || null,
    displayName: displayName || keyword.slice(0, 255) || null,
    kind: 'name',
  };
}

/** Digits-only CID from "cid:123", "123" or a Maps URL; null otherwise. */
export function normalizeCid(raw) {
  const n = normalizeGmbIdentifier(raw);
  return n.kind === 'cid' && n.cid ? n.cid : null;
}

/** The value stored in Project.gmbCid for a known CID (digits only). */
export function storedCid(cid) {
  const s = String(cid ?? '').replace(/^cid:/i, '').trim();
  return /^\d{5,30}$/.test(s) ? s : null;
}

/**
 * Identifier to send to DataForSEO for a project: CID first, then place_id, then the legacy gmbCid value (a name
 * keyword or a prefixed id from before the 20261107 migration).
 * @returns {{ identifier: string|null, kind: 'cid'|'place_id'|'name'|'empty'|'short_link', cid: string|null, placeId: string|null }}
 */
export function dfsIdentifierForProject(project) {
  const legacy = normalizeGmbIdentifier(project?.gmbCid, {
    targetMarket: project?.targetMarket,
    displayName: project?.gmbLocationName,
  });
  if (legacy.kind === 'cid' && legacy.cid) {
    return { identifier: `cid:${legacy.cid}`, kind: 'cid', cid: legacy.cid, placeId: project?.gmbPlaceId || null };
  }
  const placeId = project?.gmbPlaceId ? String(project.gmbPlaceId).trim() : legacy.kind === 'place_id' ? legacy.placeId : null;
  if (placeId) return { identifier: `place_id:${placeId}`, kind: 'place_id', cid: null, placeId };
  if (legacy.kind === 'name' && legacy.identifier) return { identifier: legacy.identifier, kind: 'name', cid: null, placeId: null };
  return { identifier: null, kind: legacy.kind === 'short_link' ? 'short_link' : 'empty', cid: null, placeId: null };
}

/**
 * Build the keyword string actually sent to DataForSEO (may append market for names).
 */
export function dfsKeywordForProject(project) {
  return dfsIdentifierForProject(project).identifier;
}

/** native | cid | place_id | name | null */
export function gbpIdentityKind(project) {
  if (project?.gmbLocationId) return 'native';
  const k = dfsIdentifierForProject(project).kind;
  return k === 'cid' || k === 'place_id' || k === 'name' ? k : null;
}

/**
 * True when the project has a Google Business Profile identity that names ONE listing: a native location, a CID or a
 * place_id. A bare name keyword does not count (resolve it with Find business first).
 */
export function hasGbpIdentity(project) {
  const k = gbpIdentityKind(project);
  return k === 'native' || k === 'cid' || k === 'place_id';
}

/** Any DataForSEO-usable identifier (CID, place_id or a legacy name keyword). */
export function hasDfsIdentifier(project) {
  return !!dfsIdentifierForProject(project).identifier;
}

const GOOGLE_HOST_RE = /^(www\.|maps\.)?google\.(com|[a-z]{2,3}|com?\.[a-z]{2})$/i;

/** True for the hosts a short-link hop may go to (and the shape of URL it may carry). */
export function isAllowedMapsUrl(u) {
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl') return u.pathname.startsWith('/maps');
  if (GOOGLE_HOST_RE.test(host)) return host.startsWith('maps.') || u.pathname.startsWith('/maps') || u.pathname === '/';
  return false;
}

/**
 * Follow a maps.app.goo.gl short link to its Google Maps URL. Every hop goes through guardedFetch (https only, no
 * private IP, connect-time DNS guard, no automatic redirects) and must stay on Google Maps hosts; at most
 * MAX_SHORT_LINK_REDIRECTS redirects. A consent.google.com interstitial is unwrapped from its `continue` parameter
 * without fetching it. Returns { ok: true, url } or { ok: false, code }.
 */
export async function resolveMapsShortLink(raw, { fetchImpl = guardedFetch, maxRedirects = MAX_SHORT_LINK_REDIRECTS, timeoutMs = 8000 } = {}) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, code: 'INVALID_URL' };
  }
  if (!isAllowedMapsUrl(u)) return { ok: false, code: 'HOST_NOT_ALLOWED' };
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const host = u.hostname.toLowerCase();
    if (host !== 'maps.app.goo.gl' && host !== 'goo.gl') {
      // Already a long Google Maps URL: done (no need to fetch it).
      return { ok: true, url: u.href };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(u.href, { method: 'GET', signal: ctrl.signal, maxBytes: 256 * 1024, headers: { 'user-agent': 'LocalWavesOS/1.0' } });
    } catch {
      return { ok: false, code: 'FETCH_FAILED' };
    } finally {
      clearTimeout(timer);
    }
    const status = res?.status ?? 0;
    const location = res?.headers?.get?.('location');
    if (status < 300 || status >= 400 || !location) return { ok: false, code: 'NO_REDIRECT' };
    let next;
    try {
      next = new URL(location, u);
    } catch {
      return { ok: false, code: 'INVALID_URL' };
    }
    if (next.hostname.toLowerCase() === 'consent.google.com') {
      const cont = next.searchParams.get('continue');
      try {
        next = new URL(cont || '');
      } catch {
        return { ok: false, code: 'HOST_NOT_ALLOWED' };
      }
    }
    if (!isAllowedMapsUrl(next)) return { ok: false, code: 'HOST_NOT_ALLOWED' };
    u = next;
  }
  return { ok: false, code: 'TOO_MANY_REDIRECTS' };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodePlaceNameFromPath(pathname) {
  const m = String(pathname || '').match(/\/maps\/place\/([^/]+)/i);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/!.*$/, '').trim() || null;
  } catch {
    return m[1].replace(/\+/g, ' ').trim() || null;
  }
}

/** Extract decimal CID from Google Maps 0x…:0x… pattern when present. */
function extractCidFromMapsData(href) {
  const m = String(href).match(/0x[a-f0-9]+:0x([a-f0-9]+)/i);
  if (!m?.[1]) return null;
  try {
    const n = BigInt(`0x${m[1]}`);
    return n.toString(10);
  } catch {
    return null;
  }
}
