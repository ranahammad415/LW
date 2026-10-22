/**
 * Contract v1.6.0 §36 (security status, backup status, logs): ingest-side validation, bounds and redaction.
 *
 * The site is the source of truth; the OS only reads (signed routes) and stores (events). Every site-supplied payload
 * goes through these pure functions BEFORE it is stored or shown:
 *   1. shape / enum / pattern checks per the contract schemas (common.json securityStatus, securityCheck,
 *      securityBackups, backupRun, security*Data, backup*Data);
 *   2. bounds (SECURITY_LIMITS): an out-of-bounds ITEM (a check, change, run, destination, ref) is dropped and the rest
 *      of the payload is kept; an over-long text is cut to its limit; evidence is bounded to 8 KiB (boundEvidence);
 *   3. the shared redaction pass (redact.js, the port of the contract's redact.mjs) on every string.
 * Text is plain text: the OS renders it as text only (never HTML / markdown), on every surface.
 */
import { redactString, boundEvidence } from './redact.js';

export const SECURITY_STATES = Object.freeze(['ok', 'warn', 'fail', 'unknown']);
/** v1.7.0 §38.9 errata: a CHECK may be 'n/a' (feature switched off: not scored, not counted, never alerted).
 *  overall.state / categories[].state stay SECURITY_STATES. */
export const SECURITY_NA = 'n/a';
export const SECURITY_CHECK_STATES = Object.freeze([...SECURITY_STATES, SECURITY_NA]);
export const SECURITY_NA_REASONS = Object.freeze(['disabled', 'not_configured']);
/** States that are "in play" (counted, scored, alertable): everything but n/a. */
export const isApplicableState = (s) => s !== SECURITY_NA;
export const SECURITY_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
export const SECURITY_UNKNOWN_REASONS = Object.freeze(['not_configured', 'not_run', 'stale', 'error', 'no_data', 'not_instrumented']);
export const SECURITY_CHECK_SOURCES = Object.freeze(['plugin', 'worker', 'ci']);
export const SECURITY_FREQUENCIES = Object.freeze(['15m', '1h', '6h', '1d', '1w', 'build', 'manual']);
export const SECURITY_INCIDENT_PHASES = Object.freeze(['detected', 'contained', 'preserved', 'eradicated', 'recovered', 'closed']);
export const SECURITY_SCAN_KINDS = Object.freeze(['scheduled', 'manual', 'build']);
export const IDENTITY_ROLE_CLASSES = Object.freeze(['owner', 'editor', 'agent', 'system']);
export const BACKUP_KINDS = Object.freeze(['db', 'files']);
export const BACKUP_OWNERS = Object.freeze(['agency', 'client']);
export const BACKUP_ERROR_CODES = Object.freeze(['AUTH', 'NETWORK', 'QUOTA', 'TIMEOUT', 'INTEGRITY', 'CONFIG', 'INTERNAL']);
export const BACKUP_RUN_RESULTS = Object.freeze(['ok', 'failed', 'running']);
export const SECURITY_EVENT_TYPES = Object.freeze(['security.status_changed', 'security.check_failed', 'security.scan_completed', 'security.incident']);
export const BACKUP_EVENT_TYPES = Object.freeze(['backup.completed', 'backup.failed', 'backup.verified', 'backup.missed']);
export const SECURITY_SEVERITY_WEIGHTS = Object.freeze({ critical: 25, high: 10, medium: 4, low: 1 });

/** Contract SECURITY_LIMITS (§36.5). */
export const SECURITY_LIMITS = Object.freeze({
  summary: 300,
  clientSummary: 300,
  remediation: 1000,
  evidenceBytes: 8192,
  checks: 200,
  changes: 50,
  changedSince: 200,
  historyDays: 90,
  incidentSummary: 500,
  refs: 10,
  destinationLabel: 80,
  backupDestinations: 20,
  backupRuns: 30,
  logsPullLimit: 500,
  logDataBytes: 2048,
  routesPerKeyPerMin: 60,
});

const CHECK_ID_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_.]{1,64}$/;
const CATEGORY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEST_TYPE_RE = /^[a-z0-9_-]{1,32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = (v, list) => (typeof v === 'string' && list.includes(v) ? v : null);
const nonNegInt = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

export function isCheckId(v) {
  return typeof v === 'string' && v.length <= 80 && CHECK_ID_RE.test(v);
}

/** RFC 3339 date-time → ISO string, else null. */
export function isoOrNull(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Plain text, redacted, cut to `max` characters (contract maxLength). Non-strings → null. */
export function safeText(v, max) {
  if (typeof v !== 'string') return null;
  const s = redactString(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s.length > max ? s.slice(0, max) : s;
}

function counts(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of SECURITY_STATES) {
    const n = nonNegInt(v[k]);
    if (n === null) return null;
    out[k] = n;
  }
  // §38.9: optional, present only when > 0 (n/a checks are outside the four counted states)
  if (nonNegInt(v.na)) out.na = v.na;
  return out;
}

/** One securityCheck. Returns null when a required field is missing or invalid (the item is dropped). */
export function sanitizeCheck(c, { withEvidence = true } = {}) {
  if (!isObj(c) || !isCheckId(c.id)) return null;
  const severity = oneOf(c.severity, SECURITY_SEVERITIES);
  const state = oneOf(c.state, SECURITY_CHECK_STATES);
  if (!severity || !state || typeof c.summary !== 'string') return null;
  if (typeof c.category !== 'string' || !CATEGORY_RE.test(c.category)) return null;
  const out = {
    id: c.id,
    category: c.category,
    severity,
    state,
    reason: state === 'unknown' ? oneOf(c.reason, SECURITY_UNKNOWN_REASONS) : state === SECURITY_NA ? oneOf(c.reason, SECURITY_NA_REASONS) || 'disabled' : null,
    source: oneOf(c.source, SECURITY_CHECK_SOURCES),
    frequency: oneOf(c.frequency, SECURITY_FREQUENCIES),
    checkedAt: isoOrNull(c.checkedAt),
    ttlSec: nonNegInt(c.ttlSec),
    since: isoOrNull(c.since),
    firstSeenAt: isoOrNull(c.firstSeenAt),
    lastChangedAt: isoOrNull(c.lastChangedAt),
    summary: safeText(c.summary, SECURITY_LIMITS.summary),
    // clientSummary travels only for client-visible checks: its presence IS the client-visible flag.
    clientSummary: typeof c.clientSummary === 'string' && c.clientSummary.trim() ? safeText(c.clientSummary, SECURITY_LIMITS.clientSummary) : null,
    remediation: safeText(c.remediation, SECURITY_LIMITS.remediation),
    autoFix: isObj(c.autoFix) ? { available: c.autoFix.available === true, applied: c.autoFix.applied === true } : null,
    // v1.6.1 §37.5: active acknowledgement (agency-only; never reaches a client response).
    acknowledged: sanitizeAck(c.acknowledged),
    refs: Array.isArray(c.refs)
      ? c.refs.filter((r) => typeof r === 'string' && r.length <= 16).slice(0, SECURITY_LIMITS.refs).map((r) => safeText(r, 16))
      : [],
  };
  if (withEvidence && c.evidence !== undefined) out.evidence = boundEvidence(c.evidence, SECURITY_LIMITS.evidenceBytes);
  return out;
}

function archiveState(a) {
  if (!isObj(a)) return null;
  return {
    lastOkAt: isoOrNull(a.lastOkAt),
    bytes: nonNegInt(a.bytes),
    encrypted: typeof a.encrypted === 'boolean' ? a.encrypted : null,
    // Unknown codes become INTERNAL (contract §36.3); never a provider message.
    lastError: a.lastError == null ? null : BACKUP_ERROR_CODES.includes(a.lastError) ? a.lastError : 'INTERNAL',
    nextExpectedAt: isoOrNull(a.nextExpectedAt),
  };
}

/** securityBackups (or null = no record: unknown, never ok). */
export function sanitizeBackups(b) {
  if (!isObj(b)) return null;
  const agency = isObj(b.agency) ? b.agency : {};
  const offsite = isObj(agency.offsite) && typeof agency.offsite.destinationType === 'string' && DEST_TYPE_RE.test(agency.offsite.destinationType)
    ? { destinationType: agency.offsite.destinationType, lastOkAt: isoOrNull(agency.offsite.lastOkAt), nextExpectedAt: isoOrNull(agency.offsite.nextExpectedAt) }
    : null;
  const client = (Array.isArray(b.client) ? b.client : [])
    .filter((d) => isObj(d) && typeof d.destinationId === 'string' && ID_RE.test(d.destinationId) && typeof d.type === 'string' && DEST_TYPE_RE.test(d.type))
    .slice(0, SECURITY_LIMITS.backupDestinations)
    .map((d) => ({
      destinationId: d.destinationId,
      type: d.type,
      // Client-entered free text: untrusted, redacted, ≤ 80, rendered as text.
      label: safeText(d.label, SECURITY_LIMITS.destinationLabel),
      schedule: safeText(d.schedule, 120),
      db: archiveState(d.db),
      files: archiveState(d.files),
      encrypted: typeof d.encrypted === 'boolean' ? d.encrypted : null,
      retentionDays: nonNegInt(d.retentionDays),
      nextExpectedAt: isoOrNull(d.nextExpectedAt),
    }));
  const rt = b.lastRestoreTest;
  return {
    agency: { db: archiveState(agency.db), files: archiveState(agency.files), offsite },
    client,
    lastRestoreTest: isObj(rt) && isoOrNull(rt.at) && ['ok', 'failed'].includes(rt.result) ? { at: isoOrNull(rt.at), result: rt.result } : null,
  };
}

/** backupRun. null when invalid (dropped). */
export function sanitizeRun(r) {
  if (!isObj(r) || typeof r.runId !== 'string' || !ID_RE.test(r.runId)) return null;
  const kind = oneOf(r.kind, BACKUP_KINDS);
  const owner = oneOf(r.owner, BACKUP_OWNERS);
  const result = oneOf(r.result, BACKUP_RUN_RESULTS);
  const startedAt = isoOrNull(r.startedAt);
  if (!kind || !owner || !result || !startedAt) return null;
  return {
    runId: r.runId,
    kind,
    owner,
    destinationId: typeof r.destinationId === 'string' && ID_RE.test(r.destinationId) ? r.destinationId : null,
    startedAt,
    finishedAt: isoOrNull(r.finishedAt),
    bytes: nonNegInt(r.bytes),
    sha256: typeof r.sha256 === 'string' && SHA256_RE.test(r.sha256) ? r.sha256 : null,
    result,
    errorCode: r.errorCode == null ? null : BACKUP_ERROR_CODES.includes(r.errorCode) ? r.errorCode : 'INTERNAL',
  };
}

/** The `status` of a security-status response. Returns null when the overall block is unusable. */
export function sanitizeStatus(s) {
  if (!isObj(s) || !isObj(s.overall)) return null;
  const state = oneOf(s.overall.state, SECURITY_STATES);
  const score = Number.isInteger(s.overall.score) && s.overall.score >= 0 && s.overall.score <= 100 ? s.overall.score : null;
  if (!state || score === null) return null;
  const detail = s.detail === 'full' ? 'full' : 'summary';
  const categories = {};
  if (isObj(s.categories)) {
    for (const [k, v] of Object.entries(s.categories).slice(0, 32)) {
      if (!CATEGORY_RE.test(k) || !isObj(v)) continue;
      const cs = oneOf(v.state, SECURITY_STATES);
      if (cs && Number.isInteger(v.score) && v.score >= 0 && v.score <= 100) categories[k] = { state: cs, score: v.score };
    }
  }
  const seen = new Set();
  const checks = [];
  const sent = Array.isArray(s.checks) ? s.checks : [];
  for (const c of sent.slice(0, SECURITY_LIMITS.checks)) {
    const sc = sanitizeCheck(c, { withEvidence: detail === 'full' });
    if (sc && !seen.has(sc.id)) {
      seen.add(sc.id);
      checks.push(sc);
    }
  }
  const build = isObj(s.scans?.lastBuild) ? s.scans.lastBuild : null;
  const audit = isObj(build?.npmAudit) ? { critical: nonNegInt(build.npmAudit.critical), high: nonNegInt(build.npmAudit.high) } : null;
  return {
    generatedAt: isoOrNull(s.generatedAt),
    catalogueVersion: typeof s.catalogueVersion === 'string' && SEMVER_RE.test(s.catalogueVersion) ? s.catalogueVersion : null,
    detail,
    sentinel: isObj(s.sentinel) ? { version: safeText(s.sentinel.version, 32), workerLastSeenAt: isoOrNull(s.sentinel.workerLastSeenAt) } : null,
    overall: { state, score, counts: counts(s.overall.counts), since: isoOrNull(s.overall.since) },
    categories,
    checks,
    // How many of the site's checks the sanitizer left out (invalid, duplicate or over the limit). The caller logs it
    // when > 0, so a new state or field on the site is never dropped silently (release-3 e2e O-R3-2).
    sentChecks: sent.length,
    droppedChecks: sent.length - checks.length,
    disabled: (Array.isArray(s.disabled) ? s.disabled : []).filter(isCheckId).slice(0, SECURITY_LIMITS.checks),
    backups: sanitizeBackups(s.backups),
    scans: {
      lastFullAt: isoOrNull(s.scans?.lastFullAt),
      lastBuild: build
        ? { commit: typeof build.commit === 'string' && COMMIT_RE.test(build.commit) ? build.commit : null, at: isoOrNull(build.at), npmAudit: audit }
        : null,
    },
  };
}

/** security-history points (UTC days, oldest first). Invalid points are dropped. */
export function sanitizeHistory(points) {
  const out = [];
  for (const p of (Array.isArray(points) ? points : []).slice(0, SECURITY_LIMITS.historyDays)) {
    if (!isObj(p) || typeof p.date !== 'string' || !DATE_ONLY_RE.test(p.date)) continue;
    const overallState = oneOf(p.overallState, SECURITY_STATES);
    if (!overallState || !Number.isInteger(p.score) || p.score < 0 || p.score > 100) continue;
    let checks = null;
    if (isObj(p.checks)) {
      checks = {};
      for (const [id, st] of Object.entries(p.checks).slice(0, SECURITY_LIMITS.checks)) {
        if (isCheckId(id) && SECURITY_CHECK_STATES.includes(st)) checks[id] = st;
      }
    }
    out.push({ date: p.date, overallState, score: p.score, checks });
  }
  return out;
}

function destination(d) {
  if (!isObj(d) || typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.type !== 'string' || !DEST_TYPE_RE.test(d.type)) return null;
  return { id: d.id, type: d.type, label: safeText(d.label, SECURITY_LIMITS.destinationLabel) };
}

function identity(b) {
  if (!isObj(b) || !IDENTITY_ROLE_CLASSES.includes(b.roleClass)) return null;
  return { userId: typeof b.userId === 'string' && ID_RE.test(b.userId) ? b.userId : null, roleClass: b.roleClass };
}

/**
 * A security.* / backup.* event's `data`, validated and bounded. Returns { data } or { error } (an envelope with a
 * missing required field is a final VALIDATION reject; out-of-bounds list items are dropped, the rest is kept).
 * Unknown security.* / backup.* types (e.g. 1.6.1 config events on a 1.6.0 OS path) return { data: null }.
 */
export function sanitizeSecurityEventData(type, raw) {
  const d = raw;
  if (!isObj(d)) return { error: 'data is required on security.* / backup.* events' };
  switch (type) {
    case 'security.check_failed': {
      if (!isCheckId(d.id)) return { error: 'data.id is invalid' };
      if (!['critical', 'high'].includes(d.severity)) return { error: 'data.severity must be critical or high' };
      if (typeof d.summary !== 'string' || typeof d.remediation !== 'string' || !isObj(d.evidence)) return { error: 'data.summary, evidence and remediation are required' };
      return {
        data: {
          id: d.id,
          severity: d.severity,
          summary: safeText(d.summary, SECURITY_LIMITS.summary),
          clientSummary: typeof d.clientSummary === 'string' && d.clientSummary.trim() ? safeText(d.clientSummary, SECURITY_LIMITS.clientSummary) : null,
          evidence: boundEvidence(d.evidence, SECURITY_LIMITS.evidenceBytes),
          remediation: safeText(d.remediation, SECURITY_LIMITS.remediation),
          at: isoOrNull(d.at),
          // Not in the 1.6.x schema: used when a site sends the previous state (O-R2-6), else the OS's stored state.
          from: SECURITY_CHECK_STATES.includes(d.from) ? d.from : SECURITY_CHECK_STATES.includes(d.before) ? d.before : null,
        },
      };
    }
    case 'security.status_changed': {
      const side = (x) => (isObj(x) && SECURITY_STATES.includes(x.state) && Number.isInteger(x.score) && x.score >= 0 && x.score <= 100 ? { state: x.state, score: x.score } : null);
      const before = side(d.before);
      const after = side(d.after);
      if (!before || !after || !Array.isArray(d.changes)) return { error: 'data.before, after and changes are required' };
      const changes = [];
      for (const c of d.changes.slice(0, SECURITY_LIMITS.changes)) {
        if (!isObj(c) || !isCheckId(c.id) || !SECURITY_CHECK_STATES.includes(c.to)) continue;
        if (c.from !== null && !SECURITY_CHECK_STATES.includes(c.from)) continue;
        if (!SECURITY_SEVERITIES.includes(c.severity) || typeof c.summary !== 'string') continue;
        changes.push({
          id: c.id,
          from: c.from,
          to: c.to,
          at: isoOrNull(c.at),
          severity: c.severity,
          summary: safeText(c.summary, SECURITY_LIMITS.summary),
          clientSummary: typeof c.clientSummary === 'string' && c.clientSummary.trim() ? safeText(c.clientSummary, SECURITY_LIMITS.clientSummary) : null,
          ...(c.to === SECURITY_NA ? { reason: oneOf(c.reason, SECURITY_NA_REASONS) || 'disabled' } : {}),
        });
      }
      const droppedChanges = Math.min(d.changes.length, SECURITY_LIMITS.changes) - changes.length;
      return { data: { before, after, changes, droppedChanges, truncated: d.truncated === true || d.changes.length > SECURITY_LIMITS.changes } };
    }
    case 'security.scan_completed': {
      if (typeof d.scanId !== 'string' || !ID_RE.test(d.scanId)) return { error: 'data.scanId is invalid' };
      if (!SECURITY_SCAN_KINDS.includes(d.kind)) return { error: 'data.kind is invalid' };
      return {
        data: {
          scanId: d.scanId,
          kind: d.kind,
          durationMs: nonNegInt(d.durationMs),
          counts: counts(d.counts),
          checksRun: nonNegInt(d.checksRun),
          catalogueVersion: typeof d.catalogueVersion === 'string' && SEMVER_RE.test(d.catalogueVersion) ? d.catalogueVersion : null,
          // v1.6.1 (optional): what started the scan.
          source: oneOf(d.source, ['schedule', 'site-admin', 'os']),
          partial: d.partial === true,
        },
      };
    }
    case 'security.incident': {
      if (typeof d.incidentId !== 'string' || !ID_RE.test(d.incidentId)) return { error: 'data.incidentId is invalid' };
      if (!SECURITY_INCIDENT_PHASES.includes(d.phase) || !SECURITY_SEVERITIES.includes(d.severity) || typeof d.summary !== 'string' || !d.summary) {
        return { error: 'data.phase, severity and summary are required' };
      }
      return {
        data: {
          incidentId: d.incidentId,
          phase: d.phase,
          severity: d.severity,
          summary: safeText(d.summary, SECURITY_LIMITS.incidentSummary),
          openedAt: isoOrNull(d.openedAt),
          by: identity(d.by),
        },
      };
    }
    case 'backup.completed':
    case 'backup.failed': {
      const dest = destination(d.destination);
      if (typeof d.runId !== 'string' || !ID_RE.test(d.runId) || !BACKUP_KINDS.includes(d.kind) || !BACKUP_OWNERS.includes(d.owner) || !dest) {
        return { error: 'data.runId, kind, owner and destination are required' };
      }
      if (type === 'backup.completed') {
        return {
          data: {
            runId: d.runId,
            kind: d.kind,
            owner: d.owner,
            destination: dest,
            bytes: nonNegInt(d.bytes),
            sha256: typeof d.sha256 === 'string' && SHA256_RE.test(d.sha256) ? d.sha256 : null,
            encrypted: d.encrypted === true,
            verified: d.verified === true,
            durationMs: nonNegInt(d.durationMs),
          },
        };
      }
      return {
        data: {
          runId: d.runId,
          kind: d.kind,
          owner: d.owner,
          destination: dest,
          errorCode: BACKUP_ERROR_CODES.includes(d.errorCode) ? d.errorCode : 'INTERNAL',
          retryable: d.retryable === true,
          attempt: Number.isInteger(d.attempt) && d.attempt >= 1 ? d.attempt : null,
        },
      };
    }
    case 'backup.verified': {
      const rt = d.restoreTest;
      if (typeof d.runId !== 'string' || !ID_RE.test(d.runId) || !isObj(rt) || !isoOrNull(rt.at) || !['ok', 'failed'].includes(rt.result)) {
        return { error: 'data.runId and restoreTest {at, result} are required' };
      }
      const c = {};
      if (isObj(rt.counts)) for (const [k, v] of Object.entries(rt.counts).slice(0, 20)) if (/^[A-Za-z0-9_]{1,40}$/.test(k) && nonNegInt(v) !== null) c[k] = v;
      return { data: { runId: d.runId, restoreTest: { at: isoOrNull(rt.at), result: rt.result, counts: c } } };
    }
    case 'backup.missed': {
      const dest = destination(d.destination);
      if (!dest || !isoOrNull(d.expectedAt) || nonNegInt(d.graceMin) === null) return { error: 'data.destination, expectedAt and graceMin are required' };
      return { data: { destination: dest, expectedAt: isoOrNull(d.expectedAt), graceMin: d.graceMin } };
    }
    case 'security.config_changed': {
      if (!Number.isInteger(d.rev) || d.rev < 1 || !isoOrNull(d.at) || !SECURITY_CONFIG_SOURCES.includes(d.source) || !Array.isArray(d.changes)) {
        return { error: 'data.rev, at, source and changes are required' };
      }
      const list = d.changes.slice(0, SECURITY_CONFIG_LIMITS.eventChanges);
      const changes = list.map(sanitizeConfigChange).filter(Boolean);
      return {
        data: {
          rev: d.rev,
          at: isoOrNull(d.at),
          source: d.source,
          by: sanitizeSiteActor(d.by),
          changes,
          // A dropped item or more than 100 changes: the mirror cannot be patched exactly (pull security-config-get).
          truncated: d.truncated === true || d.changes.length > SECURITY_CONFIG_LIMITS.eventChanges || changes.length < list.length,
          osRequest: sanitizeOsRequest(d.osRequest),
        },
      };
    }
    case 'security.acknowledged': {
      if (!isCheckId(d.checkId) || !SECURITY_SEVERITIES.includes(d.severity) || !['fail', 'warn'].includes(d.state) || !isoOrNull(d.until) || !isoOrNull(d.at)) {
        return { error: 'data.checkId, severity, state, until and at are required' };
      }
      return {
        data: {
          checkId: d.checkId,
          severity: d.severity,
          state: d.state,
          until: isoOrNull(d.until),
          note: safeText(d.note, SECURITY_CONFIG_LIMITS.note),
          at: isoOrNull(d.at),
          by: sanitizeSiteActor(d.by),
          source: oneOf(d.source, SECURITY_CONFIG_SOURCES),
          rev: Number.isInteger(d.rev) && d.rev >= 1 ? d.rev : null,
          osRequest: sanitizeOsRequest(d.osRequest),
        },
      };
    }
    default:
      return { data: null };
  }
}

// ---------------------------------------------------------------- v1.6.1 §37: security settings from the OS

export const SECURITY_CONFIG_EVENT_TYPES = Object.freeze(['security.config_changed', 'security.acknowledged']);
export const SECURITY_CONFIG_SOURCES = Object.freeze(['os', 'site-admin']);
export const SECURITY_CONFIG_FIELDS = Object.freeze(['enabled', 'clientVisible', 'severityOverride', 'schedule', 'snoozedUntil', 'note']);
export const SECURITY_ALERT_FIELDS = Object.freeze(['emailOnCritical', 'dedupeHours', 'recipientsMode']);
export const SECURITY_CONFIG_REJECT_REASONS = Object.freeze(['not_adjustable', 'value_not_allowed', 'not_acknowledgeable', 'ack_too_long', 'duplicate']);
export const SECURITY_RECIPIENTS_MODES = Object.freeze(['site', 'os']);
export const SECURITY_CONFIG_LIMITS = Object.freeze({
  changes: 50,
  eventChanges: 100,
  note: 500,
  runReason: 500,
  title: 120,
  runCheckIds: 50,
  ackDefaultDays: 7,
  ackMaxDays: 30,
  ackCriticalMaxDays: 7,
  dedupeHoursMin: 1,
  dedupeHoursMax: 168,
  dedupeHoursDefault: 24,
});
const SITE_ACTOR_KINDS = ['human', 'agent', 'plugin', 'system', 'client'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** siteActor without a name (§37.2: by.name is always null; the OS resolves osUserId to its own user). */
export function sanitizeSiteActor(a) {
  if (!isObj(a) || !SITE_ACTOR_KINDS.includes(a.kind)) return null;
  return {
    kind: a.kind,
    id: typeof a.id === 'string' && ID_RE.test(a.id) ? a.id : null,
    role: typeof a.role === 'string' ? a.role.slice(0, 32) : null,
    osUserId: typeof a.osUserId === 'string' && UUID_RE.test(a.osUserId) ? a.osUserId : null,
    source: typeof a.source === 'string' ? a.source.slice(0, 32) : null,
  };
}

function sanitizeOsRequest(r) {
  if (!isObj(r) || typeof r.route !== 'string') return null;
  return { route: r.route.slice(0, 64), idempotencyKey: typeof r.idempotencyKey === 'string' ? r.idempotencyKey.slice(0, 128) : null };
}

/** securityAcknowledgement (agency-only). */
export function sanitizeAck(a) {
  if (!isObj(a) || !isoOrNull(a.at) || !isoOrNull(a.until) || !['fail', 'warn'].includes(a.state)) return null;
  return {
    at: isoOrNull(a.at),
    until: isoOrNull(a.until),
    state: a.state,
    by: sanitizeSiteActor(a.by),
    source: oneOf(a.source, SECURITY_CONFIG_SOURCES),
    note: safeText(a.note, SECURITY_CONFIG_LIMITS.note),
    active: a.active !== false,
  };
}

/**
 * §37.5: an acknowledgement ends as soon as the check's state changes after it was given (fail → ok → fail, warn →
 * fail). True when a state change of the check at `changeAt` happened after the acknowledgement's `at` (O-R2-1).
 */
export function ackEndedBy(ack, changeAt) {
  if (!ack) return false;
  const ackAt = Date.parse(ack.at);
  const at = Date.parse(changeAt);
  if (!Number.isFinite(at)) return false;
  return !Number.isFinite(ackAt) || ackAt < at;
}

/** True while the acknowledgement mutes OS alerts for a check now in state `state` (§37.5). */
export function ackMutes(ack, state, now = Date.now()) {
  if (!ack || ack.active === false) return false;
  const until = Date.parse(ack.until);
  return Number.isFinite(until) && until > now && ack.state === state;
}

const changeValue = (v) =>
  v === null || typeof v === 'boolean' || (Number.isInteger(v) && v >= 0) ? v : typeof v === 'string' ? safeText(v, 500) : undefined;

function sanitizeConfigChange(c) {
  if (!isObj(c) || !(c.id === 'alerts' || isCheckId(c.id))) return null;
  if (![...SECURITY_CONFIG_FIELDS, ...SECURITY_ALERT_FIELDS].includes(c.field)) return null;
  const from = changeValue(c.from);
  const to = changeValue(c.to);
  if (from === undefined || to === undefined) return null;
  return { id: c.id, field: c.field, from, to };
}

/** securityConfigCheck. null when invalid (dropped). */
export function sanitizeConfigCheck(c) {
  if (!isObj(c) || !isCheckId(c.id) || typeof c.category !== 'string' || !CATEGORY_RE.test(c.category)) return null;
  const severity = oneOf(c.severity, SECURITY_SEVERITIES);
  if (!severity || typeof c.enabled !== 'boolean') return null;
  const adj = isObj(c.adjustable) ? c.adjustable : {};
  return {
    id: c.id,
    title: safeText(c.title, SECURITY_CONFIG_LIMITS.title) || c.id,
    category: c.category,
    source: oneOf(c.source, SECURITY_CHECK_SOURCES),
    enabled: c.enabled,
    clientVisible: c.clientVisible === true,
    defaultSeverity: oneOf(c.defaultSeverity, SECURITY_SEVERITIES) || severity,
    severity,
    severityOverride: oneOf(c.severityOverride, SECURITY_SEVERITIES),
    defaultSchedule: oneOf(c.defaultSchedule, SECURITY_FREQUENCIES),
    schedule: oneOf(c.schedule, SECURITY_FREQUENCIES),
    frequency: oneOf(c.frequency, SECURITY_FREQUENCIES),
    snoozedUntil: isoOrNull(c.snoozedUntil),
    note: safeText(c.note, SECURITY_CONFIG_LIMITS.note),
    acknowledged: sanitizeAck(c.acknowledged),
    adjustable: {
      enabled: adj.enabled === true,
      clientVisible: adj.clientVisible === true,
      severity: Array.isArray(adj.severity) ? [...new Set(adj.severity.filter((x) => SECURITY_SEVERITIES.includes(x)))] : [],
      schedule: Array.isArray(adj.schedule) ? [...new Set(adj.schedule.filter((x) => SECURITY_FREQUENCIES.includes(x)))] : [],
      snooze: adj.snooze === true,
    },
  };
}

/** securityConfig (security-config-get, set responses, CONFLICT_REV details.config). null when unusable. */
export function sanitizeConfig(cfg) {
  if (!isObj(cfg) || !Number.isInteger(cfg.rev) || cfg.rev < 0 || !Array.isArray(cfg.checks)) return null;
  const al = isObj(cfg.alerts) ? cfg.alerts : {};
  const lc = isObj(cfg.lastChange) ? cfg.lastChange : null;
  const lim = isObj(cfg.limits) ? cfg.limits : {};
  const pos = (v, d) => (Number.isInteger(v) && v >= 1 ? v : d);
  const seen = new Set();
  const checks = [];
  for (const c of cfg.checks.slice(0, SECURITY_LIMITS.checks)) {
    const sc = sanitizeConfigCheck(c);
    if (sc && !seen.has(sc.id)) {
      seen.add(sc.id);
      checks.push(sc);
    }
  }
  return {
    catalogueVersion: typeof cfg.catalogueVersion === 'string' && SEMVER_RE.test(cfg.catalogueVersion) ? cfg.catalogueVersion : null,
    rev: cfg.rev,
    generatedAt: isoOrNull(cfg.generatedAt),
    checks,
    alerts: {
      emailOnCritical: al.emailOnCritical === true,
      dedupeHours: Number.isInteger(al.dedupeHours) && al.dedupeHours >= 1 && al.dedupeHours <= 168 ? al.dedupeHours : SECURITY_CONFIG_LIMITS.dedupeHoursDefault,
      recipientsMode: oneOf(al.recipientsMode, SECURITY_RECIPIENTS_MODES) || 'site',
      siteRecipients: Number.isInteger(al.siteRecipients) && al.siteRecipients >= 0 && al.siteRecipients <= 10 ? al.siteRecipients : null,
    },
    worker: isObj(cfg.worker) ? { configured: cfg.worker.configured === true, lastSeenAt: isoOrNull(cfg.worker.lastSeenAt) } : { configured: false, lastSeenAt: null },
    lastChange:
      lc && Number.isInteger(lc.rev) && isoOrNull(lc.at)
        ? { rev: lc.rev, at: isoOrNull(lc.at), source: oneOf(lc.source, SECURITY_CONFIG_SOURCES), by: sanitizeSiteActor(lc.by) }
        : null,
    limits: {
      ackDefaultDays: pos(lim.ackDefaultDays, SECURITY_CONFIG_LIMITS.ackDefaultDays),
      ackMaxDays: pos(lim.ackMaxDays, SECURITY_CONFIG_LIMITS.ackMaxDays),
      ackCriticalMaxDays: pos(lim.ackCriticalMaxDays, SECURITY_CONFIG_LIMITS.ackCriticalMaxDays),
    },
  };
}

/** Envelope-level check used by validateEvent (routes/webhooks/emdash.js). Returns an error message or null. */
export function validateSecurityEvent(ev) {
  if (ev.snapshotText !== undefined || ev.lead !== undefined) return 'security.* / backup.* events never carry snapshotText or lead';
  if (!SECURITY_EVENT_TYPES.includes(ev.type) && !BACKUP_EVENT_TYPES.includes(ev.type) && !SECURITY_CONFIG_EVENT_TYPES.includes(ev.type)) return null; // unknown: stored only
  const res = sanitizeSecurityEventData(ev.type, ev.data);
  return res.error || null;
}

export function isSecurityEventType(type) {
  return typeof type === 'string' && (type.startsWith('security.') || type.startsWith('backup.'));
}

/** contract §36.2 score formula (used only to label OS-side trends; the site's score is the one shown). */
export function scoreOf(checks) {
  let s = 100;
  for (const c of checks || []) {
    const w = SECURITY_SEVERITY_WEIGHTS[c.severity] || 0;
    if (c.state === 'fail') s -= w;
    else if (c.state === 'warn') s -= w / 2;
    else if (c.state === 'unknown') s -= w / 4;
  }
  return Math.max(0, Math.round(s));
}
