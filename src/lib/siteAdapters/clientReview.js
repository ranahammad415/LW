/**
 * Contract v1.1.0 §21 (Phase 2 stage 1): client review from the OS. Pure helpers: request building and
 * validation (the site validates again), Suggestion / counts normalisation, the client-safe content view.
 * No network, no DB.
 */
import { CmsBridgeError } from './emdash.js';

export const CLIENT_DECISIONS = Object.freeze(['approved', 'changes_requested', 'changes_publish']);
export const SUGGESTION_FIELDS = Object.freeze(['title', 'excerpt', 'body', 'seo.title', 'seo.description']);
export const SUGGESTION_STATES = Object.freeze(['open', 'accepted', 'rejected', 'applied', 'closed']);
export const CLIENT_REVIEW_LIMITS = Object.freeze({
  suggestionsPerDecision: 50,
  suggestionsPerReview: 200,
  comment: 10_000,
  quote: 500,
  proposedText: 2_000,
  note: 1_000,
  blockKey: 64,
  bodyBytes: 64 * 1024,
});
/** §21.1 label for clientDecision changes_publish on EmDash (never publishes). */
export const CHANGES_PUBLISH_LABEL = 'Minor changes, then ready to publish';

/** Plain text: strip control characters except \n and \t; never interpreted as HTML. */
export function plainText(v) {
  // eslint-disable-next-line no-control-regex
  return String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function bad(message) {
  return new CmsBridgeError({ status: 400, code: 'VALIDATION', message, retryable: false });
}

/**
 * Build the `pipeline-client-review` body (§21.2). Throws CmsBridgeError VALIDATION on a bad input.
 * @param {{ reviewId: string, expectedRound: number, expectedRev?: number|null, decision: string, comment?: string|null,
 *   suggestions?: Array<{ target: { field: string, blockKey?: string|null }, quote: string, proposedText: string, note?: string|null }>,
 *   user: { id: string, name?: string, role: string }, clientAccountId?: string|null }} input
 */
export function buildClientReviewBody(input) {
  const { reviewId, expectedRound, expectedRev, decision, user } = input;
  if (!CLIENT_DECISIONS.includes(decision)) throw bad('Choose Approve, Request changes or Minor changes, then ready to publish.');
  if (!Number.isInteger(expectedRound) || expectedRound < 1) throw bad('The review round is missing. Reload the page.');
  const role = user?.role === 'OWNER' ? 'OWNER' : user?.role === 'CLIENT' ? 'CLIENT' : null;
  if (!role) throw new CmsBridgeError({ status: 403, code: 'FORBIDDEN', message: 'Only the client or an owner acting for the client can decide.' });

  const comment = plainText(input.comment ?? '').trim();
  if (comment.length > CLIENT_REVIEW_LIMITS.comment) throw bad(`The comment is longer than ${CLIENT_REVIEW_LIMITS.comment} characters.`);

  const raw = Array.isArray(input.suggestions) ? input.suggestions : [];
  if (raw.length && decision === 'approved') throw bad('Suggestions can only be sent with Request changes or Minor changes.');
  if (raw.length > CLIENT_REVIEW_LIMITS.suggestionsPerDecision) {
    throw bad(`At most ${CLIENT_REVIEW_LIMITS.suggestionsPerDecision} suggestions per decision.`);
  }
  const suggestions = raw.map((s, i) => {
    const n = i + 1;
    const field = s?.target?.field;
    if (!SUGGESTION_FIELDS.includes(field)) throw bad(`Suggestion ${n}: choose what it changes (title, excerpt, body, SEO title or SEO description).`);
    const blockKey = s?.target?.blockKey == null || s.target.blockKey === '' ? null : String(s.target.blockKey);
    if (blockKey && (field !== 'body' || blockKey.length > CLIENT_REVIEW_LIMITS.blockKey)) throw bad(`Suggestion ${n}: invalid block.`);
    const quote = plainText(s?.quote).trim();
    const proposedText = plainText(s?.proposedText).trim();
    const note = s?.note == null ? null : plainText(s.note).trim() || null;
    if (!quote || quote.length > CLIENT_REVIEW_LIMITS.quote) throw bad(`Suggestion ${n}: the quoted text must be 1–${CLIENT_REVIEW_LIMITS.quote} characters.`);
    if (!proposedText || proposedText.length > CLIENT_REVIEW_LIMITS.proposedText) {
      throw bad(`Suggestion ${n}: the replacement must be 1–${CLIENT_REVIEW_LIMITS.proposedText} characters.`);
    }
    if (note && note.length > CLIENT_REVIEW_LIMITS.note) throw bad(`Suggestion ${n}: the note is longer than ${CLIENT_REVIEW_LIMITS.note} characters.`);
    return { target: blockKey ? { field, blockKey } : { field }, quote, proposedText, note };
  });
  if (decision === 'changes_requested' && !comment && !suggestions.length) {
    throw bad('Say what should change: add a comment or at least one suggestion.');
  }

  const body = {
    reviewId,
    expectedRound,
    ...(Number.isInteger(expectedRev) ? { expectedRev } : {}),
    decision,
    ...(comment ? { comment } : {}),
    ...(suggestions.length ? { suggestions } : {}),
    actor: {
      kind: 'human',
      osUserId: String(user.id),
      name: String(user.name || (role === 'OWNER' ? 'Agency owner' : 'Client')).slice(0, 200),
      role,
    },
    ...(role === 'OWNER'
      ? { onBehalfOf: { role: 'CLIENT', ...(input.clientAccountId ? { clientAccountId: String(input.clientAccountId).slice(0, 64) } : {}) } }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > CLIENT_REVIEW_LIMITS.bodyBytes) {
    throw new CmsBridgeError({ status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Too much text in one decision (64 KB). Shorten or split the suggestions.' });
  }
  return body;
}

/** User-facing message for the site's answer to a client decision (OS routes add `details.review` mirroring). */
export function clientReviewErrorMessage(err) {
  switch (err?.code) {
    case 'CONFLICT_REV':
      return 'This page was updated since you opened it (new round). Reload and review the latest version.';
    case 'INVALID_TRANSITION':
      return 'Already decided (by the review link or another person). The latest state is shown.';
    case 'SUGGESTION_LIMIT':
      return 'This page already has the maximum number of suggestions (200). Add the rest to the comment, or ask your project manager.';
    case 'PAYLOAD_TOO_LARGE':
      return 'Too much text in one decision (64 KB). Shorten or split the suggestions.';
    case 'NOT_IMPLEMENTED':
      return 'This site cannot take decisions from Agency OS yet. Use the review link instead.';
    case 'FORBIDDEN':
      return 'Only the client or an owner acting for the client can decide.';
    default:
      return null;
  }
}

const RANK = { open: 0, accepted: 1, rejected: 2, applied: 2, closed: 3 };
/** A suggestion never moves back (e.g. a late snapshot cannot reopen an applied suggestion). */
export function suggestionStateAdvances(from, to) {
  if (!SUGGESTION_STATES.includes(to)) return false;
  if (!from) return true;
  if (from === to) return true;
  return (RANK[to] ?? -1) > (RANK[from] ?? -1);
}

const s = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Contract Suggestion → CmsReviewSuggestion column values (without projectId/contentReviewId). */
export function suggestionToRow(sg) {
  if (!sg || typeof sg !== 'object' || typeof sg.suggestionId !== 'string' || !sg.suggestionId) return null;
  const state = SUGGESTION_STATES.includes(sg.state) ? sg.state : 'open';
  const field = SUGGESTION_FIELDS.includes(sg.target?.field) ? sg.target.field : 'body';
  return {
    cmsSuggestionId: s(sg.suggestionId, 64),
    cmsReviewId: s(sg.reviewId, 64) || '',
    round: Number.isInteger(sg.round) && sg.round > 0 ? sg.round : 1,
    targetField: field,
    targetBlockKey: field === 'body' ? s(sg.target?.blockKey, 64) : null,
    quote: plainText(sg.quote).slice(0, CLIENT_REVIEW_LIMITS.quote),
    proposedText: plainText(sg.proposedText).slice(0, CLIENT_REVIEW_LIMITS.proposedText),
    note: sg.note == null ? null : plainText(sg.note).slice(0, CLIENT_REVIEW_LIMITS.note),
    state,
    source: sg.source === 'review-link' ? 'review-link' : 'os',
    createdByName: s(sg.createdBy?.name, 200),
    createdByUserId: s(sg.createdBy?.osUserId, 64),
    onBehalfOfClient: !!(sg.createdBy?.onBehalfOf && sg.createdBy.onBehalfOf.role === 'CLIENT'),
    decidedByName: s(sg.decidedBy?.name, 200),
    decidedAt: date(sg.decidedAt),
    decisionNote: sg.decisionNote == null ? null : plainText(sg.decisionNote).slice(0, CLIENT_REVIEW_LIMITS.note),
    appliedRevisionId: s(sg.appliedRevisionId, 64),
    siteCreatedAt: date(sg.createdAt),
  };
}

/** Event `suggestion` change (review.suggestion_*) → column updates. */
export function suggestionChangeToUpdate(change) {
  if (!change || typeof change !== 'object' || typeof change.suggestionId !== 'string') return null;
  if (!['accepted', 'rejected', 'applied'].includes(change.state)) return null;
  return {
    cmsSuggestionId: change.suggestionId.slice(0, 64),
    state: change.state,
    decidedByName: s(change.actor?.name, 200),
    decidedAt: date(change.at),
    ...(change.decisionNote != null ? { decisionNote: plainText(change.decisionNote).slice(0, CLIENT_REVIEW_LIMITS.note) } : {}),
    ...(change.state === 'applied' && change.draftRevisionId ? { appliedRevisionId: s(change.draftRevisionId, 64) } : {}),
  };
}

export function sanitizeSuggestionCounts(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out = {};
  for (const k of SUGGESTION_STATES) out[k] = Number.isInteger(c[k]) && c[k] >= 0 ? c[k] : 0;
  return out;
}

/** Who made a client decision, for "Decided by <owner> for the client" (names only, no ids). */
export function clientActorFromEvent(actor) {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.source !== 'os' && actor.source !== 'review-link') return null;
  return {
    name: s(actor.name, 200),
    role: s(actor.role, 32),
    source: actor.source,
    onBehalfOfClient: !!(actor.onBehalfOf && actor.onBehalfOf.role === 'CLIENT'),
  };
}

/** Timeline line for a review.suggestion_* event. */
export function suggestionEventMessage(ev, quote) {
  const ch = ev?.suggestion || {};
  const who = s(ch.actor?.name || ev?.actor?.name, 200) || 'An editor';
  const verb = { accepted: 'accepted', rejected: 'rejected', applied: 'applied' }[ch.state] || 'updated';
  const q = quote ? `: "${quote.length > 80 ? `${quote.slice(0, 79)}…` : quote}"` : '';
  const note = ch.decisionNote ? ` (${String(ch.decisionNote).slice(0, 200)})` : '';
  return `${who} ${verb} a client suggestion${q}${note}`.slice(0, 500);
}

/**
 * entry-get { includeFields } → what a client may see in the OS portal: text only. No entry/revision ids, no edit
 * URL, no block keys, no preview links.
 */
export function clientContentView(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const ef = e.entryFields && typeof e.entryFields === 'object' ? e.entryFields : {};
  const text = (v, max = 20_000) => (typeof v === 'string' ? plainText(v).slice(0, max) : null);
  const blocks = (Array.isArray(e.blocks) ? e.blocks : []).slice(0, 200).map((b) => {
    const fields = {};
    for (const [k, v] of Object.entries(b?.fields && typeof b.fields === 'object' ? b.fields : {}).slice(0, 50)) {
      if (typeof v === 'string' && v.trim()) fields[String(k).slice(0, 64)] = text(v, 20_000);
      else if (Array.isArray(v)) {
        const items = v.filter((x) => typeof x === 'string' && x.trim()).slice(0, 100).map((x) => text(x, 5_000));
        if (items.length) fields[String(k).slice(0, 64)] = items;
      }
    }
    return { type: s(b?.type, 64) || 'block', fields };
  });
  const headings = Array.isArray(e.outline?.headings)
    ? e.outline.headings.slice(0, 20).map((h) => ({ level: Number(h.level) || 2, text: text(h.text, 200) || '' }))
    : [];
  return {
    title: text(ef.title ?? e.title, 500) || '',
    path: typeof e.path === 'string' && e.path.startsWith('/') ? e.path.slice(0, 500) : null,
    excerpt: text(ef.excerpt ?? e.excerpt, 1000),
    seo: { title: text(ef['seo.title'] ?? e.seo?.title, 500), description: text(ef['seo.description'] ?? e.seo?.description, 1000) },
    wordCount: Number.isInteger(e.wordCount) ? e.wordCount : null,
    headings,
    blocks,
    plainText: blocks.length ? null : text(e.plainText, 100_000),
  };
}

/**
 * Extra review fields for EmDash rows (PM and client lists): decision channel, suggestion counts, who decided, and
 * whether the OS may take the client decision. Empty for WordPress rows (their shape stays unchanged).
 */
export function emdashReviewExtras(r, project) {
  if (project?.cmsType !== 'EMDASH') return {};
  const caps = project.cmsCapabilities && typeof project.cmsCapabilities === 'object' ? project.cmsCapabilities : {};
  const actor = r.cmsClientActor && typeof r.cmsClientActor === 'object' ? r.cmsClientActor : null;
  return {
    clientReviewFromOs: caps.clientReviewFromOs === true,
    clientDecisionSource: r.cmsClientDecisionSource || null,
    suggestionCounts: r.cmsSuggestionCounts || null,
    clientDecidedBy: actor ? { name: actor.name || null, onBehalfOfClient: !!actor.onBehalfOfClient, source: actor.source || null } : null,
    ...(r.status === 'changes_requested_by_client' && r.clientDecision === 'changes_publish' && !r.isPublished
      ? { statusLabel: CHANGES_PUBLISH_LABEL }
      : {}),
  };
}
