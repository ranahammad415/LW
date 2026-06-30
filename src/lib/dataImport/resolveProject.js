import { prisma } from '../prisma.js';

/**
 * Find existing project by projectMatch rules.
 */
export async function findProjectByMatch(projectMatch = {}) {
  const { projectNameContains, clientNameContains } = projectMatch;

  if (projectNameContains) {
    const byProject = await prisma.project.findFirst({
      where: { name: { contains: projectNameContains } },
      include: { client: true, leadPm: true },
    });
    if (byProject) return byProject;
  }

  if (clientNameContains) {
    return prisma.project.findFirst({
      where: { client: { agencyName: { contains: clientNameContains } } },
      include: { client: true, leadPm: true },
    });
  }

  return null;
}
