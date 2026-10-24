import { describe, it, expect } from 'vitest';
import { checkDiskSpace, diskView } from '../../../src/lib/osBackup/disk.js';

const MB = 1024 * 1024;

describe('osBackup disk checks', () => {
  it('free space must cover max(2 × last file, OS_BACKUP_MIN_FREE_MB)', () => {
    expect(checkDiskSpace({ freeBytes: 2000 * MB, lastFileBytes: 100 * MB, minFreeMb: 1024 }).ok).toBe(true);
    expect(checkDiskSpace({ freeBytes: 1000 * MB, lastFileBytes: 100 * MB, minFreeMb: 1024 })).toMatchObject({ ok: false, code: 'DISK_LOW', reason: 'free space' });
    expect(checkDiskSpace({ freeBytes: 1500 * MB, lastFileBytes: 800 * MB, minFreeMb: 1024 })).toMatchObject({ ok: false, requiredBytes: 1600 * MB });
  });

  it('the quota check uses OS_BACKUP_QUOTA_MB minus measured usage (statfs cannot see it)', () => {
    expect(checkDiskSpace({ freeBytes: 100_000 * MB, lastFileBytes: 200 * MB, minFreeMb: 0, quotaMb: 10_000, usedBytes: 9_700 * MB })).toMatchObject({ ok: false, reason: 'quota' });
    expect(checkDiskSpace({ freeBytes: 100_000 * MB, lastFileBytes: 200 * MB, minFreeMb: 0, quotaMb: 10_000, usedBytes: 5_000 * MB }).ok).toBe(true);
    expect(checkDiskSpace({ freeBytes: 100_000 * MB, lastFileBytes: 0, minFreeMb: 0, quotaMb: 10, usedBytes: 11 * MB }).ok).toBe(false);
  });

  it('unknown free space (statfs failed) does not block', () => {
    expect(checkDiskSpace({ freeBytes: NaN, lastFileBytes: 10, minFreeMb: 1024 }).ok).toBe(true);
  });

  it('status view projects avg size × 6 per day × retention', () => {
    const v = diskView({ stat: { freeBytes: 5, totalBytes: 10, inodes: null }, usedBytes: 3, readySizes: [10, 20], retentionDays: 7 });
    expect(v).toEqual({ usedBytes: 3, projectedBytes: 15 * 42, freeBytes: 5, totalBytes: 10, inodes: null });
  });
});
