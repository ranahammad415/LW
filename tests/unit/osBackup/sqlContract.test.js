/** The CAS predicates of store.js (the logic around them is tested with memStore; the round trip runs them on MySQL). */
import { describe, it, expect } from 'vitest';
import * as store from '../../../src/lib/osBackup/store.js';
import { acquireLock, releaseLock, lockHeld, tryLockOnLeader } from '../../../src/lib/osBackup/lock.js';

function capture(affected = 1, rows = [{ id: 1 }]) {
  const calls = [];
  return { calls, q: async (sql, p) => (calls.push({ sql, p }), rows), x: async (sql, p) => (calls.push({ sql, p }), affected) };
}
const flat = (s) => s.replace(/\s+/g, ' ');

describe('osBackup store SQL contract', () => {
  it('lock CAS: free, own, or heartbeat older than 10 minutes; UTC times', async () => {
    const db = capture(1);
    expect(await acquireLock(db, 'job-1')).toBe(true);
    const sql = flat(db.calls.find((c) => c.sql.startsWith('UPDATE')).sql);
    expect(sql).toContain('WHERE `id` = 1 AND (`lockJobId` IS NULL OR `lockJobId` = ? OR `heartbeatAt` IS NULL OR `heartbeatAt` < UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE)');
    expect(sql).not.toContain('NOW(');
    const busy = capture(0);
    expect(await acquireLock(busy, 'job-2')).toBe(false);
  });

  it('release only clears our own lock', async () => {
    const db = capture(1);
    await releaseLock(db, 'job-1');
    expect(flat(db.calls[0].sql)).toContain('WHERE `id` = 1 AND `lockJobId` = ?');
    expect(db.calls[0].p).toEqual(['job-1']);
  });

  it('lockHeld: a holder with a fresh heartbeat; stale = free', () => {
    const now = new Date('2026-11-15T10:00:00Z');
    expect(lockHeld({ lockJobId: 'j', heartbeatAt: new Date(now - 60_000) }, now)).toBe(true);
    expect(lockHeld({ lockJobId: 'j', heartbeatAt: new Date(now - 11 * 60_000) }, now)).toBe(false);
    expect(lockHeld({ lockJobId: null }, now)).toBe(false);
  });

  it('a non-leader never touches the lock', async () => {
    const db = capture(1);
    expect(await tryLockOnLeader({ leader: () => false, db, jobId: 'j' })).toEqual({ skipped: 'not-leader' });
    expect(db.calls).toHaveLength(0);
    expect(await tryLockOnLeader({ leader: () => true, db, jobId: 'j' })).toEqual({ acquired: true });
  });

  it('OTP attempt bump is bound and capped in one statement', async () => {
    const db = capture(1);
    const now = new Date();
    await store.bumpChallengeAttempt(db, { id: 'c', userId: 'u', action: 'RESTORE', backupId: 'b', now, maxAttempts: 5 });
    const { sql, p } = db.calls[0];
    expect(flat(sql)).toBe('UPDATE `osbackupchallenge` SET `attempts` = `attempts` + 1 WHERE `id` = ? AND `userId` = ? AND `action` = ? AND `backupId` = ? AND `consumedAt` IS NULL AND `invalidatedAt` IS NULL AND `expiresAt` > ? AND `attempts` < ?');
    expect(p).toEqual(['c', 'u', 'RESTORE', 'b', now, 5]);
  });

  it('download ticket is consumed only while valid', async () => {
    const db = capture(1);
    const now = new Date();
    await store.consumeTicket(db, 'h', now);
    expect(flat(db.calls[0].sql)).toContain("SET `downloadTicketHash` = NULL WHERE `downloadTicketHash` = ? AND `action` = 'DOWNLOAD' AND `ticketExpiresAt` > ?");
  });

  it('updates whitelist their columns and stringify JSON', async () => {
    const db = capture(1);
    await store.updateJob(db, 'j', { progress: { a: 1 }, status: 'RUNNING' });
    expect(db.calls[0].p).toEqual(['{"a":1}', 'RUNNING', 'j']);
    await expect(store.updateJob(db, 'j', { 'id = 1; --': 1 })).rejects.toThrow(/Unknown column/);
  });
});
