/**
 * Contract v1.6.1 §37: security check settings controlled from the OS (capability `securityConfig`).
 *
 * The site stays the source of truth. The OS keeps a mirror (SecurityConfigMirror.config) from security-config-get and
 * the security.config_changed events (applied in rev order; a gap or a truncated event → pull security-config-get and
 * replace the mirror), and edits through signed routes only:
 *   security-config-set (compare-and-set on baseRev), security-run (async, result = security.scan_completed with the
 *   same scanId), security-ack (acknowledge a failing / warning check).
 * Only human OWNER / PM may call these (routes refuse agents and API tokens before anything is sent); the site refuses
 * them again (403 HUMAN_ONLY / FORBIDDEN). Every write carries an idempotency key (one per user action).
 * Nothing here reaches a client response (settings, notes and acknowledgements are agency-only, O-4).
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { CmsBridgeError, emdashRoutes, osActor } from '../siteAdapters/emdash.js';
import {
  sanitizeConfig,
  sanitizeSecurityEventData,
  isCheckId,
  isoOrNull,
  safeText,
  SECURITY_CONFIG_LIMITS,
  SECURITY_FREQUENCIES,
  SECURITY_SEVERITIES,
  SECURITY_RECIPIENTS_MODES,
} from '../siteAdapters/security.js';
import { J } from './jsonNull.js';

const NO_RETRY = Object.freeze({ retryDelays: [] });
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const PENDING_SCAN_TTL_MS = 6 * 60 * 60 * 1000;

/** A fresh key per user action, or the caller's Idempotency-Key (a retried click replays on the site). */
export function actionKey(raw) {
  return typeof raw === 'string' && IDEMPOTENCY_RE.test(raw) ? raw : crypto.randomUUID();
}

export async function loadMirror(projectId) {
  return prisma.securityConfigMirror.findUnique({ where: { projectId } });
}

async function saveMirror(projectId, config, { pendingScans } = {}) {
  const prev = await loadMirror(projectId);
  const keep = pendingScans ?? (Array.isArray(prev?.config?.pendingScans) ? prev.config.pendingScans : []);
  const data = {
    rev: config.rev,
    config: { ...config, pendingScans: keep },
    lastChangedAt: config.lastChange?.at ? new Date(config.lastChange.at) : null,
    stale: false,
    fetchedAt: new Date(),
  };
  await prisma.securityConfigMirror.upsert({ where: { projectId }, update: J(data), create: J({ projectId, ...data }) });
  // Acknowledgements also mute OS alerts (§37.5): copy them onto the current check states.
  for (const c of config.checks) {
    await prisma.securityCheckState.updateMany({ where: { projectId, checkId: c.id }, data: J({ acknowledged: c.acknowledged && c.acknowledged.active ? c.acknowledged : null }) });
  }
  return { ...config, pendingScans: keep };
}

/** security-config-get → mirror. Returns the sanitized config (null when the site sent nothing usable). */
export async function pullSecurityConfig(projectId, { conn = null, opts = NO_RETRY } = {}) {
  const c = conn || (await loadEmdashConnection(projectId)).conn;
  const res = await emdashRoutes.securityConfigGet(c, opts);
  const cfg = sanitizeConfig(res?.config);
  if (!cfg) return null;
  return saveMirror(projectId, cfg);
}

let pullTimers = new Map();
/** Fire-and-forget re-pull after a rev gap / truncated event (once per project at a time; timer unref'd). */
export function scheduleConfigPull(projectId, log, delayMs = 2000) {
  if (pullTimers.has(projectId)) return;
  const t = setTimeout(() => {
    pullTimers.delete(projectId);
    pullSecurityConfig(projectId).catch((err) => log?.warn?.({ projectId, code: err?.code }, 'security-config-get after a rev gap failed'));
  }, delayMs);
  t.unref?.();
  pullTimers.set(projectId, t);
}
export function _resetConfigPullTimers() {
  for (const t of pullTimers.values()) clearTimeout(t);
  pullTimers = new Map();
}

/** Apply one securityConfigChange to a mirrored config (pure). */
export function patchConfig(config, change) {
  if (change.id === 'alerts') {
    config.alerts = { ...config.alerts, [change.field]: change.to };
    return;
  }
  const c = config.checks.find((x) => x.id === change.id);
  if (!c) return;
  c[change.field] = change.to;
  if (change.field === 'severityOverride') c.severity = change.to || c.defaultSeverity;
  if (change.field === 'schedule') c.frequency = change.to || c.defaultSchedule;
  if (change.field === 'snoozedUntil' && change.to === null) c.acknowledged = null;
}

/**
 * security.config_changed / security.acknowledged → mirror (contract §37.6 mirror rule). Returns a receipt outcome.
 */
export async function applySecurityConfigEvent(project, ev, { log, schedulePull = scheduleConfigPull } = {}) {
  const res = sanitizeSecurityEventData(ev.type, ev.data);
  if (!res.data) return 'stored';
  const d = res.data;
  const mirror = await loadMirror(project.id);
  if (ev.type === 'security.acknowledged') {
    const ack = { at: d.at, until: d.until, state: d.state, by: d.by, source: d.source, note: d.note, active: Date.parse(d.until) > Date.now() };
    await prisma.securityCheckState.updateMany({ where: { projectId: project.id, checkId: d.checkId }, data: { acknowledged: ack } });
    if (mirror?.config && Array.isArray(mirror.config.checks)) {
      const cfg = mirror.config;
      const c = cfg.checks.find((x) => x.id === d.checkId);
      if (c) {
        c.acknowledged = ack;
        c.snoozedUntil = d.until;
        await prisma.securityConfigMirror.update({ where: { projectId: project.id }, data: { config: cfg } });
      }
    }
    return 'applied';
  }
  // security.config_changed
  if (!mirror || mirror.rev == null || !mirror.config) {
    schedulePull(project.id, log);
    return 'applied';
  }
  if (d.rev <= mirror.rev) return 'stale';
  if (d.rev !== mirror.rev + 1 || d.truncated) {
    await prisma.securityConfigMirror.update({ where: { projectId: project.id }, data: { stale: true } });
    schedulePull(project.id, log);
    return 'applied';
  }
  const cfg = mirror.config;
  for (const ch of d.changes) patchConfig(cfg, ch);
  cfg.rev = d.rev;
  cfg.lastChange = { rev: d.rev, at: d.at, source: d.source, by: d.by };
  // CAS on the rev we read, so two instances never apply the same rev twice or out of order.
  const upd = await prisma.securityConfigMirror.updateMany({
    where: { projectId: project.id, rev: mirror.rev },
    data: { rev: d.rev, config: cfg, lastChangedAt: new Date(d.at) },
  });
  if (upd.count === 0) schedulePull(project.id, log);
  return 'applied';
}

/** security.scan_completed with a scanId the OS started: the "running…" marker ends. */
export async function completePendingScan(projectId, scanId) {
  const mirror = await loadMirror(projectId);
  const list = Array.isArray(mirror?.config?.pendingScans) ? mirror.config.pendingScans : [];
  if (!list.some((s) => s.scanId === scanId)) return false;
  await prisma.securityConfigMirror.update({ where: { projectId }, data: { config: { ...mirror.config, pendingScans: list.filter((s) => s.scanId !== scanId) } } });
  return true;
}

/** Display name for a siteActor: our own user for osUserId, else "site admin" (§37.2). */
export async function actorLabel(by) {
  if (!by) return null;
  if (by.osUserId) {
    const u = await prisma.user.findUnique({ where: { id: by.osUserId }, select: { name: true } }).catch(() => null);
    return u?.name || 'Agency OS user';
  }
  return by.source === 'admin-panel' || by.role === 'admin' ? 'site admin' : 'the site';
}

/** Mirror + labels for the staff Security tab. */
export async function configView(projectId) {
  const mirror = await loadMirror(projectId);
  if (!mirror?.config) return null;
  const cfg = mirror.config;
  const now = Date.now();
  const pendingScans = (Array.isArray(cfg.pendingScans) ? cfg.pendingScans : []).filter((s) => now - Date.parse(s.at) < PENDING_SCAN_TTL_MS);
  const labelCache = new Map();
  const label = async (by) => {
    const k = JSON.stringify(by || null);
    if (!labelCache.has(k)) labelCache.set(k, await actorLabel(by));
    return labelCache.get(k);
  };
  const checks = [];
  for (const c of cfg.checks) checks.push({ ...c, acknowledged: c.acknowledged ? { ...c.acknowledged, byName: await label(c.acknowledged.by) } : null });
  return {
    ...cfg,
    checks,
    pendingScans,
    lastChange: cfg.lastChange ? { ...cfg.lastChange, byName: await label(cfg.lastChange.by) } : null,
    stale: mirror.stale === true,
    fetchedAt: mirror.fetchedAt,
  };
}

function bad(message, details) {
  return new CmsBridgeError({ status: 400, code: 'VALIDATION', message, details });
}

/** OS-side validation of a security-config-set body (the site re-checks everything against its catalogue). */
export function buildConfigSetBody({ baseRev, changes, alerts }, user) {
  if (!Number.isInteger(baseRev) || baseRev < 0) throw bad('baseRev is required');
  const out = { baseRev, actor: osActor(user) };
  if (changes !== undefined) {
    if (!Array.isArray(changes) || changes.length > SECURITY_CONFIG_LIMITS.changes) throw bad(`At most ${SECURITY_CONFIG_LIMITS.changes} changes per save`);
    out.changes = changes.map((c) => {
      if (!c || typeof c !== 'object' || !isCheckId(c.id)) throw bad('Every change needs a check id');
      const x = { id: c.id };
      if (c.enabled !== undefined) {
        if (typeof c.enabled !== 'boolean') throw bad('enabled must be true or false');
        x.enabled = c.enabled;
      }
      if (c.clientVisible !== undefined) {
        if (typeof c.clientVisible !== 'boolean') throw bad('clientVisible must be true or false');
        x.clientVisible = c.clientVisible;
      }
      if (c.severityOverride !== undefined) {
        if (c.severityOverride !== null && !SECURITY_SEVERITIES.includes(c.severityOverride)) throw bad('Invalid severity');
        x.severityOverride = c.severityOverride;
      }
      if (c.schedule !== undefined) {
        if (c.schedule !== null && !SECURITY_FREQUENCIES.includes(c.schedule)) throw bad('Invalid schedule');
        x.schedule = c.schedule;
      }
      if (c.snoozedUntil !== undefined) {
        if (c.snoozedUntil !== null && !isoOrNull(c.snoozedUntil)) throw bad('snoozedUntil must be a date-time or null');
        x.snoozedUntil = c.snoozedUntil === null ? null : isoOrNull(c.snoozedUntil);
      }
      if (c.note !== undefined) {
        if (c.note !== null && (typeof c.note !== 'string' || c.note.length > SECURITY_CONFIG_LIMITS.note)) throw bad(`A note is at most ${SECURITY_CONFIG_LIMITS.note} characters`);
        x.note = c.note === null || c.note.trim() === '' ? null : c.note.trim();
      }
      if (Object.keys(x).length === 1) throw bad(`Nothing to change for ${c.id}`);
      return x;
    });
  }
  if (alerts !== undefined) {
    if (!alerts || typeof alerts !== 'object') throw bad('alerts must be an object');
    const a = {};
    if (alerts.emailOnCritical !== undefined) {
      if (typeof alerts.emailOnCritical !== 'boolean') throw bad('emailOnCritical must be true or false');
      a.emailOnCritical = alerts.emailOnCritical;
    }
    if (alerts.dedupeHours !== undefined) {
      if (!Number.isInteger(alerts.dedupeHours) || alerts.dedupeHours < 1 || alerts.dedupeHours > 168) throw bad('dedupeHours must be 1–168');
      a.dedupeHours = alerts.dedupeHours;
    }
    if (alerts.recipientsMode !== undefined) {
      if (!SECURITY_RECIPIENTS_MODES.includes(alerts.recipientsMode)) throw bad('recipientsMode must be site or os');
      a.recipientsMode = alerts.recipientsMode;
    }
    if (Object.keys(a).length) out.alerts = a;
  }
  if (!out.changes?.length && !out.alerts) throw bad('Nothing to save');
  return out;
}

async function audit(projectId, action, key, user, status, summary) {
  await prisma.securityConfigAction
    .create({ data: { projectId, action, idempotencyKey: key, userId: user.id, status: String(status).slice(0, 40), summary } })
    .catch(() => {});
}

/** Contract errors → mirror refresh where the site hands us the current settings. */
async function onWriteError(projectId, err) {
  if (err instanceof CmsBridgeError && err.code === 'CONFLICT_REV' && err.details?.config) {
    const cfg = sanitizeConfig(err.details.config);
    if (cfg) {
      const saved = await saveMirror(projectId, cfg);
      err.details = { currentRev: cfg.rev, config: saved };
    } else err.details = { currentRev: Number.isInteger(err.details.currentRev) ? err.details.currentRev : null };
  }
  if (err instanceof CmsBridgeError && err.code === 'UNKNOWN_CHECK') {
    err.details = { ids: Array.isArray(err.details?.ids) ? err.details.ids.filter(isCheckId).slice(0, 50) : [], catalogueVersion: err.details?.catalogueVersion ?? null };
  }
  throw err;
}

export async function setSecurityConfig(projectId, user, body, { idempotencyKey } = {}) {
  const req = buildConfigSetBody(body || {}, user);
  const key = actionKey(idempotencyKey);
  const { conn } = await loadEmdashConnection(projectId);
  try {
    const res = await emdashRoutes.securityConfigSet(conn, req, { ...NO_RETRY, idempotencyKey: key });
    const cfg = sanitizeConfig(res?.config);
    const saved = cfg ? await saveMirror(projectId, cfg) : null;
    const applied = (Array.isArray(res?.applied) ? res.applied : []).slice(0, 200).map((a) => ({ id: String(a?.id || '').slice(0, 80), field: String(a?.field || '').slice(0, 32) }));
    const rejected = (Array.isArray(res?.rejected) ? res.rejected : []).slice(0, 200).map((r) => ({
      id: String(r?.id || '').slice(0, 80),
      field: r?.field ? String(r.field).slice(0, 32) : null,
      reason: String(r?.reason || '').slice(0, 32),
      message: safeText(r?.message, 300),
    }));
    await audit(projectId, 'config-set', key, user, 'ok', { applied: applied.length, rejected: rejected.length, rev: cfg?.rev ?? null });
    return { config: saved, applied, rejected, replayed: res?.idempotentReplay === true };
  } catch (err) {
    await audit(projectId, 'config-set', key, user, err?.code || 'ERROR', null);
    return onWriteError(projectId, err);
  }
}

export async function runSecurityScan(projectId, user, { checkIds, all, reason } = {}, { idempotencyKey } = {}) {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < 1 || r.length > SECURITY_CONFIG_LIMITS.runReason) throw bad(`A reason (1–${SECURITY_CONFIG_LIMITS.runReason} characters) is required`);
  const body = { reason: r, actor: osActor(user) };
  if (all === true) body.all = true;
  else {
    if (!Array.isArray(checkIds) || checkIds.length < 1 || checkIds.length > SECURITY_CONFIG_LIMITS.runCheckIds || !checkIds.every(isCheckId)) {
      throw bad(`Pick 1–${SECURITY_CONFIG_LIMITS.runCheckIds} checks, or run all`);
    }
    body.checkIds = [...new Set(checkIds)];
  }
  const key = actionKey(idempotencyKey);
  const { conn } = await loadEmdashConnection(projectId);
  try {
    const res = await emdashRoutes.securityRun(conn, body, { ...NO_RETRY, idempotencyKey: key });
    const scanId = typeof res?.scanId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(res.scanId) ? res.scanId : null;
    if (scanId) {
      const mirror = await loadMirror(projectId);
      if (mirror?.config) {
        const list = (Array.isArray(mirror.config.pendingScans) ? mirror.config.pendingScans : []).filter((s) => s.scanId !== scanId).slice(-9);
        list.push({ scanId, at: new Date().toISOString(), byName: String(user.name || '').slice(0, 200), all: body.all === true });
        await prisma.securityConfigMirror.update({ where: { projectId }, data: { config: { ...mirror.config, pendingScans: list } } });
      }
    }
    const out = {
      scanId,
      queued: res?.queued === true,
      alreadyQueued: res?.alreadyQueued === true,
      checkIds: Array.isArray(res?.checkIds) ? res.checkIds.filter(isCheckId).slice(0, 200) : null,
      skipped: (Array.isArray(res?.skipped) ? res.skipped : []).filter((s) => isCheckId(s?.id)).slice(0, 200).map((s) => ({ id: s.id, reason: String(s.reason || '').slice(0, 32) })),
    };
    await audit(projectId, 'run', key, user, 'queued', { scanId, all: body.all === true, checks: body.checkIds?.length ?? null });
    return out;
  } catch (err) {
    await audit(projectId, 'run', key, user, err?.code || 'ERROR', null);
    if (err instanceof CmsBridgeError && err.code === 'INVALID_TRANSITION') {
      err.message = 'Nothing to run: the selected checks are disabled or run on the host only.';
      err.details = { skipped: (Array.isArray(err.details?.skipped) ? err.details.skipped : []).filter((s) => isCheckId(s?.id)).slice(0, 200).map((s) => ({ id: s.id, reason: String(s.reason || '').slice(0, 32) })) };
    }
    return onWriteError(projectId, err);
  }
}

/** OS-side limit check (the site re-checks): default 7 days, max 30, critical max 7 (by effective severity). */
export function ackBounds(severity, limits = {}, now = Date.now()) {
  const def = limits.ackDefaultDays || SECURITY_CONFIG_LIMITS.ackDefaultDays;
  const max = severity === 'critical' ? limits.ackCriticalMaxDays || SECURITY_CONFIG_LIMITS.ackCriticalMaxDays : limits.ackMaxDays || SECURITY_CONFIG_LIMITS.ackMaxDays;
  return { defaultUntil: new Date(now + def * 86400_000).toISOString(), maxUntil: new Date(now + max * 86400_000).toISOString(), maxDays: max };
}

export async function ackSecurityCheck(projectId, user, { checkId, until, note } = {}, { idempotencyKey } = {}) {
  if (!isCheckId(checkId)) throw bad('checkId is required');
  const n = typeof note === 'string' ? note.trim() : '';
  if (n.length < 1 || n.length > SECURITY_CONFIG_LIMITS.note) throw bad(`A note (1–${SECURITY_CONFIG_LIMITS.note} characters) is required`);
  const body = { checkId, note: n, actor: osActor(user) };
  if (until !== undefined && until !== null && until !== '') {
    const iso = isoOrNull(until);
    if (!iso || Date.parse(iso) <= Date.now()) throw bad('The acknowledgement must end in the future');
    const mirror = await loadMirror(projectId);
    const check = mirror?.config?.checks?.find((c) => c.id === checkId);
    const b = ackBounds(check?.severity, mirror?.config?.limits);
    if (Date.parse(iso) > Date.parse(b.maxUntil) + 60_000) throw bad(`At most ${b.maxDays} days for this check`, { reason: 'ack_too_long', maxDays: b.maxDays, maxUntil: b.maxUntil });
    body.until = iso;
  }
  const key = actionKey(idempotencyKey);
  const { conn } = await loadEmdashConnection(projectId);
  try {
    const res = await emdashRoutes.securityAck(conn, body, { ...NO_RETRY, idempotencyKey: key });
    const d = sanitizeSecurityEventData('security.acknowledged', res?.acknowledged).data;
    if (d) await applySecurityConfigEvent({ id: projectId }, { type: 'security.acknowledged', data: res.acknowledged });
    await audit(projectId, 'ack', key, user, 'ok', { checkId, rev: Number.isInteger(res?.rev) ? res.rev : null });
    return { rev: Number.isInteger(res?.rev) ? res.rev : null, acknowledged: d ? { ...d, byName: await actorLabel(d.by) } : null };
  } catch (err) {
    await audit(projectId, 'ack', key, user, err?.code || 'ERROR', { checkId });
    if (err instanceof CmsBridgeError && err.code === 'VALIDATION' && err.details?.reason === 'ack_too_long') {
      err.details = { reason: 'ack_too_long', maxDays: Number(err.details.maxDays) || null, maxUntil: isoOrNull(err.details.maxUntil) };
    }
    return onWriteError(projectId, err);
  }
}
