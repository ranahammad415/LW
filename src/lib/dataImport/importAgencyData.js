import { prisma } from '../prisma.js';
import { findProjectByMatch } from './resolveProject.js';
import { resolveTeamRoster, resolveAssignee } from './resolveTeam.js';
import {
  TASKTYPE_TO_PRESET,
  VALID_TASK_TYPES,
  VALID_STATUSES,
  VALID_PRIORITIES,
  buildDescription,
  buildMainDescription,
  normalizeStatus,
  slugRef,
} from './constants.js';

function normalizeStep(step) {
  if (typeof step === 'string') {
    const title = step.trim();
    return title ? { title, ref: slugRef('step', title) } : null;
  }
  if (!step?.title) return null;
  return {
    ref: step.ref || slugRef('step', step.title),
    title: step.title,
    assigneeKey: step.assigneeKey,
    progress: step.progress,
  };
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function statusFromCompletion(completion) {
  if (!completion) return null;
  if (completion.isComplete === true) {
    return completion.needsPmReview ? 'NEEDS_REVIEW' : 'COMPLETED';
  }
  if (completion.status) return normalizeStatus(completion.status);
  return null;
}

function statusFromProgress(progress, importMode) {
  if (!progress || importMode === 'plan_only') return 'TO_DO';
  if (progress.status) return normalizeStatus(progress.status);
  return 'TO_DO';
}

function resolveAssigneeKeys(task, team, fallback) {
  const keys = task.assigneeKeys?.length ? task.assigneeKeys : task.assigneeKey ? [task.assigneeKey] : [];
  const users = keys.map((k) => resolveAssignee(team, k, null)).filter(Boolean);
  if (users.length) return users;
  const single = resolveAssignee(team, task.assigneeKey, fallback);
  return single ? [single] : [];
}

/**
 * Import agency-data v1.1 JSON into Localwaves.
 * @param {object} data - Parsed agency-data document
 * @param {{ dryRun?: boolean, skipProjects?: string[] }} options
 */
export async function importAgencyData(data, options = {}) {
  const { dryRun = false, skipProjects = [] } = options;
  const importMode = data?.meta?.importMode || 'plan_with_progress';

  const presets = await prisma.wpAccessPreset.findMany({ select: { id: true, name: true } });
  const presetIdByName = Object.fromEntries(presets.map((p) => [p.name, p.id]));
  const resolvePresetId = (taskType) => {
    const name = TASKTYPE_TO_PRESET[taskType];
    return name ? presetIdByName[name] || null : null;
  };

  const { team, missing } = await resolveTeamRoster(data.teamRoster || {});
  if (missing.length) {
    throw new Error(`Missing required team members: ${missing.join(', ')}`);
  }

  const fallbackPm = await prisma.user.findFirst({
    where: { role: { in: ['PM', 'OWNER'] }, isActive: true },
  });
  if (!fallbackPm) throw new Error('No active PM/OWNER found for createdById fallback');

  const summary = {
    importMode,
    dryRun,
    projects: [],
    totals: { mains: 0, subs: 0, steps: 0, comments: 0, pmUpdates: 0, businessUpdates: 0, keywords: 0 },
  };

  for (const projEntry of data.projects || []) {
    const matchKey = projEntry.projectMatch?.projectNameContains || projEntry.ref || 'unknown';
    if (skipProjects.includes(matchKey)) continue;

    const project = await findProjectByMatch(projEntry.projectMatch || {});
    if (!project) {
      summary.projects.push({ match: matchKey, status: 'skipped', reason: 'project not found' });
      continue;
    }

    const createdById = project.leadPmId || fallbackPm.id;
    const refToTaskId = new Map();
    const projectResult = {
      project: project.name,
      projectId: project.id,
      mains: 0,
      subs: 0,
      steps: 0,
      skipped: 0,
      comments: 0,
      pmUpdates: 0,
      businessUpdates: 0,
      keywords: 0,
    };

    const existingTasks = await prisma.task.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true, parentTaskId: true },
    });
    const taskTree = existingTasks;
    const existingMilestoneTitles = new Set(
      existingTasks.filter((t) => !t.parentTaskId).map((t) => t.title),
    );

    if (importMode === 'sync_progress') {
      buildRefMapFromExisting(projEntry, existingTasks, refToTaskId, taskTree);
    }

    if (importMode !== 'sync_progress') {
      for (const group of projEntry.taskGroups || []) {
        const milestone = group.milestone || '(Unspecified)';
        const groupRef = group.ref || slugRef('grp', milestone);
        const tasks = group.tasks || [];

        if (existingMilestoneTitles.has(milestone)) {
          projectResult.skipped++;
          buildRefMapFromExisting(
            { taskGroups: [group] },
            existingTasks,
            refToTaskId,
            taskTree,
          );
          continue;
        }

        const firstSub = tasks[0];
        if (!firstSub) continue;

        const firstAssignees = resolveAssigneeKeys(
          firstSub,
          team,
          project.leadPm || fallbackPm,
        );
        if (!firstAssignees.length) continue;

        const mainTaskType = VALID_TASK_TYPES.has(firstSub.taskType) ? firstSub.taskType : 'reporting';
        const mainPriority = VALID_PRIORITIES.has(firstSub.priority) ? firstSub.priority : 'HIGH';

        let mainTask;
        if (!dryRun) {
          mainTask = await prisma.task.create({
            data: {
              projectId: project.id,
              title: milestone,
              taskType: mainTaskType,
              priority: mainPriority,
              status: 'TO_DO',
              description: buildMainDescription(tasks),
              clientVisible: true,
              createdById,
              wpAccessPresetId: resolvePresetId(mainTaskType),
              assignees: { connect: firstAssignees.map((u) => ({ id: u.id })) },
            },
          });
        } else {
          mainTask = { id: `dry-main-${groupRef}` };
        }

        refToTaskId.set(groupRef, mainTask.id);
        projectResult.mains++;

        for (const task of tasks) {
          const taskRef = task.ref || slugRef('task', task.title);
          const assignees = resolveAssigneeKeys(task, team, project.leadPm || fallbackPm);
          if (!assignees.length) continue;

          const taskType = VALID_TASK_TYPES.has(task.taskType) ? task.taskType : mainTaskType;
          const priority = VALID_PRIORITIES.has(task.priority) ? task.priority : 'MEDIUM';
          const subStatus = statusFromProgress(task.progress, importMode);

          let subTask;
          if (!dryRun) {
            subTask = await prisma.task.create({
              data: {
                projectId: project.id,
                parentTaskId: mainTask.id,
                title: task.title,
                taskType,
                priority,
                status: subStatus,
                milestone: milestone !== '(Unspecified)' ? milestone : null,
                description: buildDescription(task),
                dueDate: parseDate(task.dueDate),
                clientVisible: task.clientVisible !== false,
                createdById,
                wpAccessPresetId: resolvePresetId(taskType),
                requiresClientInput: Boolean(task.clientInput?.required),
                clientRequestNote: task.clientInput?.requestNote || null,
                assignees: { connect: assignees.map((u) => ({ id: u.id })) },
              },
            });
          } else {
            subTask = { id: `dry-sub-${taskRef}` };
          }

          refToTaskId.set(taskRef, subTask.id);
          projectResult.subs++;

          const steps = (task.steps || []).map(normalizeStep).filter(Boolean);
          for (const step of steps) {
            const stepAssignees = step.assigneeKey
              ? resolveAssigneeKeys({ assigneeKey: step.assigneeKey }, team, assignees[0])
              : assignees;
            const stepStatus = statusFromProgress(step.progress, importMode);

            let stepTask;
            if (!dryRun) {
              stepTask = await prisma.task.create({
                data: {
                  projectId: project.id,
                  parentTaskId: subTask.id,
                  title: step.title,
                  taskType,
                  priority: 'MEDIUM',
                  status: stepStatus,
                  milestone: milestone !== '(Unspecified)' ? milestone : null,
                  clientVisible: task.clientVisible !== false,
                  createdById,
                  wpAccessPresetId: resolvePresetId(taskType),
                  assignees: { connect: stepAssignees.map((u) => ({ id: u.id })) },
                },
              });
            } else {
              stepTask = { id: `dry-step-${step.ref}` };
            }

            refToTaskId.set(step.ref, stepTask.id);
            projectResult.steps++;
          }

          if (!dryRun) {
            for (const del of task.deliverables || []) {
              const uploader = resolveAssignee(team, del.uploadedByKey, assignees[0]);
              if (!uploader || !del.fileUrl) continue;
              await prisma.deliverableVersion.create({
                data: {
                  taskId: subTask.id,
                  version: del.version || 1,
                  fileUrl: del.fileUrl,
                  notes: del.notes || null,
                  uploadedById: uploader.id,
                  ...(del.uploadedAt ? { createdAt: parseDate(del.uploadedAt) } : {}),
                },
              });
            }

            for (const c of task.comments || []) {
              const author = resolveAssignee(team, c.authorKey, createdById);
              if (!author || !c.content) continue;
              await prisma.taskComment.create({
                data: {
                  taskId: subTask.id,
                  userId: author.id,
                  content: c.content,
                  ...(c.createdAt ? { createdAt: parseDate(c.createdAt) } : {}),
                },
              });
              projectResult.comments++;
            }

            for (const act of task.activity || []) {
              const actor = resolveAssignee(team, act.actorKey, createdById);
              if (!actor) continue;
              await prisma.taskActivityLog.create({
                data: {
                  taskId: subTask.id,
                  actorId: actor.id,
                  action: act.action || 'import',
                  detail: act.detail || null,
                  ...(act.occurredAt ? { createdAt: parseDate(act.occurredAt) } : {}),
                },
              });
            }
          }
        }
      }
    }

    if (importMode !== 'plan_only') {
      const updateStats = await applyProjectUpdates(
        projEntry.projectUpdates || [],
        refToTaskId,
        team,
        createdById,
        dryRun,
      );
      projectResult.comments += updateStats.comments;
    }

    const pmStats = await applyPmUpdates(
      projEntry.pmUpdates || [],
      project.clientId,
      team,
      fallbackPm,
      dryRun,
    );
    projectResult.pmUpdates = pmStats.count;

    const buStats = await applyBusinessUpdates(
      projEntry.businessUpdates || [],
      project.clientId,
      project.id,
      dryRun,
    );
    projectResult.businessUpdates = buStats.count;

    const kwStats = await applyKeywords(projEntry.keywords || [], project.id, dryRun);
    projectResult.keywords = kwStats.count;

    summary.projects.push(projectResult);
    summary.totals.mains += projectResult.mains;
    summary.totals.subs += projectResult.subs;
    summary.totals.steps += projectResult.steps;
    summary.totals.comments += projectResult.comments;
    summary.totals.pmUpdates += projectResult.pmUpdates;
    summary.totals.businessUpdates += projectResult.businessUpdates;
    summary.totals.keywords += projectResult.keywords;
  }

  return summary;
}

function buildRefMapFromExisting(projEntry, flatTasks, refToTaskId, tree) {
  for (const group of projEntry.taskGroups || []) {
    const milestone = group.milestone || '(Unspecified)';
    const groupRef = group.ref || slugRef('grp', milestone);
    const main = tree.find((t) => !t.parentTaskId && t.title === milestone);
    if (main) refToTaskId.set(groupRef, main.id);

    for (const task of group.tasks || []) {
      const taskRef = task.ref || slugRef('task', task.title);
      const sub = tree.find((t) => t.parentTaskId === main?.id && t.title === task.title);
      if (sub) refToTaskId.set(taskRef, sub.id);

      for (const step of task.steps || []) {
        const norm = normalizeStep(step);
        if (!norm || !sub) continue;
        const stepRow = tree.find((t) => t.parentTaskId === sub.id && t.title === norm.title);
        if (stepRow) refToTaskId.set(norm.ref, stepRow.id);
      }
    }
  }
}

async function applyProjectUpdates(updates, refToTaskId, team, fallbackUserId, dryRun) {
  let comments = 0;
  const sorted = [...updates].sort(
    (a, b) => new Date(a.reportedAt || 0) - new Date(b.reportedAt || 0),
  );

  for (const period of sorted) {
    const taskUpdates = [...(period.taskUpdates || [])].sort(
      (a, b) => new Date(a.postedAt || period.reportedAt || 0) - new Date(b.postedAt || period.reportedAt || 0),
    );

    for (const tu of taskUpdates) {
      const taskId = refToTaskId.get(tu.taskRef);
      if (!taskId || String(taskId).startsWith('dry-')) continue;

      const author = resolveAssignee(team, tu.authorKey, { id: fallbackUserId });
      if (!author || !tu.update) continue;

      const newStatus = statusFromCompletion(tu.completion);

      if (!dryRun) {
        await prisma.taskComment.create({
          data: {
            taskId,
            userId: author.id,
            content: tu.update,
            createdAt: parseDate(tu.postedAt || period.reportedAt) || new Date(),
          },
        });

        if (newStatus && VALID_STATUSES.has(newStatus)) {
          await prisma.task.update({
            where: { id: taskId },
            data: { status: newStatus },
          });
          await prisma.taskActivityLog.create({
            data: {
              taskId,
              actorId: author.id,
              action: 'status_change',
              detail: `Import: status → ${newStatus}`,
            },
          });
        }
      }
      comments++;
    }

    if (!dryRun) {
      await rollupParentStatuses([...refToTaskId.values()].filter((id) => !String(id).startsWith('dry-')));
    }
  }

  return { comments };
}

async function rollupParentStatuses(taskIds) {
  const unique = [...new Set(taskIds)];
  for (const taskId of unique) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, parentTaskId: true },
    });
    if (!task?.parentTaskId) continue;

    const siblings = await prisma.task.findMany({
      where: { parentTaskId: task.parentTaskId },
      select: { status: true },
    });
    if (!siblings.length) continue;

    const statuses = siblings.map((s) => s.status);
    let parentStatus = 'IN_PROGRESS';
    if (statuses.every((s) => s === 'COMPLETED')) parentStatus = 'COMPLETED';
    else if (statuses.some((s) => s === 'BLOCKED')) parentStatus = 'BLOCKED';
    else if (statuses.some((s) => s === 'NEEDS_REVIEW')) parentStatus = 'NEEDS_REVIEW';
    else if (statuses.every((s) => s === 'TO_DO')) parentStatus = 'TO_DO';

    await prisma.task.update({
      where: { id: task.parentTaskId },
      data: { status: parentStatus },
    });

    const grandparent = await prisma.task.findUnique({
      where: { id: task.parentTaskId },
      select: { parentTaskId: true },
    });
    if (grandparent?.parentTaskId) {
      await rollupParentStatuses([grandparent.parentTaskId]);
    }
  }
}

async function applyPmUpdates(pmUpdates, clientId, team, fallback, dryRun) {
  let count = 0;
  for (const pm of pmUpdates || []) {
    if (!pm.message) continue;
    const author = resolveAssignee(team, pm.authorKey, fallback);
    if (!author) continue;
    if (!dryRun) {
      await prisma.clientPMUpdate.create({
        data: {
          clientId,
          message: pm.message,
          authorId: author.id,
          ...(pm.createdAt ? { createdAt: parseDate(pm.createdAt) } : {}),
        },
      });
    }
    count++;
  }
  return { count };
}

async function applyBusinessUpdates(updates, clientId, projectId, dryRun) {
  let count = 0;
  for (const bu of updates || []) {
    if (!bu.details) continue;
    if (!dryRun) {
      await prisma.businessUpdate.create({
        data: {
          clientId,
          projectId,
          updateType: bu.updateType || 'OTHER',
          details: bu.details,
          ...(bu.submittedAt ? { submittedAt: parseDate(bu.submittedAt) } : {}),
        },
      });
    }
    count++;
  }
  return { count };
}

async function applyKeywords(keywords, projectId, dryRun) {
  let count = 0;
  for (const kw of keywords || []) {
    if (!kw.keyword) continue;
    if (!dryRun) {
      await prisma.keywordTrack.create({
        data: {
          projectId,
          keyword: kw.keyword,
          volume: kw.volume ?? null,
          currentRank: kw.currentRank ?? null,
          targetUrl: kw.targetUrl || null,
          status: kw.status || 'TRACKING',
        },
      });
    }
    count++;
  }
  return { count };
}
