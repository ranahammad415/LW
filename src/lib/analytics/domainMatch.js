/**
 * Strict site matching for rank checks (organic SERP and Maps) and the Find-business auto-match.
 *
 * Two hosts belong to the same site when their registrable domain is equal: `www.abc.com`, `abc.com` and
 * `shop.abc.com` match `abc.com`; `xabc.com` and `abc.com.evil.net` do not. No public-suffix dependency: a small table
 * of multi-label public suffixes (co.uk, com.au, …) and shared-hosting suffixes (wixsite.com, github.io, …) is enough
 * for the markets the agency serves. On a shared-hosting suffix the first label below it is the site
 * (abc.wixsite.com ≠ xyz.wixsite.com).
 */

const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.za', 'org.za',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.tr', 'com.sg', 'com.my', 'com.ph', 'com.pk', 'com.hk',
  'com.cn', 'com.tw', 'com.vn', 'com.ng', 'com.eg', 'com.sa',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in',
  'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr', 'co.il', 'org.il', 'co.id', 'or.id', 'co.th', 'in.th',
  'ca.us', 'ny.us', 'tx.us', 'fl.us', 'qc.ca', 'on.ca', 'bc.ca', 'ab.ca',
]);

const SHARED_HOSTING_SUFFIXES = new Set([
  'wixsite.com', 'blogspot.com', 'wordpress.com', 'github.io', 'netlify.app', 'vercel.app', 'pages.dev',
  'web.app', 'firebaseapp.com', 'herokuapp.com', 'squarespace.com', 'myshopify.com', 'business.site',
  'weebly.com', 'godaddysites.com', 'webflow.io', 'wpengine.com', 'azurewebsites.net', 'onrender.com',
]);

/** Lowercase host of a URL or bare host (no scheme, port, path, trailing dot, leading www.). '' when unusable. */
export function hostOf(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    return '';
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  if (!host.includes('.') || /[^a-z0-9.-]/.test(host)) return '';
  return host;
}

/** Registrable domain ("eTLD+1") of a host or URL; '' when unusable. */
export function registrableDomain(raw) {
  const host = hostOf(raw);
  if (!host) return '';
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  if (SHARED_HOSTING_SUFFIXES.has(last2)) return labels.slice(-3).join('.');
  if (MULTI_LABEL_SUFFIXES.has(last2)) return labels.slice(-3).join('.');
  const last3 = labels.slice(-3).join('.');
  if (labels.length >= 4 && SHARED_HOSTING_SUFFIXES.has(last3)) return labels.slice(-4).join('.');
  return last2;
}

/** True when both point at the same registrable domain (www. and subdomains allowed, look-alikes refused). */
export function sameSite(a, b) {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return !!ra && ra === rb;
}
