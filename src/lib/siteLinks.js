/**
 * Security hotfix (2026-10-19): links to a WordPress project's site that the OS stores or returns (review preview links,
 * "edit in WP" links) must be https AND on the project's stored site host (Project.wpUrl). Anything else is dropped:
 * a compromised or misconfigured plugin must not be able to make Agency OS hand out javascript:, data: or third-party
 * links. A leading "www." is ignored on both sides (WordPress home URLs often differ from the stored URL only there).
 */
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
 * Preview links of a WordPress review row for a response: each kept only when it passes safeSiteLink against the
 * project's site URL. EmDash rows are left as they are (their links come from the signed bridge).
 */
export function safeReviewLinks(row, project) {
  if (project?.cmsType === 'EMDASH') return { pmPreviewUrl: row?.pmPreviewUrl ?? null, clientPreviewUrl: row?.clientPreviewUrl ?? null };
  const site = project?.wpUrl || null;
  return {
    pmPreviewUrl: safeSiteLink(row?.pmPreviewUrl, site),
    clientPreviewUrl: safeSiteLink(row?.clientPreviewUrl, site),
  };
}
