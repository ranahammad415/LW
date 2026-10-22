/**
 * Contract v1.7.0 §38.1 / §38.7: the site's signals settings, mirrored in the OS (SignalConfigMirror), and the
 * data-quality pull (`signals-summary`).
 * - Mirror sources: site-info.signals (heartbeat / site-info; the higher rev wins), signals-config-get, the
 *   signals-config-set response, and `signals.config_changed` events (applied in rev order; a gap → pull).
 * - Writes: `signals-config-set` with baseRev (compare-and-set on the site) and one idempotency key per user action;
 *   human OWNER / PM only (the routes refuse agents and API tokens with 403 HUMAN_ONLY before any site call; the site
 *   refuses them again). 409 CONFLICT_REV → the mirror is replaced with `details.config` and the UI asks to redo.
 * The capability `signals` (= signals ON) drives every view; the mirror row exists whenever the site has the module.
 */
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { loadEmdashConnection } from '../cmsStore.js';
import { CmsBridgeError, emdashRoutes, osActor } from '../siteAdapters/emdash.js';
import { safeText } from '../siteAdapters/security.js';
import { actorName, osUserNames } from '../security/securityConfig.js';
import {
  sanitizeSignalsConfig,
  sanitizeSignalsBuffer,
  sanitizeSignalsConfigChanged,
  sanitizeSignalsSummary,
  SIGNAL_CONSENT_MODES,
  SIGNAL_GEO_DETAILS,
  SIGNALS_CONFIG_FIELDS,
  isObj,
} from './validate.js';
import { utcDay } from './common.js';

const NO_RETRY = Object.freeze({ retryDelays: [] });
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,80}$/;

export const hasSignals = (project) => project?.cmsType === 'EMDASH' && project?.cmsCapabilities?.signals === true;

export function actionKey(raw) {
  return typeof raw === 'string' && IDEMPOTENCY_RE.test(raw) ? raw : crypto.randomUUID();
}

export async function loadSignalsMirror(projectId) {
  return prisma.signalConfigMirror.findUnique({ where: { projectId } });
}

async function writeMirror(projectId, { config, buffer }) {
  const data = { fetchedAt: new Date(), stale: false };
  if (config) {
    data.rev = config.rev;
    data.config = config;
  }
  if (buffer) data.buffer = buffer;
  await prisma.signalConfigMirror.upsert({ where: { projectId }, create: { projectId, ...data }, update: data });
}

/** site-info.signals (heartbeat / site-info): config kept when its rev is not older than ours; buffer replaced. */
export async function saveSignalsSiteInfo(projectId, info) {
  if (!isObj(info)) return false;
  const config = sanitizeSignalsConfig(info.config);
  const buffer = sanitizeSignalsBuffer(info.buffer);
  const mirror = await loadSignalsMirror(projectId);
  const keepConfig = mirror?.config && Number.isInteger(mirror.rev) && config && config.rev < mirror.rev;
  await writeMirror(projectId, { config: keepConfig ? null : config, buffer });
  return true;
}

export async function pullSignalsConfig(projectId, { conn = null, opts = NO_RETRY } = {}) {
  const c = conn || (await loadEmdashConnection(projectId)).conn;
  const res = await emdashRoutes.signalsConfigGet(c, opts);
  const cfg = sanitizeSignalsConfig(res?.config);
  if (!cfg) return null;
  await writeMirror(projectId, { config: cfg });
  return cfg;
}

let pullTimers = new Map();
export function scheduleSignalsConfigPull(projectId, log, delayMs = 2000) {
  if (pullTimers.has(projectId)) return;
  const t = setTimeout(() => {
    pullTimers.delete(projectId);
    pullSignalsConfig(projectId).catch((err) => log?.warn?.({ projectId, code: err?.code }, 'signals-config-get after a rev gap failed'));
  }, delayMs);
  t.unref?.();
  pullTimers.set(projectId, t);
}
export function _resetSignalsPullTimers() {
  for (const t of pullTimers.values()) clearTimeout(t);
  pullTimers = new Map();
}

/** Apply one dotted change to a mirrored config (pure). */
export function patchSignalsConfig(cfg, { field, to }) {
  if (field.startsWith('events.')) cfg.events = { ...cfg.events, [field.slice(7)]: to };
  else if (field.startsWith('sampling.')) cfg.sampling = { ...cfg.sampling, [field.slice(9)]: to };
  else cfg[field] = to;
}

/** signals.config_changed → mirror (§38.7 mirror rule as §37.6: rev order; a gap → signals-config-get). */
export async function applySignalsConfigChanged(project, ev, { log, schedulePull = scheduleSignalsConfigPull } = {}) {
  const { data, error } = sanitizeSignalsConfigChanged(ev.data);
  if (error) throw Object.assign(new Error(error), { code: 'VALIDATION' });
  const mirror = await loadSignalsMirror(project.id);
  if (!mirror?.config || !Number.isInteger(mirror.rev)) {
    schedulePull(project.id, log);
    return 'applied';
  }
  if (data.rev <= mirror.rev) return 'stale';
  if (data.rev !== mirror.rev + 1) {
    await prisma.signalConfigMirror.update({ where: { projectId: project.id }, data: { stale: true } });
    schedulePull(project.id, log);
    return 'applied';
  }
  const cfg = { ...mirror.config };
  for (const ch of data.changes) patchSignalsConfig(cfg, ch);
  cfg.rev = data.rev;
  cfg.lastChange = { rev: data.rev, at: data.at, source: data.source, by: data.by };
  const upd = await prisma.signalConfigMirror.updateMany({ where: { projectId: project.id, rev: mirror.rev }, data: { rev: data.rev, config: cfg } });
  if (!upd?.count) schedulePull(project.id, log);
  return 'applied';
}

function bad(message) {
  return new CmsBridgeError({ status: 400, code: 'VALIDATION', message });
}

/** OS-side check of a signals-config-set body (the site re-checks each field). */
export function buildSignalsConfigSetBody({ baseRev, changes } = {}, user) {
  if (!Number.isInteger(baseRev) || baseRev < 0) throw bad('baseRev is required');
  if (!isObj(changes)) throw bad('Nothing to save');
  const out = {};
  if (changes.enabled !== undefined) {
    if (typeof changes.enabled !== 'boolean') throw bad('enabled must be true or false');
    out.enabled = changes.enabled;
  }
  if (changes.consentMode !== undefined) {
    if (!SIGNAL_CONSENT_MODES.includes(changes.consentMode)) throw bad('Invalid consent mode');
    out.consentMode = changes.consentMode;
  }
  if (changes.events !== undefined) {
    if (!isObj(changes.events)) throw bad('events must be an object');
    const ev = {};
    for (const k of ['engagement', 'cta_click', 'form_start', 'vitals']) {
      if (changes.events[k] === undefined) continue;
      if (typeof changes.events[k] !== 'boolean') throw bad(`events.${k} must be true or false`);
      ev[k] = changes.events[k];
    }
    if (Object.keys(ev).length) out.events = ev;
  }
  if (changes.sampling !== undefined) {
    if (!isObj(changes.sampling)) throw bad('sampling must be an object');
    const sm = {};
    for (const k of ['pageview', 'engagement']) {
      if (changes.sampling[k] === undefined) continue;
      const v = changes.sampling[k];
      if (typeof v !== 'number' || v < 0.1 || v > 1) throw bad(`sampling.${k} must be between 0.1 and 1`);
      sm[k] = v;
    }
    if (Object.keys(sm).length) out.sampling = sm;
  }
  if (changes.geoDetail !== undefined) {
    if (!SIGNAL_GEO_DETAILS.includes(changes.geoDetail)) throw bad('Invalid geo detail');
    out.geoDetail = changes.geoDetail;
  }
  if (changes.bufferDays !== undefined) {
    if (!Number.isInteger(changes.bufferDays) || changes.bufferDays < 1 || changes.bufferDays > 30) throw bad('bufferDays must be 1–30');
    out.bufferDays = changes.bufferDays;
  }
  if (!Object.keys(out).length) throw bad('Nothing to save');
  return { baseRev, changes: out, actor: osActor(user) };
}

export async function setSignalsConfig(projectId, user, body, { idempotencyKey } = {}) {
  const req = buildSignalsConfigSetBody(body || {}, user);
  const key = actionKey(idempotencyKey);
  const { conn } = await loadEmdashConnection(projectId);
  try {
    const res = await emdashRoutes.signalsConfigSet(conn, req, { ...NO_RETRY, idempotencyKey: key });
    const cfg = sanitizeSignalsConfig(res?.config);
    if (cfg) await writeMirror(projectId, { config: cfg });
    const applied = (Array.isArray(res?.applied) ? res.applied : []).filter((f) => SIGNALS_CONFIG_FIELDS.includes(f));
    const rejected = (Array.isArray(res?.rejected) ? res.rejected : []).slice(0, 20).map((r) => ({
      field: SIGNALS_CONFIG_FIELDS.includes(r?.field) ? r.field : null,
      reason: String(r?.reason || '').slice(0, 32),
      message: safeText(r?.message, 300),
    }));
    return { applied, rejected, replayed: res?.idempotentReplay === true };
  } catch (err) {
    if (err instanceof CmsBridgeError && err.code === 'CONFLICT_REV') {
      const cfg = sanitizeSignalsConfig(err.details?.config);
      if (cfg) await writeMirror(projectId, { config: cfg });
      err.details = { currentRev: cfg?.rev ?? (Number.isInteger(err.details?.currentRev) ? err.details.currentRev : null) };
    }
    throw err;
  }
}

/** Mirror + "last changed by" label for the staff settings card. */
export async function signalsConfigView(projectId) {
  const mirror = await loadSignalsMirror(projectId);
  if (!mirror) return null;
  const cfg = mirror.config && typeof mirror.config === 'object' ? mirror.config : null;
  const names = cfg?.lastChange?.by ? await osUserNames([cfg.lastChange.by]) : new Map();
  return {
    config: cfg ? { ...cfg, lastChange: cfg.lastChange ? { ...cfg.lastChange, byName: actorName(cfg.lastChange.by, cfg.lastChange.source, names) } : null } : null,
    buffer: mirror.buffer || null,
    stale: mirror.stale === true,
    fetchedAt: mirror.fetchedAt,
    managedFromOs: cfg?.lastChange?.source === 'os',
  };
}

/** signals-summary (§38.1) → today's SignalIngestStat.siteSummary. Returns the sanitized summary or null. */
export async function pullSignalsSummary(projectId, { hours = 24, conn = null } = {}) {
  const c = conn || (await loadEmdashConnection(projectId)).conn;
  const res = await emdashRoutes.signalsSummary(c, { hours }, NO_RETRY);
  const summary = sanitizeSignalsSummary(res);
  if (!summary) return null;
  const date = utcDay(new Date());
  await prisma.signalIngestStat.upsert({
    where: { projectId_date: { projectId, date } },
    create: { projectId, date, siteSummary: summary, siteSummaryAt: new Date() },
    update: { siteSummary: summary, siteSummaryAt: new Date() },
  });
  return summary;
}
