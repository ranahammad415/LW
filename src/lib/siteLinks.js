/**
 * Security hotfix (2026-10-19): links to a WordPress project's site that the OS stores or returns (review preview links,
 * "edit in WP" links) must be https AND on the project's stored site host (Project.wpUrl). Anything else is dropped:
 * a compromised or misconfigured plugin must not be able to make Agency OS hand out javascript:, data: or third-party
 * links. A leading "www." is ignored on both sides (WordPress home URLs often differ from the stored URL only there).
 */
import { allowInsecureDev } from './siteAdapters/netGuard.js';

const hostKey = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

/** The URL (normalised) when it is https, has no credentials and is on the site's host; otherwise null. */
export function safeSiteLink(url, siteUrl) {
  if (typeof url !== 'string' || !url.trim() || !siteUrl) return null;
  let u;
  let site;
  try {
    u = new URL(url.trim());
    site = new URL(String(siteUrl));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (!u.hostname || hostKey(u.hostname) !== hostKey(site.hostname)) return null;
  return u.toString().slice(0, 1000);
}

/**
 * EmDash variant (security hotfix rule applied to the EmDash bridge): preview, edit and site links must be on the
 * stored site URL's exact host and port (Project.wpUrl, validated at pairing; never a host from a handshake or event)
 * and https; http only under the insecure dev opt-in (NODE_ENV !== production + EMDASH_BRIDGE_ALLOW_INSECURE_DEV=true,
 * the same switch as netGuard). No credentials. Anything else → null.
 */
export function safeEmdashLink(url, siteUrl, env = process.env) {
  if (typeof url !== 'string' || !url.trim() || !siteUrl) return null;
  let u;
  let site;
  try {
    u = new URL(url.trim());
    site = new URL(String(siteUrl));
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowInsecureDev(env))) return null;
  if (!u.hostname || u.hostname.toLowerCase() !== site.hostname.toLowerCase() || u.port !== site.port) return null;
  return u.toString().slice(0, 1000);
}

/**
 * Preview links of a WordPress review row for a response: each kept only when it passes safeSiteLink against the
 * project's site URL. EmDash rows use safeEmdashLink (exact host + port, https unless the insecure dev opt-in).
 */
export function safeReviewLinks(row, project) {
  if (project?.cmsType === 'EMDASH') {
    return {
      pmPreviewUrl: safeEmdashLink(row?.pmPreviewUrl, project?.wpUrl),
      clientPreviewUrl: safeEmdashLink(row?.clientPreviewUrl, project?.wpUrl),
    };
  }
  const site = project?.wpUrl || null;
  return {
    pmPreviewUrl: safeSiteLink(row?.pmPreviewUrl, site),
    clientPreviewUrl: safeSiteLink(row?.clientPreviewUrl, site),
  };
}

/** Keys of site answers that carry links the OS stores or shows (preview, edit, staff preview). */
export const EMDASH_LINK_KEYS = new Set(['editUrl', 'pmPreviewUrl', 'clientPreviewUrl', 'previewUrl', 'existingEditUrl']);

/**
 * Applies safeEmdashLink to every EMDASH_LINK_KEYS value of a parsed site answer (success body or error details),
 * in place, depth ≤ 8. Called by emdash.siteRequest for every OS → site call, so no route can store or return a link
 * that is off the stored site host. A failing link becomes null.
 */
export function sanitizeEmdashLinks(value, siteUrl, env = process.env, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) {
    for (const v of value) sanitizeEmdashLinks(v, siteUrl, env, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (EMDASH_LINK_KEYS.has(key) && (typeof v === 'string' || v != null && typeof v !== 'object')) {
      value[key] = safeEmdashLink(String(v), siteUrl, env);
    } else if (v && typeof v === 'object') {
      sanitizeEmdashLinks(v, siteUrl, env, depth + 1);
    }
  }
  return value;
}
