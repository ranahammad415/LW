import { randomUUID } from 'crypto';
import { prisma } from './prisma.js';

const DONE_STATUSES = ['COMPLETED', 'CANCELLED'];

/**
 * Shift a due date forward by one calendar month (UTC), preserving day-of-month
 * when possible (clamps to last day of target month).
 */
export function shiftDueDateOneMonth(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();
  const nextMonth = month + 1;
  const targetYear = year + Math.floor(nextMonth / 12);
  const targetMonth = nextMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, clampedDay, hours, minutes, seconds, ms));
}

/**
 * Collect a root task and all descendants (any depth) within the same project.
 */
async function loadTaskTree(rootTaskId, { tx = prisma } = {}) {
  const root = await tx.task.findUnique({
    where: { id: rootTaskId },
    include: {
      assignees: { select: { id: true } },
      dependsOnTasks: { select: { id: true } },
    },
  });
  if (!root) return [];

  const byId = new Map([[root.id, root]]);
  let frontier = [root.id];

  while (frontier.length) {
    const children = await tx.task.findMany({
      where: { parentTaskId: { in: frontier } },
      include: {
        assignees: { select: { id: true } },
        dependsOnTasks: { select: { id: true } },
      },
    });
    frontier = [];
    for (const child of children) {
      if (!byId.has(child.id)) {
        byId.set(child.id, child);
        frontier.push(child.id);
      }
    }
  }

  return [...byId.values()];
}

/**
 * Clone a single root task tree into `targetCycleId`.
 * - Idempotent: skips if a clone of the root already exists in the target cycle.
 * - Resets status to TO_DO; clears client-input fulfillment; shifts due dates +1 month.
 * - Does NOT copy comments, attachments, activity logs, or deliverables.
 *
 * @returns {{ cloned: number, skipped: boolean, rootCloneId: string | null }}
 */
export async function cloneTaskTreeIntoCycle(rootTaskId, targetCycleId, { tx = prisma, createdById = null } = {}) {
  const existingClone = await tx.task.findFirst({
    where: { clonedFromTaskId: rootTaskId, workCycleId: targetCycleId },
    select: { id: true },
  });
  if (existingClone) {
    return { cloned: 0, skipped: true, rootCloneId: existingClone.id };
  }

  const tree = await loadTaskTree(rootTaskId, { tx });
  if (!tree.length) {
    return { cloned: 0, skipped: true, rootCloneId: null };
  }

  const idMap = new Map();
  for (const t of tree) {
    idMap.set(t.id, randomUUID());
  }

  // Parents before children.
  const byId = new Map(tree.map((t) => [t.id, t]));
  const depthOf = (t) => {
    let d = 0;
    let cur = t;
    while (cur?.parentTaskId && byId.has(cur.parentTaskId)) {
      d += 1;
      cur = byId.get(cur.parentTaskId);
      if (d > 50) break;
    }
    return d;
  };
  const ordered = [...tree].sort((a, b) => depthOf(a) - depthOf(b));

  for (const source of ordered) {
    const newId = idMap.get(source.id);
    const parentId =
      source.parentTaskId && idMap.has(source.parentTaskId)
        ? idMap.get(source.parentTaskId)
        : null;

    await tx.task.create({
      data: {
        id: newId,
        projectId: source.projectId,
        title: source.title,
        description: source.description,
        taskType: source.taskType,
        priority: source.priority,
        dueDate: shiftDueDateOneMonth(source.dueDate),
        createdById: createdById ?? source.createdById,
        status: 'TO_DO',
        clientVisible: source.clientVisible,
        parentTaskId: parentId,
        wpAccessPresetId: source.wpAccessPresetId,
        workCycleId: targetCycleId,
        clonedFromTaskId: source.id,
        milestone: source.milestone,
        requiresClientInput: source.requiresClientInput,
        clientRequestNote: source.clientRequestNote,
        clientProvidedInput: false,
        clientProvidedResponse: null,
        assignees: source.assignees?.length
          ? { connect: source.assignees.map((a) => ({ id: a.id })) }
          : undefined,
      },
    });
  }

  // Remap in-set dependencies after all rows exist.
  for (const source of tree) {
    const depsInSet = (source.dependsOnTasks || [])
      .map((d) => d.id)
      .filter((depId) => idMap.has(depId))
      .map((depId) => ({ id: idMap.get(depId) }));
    if (depsInSet.length) {
      await tx.task.update({
        where: { id: idMap.get(source.id) },
        data: { dependsOnTasks: { connect: depsInSet } },
      });
    }
  }

  return {
    cloned: tree.length,
    skipped: false,
    rootCloneId: idMap.get(rootTaskId) ?? null,
  };
}

/**
 * Clone every incomplete root task from `fromCycleId` into `toCycleId` that
 * does not already have a clone (agency-wide safety net on month close).
 */
export async function cloneMissingIncompleteTasks(fromCycleId, toCycleId, { tx = prisma, createdById = null } = {}) {
  const roots = await tx.task.findMany({
    where: {
      workCycleId: fromCycleId,
      parentTaskId: null,
      status: { notIn: DONE_STATUSES },
    },
    select: { id: true },
  });

  let cloned = 0;
  let skipped = 0;
  for (const root of roots) {
    const result = await cloneTaskTreeIntoCycle(root.id, toCycleId, { tx, createdById });
    if (result.skipped) skipped += 1;
    else cloned += result.cloned;
  }
  return { cloned, skipped, rootCount: roots.length };
}

/**
 * Prepare next-month tasks for one project: clone selected roots, remove staged
 * next-month tasks, optionally create extra tasks on the next cycle.
 */
export async function prepareProjectNextMonth({
  projectId,
  currentCycleId,
  nextCycleId,
  cloneTaskIds = [],
  removeNextTaskIds = [],
  createTasks = [],
  createdById = null,
}) {
  return prisma.$transaction(async (tx) => {
    // Remove staged next-month tasks (cascades subtasks via FK).
    let removed = 0;
    if (removeNextTaskIds.length) {
      const toRemove = await tx.task.findMany({
        where: {
          id: { in: removeNextTaskIds },
          projectId,
          workCycleId: nextCycleId,
        },
        select: { id: true },
      });
      if (toRemove.length) {
        const res = await tx.task.deleteMany({
          where: { id: { in: toRemove.map((t) => t.id) } },
        });
        removed = res.count;
      }
    }

    let cloned = 0;
    let skipped = 0;
    const uniqueCloneIds = [...new Set(cloneTaskIds)];
    for (const taskId of uniqueCloneIds) {
      const source = await tx.task.findFirst({
        where: { id: taskId, projectId, workCycleId: currentCycleId },
        select: { id: true, parentTaskId: true },
      });
      if (!source) continue;
      // Only clone roots; if a subtask id is passed, climb to root.
      let rootId = source.id;
      if (source.parentTaskId) {
        let cursor = source;
        while (cursor.parentTaskId) {
          cursor = await tx.task.findUnique({
            where: { id: cursor.parentTaskId },
            select: { id: true, parentTaskId: true },
          });
          if (!cursor) break;
          rootId = cursor.id;
        }
      }
      const result = await cloneTaskTreeIntoCycle(rootId, nextCycleId, { tx, createdById });
      if (result.skipped) skipped += 1;
      else cloned += result.cloned;
    }

    let created = 0;
    for (const payload of createTasks) {
      if (!payload?.title || !payload?.taskType) continue;
      await tx.task.create({
        data: {
          projectId,
          title: String(payload.title).slice(0, 500),
          description: payload.description ? String(payload.description) : null,
          taskType: String(payload.taskType).slice(0, 100),
          priority: payload.priority || 'MEDIUM',
          dueDate: payload.dueDate ? new Date(payload.dueDate) : null,
          createdById,
          status: 'TO_DO',
          workCycleId: nextCycleId,
          milestone: payload.milestone ? String(payload.milestone).slice(0, 100) : null,
          assignees:
            Array.isArray(payload.assigneeIds) && payload.assigneeIds.length
              ? { connect: payload.assigneeIds.map((id) => ({ id })) }
              : undefined,
        },
      });
      created += 1;
    }

    return { cloned, skipped, removed, created };
  });
}

export { DONE_STATUSES };
