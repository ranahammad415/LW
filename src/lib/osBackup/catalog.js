/**
 * Catalog (osbackup rows ↔ files on disk) and retention (plan e.5).
 * Retention: READY backups older than OS_BACKUP_RETENTION_DAYS are pruned, except the newest READY + verified backup,
 * the newest SAFETY backup (kept until a newer one exists) and any backup a QUEUED / RUNNING job references.
 * Order: file, then manifest, then the row → PRUNED. Rows (PRUNED / FAILED / MISSING) older than 90 days are deleted.
 */
import fs from 'fs';
import path from 'path';
import { layout } from './jobs.js';
import { isBackupFileName, manifestNameFor, readManifest, verifyManifestHmac } from './manifest.js';
import { rowFromManifest } from './backup.js';
import * as store from './store.js';

const DAY = 86_400_000;

/** Pure: ids of the backups to prune. */
export function planPrune({ backups, now = new Date(), retentionDays = 7, protectedIds = [] }) {
  const ready = backups.filter((b) => b.status === 'READY').sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const keep = new Set(protectedIds.filter(Boolean));
  const newestVerified = ready.find((b) => b.verifyStatus === 'OK');
  if (newestVerified) keep.add(newestVerified.id);
  const newestSafety = ready.find((b) => b.kind === 'SAFETY');
  if (newestSafety) keep.add(newestSafety.id);
  const cutoff = now.getTime() - retentionDays * DAY;
  return ready.filter((b) => new Date(b.startedAt).getTime() < cutoff && !keep.has(b.id)).map((b) => b.id);
}

export async function applyPrune({ db, dir, ids, backups, now = new Date() }) {
  const l = layout(dir);
  const byId = new Map(backups.map((b) => [b.id, b]));
  let pruned = 0;
  for (const id of ids) {
    const b = byId.get(id);
    if (!b || !isBackupFileName(b.fileName)) continue;
    await fs.promises.unlink(path.join(l.backups, b.fileName)).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    await fs.promises.unlink(path.join(l.backups, manifestNameFor(b.fileName))).catch(() => {});
    await store.updateBackup(db, id, { status: 'PRUNED', prunedAt: now });
    pruned += 1;
  }
  return pruned;
}

/** tmp/ orphans older than 24 h (partials of dead workers, CLI scratch) and job / log files older than 30 days. */
export async function cleanOrphans({ dir, now = Date.now(), activeJobIds = [] }) {
  const l = layout(dir);
  let removed = 0;
  const sweep = async (d, maxAgeMs, skip = () => false) => {
    let names = [];
    try {
      names = await fs.promises.readdir(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (skip(n)) continue;
      const p = path.join(d, n);
      try {
        const st = await fs.promises.stat(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(p);
          removed += 1;
        }
      } catch {
        /* raced */
      }
    }
  };
  const active = (n) => activeJobIds.some((id) => n.startsWith(id));
  await sweep(l.tmp, DAY, active);
  await sweep(l.jobs, 30 * DAY, active);
  await sweep(l.logs, 30 * DAY, active);
  return removed;
}

/**
 * disk ↔ rows: a READY row whose file is gone becomes MISSING; a signed manifest on disk without a row (e.g. written by
 * the CLI without the tables) gets a READY row. Manifests that fail their HMAC are ignored (and reported).
 */
export async function reconcile({ db, dir, keys }) {
  const l = layout(dir);
  const rows = await store.listBackups(db, { includePruned: true, limit: 1000 });
  const byFile = new Map(rows.map((r) => [r.fileName, r]));
  let names = [];
  try {
    names = await fs.promises.readdir(l.backups);
  } catch {
    names = [];
  }
  const files = new Set(names.filter(isBackupFileName));
  const out = { missing: 0, added: 0, badManifest: 0 };
  for (const r of rows) {
    if (r.status === 'READY' && !files.has(r.fileName)) {
      await store.updateBackup(db, r.id, { status: 'MISSING', error: 'File not found on disk' });
      out.missing += 1;
    }
  }
  for (const f of files) {
    const row = byFile.get(f);
    if (row && row.status !== 'MISSING') continue;
    let m;
    try {
      m = await readManifest(path.join(l.backups, manifestNameFor(f)));
    } catch {
      out.badManifest += 1;
      continue;
    }
    if (!verifyManifestHmac(m, keys) || m.fileName !== f) {
      out.badManifest += 1;
      continue;
    }
    if (row) await store.updateBackup(db, row.id, rowFromManifest(m, { status: 'READY', error: null }));
    else await store.insertBackup(db, { id: m.id, ...rowFromManifest(m, { status: 'READY' }) });
    out.added += 1;
  }
  return out;
}

/** Retention run: prune + old-row cleanup + orphans. */
export async function runRetention({ db, cfg, now = new Date() }) {
  const backups = await store.listBackups(db, { includePruned: false, limit: 1000 });
  const jobs = await store.activeJobs(db);
  const protectedIds = jobs.flatMap((j) => [j.backupId, j.safetyBackupId]);
  const ids = planPrune({ backups, now, retentionDays: cfg.retentionDays, protectedIds });
  const pruned = await applyPrune({ db, dir: cfg.dir, ids, backups, now });
  const before = new Date(now.getTime() - 90 * DAY);
  await store.deleteOldBackupRows(db, before);
  await store.deleteOldJobRows(db, before);
  await store.purgeOldChallenges(db, new Date(now.getTime() - 30 * DAY));
  const orphans = await cleanOrphans({ dir: cfg.dir, now: now.getTime(), activeJobIds: jobs.map((j) => j.id) });
  return { pruned, orphans };
}
