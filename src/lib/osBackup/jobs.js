/**
 * Files in OS_BACKUP_DIR (plan c.1): the truth during a restore, when the DB is half-dropped.
 *   backups/  .lwbk + .manifest.json        tmp/  <id>.partial (orphans > 24 h removed)
 *   jobs/<jobId>.json  live job status       maintenance.json  exists = maintenance ON
 *   journal.jsonl  append-only audit (who / what / when, never data)   logs/<jobId>.log  worker output
 * Directory mode 0700, files 0600.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { writeJsonAtomicSync } from './manifest.js';
import { BACKEND_ROOT } from './config.js';

export function layout(dir) {
  return {
    dir,
    backups: path.join(dir, 'backups'),
    tmp: path.join(dir, 'tmp'),
    jobs: path.join(dir, 'jobs'),
    logs: path.join(dir, 'logs'),
    maintenance: path.join(dir, 'maintenance.json'),
    journal: path.join(dir, 'journal.jsonl'),
  };
}

export function ensureDirs(dir) {
  const l = layout(dir);
  for (const d of [l.dir, l.backups, l.tmp, l.jobs, l.logs]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* Windows dev */
    }
  }
  return l;
}

const SAFE_ID = /^[0-9a-f-]{36}$/i;
export function assertJobId(id) {
  if (!SAFE_ID.test(String(id || ''))) {
    const e = new Error('Bad job id');
    e.code = 'BAD_ID';
    e.safe = true;
    throw e;
  }
  return String(id);
}

export function jobFile(dir, jobId) {
  return path.join(layout(dir).jobs, `${assertJobId(jobId)}.json`);
}

export function readJobFile(dir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(dir, jobId), 'utf8'));
  } catch {
    return null;
  }
}

/** Merge `patch` into the job file (atomic tmp + rename). */
export function writeJobFile(dir, jobId, patch) {
  fs.mkdirSync(layout(dir).jobs, { recursive: true, mode: 0o700 });
  const cur = readJobFile(dir, jobId) || { id: jobId };
  const next = { ...cur, ...patch, id: jobId, updatedAt: new Date().toISOString() };
  writeJsonAtomicSync(jobFile(dir, jobId), next);
  return next;
}

const JOURNAL_KEYS = ['event', 'jobId', 'backupId', 'type', 'trigger', 'status', 'phase', 'actorId', 'actorEmail', 'ip', 'error', 'fileName', 'kind', 'paused', 'compat', 'tables', 'rows', 'bytes', 'durationMs', 'safetyBackupId'];

/** Append one audit line. Only whitelisted, data-free fields are kept. */
export function appendJournal(dir, entry) {
  const line = { at: new Date().toISOString() };
  for (const k of JOURNAL_KEYS) if (entry[k] !== undefined && entry[k] !== null) line[k] = typeof entry[k] === 'string' ? entry[k].slice(0, 300) : entry[k];
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(layout(dir).journal, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    /* the journal must never break a job */
  }
}

export function readJournal(dir, limit = 50) {
  try {
    const text = fs.readFileSync(layout(dir).journal, 'utf8');
    return text
      .trim()
      .split('\n')
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

/**
 * Detached worker (plan e.3): own memory budget, survives the request, killed only by a PM2 treekill.
 * Its stdout / stderr go to logs/<jobId>.log (phases, counts and bytes only).
 */
export function spawnWorker(dir, jobId, { execPath = process.execPath, env = process.env } = {}) {
  ensureDirs(dir);
  const logPath = path.join(layout(dir).logs, `${assertJobId(jobId)}.log`);
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(execPath, ['--max-old-space-size=512', WORKER, jobId], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: BACKEND_ROOT,
      env,
      windowsHide: true,
    });
    child.unref();
    return { pid: child.pid };
  } finally {
    fs.closeSync(fd);
  }
}

export function hostName() {
  return os.hostname().slice(0, 100);
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}
