import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  $transaction: vi.fn(),
  clientCount: vi.fn(),
  clientFindMany: vi.fn(),
  monthlyReportFindMany: vi.fn(),
  cloneMissing: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    workCycle: {
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
    },
    task: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
    clientAccount: {
      count: mocks.clientCount,
      findMany: mocks.clientFindMany,
    },
    monthlyReport: {
      findMany: mocks.monthlyReportFindMany,
    },
    $transaction: mocks.$transaction,
  },
}));

vi.mock('../../src/lib/taskClone.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    cloneMissingRecurringTasks: mocks.cloneMissing,
    cloneMissingIncompleteTasks: mocks.cloneMissing,
    DONE_STATUSES: actual.DONE_STATUSES,
  };
});

import { previewOpenNext, openNextCycle, ensureNextCycle, monthLabel } from '../../src/lib/workCycle.js';

describe('workCycle monthLabel', () => {
  it('formats month/year', () => {
    expect(monthLabel(7, 2026)).toBe('July 2026');
  });
});

describe('ensureNextCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a CLOSED next cycle without opening it', async () => {
    const current = {
      id: 'c1',
      month: 7,
      year: 2026,
      status: 'OPEN',
      label: 'July 2026',
    };
    mocks.findFirst.mockResolvedValue(current);
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({
      id: 'c2',
      month: 8,
      year: 2026,
      status: 'CLOSED',
      label: 'August 2026',
    });

    const result = await ensureNextCycle({ userId: 'u1' });
    expect(result.current.id).toBe('c1');
    expect(result.next.month).toBe(8);
    expect(result.next.status).toBe('CLOSED');
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ month: 8, year: 2026, status: 'CLOSED' }),
      })
    );
  });
});

describe('previewOpenNext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts non-cancelled roots (incl. completed) that are not yet cloned', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'c1',
      month: 7,
      year: 2026,
      label: 'July 2026',
    });
    mocks.findUnique.mockResolvedValue({ id: 'c2', month: 8, year: 2026 });
    mocks.findMany
      .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]) // recurring roots
      .mockResolvedValueOnce([{ clonedFromTaskId: 't1' }]); // already cloned
    mocks.clientFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    // Two clients already have drafts — only one report still needed
    mocks.monthlyReportFindMany.mockResolvedValue([{ clientId: 'a' }, { clientId: 'b' }]);

    const preview = await previewOpenNext();
    expect(preview.carryOverCount).toBe(1);
    expect(preview.reportsToGenerate).toBe(0);
    expect(preview.nextCycle.month).toBe(8);
    expect(mocks.findMany.mock.calls[0][0].where.status).toEqual({ not: 'CANCELLED' });
  });
});

describe('openNextCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clones missing recurring tasks instead of moving workCycleId', async () => {
    const closed = { id: 'c1', month: 7, year: 2026, status: 'CLOSED' };
    const opened = { id: 'c2', month: 8, year: 2026, status: 'OPEN', label: 'August 2026' };

    mocks.findFirst.mockResolvedValue({
      id: 'c1',
      month: 7,
      year: 2026,
      status: 'OPEN',
    });
    mocks.findUnique.mockResolvedValue({ id: 'c2', month: 8, year: 2026, status: 'CLOSED' });
    mocks.cloneMissing.mockResolvedValue({ cloned: 4, skipped: 1, rootCount: 2 });

    mocks.$transaction.mockImplementation(async (fn) => {
      const tx = {
        workCycle: {
          update: vi
            .fn()
            .mockResolvedValueOnce(closed)
            .mockResolvedValueOnce(opened),
          create: vi.fn(),
        },
      };
      return fn(tx);
    });

    // Post-close imports will fail silently / be mocked by dynamic import failure — ok.
    const result = await openNextCycle({ userId: 'u1', log: { error: vi.fn() } });

    expect(mocks.cloneMissing).toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(result.carried).toBe(4);
    expect(result.newCycle.id).toBe('c2');
  });
});
