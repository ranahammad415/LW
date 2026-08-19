/**
 * Normalize Google Business Profile identifiers for DataForSEO Business Data.
 * Accepts Maps/GBP URLs, cid:, place_id:, numeric CID, or plain business names.
 */

/**
 * @param {string|null|undefined} raw
 * @param {{ targetMarket?: string|null, displayName?: string|null }} [opts]
 * @returns {{ identifier: string|null, displayName: string|null, kind: string }}
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
    };
  }
  if (/^cid:/i.test(input)) {
    const id = input.replace(/^cid:/i, '').trim().replace(/\D/g, '');
    return {
      identifier: id ? `cid:${id}` : null,
      displayName: opts.displayName || null,
      kind: 'cid',
    };
  }

  // Pure numeric CID
  if (/^\d{8,}$/.test(input.replace(/[\s,]/g, ''))) {
    const id = input.replace(/[\s,]/g, '');
    return { identifier: `cid:${id}`, displayName: opts.displayName || null, kind: 'cid' };
  }

  // ChIJ… place id without prefix
  if (/^ChIJ[\w-]+$/.test(input)) {
    return {
      identifier: `place_id:${input}`,
      displayName: opts.displayName || null,
      kind: 'place_id',
    };
  }

  let displayName = opts.displayName ? String(opts.displayName).trim() : null;

  // URL parsing
  if (/^https?:\/\//i.test(input) || /google\.[^/]+\/maps/i.test(input) || /maps\.app\.goo\.gl/i.test(input)) {
    try {
      const url = new URL(input.startsWith('http') ? input : `https://${input}`);
      const q = url.searchParams;

      const placeIdParam = q.get('place_id') || q.get('query_place_id');
      if (placeIdParam) {
        return {
          identifier: `place_id:${placeIdParam}`,
          displayName: displayName || decodePlaceNameFromPath(url.pathname),
          kind: 'place_id',
        };
      }

      // !1s0x…:0xHEX often encodes CID in hex after colon
      const cidFromData = extractCidFromMapsData(url.href);
      if (cidFromData) {
        return {
          identifier: `cid:${cidFromData}`,
          displayName: displayName || decodePlaceNameFromPath(url.pathname),
          kind: 'cid',
        };
      }

      const cidParam = q.get('cid') || q.get('ludocid');
      if (cidParam && /^\d+$/.test(cidParam)) {
        return {
          identifier: `cid:${cidParam}`,
          displayName: displayName || decodePlaceNameFromPath(url.pathname),
          kind: 'cid',
        };
      }

      const fromPath = decodePlaceNameFromPath(url.pathname);
      const qParam = q.get('q') || q.get('query');
      const name = fromPath || (qParam ? decodeURIComponent(qParam).replace(/\+/g, ' ') : null);
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

/**
 * Build the keyword string actually sent to DataForSEO (may append market for names).
 */
export function dfsKeywordForProject(project) {
  const normalized = normalizeGmbIdentifier(project.gmbCid, {
    targetMarket: project.targetMarket,
    displayName: project.gmbLocationName,
  });
  return normalized.identifier;
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
