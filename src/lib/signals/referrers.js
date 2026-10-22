/**
 * Exact port of the contract's src/referrers.mjs (oasis-astro packages/os-bridge-contract, v1.7.0 §38.3): the ONE
 * referrer classification. The site stamps what it knew at capture time (`referrer.table`); the OS re-runs it on
 * history (`signals.reclassify`) when the table grows. Vectors: tests/fixtures/cms-contract/vectors/referrers.json
 * (tests/unit/signals/referrers.test.js). Keep it equivalent in behaviour: same input, same { class, source }.
 * The OS cannot import oasis-astro at runtime; refresh this file when REFERRER_TABLE_VERSION changes.
 * Google AI Mode / AI Overviews send google.com like organic search: they are search / google (never an AI number).
 */

export const REFERRER_TABLE_VERSION = "1.0.0";
/** The stable class enum (same list as REF_CLASSES in constants.mjs; repeated here so this module stays standalone). */
export const CLASSES = Object.freeze(["ai", "search", "social", "referral", "direct", "email", "ads", "internal", "unknown"]);
/** The "AI assistants" group dashboards use (google-ai-mode is listed although no referrer ever yields it). */
export const AI_SOURCES = Object.freeze(["chatgpt", "perplexity", "claude", "gemini", "google-ai-mode", "copilot", "you", "meta-ai", "duckduckgo-ai", "grok", "mistral", "deepseek", "poe", "huggingchat"]);

/** utm_source values that name an AI assistant (lower-cased, www. stripped). */
const AI_UTM = Object.freeze({
  "chatgpt.com": "chatgpt",
  chatgpt: "chatgpt",
  openai: "chatgpt",
  "openai.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  perplexity: "perplexity",
  "perplexity.ai": "perplexity",
  claude: "claude",
  "claude.ai": "claude",
  gemini: "gemini",
  "gemini.google.com": "gemini",
  copilot: "copilot",
  "copilot.microsoft.com": "copilot",
});
const PAID_MEDIUM = /^(cpc|ppc|paid|paid[_-]?social|paidsocial|display|cpm)$/;
const SOCIAL_MEDIUM = /^(social|social[_-]?media|sm|social[_-]?network)$/;

/**
 * Host rules, in order: [class, source, test(host, path)]. `host` is lower-case without "www." and trailing dots;
 * `path` is the referrer path (usually "/" because browsers send only the origin cross-site).
 */
const eq = (...hosts) => (h) => hosts.includes(h);
const sub = (...domains) => (h) => domains.some((d) => h === d || h.endsWith(`.${d}`));
const label = (name) => (h) => new RegExp(`(^|\\.)${name}\\.(?:[a-z]{2,3}|co\\.[a-z]{2}|com\\.[a-z]{2})$`).test(h);
const HOSTS = Object.freeze([
  // email (webmail) before search: mail.google.com is not Google Search
  ["email", "gmail", eq("mail.google.com", "inbox.google.com")],
  ["email", "outlook", eq("outlook.live.com", "outlook.office.com", "outlook.office365.com")],
  ["email", "yahoo-mail", sub("mail.yahoo.com")],
  // AI assistants
  ["ai", "chatgpt", sub("chatgpt.com", "chat.openai.com")],
  ["ai", "perplexity", sub("perplexity.ai", "pplx.ai")],
  ["ai", "claude", sub("claude.ai", "claude.com")],
  ["ai", "gemini", eq("gemini.google.com", "bard.google.com")],
  ["ai", "copilot", (h, p) => sub("copilot.microsoft.com", "edgeservices.bing.com")(h) || (sub("bing.com")(h) && /^\/chat(\/|$)/.test(p))],
  ["ai", "you", sub("you.com")],
  ["ai", "meta-ai", sub("meta.ai")],
  ["ai", "duckduckgo-ai", (h, p) => sub("duck.ai")(h) || (sub("duckduckgo.com")(h) && /^\/duckchat(\/|$)/.test(p))],
  ["ai", "grok", sub("grok.com", "x.ai")],
  ["ai", "mistral", eq("chat.mistral.ai")],
  ["ai", "deepseek", eq("chat.deepseek.com")],
  ["ai", "poe", sub("poe.com")],
  ["ai", "huggingchat", (h, p) => h === "huggingface.co" && /^\/chat(\/|$)/.test(p)],
  // search engines
  ["search", "google", label("google")],
  ["search", "bing", sub("bing.com")],
  ["search", "yahoo", sub("search.yahoo.com")],
  ["search", "duckduckgo", sub("duckduckgo.com")],
  ["search", "brave", eq("search.brave.com")],
  ["search", "ecosia", sub("ecosia.org")],
  ["search", "yandex", label("yandex")],
  ["search", "baidu", sub("baidu.com")],
  // social networks
  ["social", "facebook", sub("facebook.com", "fb.com", "fb.me")],
  ["social", "instagram", sub("instagram.com")],
  ["social", "x", (h) => h === "t.co" || sub("x.com", "twitter.com")(h)],
  ["social", "linkedin", (h) => sub("linkedin.com")(h) || h === "lnkd.in"],
  ["social", "pinterest", (h) => label("pinterest")(h) || h === "pin.it"],
  ["social", "reddit", sub("reddit.com", "redd.it")],
  ["social", "youtube", (h) => sub("youtube.com")(h) || h === "youtu.be"],
  ["social", "tiktok", sub("tiktok.com")],
  ["social", "nextdoor", sub("nextdoor.com")],
]);

/** android-app://<package>/ referrers (Android apps that pass one). */
const APPS = Object.freeze({
  "com.google.android.gm": ["email", "gmail"],
  "com.google.android.googlequicksearchbox": ["search", "google"],
  "com.google.android.apps.bard": ["ai", "gemini"],
  "com.openai.chatgpt": ["ai", "chatgpt"],
  "ai.perplexity.app.android": ["ai", "perplexity"],
  "com.anthropic.claude": ["ai", "claude"],
  "com.microsoft.copilot": ["ai", "copilot"],
  "com.facebook.katana": ["social", "facebook"],
  "com.instagram.android": ["social", "instagram"],
  "com.linkedin.android": ["social", "linkedin"],
  "com.reddit.frontpage": ["social", "reddit"],
  "com.twitter.android": ["social", "x"],
  "com.pinterest": ["social", "pinterest"],
  "com.nextdoor": ["social", "nextdoor"],
});

/** Second-level public suffixes (enough for registrable-domain grouping; not the full PSL). */
const MULTI_SUFFIX = /\.(co|com|net|org|gov|ac|edu|ltd|plc|me)\.[a-z]{2}$/;

/** Lower-case, no trailing dots, no leading "www." (also www2.); null when empty. */
export function normalizeHost(host) {
  const h = String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^www\d*\./, "");
  return h || null;
}

/** "news.bbc.co.uk" → "bbc.co.uk", "m.yelp.com" → "yelp.com"; IPs and single labels unchanged. */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h) return null;
  if (/^\d+(\.\d+){3}$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const parts = h.split(".");
  const keep = MULTI_SUFFIX.test(h) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** A short, safe source token from free text (utm_source): lower-case [a-z0-9._-], ≤ 64. */
export function sourceToken(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || null;
}

const lower = (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

function parseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return { empty: true };
  try {
    const u = new URL(value.trim());
    return { url: u };
  } catch {
    return { invalid: true };
  }
}

/** utm_* and click ids from a landing URL (or a plain object), lower-cased source / medium. */
export function campaignOf(landingUrl) {
  const out = { utm: { source: null, medium: null, campaign: null, term: null, content: null }, clickIds: { gclid: null, gbraid: null, wbraid: null, fbclid: null, msclkid: null, ttclid: null } };
  let params = null;
  if (typeof landingUrl === "string" && landingUrl) {
    try {
      params = new URL(landingUrl, "https://x.invalid").searchParams;
    } catch {
      params = null;
    }
  }
  if (!params) return out;
  for (const k of Object.keys(out.utm)) out.utm[k] = params.get(`utm_${k}`) || null;
  for (const k of Object.keys(out.clickIds)) out.clickIds[k] = params.get(k) || null;
  return out;
}

const result = (cls, source, host) => ({ class: cls, source, host: host ?? null, table: REFERRER_TABLE_VERSION });

/**
 * Classify one visit.
 * @param {{ referrerUrl?: string|null, landingUrl?: string|null, siteHost?: string|null, utm?: object|null, clickIds?: object|null }} input
 *   utm / clickIds override what `landingUrl` carries (the site passes the validated values).
 * @returns {{ class: string, source: string, host: string|null, table: string }}
 */
export function classify({ referrerUrl = null, landingUrl = null, siteHost = null, utm = null, clickIds = null } = {}) {
  const fromLanding = campaignOf(landingUrl);
  const u = { ...fromLanding.utm, ...(utm ?? {}) };
  const c = { ...fromLanding.clickIds, ...(clickIds ?? {}) };
  const medium = lower(u.medium);
  const usource = lower(u.source);
  const ref = parseUrl(referrerUrl);
  const isApp = ref.url?.protocol === "android-app:";
  const host = ref.url ? normalizeHost(ref.url.hostname) : null;
  const path = ref.url && !isApp ? ref.url.pathname || "/" : "/";

  // 1. click ids
  if (c.gclid || c.gbraid || c.wbraid) return result("ads", "google-ads", host);
  if (c.msclkid) return result("ads", "microsoft-ads", host);
  if (c.ttclid) return result("ads", "tiktok-ads", host);
  if (c.fbclid) return medium && PAID_MEDIUM.test(medium) ? result("ads", "meta-ads", host) : result("social", "facebook", host);
  // 2. AI utm_source
  const aiUtm = usource ? AI_UTM[usource.replace(/^www\./, "")] : null;
  if (aiUtm) return result("ai", aiUtm, host);
  // 3. Google Business Profile (tagged link)
  if (usource === "gbp" || lower(u.campaign) === "gbp") return result("search", "gbp", host);
  // 4. e-mail
  const webmail = host && !isApp ? HOSTS.slice(0, 3).find(([, , test]) => test(host, path)) : null;
  if (webmail) return result("email", webmail[1], host);
  if (medium === "email" || medium === "e-mail" || medium === "newsletter") return result("email", sourceToken(usource) ?? "other", host);
  if (ref.invalid) return result("unknown", "unknown", null);
  // 5. internal
  const self = normalizeHost(siteHost);
  if (host && self && host === self) return result("internal", "self", host);
  // 6. referrer host / app table
  if (isApp) {
    const app = APPS[String(ref.url.hostname).toLowerCase()];
    if (app) return result(app[0], app[1], host);
  } else if (host) {
    for (const [cls, source, test] of HOSTS) if (test(host, path)) return result(cls, source, host);
  }
  // 7. UTM without a known referrer
  if (usource || medium) {
    const s = sourceToken(usource) ?? (host ? registrableDomain(host) : null) ?? "unknown";
    if (medium && PAID_MEDIUM.test(medium)) return result("ads", s, host);
    if (medium && SOCIAL_MEDIUM.test(medium)) return result("social", s, host);
    if (medium === "organic") return result("search", s, host);
    return result("referral", s, host);
  }
  // 8. direct
  if (ref.empty) return result("direct", "none", null);
  // 9. referral (apps without a table entry: "app:<package>")
  if (isApp) return result("referral", sourceToken(`app-${ref.url.hostname}`) ?? "app", host);
  return result("referral", registrableDomain(host) ?? "unknown", host);
}

/**
 * The short form the task list names: classifyReferrer(url, utm, clickIds, { siteHost }) → { class, source }.
 * @param {string|null} url referrer URL @param {object|null} [utm] @param {object|null} [clickIds] @param {{ siteHost?: string|null, landingUrl?: string|null }} [opts]
 */
export function classifyReferrer(url, utm = null, clickIds = null, opts = {}) {
  const r = classify({ referrerUrl: url, utm, clickIds, siteHost: opts.siteHost ?? null, landingUrl: opts.landingUrl ?? null });
  return { class: r.class, source: r.source };
}

/** True when a classification belongs to the "AI assistants" channel. */
export const isAiSource = (r) => r?.class === "ai";
