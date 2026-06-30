import { prisma } from '../prisma.js';
import { findProjectByMatch } from './resolveProject.js';
import { resolveTeamRoster, resolveAssignee } from './resolveTeam.js';
import { buildPhinixAgencyData } from './buildPhinixAgencyData.js';
import { PHINIX_TEAM_ROSTER, PHINIX_PROJECTS } from './phinixSheetConfig.js';
import { buildClientPmUpdate, PM_IMPORT_MESSAGE_HINT, clientDisplayName } from './phinixPmUpdateBuilder.js';

/**
 * Create or replace client PM dashboard updates with positive campaign summaries.
 */
export async function syncPhinixPmUpdates(options = {}) {
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

  const summary = { projects: [], totals: { created: 0, updated: 0, skipped: 0 } };

  for (const projEntry of agencyData.projects || []) {
    const project = await findProjectByMatch(projEntry.projectMatch || {});
    const projConfig = PHINIX_PROJECTS.find((p) => p.ref === projEntry.ref);

    const projectResult = {
      project: projEntry.project?.name,
      status: 'ok',
      action: null,
    };

    if (!project) {
      projectResult.status = 'skipped';
      projectResult.reason = 'project not found';
      summary.projects.push(projectResult);
      summary.totals.skipped++;
      continue;
    }

    const taskUpdates =
      projEntry.projectUpdates?.flatMap((pu) => pu.taskUpdates || []) || [];

    const planLabel = projConfig?.planLabel || projEntry.project?.name;
    const clientName = clientDisplayName(projEntry.project?.name, planLabel);

    const message = buildClientPmUpdate({
      projectName: projEntry.project?.name,
      planLabel,
      taskGroups: projEntry.taskGroups || [],
      taskUpdates,
      authorKey: projEntry.project?.leadPmKey || projConfig?.leadPmKey || 'hamza',
    });

    const author = resolveAssignee(
      team,
      projEntry.project?.leadPmKey || projConfig?.leadPmKey || 'hamza',
      fallbackPm,
    );
    if (!author) {
      projectResult.status = 'skipped';
      projectResult.reason = 'author not found';
      summary.totals.skipped++;
      summary.projects.push(projectResult);
      continue;
    }

    const planHint = planLabel?.split('—')[0]?.trim() || planLabel || '';
    const existing = await prisma.clientPMUpdate.findFirst({
      where: {
        clientId: project.clientId,
        OR: [
          { message: { contains: PM_IMPORT_MESSAGE_HINT } },
          ...(planHint ? [{ message: { contains: planHint } }] : []),
          { message: { contains: `Hello ${clientName} team` } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      if (!dryRun) {
        await prisma.clientPMUpdate.update({
          where: { id: existing.id },
          data: { message, authorId: author.id },
        });
      }
      projectResult.action = 'updated';
      summary.totals.updated++;
    } else {
      if (!dryRun) {
        await prisma.clientPMUpdate.create({
          data: {
            clientId: project.clientId,
            message,
            authorId: author.id,
          },
        });
      }
      projectResult.action = 'created';
      summary.totals.created++;
    }

    projectResult.preview = message.split('\n').slice(0, 4).join(' ');
    summary.projects.push(projectResult);
  }

  return summary;
}
