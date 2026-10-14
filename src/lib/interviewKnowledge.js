/**
 * What the interviewer is allowed to know from the client's OKF knowledge base
 * (plan §21 a–b).
 *
 *  - buildKnowledgeDigest(): a bounded, fenced summary put into the session
 *    instructions at mint time (profile + claims verbatim, cluster folders as
 *    title + excerpt, everything else title-only).
 *  - lookupKnowledge(): the token-gated `lookup_knowledge` tool. It enforces a
 *    per-respondent folder allow-list and never returns excluded folders.
 *
 * Both read local files only — no network, no AI.
 */
import { listClientFiles, readOkfFile, searchKnowledgeContext } from './knowledgeEngine.js';

/** Never shown to an interviewer, never returned by lookup. */
export const EXCLUDED_FOLDER_PREFIXES = ['knowledge-gaps', 'reports', 'content', 'seo/strategy', 'internal'];

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,120}$/i;

export function contextMaxChars() {
  const n = Number(process.env.INTERVIEW_CONTEXT_MAX_CHARS || 12000);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 40000) : 12000;
}

export function isExcludedFolder(folder) {
  const f = String(folder || '').replace(/\\/g, '/').toLowerCase();
  return EXCLUDED_FOLDER_PREFIXES.some((p) => f === p || f.startsWith(`${p}/`));
}

/**
 * Whether a folder is visible to this respondent. `allowFolders` null means
 * "everything not excluded" (root client); otherwise the folder must equal or
 * sit under one of the allowed folders, or be company/profile's folder.
 */
export function isFolderAllowed(folder, allowFolders) {
  if (isExcludedFolder(folder)) return false;
  if (!allowFolders) return true;
  const f = String(folder || '').toLowerCase();
  return allowFolders.some((a) => {
    const al = String(a).toLowerCase();
    return f === al || f.startsWith(`${al}/`) || al.startsWith(`${f}/`);
  });
}

function trimBody(body, max) {
  const s = String(body || '').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeRead(clientId, folder, filename) {
  try {
    return readOkfFile(clientId, folder, filename);
  } catch {
    return null;
  }
}

/**
 * @param {string} clientId
 * @param {{folders?: string[]|null, maxChars?: number}} [opts]
 *   folders: the respondent's cluster folders. null = root client (all folders).
 * @returns {{text: string, digestAt: string, fileCount: number}}
 */
export function buildKnowledgeDigest(clientId, { folders = null, maxChars = contextMaxChars(), files = null } = {}) {
  let all = files;
  if (!all) {
    try {
      all = listClientFiles(clientId);
    } catch {
      all = [];
    }
  }
  const visible = all.filter((f) => !isExcludedFolder(f.folder));
  const isWorker = Array.isArray(folders);

  const sections = [];
  const profile = safeRead(clientId, 'company', 'profile');
  if (profile?.body?.trim()) sections.push(`## Company profile (company/profile)\n${trimBody(profile.body, 2500)}`);

  const approved = safeRead(clientId, 'company', 'approved-claims');
  if (!isWorker && approved?.body?.trim()) {
    sections.push(`## Approved claims (company/approved-claims)\n${trimBody(approved.body, 1500)}`);
  }
  const restricted = safeRead(clientId, 'company', 'restricted-claims');
  if (restricted?.body?.trim()) {
    sections.push(`## NEVER SAY — restricted claims (company/restricted-claims)\n${trimBody(restricted.body, 1500)}`);
  }
  if (!isWorker) {
    const voice = safeRead(clientId, 'voice', 'brand-voice');
    if (voice?.body?.trim()) sections.push(`## Brand voice (voice/brand-voice)\n${trimBody(voice.body, 400)}`);
  }

  const special = new Set(['company/profile.md', 'company/approved-claims.md', 'company/restricted-claims.md', 'voice/brand-voice.md']);
  const detailed = [];
  const titleOnly = [];
  for (const f of visible) {
    if (special.has(f.rel_path)) continue;
    const name = String(f.filename || '').replace(/\.md$/, '');
    const ref = `${f.folder}/${name}`;
    const inCluster = isWorker ? isFolderAllowed(f.folder, folders) : true;
    if (isWorker && !inCluster) continue;
    // Root: services/locations/faq etc. get excerpts only when there is room;
    // the cluster (worker) always gets excerpts.
    if (isWorker || ['services', 'locations', 'products', 'faq', 'proof'].includes(String(f.folder).split('/')[0])) {
      const doc = safeRead(clientId, f.folder, name);
      detailed.push(`- ${ref} — ${f.title}: ${trimBody(doc?.body, 300).replace(/\s+/g, ' ')}`);
    } else {
      titleOnly.push(`- ${ref} — ${f.title}`);
    }
  }
  if (detailed.length) sections.push(`## Files on record (excerpts)\n${detailed.join('\n')}`);
  if (titleOnly.length) sections.push(`## Other files on record (titles only)\n${titleOnly.join('\n')}`);

  let text = sections.join('\n\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 40)}\n…(truncated to fit)`;
  return { text, digestAt: new Date().toISOString(), fileCount: visible.length };
}

/**
 * The lookup_knowledge tool.
 * @returns {{ok: boolean, results: Array<{path:string,title:string,excerpt:string}>, note?: string}}
 */
export function lookupKnowledge({ clientId, query = '', folder = null, filename = null, allowFolders = null }) {
  // Exact file requested, e.g. "services/emergency-callout".
  if (filename) {
    const parts = String(filename).replace(/\.md$/, '').replace(/\\/g, '/').split('/').filter(Boolean);
    const name = parts.pop();
    const dir = parts.length ? parts.join('/') : folder;
    if (!dir || !name || !SAFE_SEGMENT.test(name) || !dir.split('/').every((p) => SAFE_SEGMENT.test(p))) {
      return { ok: false, results: [], note: 'That file name is not valid.' };
    }
    if (!isFolderAllowed(dir, allowFolders)) {
      return { ok: true, results: [], note: 'Nothing on file that you can look up there.' };
    }
    const doc = safeRead(clientId, dir, name);
    if (!doc) return { ok: true, results: [], note: 'No file with that name is on record.' };
    return {
      ok: true,
      results: [{ path: `${dir}/${name}`, title: doc.metadata?.title || name, excerpt: trimBody(doc.body, 1500) }],
    };
  }

  let hits = [];
  try {
    hits = searchKnowledgeContext(clientId, String(query || '').slice(0, 200), 12);
  } catch {
    hits = [];
  }
  const results = hits
    .filter((h) => isFolderAllowed(h.asset.folder, allowFolders))
    .filter((h) => !folder || String(h.asset.folder).toLowerCase().startsWith(String(folder).toLowerCase()))
    .slice(0, 3)
    .map((h) => ({
      path: `${h.asset.folder}/${String(h.asset.filename).replace(/\.md$/, '')}`,
      title: h.asset.title,
      excerpt: trimBody(h.body, 600),
    }));
  return { ok: true, results, ...(results.length ? {} : { note: 'Nothing on file about that yet.' }) };
}
