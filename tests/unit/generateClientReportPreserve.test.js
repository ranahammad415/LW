import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientFindUnique: vi.fn(),
  reportFindUnique: vi.fn(),
  reportUpdate: vi.fn(),
  reportCreate: vi.fn(),
  taskCount: vi.fn(),
  taskFindMany: vi.fn(),
  wpCount: vi.fn(),
  kwCount: vi.fn(),
  promptCount: vi.fn(),
  promptFindMany: vi.fn(),
  metricFindMany: vi.fn(),
  commentCount: vi.fn(),
  issueFindMany: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    clientAccount: { findUnique: mocks.clientFindUnique },
    monthlyReport: {
      findUnique: mocks.reportFindUnique,
      update: mocks.reportUpdate,
      create: mocks.reportCreate,
    },
    task: { count: mocks.taskCount, findMany: mocks.taskFindMany },
    wpContentReview: { count: mocks.wpCount },
    keywordSuggestion: { count: mocks.kwCount },
    promptLog: { count: mocks.promptCount, findMany: mocks.promptFindMany },
    clientMetricSnapshot: { findMany: mocks.metricFindMany },
    taskComment: { count: mocks.commentCount },
    clientIssue: { findMany: mocks.issueFindMany },
  },
}));

import { generateClientReport } from '../../src/lib/monthlyReport/generateForCycle.js';

function stubGatherDeps() {
  mocks.taskCount.mockResolvedValue(0);
  mocks.taskFindMany.mockResolvedValue([]);
  mocks.wpCount.mockResolvedValue(0);
  mocks.kwCount.mockResolvedValue(0);
  mocks.promptCount.mockResolvedValue(0);
  mocks.promptFindMany.mockResolvedValue([]);
  mocks.metricFindMany.mockResolvedValue([]);
  mocks.commentCount.mockResolvedValue(0);
  mocks.issueFindMany.mockResolvedValue([]);
}

describe('generateClientReport preserve / force', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = '';
    mocks.clientFindUnique.mockResolvedValue({
      id: 'c1',
      agencyName: 'Acme',
      websiteUrl: null,
    });
  });

  it('preserves existing DRAFT when force is false', async () => {
    const draft = {
      id: 'r1',
      clientId: 'c1',
      month: 7,
      year: 2026,
      status: 'DRAFT',
      aiContent: { coverSummary: 'edited by PM' },
    };
    mocks.reportFindUnique.mockResolvedValue(draft);

    const result = await generateClientReport({
      clientId: 'c1',
      month: 7,
      year: 2026,
      force: false,
    });

    expect(result.action).toBe('preserved');
    expect(result.report.aiContent.coverSummary).toBe('edited by PM');
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
    expect(mocks.reportCreate).not.toHaveBeenCalled();
    expect(mocks.taskCount).not.toHaveBeenCalled();
  });

  it('leaves DELIVERED unchanged even when force is true', async () => {
    mocks.reportFindUnique.mockResolvedValue({
      id: 'r1',
      clientId: 'c1',
      month: 7,
      year: 2026,
      status: 'DELIVERED',
      aiContent: { coverSummary: 'shipped' },
    });

    const result = await generateClientReport({
      clientId: 'c1',
      month: 7,
      year: 2026,
      force: true,
    });

    expect(result.action).toBe('delivered_unchanged');
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it('regenerates DRAFT when force is true', async () => {
    stubGatherDeps();
    const draft = {
      id: 'r1',
      clientId: 'c1',
      month: 7,
      year: 2026,
      status: 'DRAFT',
      aiContent: { coverSummary: 'old' },
      workCycleId: 'wc1',
    };
    mocks.reportFindUnique.mockResolvedValue(draft);
    mocks.reportUpdate.mockImplementation(async ({ data }) => ({ ...draft, ...data }));

    const result = await generateClientReport({
      clientId: 'c1',
      month: 7,
      year: 2026,
      workCycleId: 'wc1',
      force: true,
      log: { error: vi.fn(), info: vi.fn() },
    });

    expect(result.action).toBe('regenerated');
    expect(mocks.reportUpdate).toHaveBeenCalled();
    expect(result.report.status).toBe('DRAFT');
    expect(result.report.aiContent).toBeTruthy();
  });

  it('creates a new draft when none exists', async () => {
    stubGatherDeps();
    mocks.reportFindUnique.mockResolvedValue(null);
    mocks.reportCreate.mockImplementation(async ({ data }) => ({
      id: 'new-r',
      ...data,
    }));

    const result = await generateClientReport({
      clientId: 'c1',
      month: 7,
      year: 2026,
      force: false,
      log: { error: vi.fn(), info: vi.fn() },
    });

    expect(result.action).toBe('created');
    expect(mocks.reportCreate).toHaveBeenCalled();
    expect(result.report.status).toBe('DRAFT');
  });
});
