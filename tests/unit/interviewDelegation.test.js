import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  count: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  clientFindUnique: vi.fn(),
  dispatchInvite: vi.fn(),
  logDispatch: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    knowledgeInterviewInvite: {
      count: m.count,
      findFirst: m.findFirst,
      findUnique: m.findUnique,
      updateMany: m.updateMany,
      update: m.update,
      create: m.create,
    },
    clientAccount: { findUnique: m.clientFindUnique },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('../../src/lib/interviewInvites.js', async (orig) => {
  const actual = await orig();
  return { ...actual, dispatchInvite: m.dispatchInvite, logDispatch: m.logDispatch, staffRecipientIds: vi.fn().mockResolvedValue(['pm1']) };
});
vi.mock('../../src/lib/notificationService.js', () => ({ notify: m.notify }));

import {
  clusterQuestionsForWorker,
  createDelegation,
  confirmDelegation,
  cancelDelegation,
  declineDelegation,
  validateWorkerEmail,
  DelegationError,
  MAX_CLUSTER,
} from '../../src/lib/interviewDelegation.js';

const agenda = {
  questions: [
    { id: 'svc-1', folder: 'services', factType: 'price', prompt: 'Prices?', topic: 'Prices' },
    { id: 'svc-2', folder: 'services', factType: 'service', prompt: 'Typical job?', topic: 'Typical job' },
    { id: 'co-1', folder: 'company', factType: 'hours', prompt: 'Hours?', topic: 'Hours' },
    { id: 'svc-3', folder: 'services', factType: 'service', prompt: 'New services?', answeredBy: 'root' },
    { id: 'faq-1', folder: 'faq', factType: 'faq', prompt: 'FAQ?', delegatedTo: 'other' },
  ],
};

const root = {
  id: 'root-1',
  rootInviteId: 'root-1',
  clientId: 'c1',
  projectId: null,
  createdById: 'owner1',
  recipientName: 'Hina',
  sentToEmail: 'hina@alnoor.com',
  respondentRole: 'CLIENT',
  delegationDepth: 0,
  expiresAt: new Date('2026-10-30T00:00:00Z'),
  templateKey: 'ONBOARDING',
  agenda,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.count.mockResolvedValue(0);
  m.findFirst.mockResolvedValue(null);
  m.updateMany.mockResolvedValue({ count: 1 });
  m.create.mockImplementation(async ({ data }) => ({ ...data }));
  m.update.mockResolvedValue({});
  m.findUnique.mockImplementation(async ({ where }) => (where.id === 'root-1' ? { agenda } : { id: where.id, status: 'SENT', sentToEmail: 'asif@alnoor.com', recipientName: 'Asif', questionCluster: [] }));
  m.clientFindUnique.mockResolvedValue({ agencyName: 'Al-Noor Motors', websiteUrl: 'https://alnoor.com', clientUsers: [] });
  m.dispatchInvite.mockResolvedValue({ ok: true, url: 'https://x/knowledge-interview/t' });
});

describe('clusterQuestionsForWorker', () => {
  it('deferred first, then open questions in the same folder; skips answered/delegated', () => {
    const cluster = clusterQuestionsForWorker(agenda, ['svc-1']);
    expect(cluster.map((q) => q.id)).toEqual(['svc-1', 'svc-2']);
  });

  it('matches the bank from a topic summary and caps the size', () => {
    const cluster = clusterQuestionsForWorker({ questions: [] }, [], 'prices and opening hours');
    expect(cluster.length).toBeGreaterThan(0);
    expect(cluster.length).toBeLessThanOrEqual(MAX_CLUSTER);
  });

  it('falls back to a custom topic question', () => {
    const cluster = clusterQuestionsForWorker({ questions: [] }, [], 'xyzzy plugh');
    expect(cluster).toHaveLength(1);
    expect(cluster[0].id).toMatch(/^topic-/);
  });
});

describe('validateWorkerEmail', () => {
  it('rejects bad, disposable and self emails', () => {
    expect(() => validateWorkerEmail('nope')).toThrow(DelegationError);
    expect(() => validateWorkerEmail('a@mailinator.com')).toThrow(/work email/);
    expect(() => validateWorkerEmail('HINA@alnoor.com', { rootEmail: 'hina@alnoor.com' })).toThrow(/own email/);
    expect(validateWorkerEmail(' Asif@AlNoor.com ')).toBe('asif@alnoor.com');
  });
});

describe('createDelegation', () => {
  it('workers cannot delegate (D1, depth 1 only)', async () => {
    await expect(
      createDelegation({ root: { ...root, respondentRole: 'STAFF', delegationDepth: 1 }, workerName: 'X', workerEmail: 'x@alnoor.com', questionIds: ['svc-1'] })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('speech delegation is PENDING_CONFIRM and sends nothing', async () => {
    const res = await createDelegation({
      root,
      session: { id: 's1' },
      workerName: 'Asif',
      workerEmail: 'asif@alnoor.com',
      workerRole: 'workshop manager',
      reason: 'He runs the workshop',
      questionIds: ['svc-1'],
      viaSpeech: true,
    });
    expect(res.status).toBe('PENDING_CONFIRM');
    expect(m.dispatchInvite).not.toHaveBeenCalled();
    const data = m.create.mock.calls[0][0].data;
    expect(data.respondentRole).toBe('STAFF');
    expect(data.delegationDepth).toBe(1);
    expect(data.parentInviteId).toBe('root-1');
    expect(data.minutesBudget).toBe(10);
    expect(data.reminderDays).toEqual([2, 5]);
    // child expiry ≤ 7 days from now and ≤ root expiry + 7
    expect(new Date(data.expiresAt).getTime()).toBeLessThanOrEqual(new Date(root.expiresAt).getTime() + 7 * 864e5);
    // root agenda questions get delegatedTo
    const agendaUpdate = m.update.mock.calls.find((c) => c[0].where.id === 'root-1');
    expect(agendaUpdate[0].data.agenda.questions.find((q) => q.id === 'svc-1').delegatedTo).toBe(data.id);
  });

  it('landing-page delegation sends immediately', async () => {
    m.findUnique.mockImplementation(async ({ where }) => (where.id === 'root-1' ? { agenda } : { id: where.id, status: 'SENT', sentToEmail: 'asif@alnoor.com', questionCluster: [] }));
    await createDelegation({ root, workerName: 'Asif', workerEmail: 'asif@alnoor.com', questionIds: ['svc-1'] });
    expect(m.dispatchInvite).toHaveBeenCalledTimes(1);
  });

  it('enforces the per-root cap with a CAS counter', async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    await expect(createDelegation({ root, workerName: 'Asif', workerEmail: 'asif@alnoor.com', questionIds: ['svc-1'] })).rejects.toMatchObject({ status: 429 });
  });

  it('enforces 3 per session and one open child per email', async () => {
    m.count.mockResolvedValue(3);
    await expect(createDelegation({ root, session: { id: 's' }, workerName: 'A', workerEmail: 'a@alnoor.com', questionIds: ['svc-1'] })).rejects.toMatchObject({ code: 'DELEGATION_SESSION_LIMIT' });
    m.count.mockResolvedValue(0);
    m.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(createDelegation({ root, workerName: 'A', workerEmail: 'a@alnoor.com', questionIds: ['svc-1'] })).rejects.toMatchObject({ status: 409 });
  });
});

describe('confirm / cancel / decline', () => {
  it('confirm uses a CAS so only one tap sends', async () => {
    m.findUnique.mockResolvedValueOnce({ id: 'child-1', parentInviteId: 'root-1', status: 'PENDING_CONFIRM', questionCluster: [] });
    m.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(confirmDelegation({ root, childId: 'child-1' })).rejects.toMatchObject({ status: 409 });
    expect(m.dispatchInvite).not.toHaveBeenCalled();
  });

  it('confirm can correct the email, then sends', async () => {
    m.findUnique.mockResolvedValueOnce({ id: 'child-1', parentInviteId: 'root-1', status: 'PENDING_CONFIRM', questionCluster: [] });
    const res = await confirmDelegation({ root, childId: 'child-1', workerEmail: 'asif.k@alnoor.com' });
    expect(m.updateMany.mock.calls[0][0].data.sentToEmail).toBe('asif.k@alnoor.com');
    expect(m.dispatchInvite).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(true);
  });

  it('cancel of an unconfirmed child frees the quota and the agenda', async () => {
    m.findUnique.mockResolvedValueOnce({ id: 'child-1', parentInviteId: 'root-1', status: 'PENDING_CONFIRM', questionCluster: [{ id: 'svc-1' }] });
    await cancelDelegation({ root, childId: 'child-1', reason: 'unconfirmed' });
    expect(m.update.mock.calls[0][0].data).toMatchObject({ status: 'REVOKED', statusReason: 'unconfirmed' });
    expect(m.updateMany.mock.calls[0][0].data).toEqual({ delegationCount: { decrement: 1 } });
  });

  it('decline revokes once and notifies staff', async () => {
    await declineDelegation({ id: 'child-1', parentInviteId: 'root-1', respondentRole: 'STAFF', clientId: 'c1', questionCluster: [] });
    expect(m.updateMany.mock.calls[0][0].data.status).toBe('DECLINED');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ slug: 'interview_delegation_declined' }));
    await expect(declineDelegation({ id: 'r', respondentRole: 'CLIENT' })).rejects.toBeInstanceOf(DelegationError);
  });
});
