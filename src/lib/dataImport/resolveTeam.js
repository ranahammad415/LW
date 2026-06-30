import { prisma } from '../prisma.js';

/**
 * Resolve teamRoster keys → User records by email (preferred) or name contains.
 * @param {Record<string, { email: string, name?: string, required?: boolean }>} roster
 */
export async function resolveTeamRoster(roster) {
  const team = {};
  const missing = [];

  for (const [key, entry] of Object.entries(roster || {})) {
    let user = null;
    if (entry.email) {
      user = await prisma.user.findUnique({
        where: { email: entry.email.toLowerCase() },
      });
    }
    if (!user && entry.name) {
      user = await prisma.user.findFirst({
        where: { name: { contains: entry.name }, isActive: true },
      });
    }
    if (!user) {
      user = await prisma.user.findFirst({
        where: { name: { contains: key }, isActive: true },
      });
    }
    if (!user) {
      if (entry.required !== false) missing.push(`${key} (${entry.email || entry.name || key})`);
    } else {
      team[key] = user;
    }
  }

  return { team, missing };
}

export function resolveAssignee(team, assigneeKey, fallbackUser) {
  if (assigneeKey && team[assigneeKey]) return team[assigneeKey];
  return fallbackUser;
}
