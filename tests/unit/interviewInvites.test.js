import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  inviteCreate: vi.fn(),
  inviteUpdate: vi.fn(),
  inviteFindUnique: vi.fn(),
  logCreate: vi.fn(),
  clientFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  sendEmail: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    knowledgeInterviewInvite: { create: m.inviteCreate, update: m.inviteUpdate, findUnique: m.inviteFindUnique },
    interviewDispatchLog: { create: m.logCreate },
    clientAccount: { findUnique: m.clientFindUnique },
    user: { findMany: m.userFindMany },
    agencySetting: { findFirst: vi.fn().mockResolvedValue({ agencyName: 'Acme Agency' }) },
  },
}));
vi.mock('../../src/lib/mailer.js', () => ({ sendEmail: m.sendEmail }));
vi.mock('../../src/lib/notificationService.js', () => ({ notify: m.notify }));
vi.mock('../../src/lib/interviewAgenda.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    buildInterviewAgenda: vi.fn(async ({ templateKey }) => ({
      version: 1,
      templateKey,
      goals: ['Catch up'],
      questions: [{ id: 'company-hours', folder: 'company', prompt: 'Hours?', topic: 'Your opening hours', kind: 'primary' }],
      doNotAsk: [],
      gaps: [],
      estMinutes: 8,
    })),
  };
});

import {
  hashToken,
  deriveToken,
  mintToken,
  currentToken,
  placeholderHash,
  publicShape,
  normaliseReminderDays,
  createInvites,
  dispatchInvite,
  inviteUrl,
} from '../../src/lib/interviewInvites.js';

const NOW = new Date('2026-10-15T09:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERVIEW_TOKEN_SECRET = 'test-interview-secret-which-is-long-enough';
  process.env.FRONTEND_URL = 'https://app.example.com,https://other.example.com';
  delete process.env.NOTIFICATION_EMAILS_PAUSED;
  m.clientFindUnique.mockResolvedValue({ agencyName: 'Al-Noor Motors', leadPmId: 'pm1', secondaryPmId: null });
  m.userFindMany.mockResolvedValue([{ id: 'owner1' }]);
  m.inviteCreate.mockImplementation(async ({ data }) => ({ ...data }));
  m.inviteUpdate.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data, clientId: 'c1', sentToEmail: 'a@b.com', status: 'PENDING' }));
});

describe('tokens', () => {
  it('stores only sha256 and derives the same link from id + nonce', () => {
    const { token, nonce, tokenHash } = mintToken('inv-1');
    expect(tokenHash).toBe(hashToken(token));
    expect(deriveToken('inv-1', nonce)).toBe(token);
    expect(currentToken({ id: 'inv-1', tokenNonce: nonce })).toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('rotating the nonce changes the token; legacy invites have no derivable token', () => {
    const a = mintToken('inv-1');
    const b = mintToken('inv-1');
    expect(a.token).not.toBe(b.token);
    expect(currentToken({ id: 'inv-1', tokenNonce: null })).toBeNull();
    expect(placeholderHash()).toHaveLength(64);
  });

  it('uses the first FRONTEND_URL for links', () => {
    expect(inviteUrl('abc')).toBe('https://app.example.com/knowledge-interview/abc');
  });

  it('publicShape never leaks hash, nonce or lock owner', () => {
    const shaped = publicShape({ id: '1', tokenHash: 'h', tokenNonce: 'n', lockedBy: 'x', dispatchKey: 'k', status: 'SENT' });
    expect(shaped).toEqual({ id: '1', status: 'SENT' });
  });

  it('normalises reminder days', () => {
    expect(normaliseReminderDays([7, 3, 3, 0, 99, 'x'])).toEqual([3, 7]);
    expect(normaliseReminderDays(null)).toEqual([3, 7]);
  });
});

describe('createInvites', () => {
  it('schedules a future send without minting a usable token', async () => {
    const res = await createInvites({
      clientId: 'c1',
      createdById: 'owner1',
      templateKey: 'MONTHLY_UPDATE',
      recipients: [{ name: 'Hina', email: 'Hina@Example.com' }],
      scheduledSendAt: new Date(NOW.getTime() + 2 * 24 * 3600 * 1000),
      now: NOW,
    });
    const data = m.inviteCreate.mock.calls[0][0].data;
    expect(data.status).toBe('SCHEDULED');
    expect(data.tokenNonce).toBeNull();
    expect(data.sentToEmail).toBe('hina@example.com');
    expect(data.rootInviteId).toBe(data.id);
    expect(data.minutesBudget).toBe(10); // MONTHLY_UPDATE default
    expect(res.urls).toEqual([]);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('send-now marks SEND_FAILED and logs when SMTP fails (plan §1.3)', async () => {
    m.sendEmail.mockResolvedValue({ success: false, error: 'SMTP not configured' });
    m.inviteFindUnique.mockResolvedValue({ id: 'x', status: 'SEND_FAILED' });
    const res = await createInvites({
      clientId: 'c1',
      createdById: 'owner1',
      recipients: [{ name: 'Hina', email: 'hina@example.com' }],
      now: NOW,
    });
    const statusUpdate = m.inviteUpdate.mock.calls.find((c) => c[0].data.status);
    expect(statusUpdate[0].data.status).toBe('SEND_FAILED');
    expect(statusUpdate[0].data.sendError).toBe('SMTP not configured');
    expect(m.logCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'SEND', ok: false }) }));
    expect(res.urls[0].emailed).toBe(false);
    expect(res.urls[0].url).toContain('/knowledge-interview/');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ slug: 'interview_send_failed' }));
  });

  it('no-email invites return a link once and stay PENDING', async () => {
    const res = await createInvites({ clientId: 'c1', createdById: 'o', recipients: [{ name: 'X' }], sendEmail: false, now: NOW });
    expect(m.inviteCreate.mock.calls[0][0].data.status).toBe('PENDING');
    expect(res.urls).toHaveLength(1);
  });
});

describe('dispatchInvite', () => {
  const invite = {
    id: 'inv-9',
    clientId: 'c1',
    sentToEmail: 'hina@example.com',
    recipientName: 'Hina',
    status: 'SENT',
    tokenNonce: 'abc',
    expiresAt: new Date('2026-11-01'),
    agenda: { goals: ['Catch up'], questions: [{ id: 'q', folder: 'company', topic: 'Hours', kind: 'primary' }] },
    respondentRole: 'CLIENT',
    minutesBudget: 10,
  };

  it('a reminder re-sends the SAME link and does not change status', async () => {
    m.sendEmail.mockResolvedValue({ success: true });
    const res = await dispatchInvite(invite, { kind: 'REMINDER' });
    expect(res.ok).toBe(true);
    expect(res.url).toBe(inviteUrl(deriveToken('inv-9', 'abc')));
    expect(m.inviteUpdate).not.toHaveBeenCalled();
    const mail = m.sendEmail.mock.calls[0][0];
    expect(mail.subject).not.toContain(deriveToken('inv-9', 'abc'));
    expect(mail.html).toContain('Start interview');
    expect(mail.html).toContain('Hours');
    expect(mail.fromName).toBe('Acme Agency');
  });

  it('a resend rotates the token', async () => {
    m.sendEmail.mockResolvedValue({ success: true });
    const res = await dispatchInvite(invite, { kind: 'RESEND' });
    expect(m.inviteUpdate.mock.calls[0][0].data.tokenNonce).not.toBe('abc');
    expect(res.url).not.toBe(inviteUrl(deriveToken('inv-9', 'abc')));
  });

  it('respects NOTIFICATION_EMAILS_PAUSED', async () => {
    process.env.NOTIFICATION_EMAILS_PAUSED = 'true';
    const res = await dispatchInvite(invite, { kind: 'SEND' });
    expect(res.paused).toBe(true);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});
