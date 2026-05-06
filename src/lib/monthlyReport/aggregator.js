import { prisma } from '../prisma.js';

const ROW_LIMIT = 20;
const ACTIVE_TASK_STATUSES = ['TO_DO', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REVISION_NEEDED', 'BLOCKED', 'WAITING_DEPENDENCY'];

/**
 * Convert "YYYY-MM" to { from, to } Date range covering the full month (UTC).
 */
export function monthToRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw new Error('Invalid month, expected "YYYY-MM"');
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const from = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, mon, 1, 0, 0, 0, 0));
  return { from, to };
}

function countBy(list, key) {
  const out = {};
  for (const row of list) {
    const k = row[key] ?? 'UNKNOWN';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Aggregate raw activity for a single project over a date range.
 */
export async function aggregateProject({ projectId, from, to }) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      client: { select: { id: true, agencyName: true, healthScore: true } },
      leadPm: { select: { id: true, name: true, email: true } },
    },
  });
  if (!project) throw new Error('Project not found');

  const [
    tasksCreated,
    tasksCompleted,
    tasksOpen,
    tasksOverdue,
    allTasksForStatusBreakdown,
    topContributors,
    standups,
    contentReviewsStarted,
    contentReviewsPublished,
    keywordSuggestionsNew,
    keywordSuggestionsAccepted,
    keywordSuggestionsRejected,
    promptLogs,
    promptCitations,
    activityActions,
    issuesOpened,
    issuesResolved,
    businessUpdates,
    intakeSubmissions,
    checklist,
    notifCount,
    notifReadCount,
    recentCompletedTasksList,
    recentBlockersList,
  ] = await Promise.all([
    prisma.task.count({ where: { projectId, createdAt: { gte: from, lt: to } } }),
    prisma.task.count({ where: { projectId, status: 'COMPLETED', updatedAt: { gte: from, lt: to } } }),
    prisma.task.count({ where: { projectId, status: { in: ACTIVE_TASK_STATUSES } } }),
    prisma.task.count({
      where: { projectId, status: { in: ACTIVE_TASK_STATUSES }, dueDate: { lt: to, not: null } },
    }),
    prisma.task.findMany({
      where: { projectId, OR: [{ createdAt: { gte: from, lt: to } }, { updatedAt: { gte: from, lt: to } }] },
      select: { status: true, priority: true },
    }),
    prisma.task.findMany({
      where: { projectId, status: 'COMPLETED', updatedAt: { gte: from, lt: to } },
      include: { assignees: { select: { id: true, name: true } } },
      take: 100,
    }),
    prisma.dailyStandup.findMany({
      where: {
        date: { gte: from, lt: to },
        user: { OR: [{ projectsLed: { some: { id: projectId } } }, { assignedTasks: { some: { projectId } } }] },
      },
      select: { id: true, blockers: true, date: true, userId: true },
      take: 200,
    }),
    prisma.wpContentReview.count({ where: { projectId, createdAt: { gte: from, lt: to } } }),
    prisma.wpContentReview.count({ where: { projectId, publishedAt: { gte: from, lt: to }, isPublished: true } }),
    prisma.keywordSuggestion.count({ where: { projectId, submittedAt: { gte: from, lt: to } } }),
    prisma.keywordSuggestion.count({
      where: { projectId, reviewedAt: { gte: from, lt: to }, status: 'ACCEPTED' },
    }),
    prisma.keywordSuggestion.count({
      where: { projectId, reviewedAt: { gte: from, lt: to }, status: 'REJECTED' },
    }),
    prisma.promptLog.count({ where: { projectId, createdAt: { gte: from, lt: to } } }),
    prisma.promptLog.count({ where: { projectId, createdAt: { gte: from, lt: to }, cited: true } }),
    prisma.clientActivityLog.findMany({
      where: { clientId: project.clientId, createdAt: { gte: from, lt: to } },
      select: { action: true },
      take: 500,
    }),
    prisma.clientIssue.count({ where: { projectId, createdAt: { gte: from, lt: to } } }),
    prisma.clientIssue.count({
      where: { projectId, resolvedAt: { gte: from, lt: to, not: null }, status: 'RESOLVED' },
    }),
    prisma.businessUpdate.count({ where: { projectId, submittedAt: { gte: from, lt: to } } }),
    prisma.intakeSubmission.count({ where: { projectId, submittedAt: { gte: from, lt: to } } }),
    prisma.onboardingChecklist.findUnique({ where: { projectId } }).catch(() => null),
    prisma.notificationLog.count({
      where: { createdAt: { gte: from, lt: to }, metadata: { path: ['projectId'], equals: projectId } },
    }).catch(() => 0),
    prisma.notificationLog.count({
      where: {
        createdAt: { gte: from, lt: to },
        isRead: true,
        metadata: { path: ['projectId'], equals: projectId },
      },
    }).catch(() => 0),
    prisma.task.findMany({
      where: { projectId, status: 'COMPLETED', updatedAt: { gte: from, lt: to } },
      select: { id: true, title: true, updatedAt: true, priority: true },
      orderBy: { updatedAt: 'desc' },
      take: ROW_LIMIT,
    }),
    prisma.dailyStandup.findMany({
      where: {
        date: { gte: from, lt: to },
        blockers: { not: null },
        user: { OR: [{ projectsLed: { some: { id: projectId } } }, { assignedTasks: { some: { projectId } } }] },
      },
      select: { date: true, blockers: true, user: { select: { name: true } } },
      orderBy: { date: 'desc' },
      take: ROW_LIMIT,
    }),
  ]);

  // Contributor leaderboard
  const contribMap = new Map();
  for (const t of topContributors) {
    for (const a of t.assignees) {
      contribMap.set(a.id, { id: a.id, name: a.name, completed: (contribMap.get(a.id)?.completed || 0) + 1 });
    }
  }
  const topContributorList = Array.from(contribMap.values()).sort((a, b) => b.completed - a.completed).slice(0, ROW_LIMIT);

  const blockersCount = standups.filter((s) => s.blockers && s.blockers.trim().length > 0).length;

  return {
    scope: 'PROJECT',
    project: {
      id: project.id,
      name: project.name,
      projectType: project.projectType,
      status: project.status,
      onboardingStep: project.onboardingStep,
      client: project.client,
      leadPm: project.leadPm,
      wpSiteInfoSyncedAt: project.wpSiteInfoSyncedAt,
      gscLastSyncedAt: project.gscLastSyncedAt,
    },
    period: { from: from.toISOString(), to: to.toISOString() },
    tasks: {
      created: tasksCreated,
      completed: tasksCompleted,
      stillOpen: tasksOpen,
      overdue: tasksOverdue,
      byStatus: countBy(allTasksForStatusBreakdown, 'status'),
      byPriority: countBy(allTasksForStatusBreakdown, 'priority'),
      topContributors: topContributorList,
      recentCompleted: recentCompletedTasksList.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        updatedAt: t.updatedAt,
      })),
    },
    standups: {
      totalEntries: standups.length,
      blockersReported: blockersCount,
      recentBlockers: recentBlockersList.map((b) => ({
        date: b.date,
        userName: b.user?.name ?? '—',
        blockers: b.blockers?.slice(0, 500) ?? '',
      })),
    },
    content: {
      reviewsStarted: contentReviewsStarted,
      reviewsPublished: contentReviewsPublished,
    },
    seoAeo: {
      keywordSuggestionsNew,
      keywordSuggestionsAccepted,
      keywordSuggestionsRejected,
      promptLogs,
      promptCitations,
    },
    clientActivity: {
      totalEvents: activityActions.length,
      byAction: countBy(activityActions, 'action'),
    },
    issues: { opened: issuesOpened, resolved: issuesResolved },
    inputs: {
      businessUpdates,
      intakeSubmissions,
      onboardingComplete: !!checklist?.completedAt,
    },
    notifications: {
      sent: notifCount,
      read: notifReadCount,
    },
  };
}

/**
 * Aggregate raw activity across the whole agency for the date range.
 */
export async function aggregateAgency({ from, to }) {
  const [
    activeClients,
    totalProjects,
    projectsByStatus,
    tasksCreated,
    tasksCompleted,
    tasksStillOpen,
    issuesOpened,
    issuesResolved,
    standupsTotal,
    blockersTotal,
    keywordSuggestionsNew,
    keywordCitations,
    notificationsSent,
    notificationsRead,
    topProjectsByCompletions,
    topTeamByCompletions,
  ] = await Promise.all([
    prisma.clientAccount.count({ where: { isActive: true } }),
    prisma.project.count(),
    prisma.project.findMany({ select: { status: true } }),
    prisma.task.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.task.count({ where: { status: 'COMPLETED', updatedAt: { gte: from, lt: to } } }),
    prisma.task.count({ where: { status: { in: ACTIVE_TASK_STATUSES } } }),
    prisma.clientIssue.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.clientIssue.count({ where: { resolvedAt: { gte: from, lt: to, not: null }, status: 'RESOLVED' } }),
    prisma.dailyStandup.count({ where: { date: { gte: from, lt: to } } }),
    prisma.dailyStandup.count({ where: { date: { gte: from, lt: to }, blockers: { not: null } } }),
    prisma.keywordSuggestion.count({ where: { submittedAt: { gte: from, lt: to } } }),
    prisma.promptLog.count({ where: { createdAt: { gte: from, lt: to }, cited: true } }),
    prisma.notificationLog.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.notificationLog.count({ where: { createdAt: { gte: from, lt: to }, isRead: true } }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: { status: 'COMPLETED', updatedAt: { gte: from, lt: to } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: ROW_LIMIT,
    }),
    prisma.$queryRawUnsafe(
      `SELECT u.id, u.name, COUNT(*) AS completed
       FROM _TaskAssignees ta
       JOIN task t ON t.id = ta.A
       JOIN user u ON u.id = ta.B
       WHERE t.status = 'COMPLETED' AND t.updatedAt >= ? AND t.updatedAt < ?
       GROUP BY u.id, u.name
       ORDER BY completed DESC
       LIMIT ${ROW_LIMIT}`,
      from,
      to,
    ).catch(() => []),
  ]);

  // Resolve project names for top projects
  const projectIds = topProjectsByCompletions.map((p) => p.projectId);
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true, client: { select: { agencyName: true } } },
      })
    : [];
  const projectMap = new Map(projects.map((p) => [p.id, p]));

  return {
    scope: 'AGENCY',
    period: { from: from.toISOString(), to: to.toISOString() },
    overview: {
      activeClients,
      totalProjects,
      projectsByStatus: countBy(projectsByStatus, 'status'),
    },
    tasks: { created: tasksCreated, completed: tasksCompleted, stillOpen: tasksStillOpen },
    issues: { opened: issuesOpened, resolved: issuesResolved },
    standups: { totalEntries: standupsTotal, blockersReported: blockersTotal },
    seoAeo: { keywordSuggestionsNew, citations: keywordCitations },
    notifications: { sent: notificationsSent, read: notificationsRead },
    topProjects: topProjectsByCompletions.map((p) => ({
      projectId: p.projectId,
      completed: p._count.id,
      name: projectMap.get(p.projectId)?.name ?? 'Unknown',
      client: projectMap.get(p.projectId)?.client?.agencyName ?? '—',
    })),
    topTeam: Array.isArray(topTeamByCompletions)
      ? topTeamByCompletions.map((row) => ({
          id: row.id,
          name: row.name,
          completed: Number(row.completed),
        }))
      : [],
  };
}
