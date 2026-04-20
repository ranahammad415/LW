import { prisma } from './prisma.js';

export async function ensureProjectAccess(project, user) {
  if (!project) return false;
  if (user.role === 'OWNER') return true;
  if (user.role === 'PM') {
    if (project.leadPmId === user.id) return true;
    const client = await prisma.clientAccount.findUnique({
      where: { id: project.clientId },
      select: { secondaryPmId: true },
    });
    return client?.secondaryPmId === user.id;
  }
  if (user.role === 'TEAM_MEMBER' || user.role === 'CONTRACTOR') {
    const tasksWithAssignees = Array.isArray(project.tasks) && project.tasks.every((t) => Array.isArray(t.assignees));
    if (tasksWithAssignees && project.tasks?.length) {
      return project.tasks.some((t) => t.assignees.some((a) => a.id === user.id));
    }
    const assigned = await prisma.task.count({
      where: { projectId: project.id, assignees: { some: { id: user.id } } },
    });
    return assigned > 0;
  }
  return false;
}
