import { prisma } from '../../lib/prisma.js';

const PM_ROLES = ['PM', 'OWNER'];

export async function pmDigestRoutes(app) {
  app.get(
    '/digest',
    { onRequest: [app.verifyJwt] },
    async (request, reply) => {
      if (!PM_ROLES.includes(request.user?.role)) {
        return reply.status(403).send({ message: 'PM or Owner access required' });
      }

      const userId = request.user.id;
      const userRole = request.user.role;
      const now = new Date();

      // ── Scope: PM sees only their projects, OWNER sees all ──
      const projectWhere = userRole === 'PM' ? { leadPmId: userId } : {};

      // ── 1. Review Queue: content items awaiting PM review ──
      const reviewQueue = await prisma.wpContentReview.count({
        where: {
          status: 'pending_pm_review',
          isPublished: false,
          project: projectWhere,
        },
      });

      // ── 2. Due This Week: tasks due between now and end of Sunday ──
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dayOfWeek = startOfToday.getDay(); // 0=Sun
      const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      const endOfWeek = new Date(startOfToday);
      endOfWeek.setDate(endOfWeek.getDate() + daysUntilSunday);
      endOfWeek.setHours(23, 59, 59, 999);

      const activeTaskStatuses = ['TO_DO', 'IN_PROGRESS', 'NEEDS_REVIEW', 'REVISION_NEEDED', 'BLOCKED', 'WAITING_DEPENDENCY'];

      const dueThisWeek = await prisma.task.count({
        where: {
          status: { in: activeTaskStatuses },
          dueDate: { gte: startOfToday, lte: endOfWeek },
          project: projectWhere,
        },
      });

      // ── 3. Urgent: overdue tasks + unread alerts ──
      const overdueTasks = await prisma.task.count({
        where: {
          status: { in: activeTaskStatuses },
          dueDate: { lt: startOfToday },
          project: projectWhere,
        },
      });

      const unreadAlerts = await prisma.systemAlert.count({
        where: { userId, isRead: false },
      });

      const urgent = overdueTasks + unreadAlerts;

      return reply.send({
        urgent,
        reviewQueue,
        dueThisWeek,
      });
    }
  );
}
