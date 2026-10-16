/**
 * Contract v1.4.0 §25 (plan §4.4, D12–D14): SEO profile sync, pure helpers. Field ownership and proposal limits are
 * ported from oasis-astro packages/os-bridge-contract/src/constants.mjs (2c59003). The OS reads profiles, creates
 * proposals, and never decides them (D13); OS-owned fields changed on the site become drift rows (D14).
 */

export const PROFILE_EVENT_TYPES = Object.freeze(['seo.profile_changed', 'seo.contract_locked', 'seo.proposal_opened', 'seo.proposal_decided', 'seo.check_failed']);
export const PROFILE_LIMITS = Object.freeze({ listLimit: 100, profileBytes: 512 * 1024, briefBytes: 64 * 1024, proposalOps: 20, reasonMin: 20, reasonMax: 2000 });
export const PROFILE_FIELD_OWNERSHIP = Object.freeze({
  page_type: 'os',
  cluster: 'os',
  locality: 'os',
  parent_page_id: 'os',
  working_title: 'os',
  targeting: 'os',
  aeo: 'os',
  'lifecycle.publish_by': 'os',
  'lifecycle.next_review_on': 'os',
  research: 'os',
  brief: 'os',
  contract: 'os-until-locked',
  target: 'site',
  entry_id: 'site',
  path: 'site',
  'lifecycle.status': 'site',
  'contract.locked_on': 'site',
  'contract.version': 'site',
  'facts.used': 'os',
  'facts.status': 'site',
  checks: 'site',
  proposals: 'site',
  overrides: 'site',
  redirects: 'site',
});
/** Proposal patches may only touch these roots (RFC 6902 paths). */
export const PROPOSAL_PATH = /^\/(contract|targeting|aeo|facts)(\/|$)/;
export const PROPOSAL_OPS = Object.freeze(['add', 'remove', 'replace']);
export const PAGE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

const s = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const intOr0 = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** Owner of a dotted field name: the most specific entry wins (e.g. `contract.version` → site, `contract.x` → os-until-locked). */
export function fieldOwner(field) {
  const f = String(field || '');
  const parts = f.split('.');
  for (let i = parts.length; i > 0; i -= 1) {
    const key = parts.slice(0, i).join('.');
    if (PROFILE_FIELD_OWNERSHIP[key]) return PROFILE_FIELD_OWNERSHIP[key];
  }
  return 'site';
}

/** profileSummary → CmsSeoProfile columns. */
export function profileSummaryToRow(p) {
  if (!p || typeof p !== 'object' || !PAGE_ID.test(String(p.page_id || ''))) return null;
  const contract = p.contract && typeof p.contract === 'object'
    ? { version: Number.isInteger(p.contract.version) ? p.contract.version : null, locked: p.contract.locked === true, locked_on: s(p.contract.locked_on, 40), locked_by: s(p.contract.locked_by, 200) }
    : null;
  const checks = p.checks && typeof p.checks === 'object'
    ? { block: intOr0(p.checks.block), warn: intOr0(p.checks.warn), info: intOr0(p.checks.info), ran_at: s(p.checks.ran_at, 40), variant: s(p.checks.variant, 8) }
    : null;
  const facts = p.facts && typeof p.facts === 'object' ? { requested: intOr0(p.facts.requested), placeholder: intOr0(p.facts.placeholder), confirmed: intOr0(p.facts.confirmed) } : null;
  return {
    pageId: String(p.page_id),
    entryId: s(p.entry_id, 64),
    target: s(p.target, 200),
    path: s(p.path, 500),
    status: s(p.status, 32),
    primaryKeyword: s(p.primary_keyword, 200),
    contract,
    checks,
    facts,
    openProposals: intOr0(p.open_proposals),
    nextReviewOn: /^\d{4}-\d{2}-\d{2}$/.test(String(p.next_review_on || '')) ? p.next_review_on : null,
    profileHash: s(p.profile_hash, 64),
    siteUpdatedAt: date(p.updated_at),
  };
}

/** proposal → CmsSeoProposal columns. */
export function proposalToRow(p) {
  if (!p || typeof p !== 'object' || typeof p.proposal_id !== 'string' || !PAGE_ID.test(String(p.page_id || ''))) return null;
  return {
    proposalId: p.proposal_id.slice(0, 64),
    pageId: String(p.page_id),
    state: ['open', 'approved', 'rejected', 'withdrawn'].includes(p.state) ? p.state : 'open',
    patch: Array.isArray(p.patch) ? p.patch.slice(0, PROFILE_LIMITS.proposalOps) : [],
    reason: String(p.reason || '').slice(0, PROFILE_LIMITS.reasonMax),
    source: ['os', 'mcp', 'admin'].includes(p.source) ? p.source : 'admin',
    createdByName: s(p.created_by?.name, 200),
    createdByUserId: s(p.created_by?.osUserId, 64),
    decidedByName: s(p.decided_by?.name, 200),
    decidedAt: date(p.decided_at),
    decisionNote: s(p.decision_note, 2000),
    siteCreatedAt: date(p.created_at),
  };
}

/** A proposal state only moves forward (a late `opened` never reopens a decided proposal). */
export function proposalStateAdvances(from, to) {
  if (!from || from === to) return true;
  return from === 'open' && to !== 'open';
}

/**
 * Validate a proposal from the OS (§25.2): 1–20 RFC 6902 ops (add/remove/replace) on /contract, /targeting, /aeo,
 * /facts; reason 20–2000 characters. Returns { ok, errors }.
 */
export function validateProposal({ pageId, patch, reason }) {
  const errors = [];
  if (!PAGE_ID.test(String(pageId || ''))) errors.push({ path: '$.page_id', message: 'Unknown page' });
  if (!Array.isArray(patch) || patch.length < 1 || patch.length > PROFILE_LIMITS.proposalOps) {
    errors.push({ path: '$.patch', message: `1–${PROFILE_LIMITS.proposalOps} changes per proposal` });
  } else {
    patch.forEach((op, i) => {
      if (!op || typeof op !== 'object') return errors.push({ path: `$.patch[${i}]`, message: 'must be an object' });
      if (!PROPOSAL_OPS.includes(op.op)) errors.push({ path: `$.patch[${i}].op`, message: 'op must be add, remove or replace' });
      if (typeof op.path !== 'string' || op.path.length > 300 || !PROPOSAL_PATH.test(op.path)) {
        errors.push({ path: `$.patch[${i}].path`, message: 'only /contract, /targeting, /aeo or /facts can be proposed' });
      }
      if (op.op !== 'remove' && !('value' in op)) errors.push({ path: `$.patch[${i}].value`, message: 'a value is required' });
    });
  }
  const r = String(reason || '').trim();
  if (r.length < PROFILE_LIMITS.reasonMin || r.length > PROFILE_LIMITS.reasonMax) {
    errors.push({ path: '$.reason', message: `the reason needs ${PROFILE_LIMITS.reasonMin}–${PROFILE_LIMITS.reasonMax} characters` });
  }
  return { ok: errors.length === 0, errors };
}

/** OS-owned fields among a seo.profile_changed `changed[]` list (the ones that need a PM decision, D14). */
export function osOwnedChanges(changed) {
  return (Array.isArray(changed) ? changed : [])
    .filter((c) => c && typeof c.field === 'string')
    .map((c) => ({ field: c.field.slice(0, 120), owner: c.owner === 'os' || c.owner === 'os-until-locked' ? c.owner : fieldOwner(c.field) }))
    .filter((c) => c.owner === 'os' || c.owner === 'os-until-locked');
}

/** Clamp a full profile (profile-get) for the OS view: plain JSON, ≤ 512 KiB, nothing executed. */
export function clampProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const json = JSON.stringify(profile);
  if (Buffer.byteLength(json, 'utf8') > PROFILE_LIMITS.profileBytes) return { ...profileSummaryToRow(profile), truncated: true };
  return profile;
}
