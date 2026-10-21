/**
 * EmDash contract v1.5.9 (§35): reopen after client approval.
 *
 * The site enforces the rule (a content change of a `client_approved` / `scheduled` review sends it back to
 * `pending_client_review`, round + 1, new client link). The OS only mirrors `pipeline_reopened` (and the
 * `pipeline_unscheduled {cause: "content_changed"}` that precedes it for a scheduled review) and words the timeline
 * line and the notifications. `client_approved → pending_client_review` is a site-only edge: the OS has no route that
 * requests it.
 *
 * Pure (no prisma), so the webhook route and its in-memory tests can use it.
 */

export const REOPEN_EVENT = 'pipeline_reopened';
/** `changed[]` carries at most this many paths (contract `REOPEN_CHANGED_MAX`). */
export const REOPEN_CHANGED_MAX = 20;
/** Timeline row message column (`WpContentReviewEvent.message`, VARCHAR(500)). */
const MESSAGE_MAX = 500;
/** One path in the timeline line (the contract allows 300; real paths are short). */
const PATH_MAX = 80;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const plain = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/**
 * v1.5.4 §30.3 site-actor display rule: names only, never site ids or e-mails; `viaOs` = the save came from an Agency
 * OS push. null when nobody can be named. (Also used for CONFLICT_REV.updatedBy, see lib/cmsDrafts.js.)
 */
export function changedBy(u) {
  if (!u || typeof u !== 'object') return null;
  const name = typeof u.name === 'string' && u.name.trim() ? u.name.trim().slice(0, 200) : null;
  const kind = ['human', 'agent', 'plugin', 'system'].includes(u.kind) ? u.kind : null;
  const viaOs = !!u.osUserId || u.source === 'os';
  if (!name && !kind) return null;
  return { name, kind, viaOs };
}

/** The same wording as the frontend `changedByText` (CmsDraftEditor.tsx), without the leading ", changed by". */
export function siteActorText(u) {
  const a = u && typeof u === 'object' && 'viaOs' in u ? u : changedBy(u);
  if (!a) return 'someone on the site';
  const who = plain(a.name || '', 200) || (a.kind === 'agent' ? 'an agent' : a.kind === 'human' ? 'a site editor' : 'the site');
  return `${who}${a.viaOs ? ' from Agency OS' : a.kind === 'agent' ? ' (agent)' : ''}`;
}

/**
 * The event's `data` normalised: `{ from, round, by, changed[≤20], changedTotal }`. Paths are plain text (control
 * characters removed, ≤ 300 chars); `changedTotal` is never below the number of listed paths. Missing data (a site
 * that broke the schema) gives what the Review itself says.
 */
export function reopenData(ev) {
  const d = ev?.data && typeof ev.data === 'object' && !Array.isArray(ev.data) ? ev.data : {};
  const changed = (Array.isArray(d.changed) ? d.changed : [])
    .map((p) => plain(p, 300))
    .filter(Boolean)
    .slice(0, REOPEN_CHANGED_MAX);
  const total = Math.max(posInt(d.changedTotal) || 0, changed.length);
  return {
    from: d.from === 'scheduled' ? 'scheduled' : 'client_approved',
    round: posInt(d.round) || posInt(ev?.review?.round) || null,
    by: changedBy(d.by && typeof d.by === 'object' ? d.by : ev?.actor),
    changed,
    changedTotal: total,
  };
}

/**
 * Timeline line for `pipeline_reopened` (OS wording, text only):
 * "Back to client review (round 2): the content changed after client approval. Changed by Erin Editor: title,
 * layout[faq1] (+3 more)". The path list is cut to fit the 500-character message column; what does not fit is
 * counted in "+X more".
 */
export function reopenEventMessage(ev) {
  const d = reopenData(ev);
  const head = `Back to client review${d.round ? ` (round ${d.round})` : ''}: the content changed after client approval`;
  const who = `Changed by ${siteActorText(d.by)}`;
  if (!d.changed.length) return `${head}. ${who}.`.slice(0, MESSAGE_MAX);
  const paths = d.changed.map((p) => (p.length > PATH_MAX ? `${p.slice(0, PATH_MAX - 1)}…` : p));
  const build = (n) => {
    const more = d.changedTotal - n;
    return `${head}. ${who}: ${paths.slice(0, n).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  };
  let n = paths.length;
  while (n > 1 && build(n).length > MESSAGE_MAX) n -= 1;
  return build(n).slice(0, MESSAGE_MAX);
}

/**
 * Notification bits for a reopen (names and counts only; never links). Template variables are interpolated into the
 * HTML e-mail body unescaped (notificationService.renderTemplate), so markup characters from the site are removed.
 */
export function reopenNotice(ev) {
  const d = reopenData(ev);
  const noMarkup = (s) => s.replace(/[<>&"]/g, '');
  const shown = d.changed.slice(0, 5).map((p) => noMarkup(p.length > PATH_MAX ? `${p.slice(0, PATH_MAX - 1)}…` : p));
  const more = d.changedTotal - shown.length;
  return {
    round: d.round,
    from: d.from,
    changedBy: noMarkup(siteActorText(d.by)),
    changedSummary: shown.length ? `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '',
  };
}
