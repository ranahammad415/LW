/**
 * SSRF guard for EmDash OS → site calls (review S1/S2). One helper for both the pairing-time
 * URL validation and every outbound request:
 * - `isPrivateIp`: loopback, private, link-local, CGNAT, benchmark, multicast/reserved, IPv4-mapped
 *   IPv6 (dotted and hex forms), NAT64 64:ff9b::/96, ULA, site-local fec0::/10, …
 * - `validateSiteUrl`: https only (http://localhost outside production), no query/credentials,
 *   and in production the host must resolve to public addresses only.
 * - `guardedFetch`: a fetch-compatible POST built on node:https with a connect-time `lookup`
 *   that refuses private addresses (defeats DNS rebinding between validation and connect) and
 *   never follows redirects (any 3xx is returned to the caller, which treats it as an error).
 */
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// Separate lists: net.BlockList checks an IPv4 address against IPv6 rules too (as ::ffff:a.b.c.d),
// so a ::ffff:0:0/96 rule in a shared list would match every IPv4 address.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
// IPv4
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked4.addSubnet(addr, prefix, 'ipv4');
}
// IPv6
for (const [addr, prefix] of [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped (any form)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
]) {
  blocked6.addSubnet(addr, prefix, 'ipv6');
}

/** True for any address an OS → site call must never reach. Unknown formats are treated as private. */
export function isPrivateIp(address) {
  const a = String(address || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(a)) return blocked4.check(a, 'ipv4');
  if (net.isIPv6(a)) return blocked6.check(a, 'ipv6');
  return true;
}

/**
 * Insecure dev mode (http://localhost, loopback/private targets) is opt-in: only outside production AND
 * with EMDASH_BRIDGE_ALLOW_INSECURE_DEV=true. Without the flag, development behaves like production
 * (https + public addresses only). Production ignores the flag.
 */
export function allowInsecureDev(env = process.env) {
  return env.NODE_ENV !== 'production' && env.EMDASH_BRIDGE_ALLOW_INSECURE_DEV === 'true';
}

function allowPrivate(env = process.env) {
  return allowInsecureDev(env);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate a site URL once (pairing-code creation, cmsType switch). Returns { ok, url } or { ok:false, message }.
 */
export async function validateSiteUrl(raw, { env = process.env, lookup = dns.promises.lookup } = {}) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, message: 'Enter the full site URL, e.g. https://example.com' };
  }
  const strict = !allowInsecureDev(env);
  const localHost = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localHost && !strict)) {
    return { ok: false, message: 'The site URL must use https://' };
  }
  if (u.search || u.hash || u.username || u.password) {
    return { ok: false, message: 'The site URL must not carry a query string, fragment or credentials' };
  }
  if (strict) {
    if (localHost) return { ok: false, message: 'The site URL must be a public https address' };
    // IP literals and hostnames both go through lookup (an IP literal resolves to itself).
    try {
      const addrs = await lookup(u.hostname, { all: true });
      if (!addrs.length || addrs.some((x) => isPrivateIp(x.address))) {
        return { ok: false, message: 'The site URL must resolve to a public address' };
      }
    } catch {
      return { ok: false, message: 'The site URL host could not be resolved' };
    }
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.origin}${path}`.slice(0, 500) };
}

/** net/tls `lookup` that refuses private addresses at connect time (production). */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [];
    if (!allowPrivate() && (list.length === 0 || list.some((x) => isPrivateIp(x.address)))) {
      const e = new Error(`Refusing to connect to a private address for ${hostname}`);
      e.code = 'EAI_BLOCKED';
      return callback(e);
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/**
 * Minimal fetch-compatible POST (method/headers/body/signal) with the guarded lookup and no
 * redirect following. Resolves to a WHATWG Response.
 */
export function guardedFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname) && allowPrivate() ? http : null;
    if (!mod) {
      reject(new Error('Only https site URLs are allowed'));
      return;
    }
    const body = init.body == null ? null : Buffer.from(init.body);
    const headers = { ...(init.headers || {}) };
    if (body) headers['content-length'] = String(body.length);
    const req = mod.request(
      u,
      { method: init.method || 'GET', headers, lookup: guardedLookup, signal: init.signal },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) h.append(k, String(one));
          }
          const status = res.statusCode || 502;
          const nullBody = status === 204 || status === 304;
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers: h }));
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
