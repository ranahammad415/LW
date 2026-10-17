/**
 * Contract v1.2.x (§22, §23) OS pre-checks for draft push and media import, ported exactly from oasis-astro
 * packages/os-bridge-contract/src/blocks.mjs (checkLayout) and src/push.mjs (prepareDraftPush, checkMediaItems)
 * at 2c59003. The site re-validates and is authoritative; these give the user the same answer before the call.
 * Never throws on bad input.
 */

export const MEDIA_LIMITS = Object.freeze({ itemsPerCall: 20, maxBytes: 1024 * 1024, maxDimension: 4000, altMax: 300, uploadsPerCall: 1 });
/** v1.2.1: the OS waits this long for a media-import response. */
export const MEDIA_IMPORT_TIMEOUT_MS = 30_000;
export const MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
/**
 * v1.5.1: entry-get `includeLayout` (capability layoutRead). The editable content comes back only while a draft-upsert
 * carrying it fits the draft-upsert limits; otherwise `editable.omitted`. `maxErrors`: cap of `editable.errors`.
 */
export const LAYOUT_READ_LIMITS = Object.freeze({ maxBytes: 1536 * 1024, maxBlocks: 24, markdownChars: 200_000, maxErrors: 50 });
/** draft-upsert body limits (§22.2). */
export const DRAFT_LIMITS = Object.freeze({ maxBlocks: 24, markdownChars: 200_000, bodyBytes: 2 * 1024 * 1024, bylines: 10 });

// ───────────────────────────── blocks.mjs ─────────────────────────────

const META_KEYS = new Set(['_type', '_key', '_version']);

function isEmpty(v, minItemsField = false) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0 && !minItemsField);
}

function checkFields(fields, obj, path, errors, metaKeys) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push({ code: 'SCHEMA_INVALID', path, message: 'must be an object' });
    return;
  }
  const bySlug = new Map(fields.map((f) => [f.slug, f]));
  for (const k of Object.keys(obj)) if (!metaKeys.has(k) && !bySlug.has(k)) errors.push({ code: 'SCHEMA_INVALID', path: `${path}.${k}`, message: 'unknown field' });
  for (const f of fields) {
    const v = obj[f.slug];
    const p = `${path}.${f.slug}`;
    if (isEmpty(v, f.minItems > 0)) {
      if (f.required) errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'is required' });
      continue;
    }
    switch (f.type) {
      case 'string':
      case 'text':
      case 'url':
        if (typeof v !== 'string') errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'must be a string' });
        else if (f.maxLength != null && [...v].length > f.maxLength) errors.push({ code: 'SCHEMA_INVALID', path: p, message: `longer than ${f.maxLength}` });
        break;
      case 'select':
        if (f.options && !f.options.includes(v)) errors.push({ code: 'SCHEMA_INVALID', path: p, message: `must be one of ${f.options.join(', ')}` });
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'must be a boolean' });
        break;
      case 'number':
      case 'integer':
        if (typeof v !== 'number') errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'must be a number' });
        break;
      case 'image':
        // v1.5.1: a stored EmDash media reference ({ id, provider, meta: { storageKey }, alt, ... }, no src) is valid
        // too, so a layout read with entry-get includeLayout goes back through draft-upsert unchanged.
        if (typeof v !== 'object' || Array.isArray(v) || (typeof v.src !== 'string' && typeof v.id !== 'string')) errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'must be an image object { src, alt } or a media reference { id, alt }' });
        break;
      case 'portableText':
        if (!Array.isArray(v)) errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'must be a Portable Text array' });
        break;
      case 'repeater':
        if (!Array.isArray(v)) {
          errors.push({ code: 'SCHEMA_INVALID', path: p, message: 'must be an array' });
          break;
        }
        if (f.minItems != null && v.length < f.minItems) errors.push({ code: 'SCHEMA_INVALID', path: p, message: `needs at least ${f.minItems} items` });
        if (f.maxItems != null && v.length > f.maxItems) errors.push({ code: 'SCHEMA_INVALID', path: p, message: `allows at most ${f.maxItems} items` });
        if (f.subFields) v.forEach((item, i) => checkFields(f.subFields, item, `${p}[${i}]`, errors, new Set(['_key'])));
        break;
      default:
        break; // unknown field types are checked by the site only
    }
  }
}

/**
 * @param {Array<object>} layout
 * @param {Record<string, {fields: Array<object>}>} blockSchemas  from site-info.framework.blockSchemas
 * @returns {{ ok: boolean, errors: Array<{code: 'UNKNOWN_BLOCK'|'SCHEMA_INVALID', path: string, message: string}> }}
 */
export function checkLayout(layout, blockSchemas) {
  const errors = [];
  if (!Array.isArray(layout)) return { ok: false, errors: [{ code: 'SCHEMA_INVALID', path: '$.layout', message: 'must be an array' }] };
  layout.forEach((block, i) => {
    const path = `$.layout[${i}]`;
    const schema = block && typeof block === 'object' ? blockSchemas?.[block._type] : undefined;
    if (!schema) {
      errors.push({ code: 'UNKNOWN_BLOCK', path, message: `unknown block type ${JSON.stringify(block?._type)}` });
      return;
    }
    // v1.0.4: _version is optional for the OS; when sent it must equal the site's current block version.
    if (block._version !== undefined && schema.version !== undefined && block._version !== schema.version) {
      errors.push({ code: 'SCHEMA_INVALID', path: `${path}._version`, message: `block version ${block._version} is not the current version ${schema.version}` });
    }
    checkFields(schema.fields ?? [], block, path, errors, META_KEYS);
  });
  return { ok: errors.length === 0, errors };
}

// ───────────────────────────── push.mjs ─────────────────────────────

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * @param {object} siteInfo  a site-info response (framework.blockSchemas, collections[], bylines, taxonomies)
 * @param {object} draft     a draft-upsert request body
 * @param {{ collection?: string }} [opts]  for updates (target.entryId): the entry's collection from the OS mirror
 * @returns {{ ok: boolean, errors: Array<{ code, path, message }>, warnings: Array<{ code, path, message }> }}
 */
export function prepareDraftPush(siteInfo, draft, { collection: knownCollection } = {}) {
  const errors = [];
  const warnings = [];
  const push = (code, path, message) => errors.push({ code, path, message });
  const warn = (code, path, message) => warnings.push({ code, path, message });
  if (!draft || typeof draft !== 'object') return { ok: false, errors: [{ code: 'VALIDATION', path: '$', message: 'draft must be an object' }], warnings };
  const target = draft.target ?? {};
  const creating = 'collection' in target;
  const collection = creating ? target.collection : knownCollection ?? null;
  const cinfo = collection ? (siteInfo?.collections ?? []).find((c) => c.name === collection) : null;
  if (creating && !cinfo) push('VALIDATION', '$.target.collection', `collection ${collection} is not bridged`);
  if (!creating && !target.entryId) push('VALIDATION', '$.target', 'target needs entryId (update) or collection + slug (create)');
  if (creating && !SLUG.test(target.slug ?? '')) push('VALIDATION', '$.target.slug', "slug must be lowercase words joined by '-'");
  if (!creating && draft.slug !== undefined && !SLUG.test(draft.slug ?? '')) push('VALIDATION', '$.slug', "slug must be lowercase words joined by '-'");
  if (!creating && !draft.baseRev) push('VALIDATION', '$.baseRev', 'baseRev is required on updates (v1.2.0)');
  // exactly one content kind (v1.2.1)
  const kinds = [draft.layout !== undefined && 'layout', draft.body?.markdown !== undefined && 'body.markdown', draft.portableText !== undefined && 'portableText'].filter(Boolean);
  if (kinds.length !== 1) push('VALIDATION', '$', `exactly one of layout, body.markdown, portableText (got ${kinds.length ? kinds.join(', ') : 'none'})`);
  const parent = creating ? target.parent : draft.parent;
  if (parent && cinfo?.parentOptions && !cinfo.parentOptions.includes(parent) && !ULID.test(parent)) {
    push('PARENT_NOT_FOUND', creating ? '$.target.parent' : '$.parent', `parent ${parent} is not one of ${cinfo.parentOptions.join(', ')}`);
  }
  if (Array.isArray(draft.layout)) for (const e of checkLayout(draft.layout, siteInfo?.framework?.blockSchemas ?? {}).errors) push(e.code, e.path, e.message);
  // bylines (v1.2.0 decision 5; v1.2.1: the collection must have bylines)
  if (draft.bylines?.length && cinfo && cinfo.hasBylines !== true) push('BYLINE_NOT_ALLOWED', '$.bylines', `collection ${collection} has no bylines`);
  const bylineBySlug = new Map((siteInfo?.bylines ?? []).map((b) => [b.slug, b]));
  const isAgent = draft.actor?.kind !== 'human';
  (draft.bylines ?? []).forEach((b, i) => {
    const known = bylineBySlug.get(b);
    if (!known) push('BYLINE_NOT_ALLOWED', `$.bylines[${i}]`, `unknown byline ${b}`);
    else if (known.team) return;
    else if (isAgent) push('BYLINE_NOT_ALLOWED', `$.bylines[${i}]`, 'agent-originated pushes are credited to the team byline only');
    else if (known.osUserId !== draft.actor?.osUserId) push('BYLINE_NOT_ALLOWED', `$.bylines[${i}]`, `byline ${b} is not mapped to the requesting OS user`);
  });
  // taxonomies: existing terms only; the taxonomy must belong to the collection (v1.2.1)
  for (const [tax, terms] of Object.entries(draft.taxonomies ?? {})) {
    const known = siteInfo?.taxonomies?.[tax];
    if (!known || (cinfo && !(cinfo.taxonomies ?? []).includes(tax))) {
      warn('TERM_NOT_FOUND', `$.taxonomies.${tax}`, `taxonomy ${tax} is not attached to ${collection ?? 'this collection'}; ignored`);
      continue;
    }
    const slugs = new Set(known.terms.map((t) => t.slug));
    (terms ?? []).forEach((t, i) => {
      if (!slugs.has(t)) warn('TERM_NOT_FOUND', `$.taxonomies.${tax}[${i}]`, `unknown term ${t}; saved without it (terms are created by a site admin)`);
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}

function hostAllowed(host, allowed) {
  const h = host.toLowerCase();
  return allowed.some((raw) => {
    const a = String(raw).toLowerCase();
    return a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a;
  });
}

function prefixAllowed(url, prefixes) {
  return prefixes.some((p) => {
    try {
      const pu = new URL(p);
      return pu.protocol === 'https:' && url.origin.toLowerCase() === pu.origin.toLowerCase() && url.pathname.startsWith(pu.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * @param {object} media  site-info.media
 * @param {Array<object>} items  media-import items
 * @returns {{ ok: boolean, errors: Array<{ index: number, code: string, message: string }> }}
 */
export function checkMediaItems(media, items) {
  const errors = [];
  const limits = { ...MEDIA_LIMITS, ...(media ?? {}) };
  if (!Array.isArray(items) || items.length === 0) return { ok: false, errors: [{ index: -1, code: 'VALIDATION', message: 'items must be a non-empty array' }] };
  if (items.length > limits.itemsPerCall) errors.push({ index: -1, code: 'VALIDATION', message: `at most ${limits.itemsPerCall} items per call` });
  if (items.filter((i) => i?.upload).length > limits.uploadsPerCall) errors.push({ index: -1, code: 'VALIDATION', message: `at most ${limits.uploadsPerCall} upload(s) per call` });
  items.forEach((it, index) => {
    if (!it || typeof it !== 'object') return errors.push({ index, code: 'VALIDATION', message: 'item must be an object' });
    const alt = typeof it.alt === 'string' ? it.alt.trim() : '';
    if (!alt) errors.push({ index, code: 'VALIDATION', message: 'alt text is required' });
    else if ([...alt].length > limits.altMax) errors.push({ index, code: 'VALIDATION', message: `alt text longer than ${limits.altMax}` });
    const hasUrl = it.url !== undefined;
    const hasUpload = it.upload !== undefined;
    if (hasUrl === hasUpload) return errors.push({ index, code: 'VALIDATION', message: 'exactly one of url or upload' });
    if (hasUrl) {
      let u;
      try {
        u = new URL(it.url);
      } catch {
        return errors.push({ index, code: 'VALIDATION', message: 'invalid URL' });
      }
      if (u.protocol !== 'https:') return errors.push({ index, code: 'MEDIA_HOST_NOT_ALLOWED', message: 'https only' });
      if (u.username || u.password) return errors.push({ index, code: 'MEDIA_HOST_NOT_ALLOWED', message: 'credentials in URLs are not allowed' });
      const ok = hostAllowed(u.hostname, limits.allowedSourceHosts ?? []) || prefixAllowed(u, limits.allowedSourcePathPrefixes ?? []);
      if (!ok) errors.push({ index, code: 'MEDIA_HOST_NOT_ALLOWED', message: `${u.hostname}${u.pathname} is not in allowedSourceHosts / allowedSourcePathPrefixes` });
      return;
    }
    const up = it.upload;
    if (!up || typeof up !== 'object' || typeof up.dataBase64 !== 'string' || !up.dataBase64) {
      return errors.push({ index, code: 'VALIDATION', message: 'upload needs filename, contentType and dataBase64' });
    }
    if (!(limits.types ?? []).includes(up.contentType)) errors.push({ index, code: 'MEDIA_TYPE_UNSUPPORTED', message: String(up.contentType) });
    const b64 = up.dataBase64.replace(/\s+/g, '').replace(/=+$/, '');
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > limits.maxBytes) errors.push({ index, code: 'MEDIA_TOO_LARGE', message: `${bytes} > ${limits.maxBytes} bytes` });
  });
  return { ok: errors.length === 0, errors };
}

/**
 * v1.5.1 (§27): turn an entry-get `includeLayout` response into the body of the draft-upsert that writes it back. The
 * content (layout / portableText / body.markdown), title and excerpt are copied as read and `baseRev` is
 * `editable.rev`, so pushing the result without edits changes nothing. Apply edits to the returned draft, then send it.
 * Ported exactly from oasis-astro packages/os-bridge-contract/src/push.mjs (0d6cf61).
 * @param {object} response  an entry-get response with `editable`
 * @param {{ actor: object, [k: string]: unknown }} extra  draft-upsert fields to add (actor is required; e.g. seo, reviewAfter)
 * @returns {{ ok: boolean, draft?: object, errors: Array<{ code: string, path: string, message: string }> }}
 */
export function draftFromEntryGet(response, extra = {}) {
  const e = response?.editable;
  const fail = (code, path, message) => ({ ok: false, errors: [{ code, path, message }] });
  if (!e || typeof e !== 'object') return fail('VALIDATION', '$.editable', 'no editable content: send entry-get with includeLayout: true (capability layoutRead)');
  if (e.omitted) return fail('PAYLOAD_TOO_LARGE', '$.editable.omitted', `content not returned (${e.omitted.reason}, limit ${e.omitted.limit}); edit this entry in the EmDash admin`);
  const entryId = response.entry?.entryId;
  if (!entryId) return fail('VALIDATION', '$.entry.entryId', 'entry.entryId is missing');
  const content = e.format === 'layout' ? { layout: structuredClone(e.layout) } : e.format === 'portableText' ? { portableText: structuredClone(e.portableText) } : { body: { markdown: e.body?.markdown } };
  const draft = {
    target: { entryId },
    title: e.title,
    ...content,
    ...(e.excerpt !== undefined && e.excerpt !== null ? { excerpt: e.excerpt } : {}),
    baseRev: e.rev,
    ...extra,
  };
  return { ok: true, draft, errors: [] };
}

// ─────────────────────────────── v1.5.4 §30.1: service user role ───────────────────────────────

export const SERVICE_ROLES = Object.freeze(['subscriber', 'contributor', 'author', 'editor', 'admin']);
export const SERVICE_ROLE_REQUIRED = 'editor';
export const SERVICE_TOKEN_PROBLEMS = Object.freeze(['NOT_CONFIGURED', 'TOKEN_REFUSED', 'SCOPE_MISSING', 'ROLE_INSUFFICIENT', 'ROLE_UNVERIFIED', 'ROLE_ABOVE_REQUIRED', 'SEO_TOOLS_UNREACHABLE']);

/** site-info.serviceToken (never the token): normalised for Project.cmsHealth.serviceToken, or null. */
export function sanitizeServiceToken(v) {
  if (!v || typeof v !== 'object') return null;
  const role = SERVICE_ROLES.includes(v.role) ? v.role : 'unknown';
  const requiredRole = SERVICE_ROLES.includes(v.requiredRole) ? v.requiredRole : SERVICE_ROLE_REQUIRED;
  return {
    usable: v.usable === true,
    role,
    requiredRole,
    meetsRequiredRole: v.meetsRequiredRole === true ? true : v.meetsRequiredRole === false ? false : null,
    checkedAt: typeof v.checkedAt === 'string' && !Number.isNaN(Date.parse(v.checkedAt)) ? new Date(v.checkedAt).toISOString() : null,
    problems: (Array.isArray(v.problems) ? v.problems : [])
      .filter((p) => p && SERVICE_TOKEN_PROBLEMS.includes(p.code))
      .slice(0, 10)
      .map((p) => ({ code: p.code, message: typeof p.message === 'string' ? p.message.slice(0, 500) : '' })),
  };
}
