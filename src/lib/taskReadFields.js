/**
 * Task read helpers for the SEO Engine contract (OS-02 worker visibility, OS-07 read fields).
 */

/**
 * Worker API tokens see only tasks assigned to them (OS-02 / A2 "only for tasks assigned to that worker").
 * Walks a task tree (`subTasks`) and keeps assigned tasks; an assigned sub-task under an unassigned parent moves up
 * to the nearest kept ancestor (or the top level). Dependency stubs are reduced to { id, status } so titles of
 * unassigned tasks do not leak.
 */
export function pruneTasksForWorker(tasks, userId) {
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const kids = Array.isArray(t.subTasks) ? pruneTasksForWorker(t.subTasks, userId) : undefined;
    const assigned = Array.isArray(t.assignees) && t.assignees.some((a) => a?.id === userId);
    if (assigned) {
      const next = { ...t };
      if (kids !== undefined) next.subTasks = kids;
      if (Array.isArray(t.dependsOnTasks)) next.dependsOnTasks = t.dependsOnTasks.map((d) => ({ id: d.id, status: d.status }));
      out.push(next);
    } else if (kids) {
      out.push(...kids);
    }
  }
  return out;
}

/**
 * OS-07: every task object carries assigneeId (first assignee or null; `assignees` stays), updatedAt,
 * completedAt (nullable) and workCycleId. Applied recursively to subTasks.
 */
export function withTaskReadFields(task) {
  if (!task || typeof task !== 'object') return task;
  const out = {
    ...task,
    assigneeId: Array.isArray(task.assignees) && task.assignees.length ? task.assignees[0]?.id ?? null : null,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    workCycleId: task.workCycleId ?? null,
  };
  if (Array.isArray(task.subTasks)) out.subTasks = task.subTasks.map(withTaskReadFields);
  return out;
}
