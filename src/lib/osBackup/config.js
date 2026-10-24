/**
 * OS Backups configuration (docs/ledger/features/os-backups.md, env-vars.md "OS Backups").
 * Pure: everything is derived from an env object, so tests pass their own. An invalid encryption key never exits the
 * app: it disables the feature and the reason is shown on the status card.
 */
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/backend (the deployed ~/LW). */
export const BACKEND_ROOT = path.resolve(here, '..', '..', '..');
export const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');

/** Our own tables: never dumped, never dropped, no FKs (they must survive a restore untouched). */
export const PRESERVED_TABLES = Object.freeze(['osbackup', 'osbackupjob', 'osbackupchallenge', 'osbackupstate']);
/** Emptied after every restore (a restored reset link or MCP auth request must not come back to life). */
export const PURGE_AFTER_RESTORE = Object.freeze(['password_reset_token', 'mcpauthrequest', 'mcpconfirmation']);

export const PAYLOAD_FORMAT = 'lwos-jsonl/1';
export const MANIFEST_FORMAT = 'lwos-backup/1';
export const DEFAULT_CRON = '50 0,4,8,12,16,20 * * *';
export const KINDS = Object.freeze({ SCHEDULED: 'sched', MANUAL: 'manual', SAFETY: 'safety' });

const truthy = (v, dflt) => {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};
const int = (v, dflt, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/** base64 of exactly 32 bytes, else { error }. */
export function parseKey(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { key: null, error: 'missing' };
  const s = String(raw).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return { key: null, error: 'not base64' };
  const key = Buffer.from(s, 'base64');
  if (key.length !== 32) return { key: null, error: `decodes to ${key.length} bytes, need 32` };
  return { key, error: null };
}

export function loadConfig(env = process.env) {
  const master = parseKey(env.OS_BACKUP_ENCRYPTION_KEY);
  const previous = parseKey(env.OS_BACKUP_ENCRYPTION_KEY_PREVIOUS);
  const dir = path.resolve(env.OS_BACKUP_DIR && String(env.OS_BACKUP_DIR).trim() ? String(env.OS_BACKUP_DIR).trim() : path.join(os.homedir(), 'os-backups'));
  const engineRequested = String(env.OS_BACKUP_ENGINE || 'node').trim().toLowerCase();
  const exclude = String(env.OS_BACKUP_EXCLUDE_DATA_TABLES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => !PRESERVED_TABLES.includes(t));
  const rel = path.relative(BACKEND_ROOT, dir);
  const insideApp = !rel.startsWith('..') && !path.isAbsolute(rel);
  return {
    enabled: truthy(env.OS_BACKUP_ENABLED, false),
    master: master.key,
    keyError: master.error,
    previous: previous.key,
    keyOk: !!master.key,
    dir,
    dirInsideApp: insideApp,
    cron: String(env.OS_BACKUP_CRON || '').trim() || DEFAULT_CRON,
    retentionDays: int(env.OS_BACKUP_RETENTION_DAYS, 7, 1, 365),
    // P7 (mysqldump engine) is not built: every value runs the Node engine; the requested value is reported.
    engine: 'node',
    engineRequested,
    mysqldumpPath: String(env.OS_BACKUP_MYSQLDUMP_PATH || '').trim() || 'mysqldump',
    mysqlPath: String(env.OS_BACKUP_MYSQL_PATH || '').trim() || 'mysql',
    maxMinutes: int(env.OS_BACKUP_MAX_MINUTES, 30, 1, 24 * 60),
    minFreeMb: int(env.OS_BACKUP_MIN_FREE_MB, 1024, 0),
    quotaMb: env.OS_BACKUP_QUOTA_MB ? int(env.OS_BACKUP_QUOTA_MB, 0, 0) || null : null,
    pageRows: int(env.OS_BACKUP_PAGE_ROWS, 2000, 10, 100_000),
    pageDelayMs: int(env.OS_BACKUP_PAGE_DELAY_MS, 5, 0, 10_000),
    recycleWorkers: truthy(env.OS_RESTORE_RECYCLE_WORKERS, true),
    excludeDataTables: exclude,
    staleHours: 9,
    databaseUrl: env.DATABASE_URL || '',
  };
}

/** Keys a file may be decrypted with (current first, then the rotation key). */
export function decryptKeys(cfg) {
  return [cfg.master, cfg.previous].filter(Boolean);
}

/** Feature usable for writes: enabled flag + valid key + a directory outside the app. */
export function featureProblem(cfg, { requireEnabled = true } = {}) {
  if (requireEnabled && !cfg.enabled) return 'OS_BACKUP_ENABLED is not true';
  if (!cfg.keyOk) return `OS_BACKUP_ENCRYPTION_KEY is invalid (${cfg.keyError})`;
  if (cfg.dirInsideApp) return 'OS_BACKUP_DIR must be outside the app directory';
  return null;
}
