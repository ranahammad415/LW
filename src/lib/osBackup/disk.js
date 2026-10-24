/**
 * Disk checks (plan e.4). statfs on CloudLinux shows the whole volume, not the per-user Hostinger quota, so the quota
 * check only works with OS_BACKUP_QUOTA_MB. Fail fast with DISK_LOW before a backup or a restore's safety backup.
 */
import fs from 'fs';
import path from 'path';

const MB = 1024 * 1024;

/** Pure decision. All sizes in bytes. */
export function checkDiskSpace({ freeBytes, lastFileBytes = 0, minFreeMb = 1024, quotaMb = null, usedBytes = 0, nextFileBytes = null }) {
  const projected = Math.max(Number(nextFileBytes ?? lastFileBytes) || 0, 0);
  const required = Math.max(2 * projected, minFreeMb * MB);
  const res = { ok: true, code: null, requiredBytes: required, freeBytes, quotaRemainingBytes: null };
  if (Number.isFinite(freeBytes) && freeBytes < required) {
    res.ok = false;
    res.code = 'DISK_LOW';
    res.reason = 'free space';
  }
  if (quotaMb) {
    const remaining = quotaMb * MB - (Number(usedBytes) || 0);
    res.quotaRemainingBytes = remaining;
    // The quota must hold two more files of the last size (the new one + a safety backup), and never be at 0.
    if (remaining <= 0 || remaining < 2 * projected) {
      res.ok = false;
      res.code = 'DISK_LOW';
      res.reason = res.reason ? 'free space and quota' : 'quota';
    }
  }
  return res;
}

export async function statDir(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    const bsize = Number(s.bsize) || 4096;
    const files = Number(s.files);
    const ffree = Number(s.ffree);
    return {
      freeBytes: Number(s.bavail) * bsize,
      totalBytes: Number(s.blocks) * bsize,
      inodes: files > 0 && Number.isFinite(ffree) ? { total: files, free: ffree } : null,
    };
  } catch {
    return { freeBytes: NaN, totalBytes: NaN, inodes: null };
  }
}

/** Bytes used by the backup directory (recursive, files only). */
export async function dirUsage(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries = [];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {
          /* raced with a delete */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

/** Status-card view: used, the 7-day projection (avg size × backups kept), free, inodes. */
export function diskView({ stat, usedBytes, readySizes, retentionDays, perDay = 6 }) {
  const avg = readySizes.length ? readySizes.reduce((a, b) => a + b, 0) / readySizes.length : 0;
  return {
    usedBytes,
    projectedBytes: Math.round(avg * perDay * retentionDays),
    freeBytes: Number.isFinite(stat.freeBytes) ? stat.freeBytes : null,
    totalBytes: Number.isFinite(stat.totalBytes) ? stat.totalBytes : null,
    inodes: stat.inodes,
  };
}
