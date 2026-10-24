/** Deferred notification emails are dropped when they fire during maintenance or after a restore (epoch change). */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sendEmail = vi.fn(async () => ({ success: true }));
const prisma = { systemAlert: { findUnique: vi.fn(async () => ({ isRead: false })) }, notificationLog: { update: vi.fn(async () => ({})) } };
vi.mock('../../../src/lib/prisma.js', () => ({ prisma }));
vi.mock('../../../src/lib/mailer.js', () => ({ sendEmail, smtpConfigured: true }));
vi.mock('../../../src/lib/notificationEmailPause.js', () => ({ notificationEmailsPaused: () => false, PAUSED_EMAIL_ERROR: 'paused' }));

const M = await import('../../../src/lib/osBackup/maintenance.js');
const { deferEmail } = await import('../../../src/lib/emailDeferralQueue.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwos-defer-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  M.setMaintenanceDir(dir);
  M.clearMaintenance(dir);
  sendEmail.mockClear();
  prisma.systemAlert.findUnique.mockClear();
  prisma.notificationLog.update.mockClear();
});

const fire = async () => {
  await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 10);
};

describe('email deferral and maintenance', () => {
  it('normal: the deferred email is sent', async () => {
    vi.useFakeTimers();
    deferEmail({ logId: 'l1', alertId: 'a1', to: 'x@y.io', subject: 's', html: 'h' });
    await fire();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('fires during maintenance: dropped without touching the DB', async () => {
    vi.useFakeTimers();
    deferEmail({ logId: 'l2', alertId: 'a2', to: 'x@y.io', subject: 's', html: 'h' });
    M.writeMaintenance(dir, { jobId: 'j', phase: 'RESTORING' });
    await fire();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.systemAlert.findUnique).not.toHaveBeenCalled();
    expect(prisma.notificationLog.update).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('maintenance came and went before it fired (restore epoch changed): dropped', async () => {
    vi.useFakeTimers();
    deferEmail({ logId: 'l3', alertId: 'a3', to: 'x@y.io', subject: 's', html: 'h' });
    M.writeMaintenance(dir, { jobId: 'j', phase: 'RESTORING' });
    await vi.advanceTimersByTimeAsync(1500);
    M.isMaintenance();
    M.clearMaintenance(dir);
    await vi.advanceTimersByTimeAsync(1500);
    M.isMaintenance();
    await fire();
    expect(sendEmail).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
