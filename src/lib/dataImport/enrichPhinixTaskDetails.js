import { prisma } from '../prisma.js';
import { findProjectByMatch } from './resolveProject.js';
import { resolveTeamRoster, resolveAssignee } from './resolveTeam.js';
import { buildPhinixAgencyData } from './buildPhinixAgencyData.js';
import {
  ENRICH_MARKER,
  PHINIX_TEAM_ROSTER,
  PHINIX_PROJECTS,
  spreadsheetEditUrl,
  masterPlanUrl,
} from './phinixSheetConfig.js';
import { buildDeliverableComment, buildDeliverables, buildMilestoneSummaryComment, isEnrichedPhinixComment, normalizePhinixCommentContent } from './phinixTaskEnrichment.js';

/**
 * Backfill rich comments + sheet-link deliverables on existing Agency OS tasks.
 * Idempotent: skips tasks that already have an enriched comment.
 */
export async function enrichPhinixTaskDetails(options = {}) {
  const { dryRun = false, projects: projectFilter, fetchFn } = options;

  const agencyData = await buildPhinixAgencyData({
    projects: projectFilter,
    fetchFn,
  });

  const { team } = await resolveTeamRoster(PHINIX_TEAM_ROSTER);
  const fallbackPm = await prisma.user.findFirst({
    where: { role: { in: ['PM', 'OWNER'] }, isActive: true },
  });
  if (!fallbackPm) throw new Error('No PM/OWNER user found');

  const summary = { projects: [], totals: { comments: 0, deliverables: 0, milestones: 0, attachments: 0, skipped: 0 } };

  for (const projEntry of agencyData.projects || []) {
    const project = await findProjectByMatch(projEntry.projectMatch || {});
    if (!project) {
      summary.projects.push({
        name: projEntry.project?.name,
        status: 'skipped',
        reason: 'project not found',
      });
      continue;
    }

    const projConfig = PHINIX_PROJECTS.find((p) => p.ref === projEntry.ref);

    const projectResult = {
      project: project.name,
      comments: 0,
      deliverables: 0,
      milestones: 0,
      attachments: 0,
      skipped: 0,
    };

    const allTasks = await prisma.task.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        title: true,
        parentTaskId: true,
        comments: { select: { content: true } },
        deliverables: { select: { id: true, fileUrl: true, notes: true } },
        attachments: { select: { id: true, fileUrl: true } },
      },
    });

    const byTitleParent = new Map();
    for (const t of allTasks) {
      const key = `${t.parentTaskId || 'root'}::${t.title}`;
      if (!byTitleParent.has(key)) byTitleParent.set(key, t);
    }

    const milestoneTaskIds = new Set();

    for (const group of projEntry.taskGroups || []) {
      const milestoneTitle = group.milestone;
      const mainKey = `root::${milestoneTitle}`;
      const mainTask = byTitleParent.get(mainKey);

      const enrichedChildren = [];

      for (const task of group.tasks || []) {
        const subKey = mainTask ? `${mainTask.id}::${task.title}` : `root::${task.title}`;
        const dbTask = byTitleParent.get(subKey);
        if (!dbTask) {
          projectResult.skipped++;
          continue;
        }

        const already = dbTask.comments.some((c) => isEnrichedPhinixComment(c.content));
        if (already) {
          projectResult.skipped++;
          enrichedChildren.push({ ...task, _completionDetails: task._completionDetails });
          continue;
        }

        const assigneeTab =
          task._assigneeTab ||
          PHINIX_TEAM_ROSTER[task.assigneeKey]?.name?.split(' ')[0] ||
          task.assigneeKey;
        const commentBody = buildDeliverableComment({
          milestone: milestoneTitle,
          title: task.title,
          goal: task.goal,
          description: task.description,
          stepsRaw: task._stepsRaw,
          completionDetails: task._completionDetails,
          statusRaw: task._statusRaw,
          assigneeKey: task.assigneeKey,
          assigneeTabName: assigneeTab,
          spreadsheetId: projConfig?.spreadsheetId,
          projectLabel: projEntry.project?.name,
          masterTab: projConfig?.masterTab,
        });

        const author = resolveAssignee(team, task.assigneeKey, fallbackPm);
        if (!dryRun && author) {
          await prisma.taskComment.create({
            data: {
              taskId: dbTask.id,
              userId: author.id,
              content: commentBody,
            },
          });
        }
        projectResult.comments++;

        const hasSheetDeliverable = dbTask.deliverables.some((d) =>
          d.fileUrl?.includes('docs.google.com/spreadsheets'),
        );
        if (!hasSheetDeliverable && projConfig?.spreadsheetId && !dryRun) {
          const del = buildDeliverables({
            spreadsheetId: projConfig.spreadsheetId,
            assigneeTabName: assigneeTab,
            completionDetails: task._completionDetails,
            assigneeKey: task.assigneeKey,
            title: task.title,
          })[0];
          if (del && author) {
            await prisma.deliverableVersion.create({
              data: {
                taskId: dbTask.id,
                version: del.version || 1,
                fileUrl: del.fileUrl,
                notes: del.notes,
                uploadedById: author.id,
              },
            });
            projectResult.deliverables++;
          }
        } else if (!hasSheetDeliverable && projConfig?.spreadsheetId && dryRun) {
          projectResult.deliverables++;
        }

        enrichedChildren.push({
          ...task,
          _completionDetails: task._completionDetails,
          _statusRaw: task._statusRaw,
        });
      }

      if (mainTask && enrichedChildren.length) {
        milestoneTaskIds.add(mainTask.id);
        const mainEnriched = mainTask.comments.some((c) => isEnrichedPhinixComment(c.content));
        if (!mainEnriched) {
          const summaryComment = buildMilestoneSummaryComment(
            milestoneTitle,
            enrichedChildren,
            projEntry.project?.name,
            projConfig?.spreadsheetId,
            projConfig?.masterTab,
          );
          const reporter = resolveAssignee(team, projEntry.project?.leadPmKey || 'hamza', fallbackPm);
          if (!dryRun && reporter) {
            await prisma.taskComment.create({
              data: {
                taskId: mainTask.id,
                userId: reporter.id,
                content: summaryComment,
              },
            });
          }
          projectResult.milestones++;

          const mainHasSheet = mainTask.deliverables.some((d) =>
            d.fileUrl?.includes('docs.google.com/spreadsheets'),
          );
          if (!mainHasSheet && projConfig?.spreadsheetId && !dryRun && reporter) {
            await prisma.deliverableVersion.create({
              data: {
                taskId: mainTask.id,
                version: 1,
                fileUrl: spreadsheetEditUrl(projConfig.spreadsheetId),
                notes: `Project task plan — ${projConfig.masterTab || 'assignee tabs'}. Master: ${masterPlanUrl()}`,
                uploadedById: reporter.id,
              },
            });
            projectResult.deliverables++;
          } else if (!mainHasSheet && projConfig?.spreadsheetId && dryRun) {
            projectResult.deliverables++;
          }
        }
      }
    }

    summary.projects.push(projectResult);
    summary.totals.comments += projectResult.comments;
    summary.totals.deliverables += projectResult.deliverables;
    summary.totals.milestones += projectResult.milestones;
    summary.totals.skipped += projectResult.skipped;
  }

  // Backfill TaskAttachment rows for sheet links (UI attachments panel reads this table).
  for (const projEntry of agencyData.projects || []) {
    const project = await findProjectByMatch(projEntry.projectMatch || {});
    if (!project) continue;

    const projConfig = PHINIX_PROJECTS.find((p) => p.ref === projEntry.ref);
    const projectResult = summary.projects.find((p) => p.project === project.name);
    if (!projectResult) continue;

    const tasksWithLinks = await prisma.task.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        title: true,
        deliverables: { select: { fileUrl: true, notes: true, uploadedById: true } },
        attachments: { select: { fileUrl: true } },
      },
    });

    for (const dbTask of tasksWithLinks) {
      const sheetDeliverable = dbTask.deliverables.find((d) =>
        d.fileUrl?.includes('docs.google.com/spreadsheets'),
      );
      if (!sheetDeliverable) continue;

      const hasSheetAttachment = dbTask.attachments.some((a) =>
        a.fileUrl?.includes('docs.google.com/spreadsheets'),
      );
      if (hasSheetAttachment) continue;

      const fileName =
        sheetDeliverable.notes?.split('\n')[0]?.slice(0, 200) ||
        `Working sheet — ${projConfig?.label || project.name}`;
      if (!dryRun) {
        await prisma.taskAttachment.create({
          data: {
            taskId: dbTask.id,
            uploadedById: sheetDeliverable.uploadedById,
            fileName,
            fileUrl: sheetDeliverable.fileUrl,
          },
        });
      }
      projectResult.attachments++;
      summary.totals.attachments++;
    }
  }

  return summary;
}

/**
 * Fix comments that still contain the internal marker or raw markdown.
 */
export async function cleanupLegacyPhinixComments(options = {}) {
  const { dryRun = false } = options;
  const comments = await prisma.taskComment.findMany({
    where: {
      OR: [
        { content: { contains: ENRICH_MARKER } },
        { content: { contains: '##' } },
        { content: { contains: '**' } },
      ],
    },
    select: { id: true, content: true },
  });

  let updated = 0;
  for (const comment of comments) {
    const normalized = normalizePhinixCommentContent(comment.content);
    if (normalized !== comment.content) {
      if (!dryRun) {
        await prisma.taskComment.update({
          where: { id: comment.id },
          data: { content: normalized },
        });
      }
      updated++;
    }
  }

  return { scanned: comments.length, updated };
}
