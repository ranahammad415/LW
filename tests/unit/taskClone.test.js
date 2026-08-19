import { describe, it, expect, beforeEach, vi } from 'vitest';

const cloneMocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    task: {
      findFirst: cloneMocks.findFirst,
      findUnique: cloneMocks.findUnique,
      findMany: cloneMocks.findMany,
      create: cloneMocks.create,
      update: cloneMocks.update,
    },
  },
}));

import {
  shiftDueDateOneMonth,
  cloneTaskTreeIntoCycle,
  cloneMissingRecurringTasks,
} from '../../src/lib/taskClone.js';

describe('shiftDueDateOneMonth', () => {
  it('returns null for nullish input', () => {
    expect(shiftDueDateOneMonth(null)).toBeNull();
    expect(shiftDueDateOneMonth(undefined)).toBeNull();
  });

  it('shifts mid-month dates by one calendar month', () => {
    const input = new Date(Date.UTC(2026, 6, 15, 12, 0, 0)); // Jul 15
    const out = shiftDueDateOneMonth(input);
    expect(out.getUTCFullYear()).toBe(2026);
    expect(out.getUTCMonth()).toBe(7); // Aug
    expect(out.getUTCDate()).toBe(15);
  });

  it('clamps end-of-month days (Jan 31 → Feb 28/29)', () => {
    const input = new Date(Date.UTC(2026, 0, 31)); // Jan 31
    const out = shiftDueDateOneMonth(input);
    expect(out.getUTCMonth()).toBe(1); // Feb
    expect(out.getUTCDate()).toBe(28);
  });

  it('rolls year forward from December', () => {
    const input = new Date(Date.UTC(2026, 11, 10)); // Dec 10
    const out = shiftDueDateOneMonth(input);
    expect(out.getUTCFullYear()).toBe(2027);
    expect(out.getUTCMonth()).toBe(0);
    expect(out.getUTCDate()).toBe(10);
  });
});

describe('cloneTaskTreeIntoCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates clones with TO_DO even when source is COMPLETED', async () => {
    cloneMocks.findFirst.mockResolvedValue(null); // no existing clone
    cloneMocks.findUnique.mockResolvedValue({
      id: 'src1',
      projectId: 'p1',
      title: 'Off-page SEO',
      description: null,
      taskType: 'SEO',
      priority: 'MEDIUM',
      dueDate: new Date(Date.UTC(2026, 6, 15)),
      createdById: 'u1',
      status: 'COMPLETED',
      clientVisible: true,
      parentTaskId: null,
      wpAccessPresetId: null,
      milestone: null,
      requiresClientInput: false,
      clientRequestNote: null,
      assignees: [],
      dependsOnTasks: [],
    });
    cloneMocks.findMany.mockResolvedValue([]); // no children
    cloneMocks.create.mockResolvedValue({});

    const result = await cloneTaskTreeIntoCycle('src1', 'cycle-aug');
    expect(result.skipped).toBe(false);
    expect(result.cloned).toBe(1);
    expect(cloneMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'TO_DO',
          workCycleId: 'cycle-aug',
          clonedFromTaskId: 'src1',
          title: 'Off-page SEO',
        }),
      })
    );
  });

  it('skips when a clone already exists in the target cycle', async () => {
    cloneMocks.findFirst.mockResolvedValue({ id: 'existing-clone' });
    const result = await cloneTaskTreeIntoCycle('src1', 'cycle-aug');
    expect(result.skipped).toBe(true);
    expect(result.cloned).toBe(0);
    expect(cloneMocks.create).not.toHaveBeenCalled();
  });
});

describe('cloneMissingRecurringTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries non-cancelled roots only (includes COMPLETED)', async () => {
    cloneMocks.findMany.mockResolvedValueOnce([]); // roots query
    await cloneMissingRecurringTasks('from', 'to');
    expect(cloneMocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workCycleId: 'from',
          parentTaskId: null,
          status: { not: 'CANCELLED' },
        }),
      })
    );
  });

  it('clones completed and todo roots as TO_DO', async () => {
    cloneMocks.findMany.mockResolvedValueOnce([{ id: 'completed-root' }, { id: 'todo-root' }]);
    cloneMocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    cloneMocks.findUnique
      .mockResolvedValueOnce({
        id: 'completed-root',
        projectId: 'p1',
        title: 'A',
        description: null,
        taskType: 'SEO',
        priority: 'MEDIUM',
        dueDate: null,
        createdById: 'u1',
        status: 'COMPLETED',
        clientVisible: false,
        parentTaskId: null,
        wpAccessPresetId: null,
        milestone: null,
        requiresClientInput: false,
        clientRequestNote: null,
        assignees: [],
        dependsOnTasks: [],
      })
      .mockResolvedValueOnce({
        id: 'todo-root',
        projectId: 'p1',
        title: 'B',
        description: null,
        taskType: 'SEO',
        priority: 'MEDIUM',
        dueDate: null,
        createdById: 'u1',
        status: 'TO_DO',
        clientVisible: false,
        parentTaskId: null,
        wpAccessPresetId: null,
        milestone: null,
        requiresClientInput: false,
        clientRequestNote: null,
        assignees: [],
        dependsOnTasks: [],
      });
    cloneMocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    cloneMocks.create.mockResolvedValue({});

    const result = await cloneMissingRecurringTasks('from', 'to');
    expect(result.rootCount).toBe(2);
    expect(result.cloned).toBe(2);
    expect(cloneMocks.create).toHaveBeenCalledTimes(2);
    for (const call of cloneMocks.create.mock.calls) {
      expect(call[0].data.status).toBe('TO_DO');
    }
  });
});
