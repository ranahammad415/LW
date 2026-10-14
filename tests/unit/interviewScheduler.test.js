import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  inviteFindMany: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteUpdateMany: vi.fn(),
  inviteUpdate: vi.fn(),
  sessionFindMany: vi.fn(),
  sessionUpdateMany: vi.fn(),
  sessionUpdate: vi.fn(),
  draftCount: vi.fn(),
  draftFindMany: vi.fn(),
  clientFindUnique: vi.fn(),
  dispatchInvite: vi.fn(),
  logDispatch: vi.fn(),
  sendEmail: vi.fn(),
  consolidateSession: vi.fn(),
  cancelDelegation: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    knowledgeInterviewInvite: { findMany: m.inviteFindMany, findUnique: m.inviteFindUnique, updateMany: m.inviteUpdateMany, update: m.inviteUpdate },
    voiceInterviewSession: { findMany: m.sessionFindMany, updateMany: m.sessionUpdateMany, update: m.sessionUpdate },
    okfDraftChange: { count: m.draftCount, findMany: m.draftFindMany },
    clientAccount: { findUnique: m.clientFindUnique },
    agencySetting: { findFirst: vi.fn().mockResolvedValue({ agencyName: 'Acme' }) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../../src/lib/interviewInvites.js', async (orig) => ({
  ...(await orig()),
  dispatchInvite: m.dispatchInvite,
  logDispatch: m.logDispatch,
  staffRecipientIds: vi.fn().mockResolvedValue(['pm1']),
}));
vi.mock('../../src/lib/mailer.js', () => ({ sendEmail: m.sendEmail }));
vi.mock('../../src/lib/interviewConsolidation.js', () => ({ consolidateSession: m.consolidateSession }));
vi.mock('../../src/lib/interviewDelegation.js', () => ({ cancelDelegation: m.cancelDelegation }));
vi.mock('../../src/lib/notificationService.js', () => ({ notify: m.notify }));

import {
  isLeader,
  dueReminderIndex,
  reapBilledSeconds,
  treeIsSettled,
  sendScheduledInvites,
  sendReminders,
  reapStaleSessions,
  runConsolidation,
  finalizeRootInvites,
  cancelUnconfirmedDelegations,
  runInterviewSchedulerTick,
  isSessionStale,
} from '../../src/lib/interviewScheduler.js';

const NOW = new Date('2026-10-15T09:00:00Z');
const DAY = 864e5;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERVIEW_TOKEN_SECRET = 'test-secret-test-secret-test-secret';
  delete process.env.NOTIFICATION_EMAILS_PAUSED;
  m.inviteUpdate.mockResolvedValue({});
  m.sessionUpdate.mockResolvedValue({});
  m.clientFindUnique.mockResolvedValue({ agencyName: 'Al-Noor Motors' });
  m.notify.mockResolvedValue(undefined);
});

describe('pure helpers', () => {
  it('leader election uses NODE_APP_INSTANCE', () => {
    expect(isLeader({})).toBe(true);
    expect(isLeader({ NODE_APP_INSTANCE: '0' })).toBe(true);
    expect(isLeader({ NODE_APP_INSTANCE: '1' })).toBe(false);
  });

  it('reminder schedule math', () => {
    const inv = { sentAt: new Date(NOW.getTime() - 3.5 * DAY), reminderDays: [3, 7], reminderCount: 0, expiresAt: new Date(NOW.getTime() + 10 * DAY) };
    expect(dueReminderIndex(inv, NOW)).toBe(0);
    expect(dueReminderIndex({ ...inv, reminderCount: 1 }, NOW)).toBe(-1);
    expect(dueReminderIndex({ ...inv, reminderCount: 2 }, NOW)).toBe(-1);
    // never remind inside the last 24 h
    expect(dueReminderIndex({ ...inv, expiresAt: new Date(NOW.getTime() + 12 * 3600e3) }, NOW)).toBe(-1);
    expect(dueReminderIndex({ ...inv, sentAt: null }, NOW)).toBe(-1);
  });

  it('reaper bills heartbeat span + grace, wall-clock when no heartbeat (H1), never text', () => {
    const started = new Date(NOW.getTime() - 30 * 60e3);
    expect(reapBilledSeconds({ mode: 'VOICE', startedAt: started, lastHeartbeatAt: new Date(started.getTime() + 300e3) }, NOW)).toBe(330);
    // never heartbeated → full wall clock, capped at the session max
    expect(reapBilledSeconds({ mode: 'VOICE', startedAt: started, lastHeartbeatAt: null }, NOW)).toBe(900);
    expect(reapBilledSeconds({ mode: 'VOICE', startedAt: new Date(NOW.getTime() - 120e3), lastHeartbeatAt: null }, NOW)).toBe(120);
    expect(reapBilledSeconds({ mode: 'TEXT', startedAt: started }, NOW)).toBe(0);
  });

  it('isSessionStale: voice without heartbeat waits for the full max + 5 min', () => {
    expect(isSessionStale({ mode: 'VOICE', startedAt: new Date(NOW.getTime() - 10 * 60e3), lastHeartbeatAt: null }, NOW)).toBe(false);
    expect(isSessionStale({ mode: 'VOICE', startedAt: new Date(NOW.getTime() - 21 * 60e3), lastHeartbeatAt: null }, NOW)).toBe(true);
    expect(isSessionStale({ mode: 'VOICE', startedAt: new Date(NOW.getTime() - 5 * 60e3), lastHeartbeatAt: new Date(NOW.getTime() - 11 * 60e3) }, NOW)).toBe(true);
  });

  it('a tree is settled only when root, children and sessions are done', () => {
    const root = { status: 'COMPLETED' };
    expect(treeIsSettled({ root, children: [], sessions: [] })).toBe(true);
    expect(treeIsSettled({ root, children: [{ status: 'SENT' }], sessions: [] })).toBe(false);
    expect(treeIsSettled({ root, children: [{ status: 'EXPIRED' }], sessions: [{ status: 'COMPLETED', consolidationStatus: 'PENDING' }] })).toBe(false);
    expect(treeIsSettled({ root: { status: 'IN_PROGRESS' }, children: [], sessions: [] })).toBe(false);
  });
});

describe('CAS claims', () => {
  it('sends a scheduled invite only when this instance wins the claim', async () => {
    m.inviteFindMany.mockImplementation(async ({ where }) => (where.status === 'SCHEDULED' ? [{ id: 'a' }, { id: 'b' }] : []));
    m.inviteUpdateMany.mockImplementation(async ({ where }) => ({ count: where.id === 'a' ? 1 : 0 }));
    m.inviteFindUnique.mockResolvedValue({ id: 'a', status: 'SCHEDULED' });
    m.dispatchInvite.mockResolvedValue({ ok: true });
    const res = await sendScheduledInvites({ now: NOW, instance: 'i1' });
    expect(res).toEqual({ sent: 1, failed: 0 });
    expect(m.dispatchInvite).toHaveBeenCalledTimes(1);
    const claim = m.inviteUpdateMany.mock.calls[0][0];
    expect(claim.where.status).toBe('SCHEDULED');
    expect(claim.where.OR).toBeDefined();
  });

  it('two concurrent reminder ticks send exactly one email per step', async () => {
    const inv = { id: 'r', sentAt: new Date(NOW.getTime() - 4 * DAY), reminderDays: [3, 7], reminderCount: 0, expiresAt: new Date(NOW.getTime() + 10 * DAY), status: 'SENT' };
    m.inviteFindMany.mockResolvedValue([inv]);
    let claimed = false;
    m.inviteUpdateMany.mockImplementation(async ({ where }) => {
      if (where.reminderCount === 0 && !claimed) {
        claimed = true;
        return { count: 1 };
      }
      return { count: 0 };
    });
    m.dispatchInvite.mockResolvedValue({ ok: true });
    m.inviteFindUnique.mockResolvedValue({ ...inv, tokenNonce: 'fresh-nonce' });
    await Promise.all([sendReminders({ now: NOW, instance: 'a' }), sendReminders({ now: NOW, instance: 'b' })]);
    expect(m.dispatchInvite).toHaveBeenCalledTimes(1);
    expect(m.dispatchInvite.mock.calls[0][1].kind).toBe('REMINDER');
    // re-read after the claim: the fresh row (rotated link) is what gets sent
    expect(m.dispatchInvite.mock.calls[0][0].tokenNonce).toBe('fresh-nonce');
  });

  it('reminders are not consumed while emails are paused', async () => {
    process.env.NOTIFICATION_EMAILS_PAUSED = 'true';
    const res = await sendReminders({ now: NOW, instance: 'a' });
    expect(res.paused).toBe(true);
    expect(m.inviteUpdateMany).not.toHaveBeenCalled();
  });

  it('retries landing-page delegations created while emails were paused', async () => {
    m.inviteFindMany.mockImplementation(async ({ where }) => (where.respondentRole === 'STAFF' ? [{ id: 'kid', status: 'PENDING' }] : []));
    m.inviteUpdateMany.mockResolvedValue({ count: 1 });
    m.dispatchInvite.mockResolvedValue({ ok: true });
    const res = await sendScheduledInvites({ now: NOW, instance: 'i' });
    expect(res.sent).toBe(1);
    expect(m.dispatchInvite.mock.calls[0][0].id).toBe('kid');
  });

  it('scheduled sends wait while notification emails are paused', async () => {
    process.env.NOTIFICATION_EMAILS_PAUSED = 'true';
    m.inviteFindMany.mockResolvedValue([{ id: 'a' }]);
    const res = await sendScheduledInvites({ now: NOW, instance: 'i' });
    expect(res.paused).toBe(1);
    expect(m.dispatchInvite).not.toHaveBeenCalled();
  });
});

describe('sessions', () => {
  it('reaps stale voice sessions, bills them and queues consolidation when drafts exist', async () => {
    m.sessionFindMany.mockResolvedValue([
      { id: 's1', mode: 'VOICE', inviteId: 'inv', startedAt: new Date(NOW.getTime() - 20 * 60e3), lastHeartbeatAt: new Date(NOW.getTime() - 15 * 60e3) },
      { id: 's2', mode: 'VOICE', inviteId: null, startedAt: new Date(NOW.getTime() - 5 * 60e3), lastHeartbeatAt: null },
    ]);
    m.draftCount.mockResolvedValue(2);
    m.sessionUpdateMany.mockResolvedValue({ count: 1 });
    const res = await reapStaleSessions({ now: NOW, instance: 'i' });
    expect(res.reaped).toBe(1);
    const data = m.sessionUpdateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'ABANDONED', durationSeconds: 330, consolidationStatus: 'PENDING' });
    expect(m.inviteUpdate.mock.calls[0][0].data).toEqual({ totalVoiceSeconds: { increment: 330 } });
    // portal sessions (no invite) are never reaped (no billing surprise after deploy)
    expect(m.sessionFindMany.mock.calls[0][0].where.inviteId).toEqual({ not: null });
  });

  it('consolidation claims PENDING → RUNNING and marks DONE', async () => {
    m.sessionFindMany.mockResolvedValue([{ id: 's1', inviteId: 'inv', clientId: 'c1' }]);
    m.sessionUpdateMany.mockResolvedValue({ count: 1 });
    m.consolidateSession.mockResolvedValue({ processed: 2, byRisk: { LOW: 1, MEDIUM: 0, HIGH: 1 } });
    const res = await runConsolidation({ now: NOW, instance: 'i' });
    expect(res.consolidated).toBe(1);
    // first call recovers stale RUNNING leases (M1), second claims
    expect(m.sessionUpdateMany.mock.calls[0][0].where.consolidationStatus).toBe('RUNNING');
    expect(m.sessionUpdateMany.mock.calls[0][0].data).toEqual({ consolidationStatus: 'PENDING' });
    expect(m.sessionUpdateMany.mock.calls[1][0]).toMatchObject({ where: { id: 's1', consolidationStatus: 'PENDING' }, data: { consolidationStatus: 'RUNNING' } });
    expect(m.sessionUpdate.mock.calls[0][0].data.consolidationStatus).toBe('DONE');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ slug: 'interview_drafts_ready' }));
  });
});

describe('finalizeRootInvites', () => {
  const root = { id: 'root', status: 'COMPLETED', clientId: 'c1', sentToEmail: 'hina@x.com', recipientName: 'Hina', tokenNonce: 'n1', summaryStatus: 'NONE', agenda: { questions: [] } };

  it('waits while a child is still open', async () => {
    m.inviteFindMany.mockImplementation(async ({ where }) => (where.rootInviteId ? [root, { id: 'child', status: 'SENT', parentInviteId: 'root' }] : [root]));
    m.sessionFindMany.mockResolvedValue([]);
    m.inviteUpdateMany.mockResolvedValue({ count: 0 });
    const res = await finalizeRootInvites({ now: NOW, instance: 'i' });
    expect(res.summaries).toBe(0);
    // only the lease-recovery updateMany ran; no summary claim
    expect(m.inviteUpdateMany.mock.calls.every((c) => c[0].data.summaryStatus !== 'PENDING')).toBe(true);
    // the unsettled root is touched so others get a turn (M1)
    expect(m.inviteUpdate.mock.calls[0][0].where.id).toBe('root');
    expect(m.inviteFindMany.mock.calls[0][0].orderBy).toEqual({ updatedAt: 'asc' });
  });

  it('sends exactly one summary even with two concurrent ticks', async () => {
    m.inviteFindMany.mockImplementation(async ({ where }) => (where.rootInviteId ? [root, { id: 'child', status: 'COMPLETED', parentInviteId: 'root', recipientName: 'Asif' }] : [root]));
    m.sessionFindMany.mockResolvedValue([{ id: 's', status: 'COMPLETED', consolidationStatus: 'DONE' }]);
    m.draftFindMany.mockResolvedValue([{ id: 'd', inviteId: 'child', title: 'Prices', folder: 'services', proposedBody: 'MOT £45', respondentName: 'Asif', respondentRole: 'STAFF', status: 'PENDING', proposedMetadata: {} }]);
    let won = false;
    m.inviteUpdateMany.mockImplementation(async ({ data }) => {
      if (data.summaryStatus !== 'PENDING') return { count: 0 };
      if (won) return { count: 0 };
      won = true;
      return { count: 1 };
    });
    m.sendEmail.mockResolvedValue({ success: true });
    await Promise.all([finalizeRootInvites({ now: NOW, instance: 'a' }), finalizeRootInvites({ now: NOW, instance: 'b' })]);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    const mail = m.sendEmail.mock.calls[0][0];
    expect(mail.html).toContain('MOT £45'); // D4: worker content in full
    expect(mail.html).toContain('from Asif');
    expect(mail.html).not.toMatch(/transcript/i); // D2
    expect(mail.html).toContain('Correct it');
    const final = m.inviteUpdate.mock.calls.find((c) => c[0].data.summaryStatus === 'SENT');
    expect(final).toBeTruthy();
  });
});

describe('cancelUnconfirmedDelegations', () => {
  it('revokes PENDING_CONFIRM older than 24 h', async () => {
    m.inviteFindMany.mockResolvedValue([{ id: 'child', parentInviteId: 'root' }]);
    m.inviteFindUnique.mockResolvedValue({ id: 'root' });
    m.cancelDelegation.mockResolvedValue({});
    const res = await cancelUnconfirmedDelegations({ now: NOW });
    expect(res.cancelled).toBe(1);
    expect(m.cancelDelegation).toHaveBeenCalledWith({ root: { id: 'root' }, childId: 'child', reason: 'unconfirmed' });
    expect(m.inviteFindMany.mock.calls[0][0].where.createdAt.lt.getTime()).toBe(NOW.getTime() - DAY);
  });
});

describe('tick', () => {
  it('non-leader instances skip the tick', async () => {
    process.env.NODE_APP_INSTANCE = '2';
    const res = await runInterviewSchedulerTick({ now: NOW });
    expect(res.skipped).toBe('not-leader');
    delete process.env.NODE_APP_INSTANCE;
  });

  it('one failing step does not stop the others', async () => {
    m.inviteFindMany.mockRejectedValue(new Error('db down'));
    m.sessionFindMany.mockResolvedValue([]);
    const res = await runInterviewSchedulerTick({ now: NOW, force: true });
    expect(res.sendScheduledInvites.error).toBe('db down');
    expect(res.runConsolidation).toEqual({ consolidated: 0 });
  });
});
