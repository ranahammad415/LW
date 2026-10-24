/**
 * Maintenance mode (plan f.1 / f.3). The truth is the file OS_BACKUP_DIR/maintenance.json, never the DB (it is
 * half-dropped during a restore). Every instance checks it at most once a second (statSync, cached by mtime) and fails
 * OPEN when the file or the directory is missing.
 *
 * maintenanceGate (onRequest, registered right after @fastify/cors so 503s keep the CORS headers) answers
 * 503 { code: 'MAINTENANCE' } with Retry-After: 120 and Cache-Control: no-store, except:
 *   OPTIONS *, GET /health (503 { status: 'maintenance' }, no DB), the restore status route (watch token),
 *   POST /api/admin/os-backups/maintenance/clear, and POST /api/auth/login only while phase = NEEDS_MIGRATION.
 * When the file disappears (or its epoch changes) every instance runs the onMaintenanceEnded handlers (cache resets)
 * and, with OS_RESTORE_RECYCLE_WORKERS=true under PM2, exits after NODE_APP_INSTANCE × 3 s so PM2 restarts it clean.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { writeJsonAtomicSync } from './manifest.js';

let dirOverride = null;
const resolveDir = () => dirOverride || path.resolve(process.env.OS_BACKUP_DIR && process.env.OS_BACKUP_DIR.trim() ? process.env.OS_BACKUP_DIR.trim() : path.join(os.homedir(), 'os-backups'));
export const maintenanceFile = (dir = resolveDir()) => path.join(dir, 'maintenance.json');

/** Tests / CLI: point the module at another directory. */
export function setMaintenanceDir(dir) {
  dirOverride = dir;
  cache = { at: 0, mtimeMs: -1, info: null };
}

let cache = { at: 0, mtimeMs: -1, info: null };
let generation = 0; // bumps on every on → off / epoch change (deferred emails compare it)
let lastEpoch = null;
const endedHandlers = [];

export function readMaintenance(dir = resolveDir()) {
  try {
    return JSON.parse(fs.readFileSync(maintenanceFile(dir), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    // Present but unreadable (should not happen: written atomically) = maintenance on.
    return fs.existsSync(maintenanceFile(dir)) ? { phase: 'UNKNOWN', retryAfter: 120 } : null;
  }
}

function refresh(now) {
  let info = null;
  let mtimeMs = -1;
  try {
    const st = fs.statSync(maintenanceFile());
    mtimeMs = st.mtimeMs;
    info = mtimeMs === cache.mtimeMs && cache.info ? cache.info : readMaintenance() || { phase: 'UNKNOWN', retryAfter: 120 };
  } catch {
    info = null; // missing file or directory: fail open
  }
  const prevEpoch = lastEpoch;
  const nextEpoch = info ? info.epoch || 'unknown' : null;
  cache = { at: now, mtimeMs, info };
  if (prevEpoch !== nextEpoch) {
    generation += 1;
    lastEpoch = nextEpoch;
    // Maintenance ended (file gone) or a new maintenance replaced the one this process saw.
    if (prevEpoch !== null) runEnded(prevEpoch, nextEpoch);
  }
}

function runEnded(prevEpoch, nextEpoch) {
  for (const h of endedHandlers) {
    try {
      h({ prevEpoch, nextEpoch });
    } catch {
      /* a cache reset must never break a request */
    }
  }
}

/** True while maintenance.json exists. At most one statSync per second per process. */
export function isMaintenance(now = Date.now()) {
  if (now - cache.at >= 1000) refresh(now);
  return !!cache.info;
}

export function maintenanceInfo(now = Date.now()) {
  isMaintenance(now);
  return cache.info;
}

/** Changes whenever maintenance starts or ends: deferred work scheduled under another generation is dropped. */
export function maintenanceGeneration(now = Date.now()) {
  isMaintenance(now);
  return generation;
}

export function onMaintenanceEnded(fn) {
  endedHandlers.push(fn);
}

export function writeMaintenance(dir, info) {
  const body = { retryAfter: 300, epoch: crypto.randomUUID(), ...info, updatedAt: new Date().toISOString() };
  writeJsonAtomicSync(maintenanceFile(dir), body);
  cache.at = 0;
  return body;
}

export function updateMaintenancePhase(dir, phase, extra = {}) {
  const cur = readMaintenance(dir);
  if (!cur) return null;
  return writeMaintenance(dir, { ...cur, ...extra, phase });
}

export function clearMaintenance(dir) {
  try {
    fs.unlinkSync(maintenanceFile(dir));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  cache.at = 0;
}

const STATUS_RE = /^\/api\/admin\/os-backups\/restore\/[^/]+\/status$/;
const RETRY_AFTER = 120;

/** Pure: should this request pass during maintenance? */
export function isExempt(method, url, info) {
  const p = String(url || '').split('?')[0];
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && STATUS_RE.test(p)) return true;
  if (method === 'POST' && p === '/api/admin/os-backups/maintenance/clear') return true;
  if (method === 'POST' && p === '/api/auth/login' && info?.phase === 'NEEDS_MIGRATION') return true;
  return false;
}

export async function maintenanceGate(request, reply) {
  if (!isMaintenance()) return;
  const info = cache.info || {};
  const p = String(request.url || '').split('?')[0];
  if (request.method === 'GET' && p === '/health') {
    return reply.code(503).header('Cache-Control', 'no-store').header('Retry-After', String(RETRY_AFTER)).send({ status: 'maintenance', timestamp: new Date().toISOString() });
  }
  if (isExempt(request.method, request.url, info)) return;
  return reply
    .code(503)
    .header('Retry-After', String(RETRY_AFTER))
    .header('Cache-Control', 'no-store')
    .send({
      code: 'MAINTENANCE',
      message: info.phase === 'NEEDS_MIGRATION' ? 'Agency OS was restored and is waiting for a database migration.' : 'Agency OS is being restored. It will be back in a few minutes.',
      retryAfter: RETRY_AFTER,
      startedAt: info.startedAt || null,
      phase: info.phase || null,
    });
}

/**
 * Per-instance watcher: notices the end of maintenance even with no traffic, then (PM2 only, opt-out) recycles the
 * worker so in-memory state from before the restore (rate counters, tokens, deferred emails, SSE) is gone.
 */
export function startMaintenanceWatcher(log, { env = process.env, exit = (c) => process.exit(c) } = {}) {
  const recycle = String(env.OS_RESTORE_RECYCLE_WORKERS ?? 'true').toLowerCase() !== 'false';
  onMaintenanceEnded(({ prevEpoch, nextEpoch }) => {
    log?.info?.({ epoch: prevEpoch }, 'OS maintenance ended: caches reset');
    if (recycle && nextEpoch === null && env.pm_id !== undefined) {
      const delay = (Number(env.NODE_APP_INSTANCE) || 0) * 3000 + 2000;
      log?.info?.({ delay }, 'Recycling this PM2 worker after the restore');
      setTimeout(() => exit(0), delay).unref?.();
    }
  });
  const t = setInterval(() => isMaintenance(), 1000);
  t.unref?.();
  return t;
}
