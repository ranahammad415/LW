/** Pure decisions: schema compat, retention, crash recovery, carry-forward plan, scheduled-run skips. */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareSchema, dbHasAllMigrations, listCodeMigrations } from '../../../src/lib/osBackup/compat.js';
import { planPrune, cleanOrphans } from '../../../src/lib/osBackup/catalog.js';
import { decideRecovery, isStale } from '../../../src/lib/osBackup/recovery.js';
import { buildCarryForwardPlan } from '../../../src/lib/osBackup/securityCarryForward.js';
import { scheduledSkipReason } from '../../../src/lib/osBackup/scheduler.js';
import { nextRunFromCron } from '../../../src/routes/admin/osBackups.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-20T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

describe('schema compatibility', () => {
  it('same / older / newer', () => {
    expect(compareSchema(['a', 'b'], ['a', 'b']).status).toBe('SAME');
    expect(compareSchema(['a'], ['a', 'b'])).toEqual({ status: 'OLDER', missingMigrations: ['b'], unknownMigrations: [] });
    expect(compareSchema(['a', 'b', 'c'], ['a', 'b'])).toMatchObject({ status: 'NEWER', unknownMigrations: ['c'] });
    expect(compareSchema(['a', 'x'], ['a', 'b']).status).toBe('NEWER');
  });
  it('maintenance/clear needs every code migration in the DB', () => {
    expect(dbHasAllMigrations(['a', 'b', 'c'], ['a', 'b']).ok).toBe(true);
    expect(dbHasAllMigrations(['a'], ['a', 'b'])).toEqual({ ok: false, missing: ['b'] });
  });
  it('the shipped migrations include this feature', () => {
    expect(listCodeMigrations()).toContain('20261115_os_backups');
  });
});

describe('retention (prune)', () => {
  const b = (id, days, extra = {}) => ({ id, status: 'READY', kind: 'SCHEDULED', verifyStatus: 'OK', startedAt: ago(days * DAY), fileName: `f-${id}`, ...extra });
  it('the 7-day cut', () => {
    expect(planPrune({ backups: [b('new', 1), b('old', 8), b('older', 9)], now: NOW, retentionDays: 7 }).sort()).toEqual(['old', 'older']);
  });
  it('never the newest READY + verified backup, even past retention', () => {
    expect(planPrune({ backups: [b('a', 8), b('b', 10)], now: NOW, retentionDays: 7 })).toEqual(['b']);
    expect(planPrune({ backups: [b('a', 8, { verifyStatus: 'PENDING' }), b('b', 10)], now: NOW, retentionDays: 7 })).toEqual(['a']);
  });
  it('keeps the newest SAFETY backup until a newer one exists', () => {
    const list = [b('n', 0), b('s1', 20, { kind: 'SAFETY' }), b('s0', 30, { kind: 'SAFETY' })];
    expect(planPrune({ backups: list, now: NOW, retentionDays: 7 })).toEqual(['s0']);
  });
  it('keeps a backup a running job references; ignores non-READY rows', () => {
    const list = [b('n', 0), b('x', 9), b('f', 9, { status: 'FAILED' })];
    expect(planPrune({ backups: list, now: NOW, retentionDays: 7, protectedIds: ['x'] })).toEqual([]);
  });
  it('removes tmp orphans older than 24 h, never an active job file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-ret-'));
    try {
      fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
      for (const n of ['old.partial', 'fresh.partial', 'active-job.partial']) fs.writeFileSync(path.join(dir, 'tmp', n), 'x');
      const past = (Date.now() - 2 * DAY) / 1000;
      fs.utimesSync(path.join(dir, 'tmp', 'old.partial'), past, past);
      fs.utimesSync(path.join(dir, 'tmp', 'active-job.partial'), past, past);
      expect(await cleanOrphans({ dir, activeJobIds: ['active-job'] })).toBe(1);
      expect(fs.readdirSync(path.join(dir, 'tmp')).sort()).toEqual(['active-job.partial', 'fresh.partial']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('crash recovery decisions', () => {
  const t = NOW.getTime();
  const dead = () => false;
  const job = (over) => ({ type: 'RESTORE', status: 'RUNNING', phase: 'RESTORING', heartbeatAt: new Date(t - 3 * 60_000), workerPid: 123, ...over });
  it('fresh heartbeat or live pid: no action', () => {
    expect(decideRecovery({ maintenance: {}, job: job({ heartbeatAt: new Date(t - 30_000) }), now: t, alive: dead }).action).toBe('NONE');
    expect(decideRecovery({ maintenance: {}, job: job(), now: t, alive: () => true }).action).toBe('NONE');
    expect(isStale(job(), t, dead)).toBe(true);
  });
  it('phase ≤ SAFETY_BACKUP: clear maintenance, fail (DB untouched)', () => {
    for (const phase of ['PREFLIGHT', 'MAINTENANCE_ON', 'DRAIN', 'SAFETY_BACKUP']) expect(decideRecovery({ maintenance: {}, job: job({ phase }), now: t, alive: dead }).action).toBe('CLEAR_AND_FAIL');
  });
  it('phase ≥ RESTORING: roll back from the safety backup, or keep maintenance and alert', () => {
    for (const phase of ['RESTORING', 'POST_RESTORE', 'VERIFYING', 'FINALIZING', 'ROLLING_BACK']) {
      expect(decideRecovery({ maintenance: {}, job: job({ phase }), safetyReady: true, now: t, alive: dead }).action).toBe('ROLLBACK');
      expect(decideRecovery({ maintenance: {}, job: job({ phase }), safetyReady: false, now: t, alive: dead }).action).toBe('KEEP_AND_ALERT');
    }
  });
  it('a dead rollback never loops; final states wait or clear', () => {
    expect(decideRecovery({ maintenance: {}, job: job({ type: 'ROLLBACK', phase: 'ROLLING_BACK' }), safetyReady: true, now: t, alive: dead }).action).toBe('KEEP_AND_ALERT');
    expect(decideRecovery({ maintenance: {}, job: job({ status: 'NEEDS_MIGRATION' }), now: t, alive: dead }).action).toBe('NONE');
    expect(decideRecovery({ maintenance: {}, job: job({ status: 'FAILED_ROLLBACK' }), now: t, alive: dead }).action).toBe('NONE');
    expect(decideRecovery({ maintenance: {}, job: job({ status: 'SUCCEEDED' }), now: t, alive: dead }).action).toBe('CLEAR');
    expect(decideRecovery({ maintenance: null, job: job({ type: 'BACKUP', phase: 'DUMP' }), now: t, alive: dead }).action).toBe('FAIL_BACKUP');
    expect(decideRecovery({ maintenance: null, job: null }).action).toBe('NONE');
  });
});

describe('security carry-forward plan', () => {
  const snap = {
    users: [
      { id: 'u1', tokenVersion: 4, passwordHash: '$2b$new', isActive: 1, twoFaSecret: 'S', twoFaEnabled: 1, twoFaBackupCodes: '["a"]' },
      { id: 'u2', tokenVersion: 0, passwordHash: '$2b$x', isActive: 0, twoFaSecret: null, twoFaEnabled: 0, twoFaBackupCodes: null },
    ],
    revokedApiTokens: [{ id: 't1', revokedAt: '2026-11-19 10:00:00.000', revokedById: 'u1' }],
  };
  it('bumps everyone, keeps current passwords and 2FA, keeps deactivations, re-applies revocations', () => {
    const plan = buildCarryForwardPlan(snap, { hasMcpGrant: true, hasMcpToken: false });
    const sqls = plan.map((s) => s.sql);
    expect(plan[0]).toEqual({ sql: 'UPDATE `user` SET `tokenVersion` = `tokenVersion` + 1 WHERE `id` NOT IN (?,?)', params: ['u1', 'u2'] });
    const u1 = plan.find((s) => s.sql.includes('GREATEST') && s.params.at(-1) === 'u1');
    expect(u1.sql).toContain('`tokenVersion` = GREATEST(`tokenVersion`, ?) + 1');
    expect(u1.sql).toContain('`isActive` = (`isActive` AND ?)');
    expect(u1.params).toEqual([4, 1, '$2b$new', 'S', 1, '["a"]', 'u1']);
    expect(plan.find((s) => s.sql.includes('GREATEST') && s.params.at(-1) === 'u2').params.slice(0, 2)).toEqual([0, 0]);
    expect(plan.find((s) => s.params.includes('t1')).sql).toContain('WHERE `id` = ? AND `revokedAt` IS NULL');
    expect(sqls.some((s) => s.includes('a.`userTokenVersion` = u.`tokenVersion`'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('UPDATE `mcpgrant`'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('UPDATE `mcptoken`'))).toBe(false);
  });
  it('carryForwardCredentials=false restores the old password / 2FA but still bumps sessions', () => {
    const u1 = buildCarryForwardPlan(snap, { carryForwardCredentials: false }).find((s) => s.params.at(-1) === 'u1');
    expect(u1.sql).not.toContain('passwordHash');
    expect(u1.params).toEqual([4, 1, 'u1']);
  });
  it('rollback mode: only bump sessions and sync tokens', () => {
    const plan = buildCarryForwardPlan(null, { mode: 'rollback', hasMcpGrant: false, hasMcpToken: false });
    expect(plan.map((s) => s.sql)).toEqual(['UPDATE `user` SET `tokenVersion` = `tokenVersion` + 1', 'UPDATE `apitoken` a JOIN `user` u ON u.`id` = a.`userId` SET a.`userTokenVersion` = u.`tokenVersion` WHERE a.`revokedAt` IS NULL']);
  });
});

describe('scheduled run skips', () => {
  it('paused, maintenance, lock held, < 30 min since the last start', () => {
    const now = NOW;
    expect(scheduledSkipReason({ state: { schedulePaused: true }, now })).toBe('paused');
    expect(scheduledSkipReason({ state: {}, maintenance: true, now })).toBe('maintenance');
    expect(scheduledSkipReason({ state: { lockJobId: 'j', heartbeatAt: ago(60_000) }, now })).toBe('locked');
    expect(scheduledSkipReason({ state: {}, lastStartedAt: ago(10 * 60_000), now })).toBe('recent');
    expect(scheduledSkipReason({ state: { lockJobId: 'j', heartbeatAt: ago(20 * 60_000) }, lastStartedAt: ago(4 * 3_600_000), now })).toBeNull();
  });
  it('next run of the default cron', () => {
    const now = new Date(2026, 10, 20, 9, 0, 0);
    expect(nextRunFromCron('50 0,4,8,12,16,20 * * *', now)).toEqual(new Date(2026, 10, 20, 12, 50, 0));
    expect(nextRunFromCron('50 0,4,8,12,16,20 * * *', new Date(2026, 10, 20, 21, 0, 0))).toEqual(new Date(2026, 10, 21, 0, 50, 0));
    expect(nextRunFromCron('0 0 1 * *', now)).toBeNull();
  });
});
